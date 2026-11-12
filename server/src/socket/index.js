import { Server } from 'socket.io';
import { MatchmakingEngine } from './matchmaking.js';
import { incrementCounter, getCounters } from '../config/counters.js';
import { signalRateLimiter, chatRateLimiter, reportRateLimiter } from '../config/rateLimiter.js';
import {
  validateGenderMode,
  validateChatText,
  validateTyping,
  validateReport,
  validateSdp,
  validateIceCandidate,
} from '../middleware/validation.js';
import { CallManager } from './callManager.js';
import { reportStore } from '../config/reportStore.js';

/** Session-level block list: socketId -> Set of blocked socketIds. Ephemeral, in-memory only. */
const blocks = new Map();

export function attachRealtime(httpServer, allowedOrigins) {
  const io = new Server(httpServer, {
    cors: { origin: allowedOrigins, methods: ['GET', 'POST'] },
    // Reduce ping timeout so dead sockets are detected faster.
    pingTimeout: 20000,
    pingInterval: 5000,
    maxHttpBufferSize: 64 * 1024, // 64KB max per message (signaling SDP can be large)
  });

  const engine = new MatchmakingEngine(io);
  const calls = new CallManager(io);

  // Inject session-level block map so matchmaking never pairs blocked users.
  engine.setBlocks(blocks);

  // Wire MongoDB counters (safely optional — the app runs without them).
  engine.incrementCounter = incrementCounter;
  engine.getCounterValues = getCounters;

  // Periodic rate-limiter bucket sweep.
  const rateSweep = setInterval(() => {
    signalRateLimiter.sweep();
    chatRateLimiter.sweep();
    reportRateLimiter.sweep();
  }, 60_000);
  if (typeof rateSweep.unref === 'function') rateSweep.unref();

  /** Metadata-only logging — never message content, never media streams. */
  const logSocket = (socket, event, extra = {}) => {
    console.log(
      `[socket] ${socket.id.slice(0, 6)} → ${event}`,
      JSON.stringify({ ...extra, matchId: extra.matchId ?? engine.sessions.get(socket.id)?.matchId }),
    );
  };

  /** Middleware: authenticate/authorize every socket connection. */
  io.use((socket, next) => {
    const session = engine.sessions.get(socket.id);
    if (!session) {
      // First time seeing this socket; register it lazily on first event.
      return next();
    }
    next();
  });

  io.on('connection', (socket) => {
    engine.register(socket);

    // One visit = one realtime client connection.
    engine.incrementCounter('totalVisits').catch(() => {});

    logSocket(socket, 'connect');

    /* -------------------------------------------------------------- */
    /* Session join                                                   */
    /* -------------------------------------------------------------- */
    socket.on('session:join', (payload) => {
      const validated = validateGenderMode(payload);
      if (!validated.ok) {
        socket.emit('system:error', { message: validated.error });
        logSocket(socket, 'session:join', { error: validated.error });
        return;
      }
      logSocket(socket, 'session:join', { gender: validated.value.gender, mode: validated.value.mode });
      engine.join(socket, validated.value);
    });

    /* -------------------------------------------------------------- */
    /* Search control                                                 */
    /* -------------------------------------------------------------- */
    socket.on('match:cancel', () => {
      logSocket(socket, 'match:cancel');
      engine.cancel(socket);
    });

    socket.on('match:next', () => {
      if (!signalRateLimiter.check(socket.id, 'match:next')) {
        socket.emit('system:error', { message: 'Too many requests. Slow down.' });
        return;
      }
      logSocket(socket, 'match:next');
      // End any active call for this socket before requeueing.
      calls.endCallsFor(socket.id);
      engine.next(socket);
    });

    socket.on('match:leave', () => {
      logSocket(socket, 'match:leave');
      calls.endCallsFor(socket.id);
      engine.leave(socket);
    });

    /* -------------------------------------------------------------- */
    /* WebRTC signaling (audio calls only, between matched partners)  */
    /* -------------------------------------------------------------- */
    socket.on('call:offer', (payload) => {
      if (!signalRateLimiter.check(socket.id, 'call:offer')) {
        socket.emit('system:error', { message: 'Too many requests. Slow down.' });
        return;
      }
      const { matchId, sdp } = payload;
      if (!matchId || !validateSdp(sdp)) {
        socket.emit('system:error', { message: 'Invalid call offer.' });
        return;
      }
      if (!calls.isAuthorized(socket.id, matchId)) {
        socket.emit('system:error', { message: 'Not authorized for this call.' });
        logSocket(socket, 'call:offer', { error: 'unauthorized', matchId });
        return;
      }
      calls.startCall(matchId, [socket.id, engine.partnerOf(socket.id)?.session.socketId ?? null], socket.id);
      const partnerId = engine.partnerOf(socket.id)?.session.socketId;
      if (!partnerId) return;
      logSocket(socket, 'call:offer', { matchId, to: partnerId.slice(0, 6) });
      io.to(partnerId).emit('call:offer', { from: socket.id, sdp, matchId });
    });

    socket.on('call:answer', (payload) => {
      if (!signalRateLimiter.check(socket.id, 'call:answer')) {
        socket.emit('system:error', { message: 'Too many requests. Slow down.' });
        return;
      }
      const { matchId, sdp } = payload;
      if (!matchId || !validateSdp(sdp)) {
        socket.emit('system:error', { message: 'Invalid call answer.' });
        return;
      }
      if (!calls.isAuthorized(socket.id, matchId)) {
        socket.emit('system:error', { message: 'Not authorized for this call.' });
        return;
      }
      calls.setAnswered(matchId);
      const partnerId = engine.partnerOf(socket.id)?.session.socketId;
      if (!partnerId) return;
      logSocket(socket, 'call:answer', { matchId, to: partnerId.slice(0, 6) });
      io.to(partnerId).emit('call:answer', { from: socket.id, sdp, matchId });
    });

    socket.on('call:ice-candidate', (payload) => {
      if (!signalRateLimiter.check(socket.id, 'call:ice-candidate')) {
        socket.emit('system:error', { message: 'Too many requests. Slow down.' });
        return;
      }
      const { matchId, candidate } = payload;
      if (!matchId || !validateIceCandidate(candidate)) {
        socket.emit('system:error', { message: 'Invalid ICE candidate.' });
        return;
      }
      if (!calls.isAuthorized(socket.id, matchId)) {
        socket.emit('system:error', { message: 'Not authorized for this call.' });
        return;
      }
      const partnerId = engine.partnerOf(socket.id)?.session.socketId;
      if (!partnerId) return;
      io.to(partnerId).emit('call:ice-candidate', { from: socket.id, candidate, matchId });
    });

    socket.on('call:active', (payload) => {
      const { matchId } = payload ?? {};
      if (!matchId || !calls.isAuthorized(socket.id, matchId)) return;
      calls.setActive(matchId);
      logSocket(socket, 'call:active', { matchId });
    });

    socket.on('call:end', (payload) => {
      const { matchId } = payload ?? {};
      if (!matchId || !calls.isAuthorized(socket.id, matchId)) return;
      const partnerId = engine.partnerOf(socket.id)?.session.socketId;
      calls.endCall(matchId);
      if (partnerId) io.to(partnerId).emit('call:ended', { reason: 'partner-ended', matchId });
      logSocket(socket, 'call:end', { matchId });
    });

    /* -------------------------------------------------------------- */
    /* Text chat relay (works in both text and audio modes)           */
    /* -------------------------------------------------------------- */
    socket.on('chat:message', (payload) => {
      if (!chatRateLimiter.check(socket.id, 'chat:message')) {
        socket.emit('system:error', { message: 'Too many messages. Slow down.' });
        return;
      }
      const validated = validateChatText(payload);
      if (!validated.ok) {
        socket.emit('system:error', { message: validated.error });
        return;
      }
      // Rate-limiter already checks author; partnerOf does authorization.
      engine.chatMessage(socket, validated.value);
      logSocket(socket, 'chat:message', { len: validated.value.text.length });
    });

    socket.on('chat:typing', (payload) => {
      if (!signalRateLimiter.check(socket.id, 'chat:typing')) return;
      const validated = validateTyping(payload);
      if (!validated.ok) return;
      engine.chatTyping(socket, validated.value);
    });

    /* -------------------------------------------------------------- */
    /* Report / block (ephemeral, session-level)                      */
    /* -------------------------------------------------------------- */
    socket.on('report', (payload) => {
      if (!reportRateLimiter.check(socket.id, 'report')) {
        socket.emit('system:error', { message: 'Too many reports. Slow down.' });
        return;
      }
      const partnerId = engine.partnerOf(socket.id)?.session.socketId;
      if (!partnerId) {
        socket.emit('system:error', { message: 'No partner to report.' });
        return;
      }
      const validated = validateReport(payload);
      if (!validated.ok) {
        socket.emit('system:error', { message: validated.error });
        return;
      }
      const session = engine.sessions.get(socket.id);
      const entry = reportStore.add({
        reporter: socket.id,
        target: partnerId,
        reason: validated.value.reason,
        mode: session?.mode ?? 'unknown',
        at: Date.now(),
      });
      // Add target to this socket's block list (session-level).
      const socketBlocks = blocks.get(socket.id) ?? new Set();
      socketBlocks.add(partnerId);
      blocks.set(socket.id, socketBlocks);
      socket.emit('report:sent', { id: entry.at, reason: entry.reason });
      logSocket(socket, 'report', { reason: validated.value.reason, matchId: session?.matchId });
    });

    socket.on('block', () => {
      const partnerId = engine.partnerOf(socket.id)?.session.socketId;
      if (!partnerId) return;
      const socketBlocks = blocks.get(socket.id) ?? new Set();
      socketBlocks.add(partnerId);
      blocks.set(socket.id, socketBlocks);
      socket.emit('block:set');
      logSocket(socket, 'block');
    });

    /* -------------------------------------------------------------- */
    /* Disconnect                                                     */
    /* -------------------------------------------------------------- */
    socket.on('disconnect', (reason) => {
      logSocket(socket, 'disconnect', { reason });
      calls.endCallsFor(socket.id);
      engine.disconnect(socket);
      // Clean up this socket's block list.
      blocks.delete(socket.id);
    });
  });

  return { io, engine, calls };
}
