const GENDERS = new Set(['male', 'female']);
const MODES = new Set(['text', 'audio']);
const SWEEP_INTERVAL_MS = 10_000;
const PAIR_COOLDOWN_MS = 30_000; // don't instantly re-pair the same two users after Next/leave
const MAX_MESSAGE_LENGTH = 1000;
/**
 * MatchmakingEngine
 * -----------------
 * In-memory, anonymous matchmaking:
 *  - Four temporary queues: {male|female} × {text|audio}
 *  - Only opposite genders, same communication mode, are paired
 *  - Pairing is atomic (runs synchronously inside one event-loop turn)
 *  - No persistence: users, queues and matches live and die with this process
 */
export class MatchmakingEngine {
  constructor(io) {
    this.io = io;
    this.sessions = new Map(); // socketId -> session
    this.matches = new Map(); // matchId  -> match
    this.queues = {
      'male:text': [],
      'female:text': [],
      'male:audio': [],
      'female:audio': [],
    };
    // "sortedIdA|sortedIdB" -> timestamp of last breakup (pair cooldown)
    this.recentPairs = new Map();
    // session-level blocks: socketId -> Set of blocked socketIds (set from outside)
    this.blocks = new Map();

    // Injected by src/index.js (may be no-ops when MongoDB is unavailable)
    this.incrementCounter = async () => {};
    this.getCounterValues = async () => ({ totalVisits: 0, totalConnections: 0 });

    // Periodic sweep for stale sockets / zombie matches
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    if (typeof this.sweepTimer.unref === 'function') this.sweepTimer.unref();
  }

  /** Inject the block map (owned by the socket layer). */
  setBlocks(blocks) {
    this.blocks = blocks;
  }

  /** True if a has blocked b (session-level, ephemeral). */
  isBlocked(a, b) {
    const set = this.blocks.get(a);
    return Boolean(set && set.has(b));
  }

  /* ------------------------------------------------------------------ */
  /* Session lifecycle                                                   */
  /* ------------------------------------------------------------------ */

  register(socket) {
    this.sessions.set(socket.id, {
      socketId: socket.id,
      socket,
      gender: null,
      mode: null,
      state: 'idle', // idle | queued | matched
      queueKey: null,
      matchId: null,
      joinedAt: null,
    });
  }

  join(socket, payload = {}) {
    const session = this.sessions.get(socket.id);
    if (!session) return;

    const { gender, mode } = payload;
    if (!GENDERS.has(gender) || !MODES.has(mode)) {
      socket.emit('system:error', { message: 'Invalid gender or mode.' });
      return;
    }

    // Duplicate-match prevention: never touch a session already in a match.
    if (session.state === 'matched') return;

    const queueKey = `${gender}:${mode}`;

    // Idempotent re-join of the same queue.
    if (session.state === 'queued' && session.queueKey === queueKey) {
      socket.emit('session:queued', { gender, mode });
      return;
    }
    if (session.state === 'queued') this.removeFromQueue(session);

    session.gender = gender;
    session.mode = mode;
    session.state = 'queued';
    session.queueKey = queueKey;
    session.joinedAt = Date.now();
    this.queues[queueKey].push(socket.id);

    socket.emit('session:queued', { gender, mode });
    this.broadcastStats();
    this.tryMatch(queueKey);
  }

  cancel(socket) {
    const session = this.sessions.get(socket.id);
    if (!session) return;
    if (session.state === 'queued') {
      this.removeFromQueue(session);
      session.state = 'idle';
      socket.emit('match:cancelled', {});
      this.broadcastStats();
    }
  }

  /** "Next": end the current match and requeue both sides. */
  next(socket) {
    const session = this.sessions.get(socket.id);
    if (!session || session.state !== 'matched') return;
    const match = this.matches.get(session.matchId);
    if (match) this.breakMatch(match, 'partner-next', { requeueBoth: true, initiator: socket.id });
  }

  /** "Leave": end the current match, requeue only the partner, leaver goes idle. */
  leave(socket) {
    const session = this.sessions.get(socket.id);
    if (!session || session.state !== 'matched') return;
    const match = this.matches.get(session.matchId);
    if (match) this.breakMatch(match, 'partner-left', { requeueSurvivor: true, gone: socket.id });
  }

  disconnect(socket) {
    const session = this.sessions.get(socket.id);
    if (!session) return;
    if (session.state === 'matched') {
      const match = this.matches.get(session.matchId);
      if (match) this.breakMatch(match, 'partner-left', { requeueSurvivor: true, gone: socket.id });
    } else if (session.state === 'queued') {
      this.removeFromQueue(session);
      this.broadcastStats();
    }
    this.sessions.delete(socket.id);
  }

  /* ------------------------------------------------------------------ */
  /* Relay (text relay works in both text and audio modes)               */
  /* ------------------------------------------------------------------ */

  chatMessage(socket, payload = {}) {
    const text = typeof payload.text === 'string' ? payload.text.trim().slice(0, MAX_MESSAGE_LENGTH) : '';
    if (!text) return;
    const partner = this.partnerOf(socket.id);
    if (!partner) return;
    partner.socket.emit('chat:message', { text, at: Date.now() });
  }

  chatTyping(socket, payload = {}) {
    const partner = this.partnerOf(socket.id);
    if (!partner) return;
    partner.socket.emit('chat:typing', { typing: Boolean(payload.typing) });
  }

  /* ------------------------------------------------------------------ */
  /* Matching core                                                       */
  /* ------------------------------------------------------------------ */

  tryMatch(queueKey) {
    const [gender, mode] = queueKey.split(':');
    const oppositeKey = `${gender === 'male' ? 'female' : 'male'}:${mode}`;
    const mine = this.queues[queueKey];
    const theirs = this.queues[oppositeKey];

    // Atomic: the whole pairing happens synchronously in one event-loop turn,
    // so two concurrent joins can never race into the same partner.
    // Scan for the first compatible pair; repeat until none is left.
    for (;;) {
      const aId = this.firstValid(mine);
      const bId = this.firstValidExcept(theirs, aId);
      if (!aId || !bId) {
        this.pruneQueue(mine);
        this.pruneQueue(theirs);
        break;
      }

      // Commit the pairing: remove both from their queues.
      this.removeId(mine, aId);
      this.removeId(theirs, bId);

      const a = this.sessions.get(aId);
      const b = this.sessions.get(bId);
      // Extra guards: state may have changed between queue push and now.
      if (!a || !b || a.state !== 'queued' || b.state !== 'queued') {
        if (a && a.state === 'queued') mine.unshift(aId);
        if (b && b.state === 'queued') theirs.unshift(bId);
        continue;
      }

      const matchId = `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      this.matches.set(matchId, { id: matchId, mode, users: [aId, bId], startedAt: Date.now() });
      for (const s of [a, b]) {
        s.state = 'matched';
        s.matchId = matchId;
      }

      // Both partners join a Socket.IO room scoped to this match. Signaling and
      // chat relay are only accepted from members of the room (room authorization).
      this.io.socketsJoin([`match_${matchId}`], [aId, bId]);

      this.io.to(aId).emit('match:found', { matchId, mode });
      this.io.to(bId).emit('match:found', { matchId, mode });

      this.incrementCounter('totalConnections').catch(() => {});
      this.broadcastStats();
    }
  }

  /** Peek the first queue entry whose session is still queued. */
  firstValid(queue) {
    for (const id of queue) {
      const s = this.sessions.get(id);
      if (s && s.state === 'queued' && s.socket && s.socket.connected) return id;
    }
    return null;
  }

  /** First queued candidate for whom pairing is allowed (skips pair-cooldown). */
  firstValidExcept(queue, skipId) {
    for (const id of queue) {
      if (id === skipId) continue;
      const s = this.sessions.get(id);
      if (!s || s.state !== 'queued' || !s.socket || !s.socket.connected) continue;
      if (skipId && this.pairOnCooldown(skipId, id)) continue;
      // Block-aware: never pair two sockets where either has blocked the other.
      if (this.isBlocked(skipId, id) || this.isBlocked(id, skipId)) continue;
      return id;
    }
    return null;
  }

  pruneQueue(queue) {
    for (let i = queue.length - 1; i >= 0; i -= 1) {
      const s = this.sessions.get(queue[i]);
      if (!s || s.state !== 'queued' || !s.socket || !s.socket.connected) queue.splice(i, 1);
    }
  }

  removeId(queue, id) {
    if (id == null) return;
    const index = queue.indexOf(id);
    if (index !== -1) queue.splice(index, 1);
  }

  pairOnCooldown(aId, bId) {
    const key = [aId, bId].sort().join('|');
    const last = this.recentPairs.get(key);
    if (!last) return false;
    if (Date.now() - last > PAIR_COOLDOWN_MS) {
      this.recentPairs.delete(key);
      return false;
    }
    return true;
  }

  removeFromQueue(session) {
    if (!session.queueKey) return;
    const queue = this.queues[session.queueKey];
    const index = queue.indexOf(session.socketId);
    if (index !== -1) queue.splice(index, 1);
    this.queues[session.queueKey] = queue.filter((id) => {
      const s = this.sessions.get(id);
      return s && s.state === 'queued';
    });
  }

  partnerOf(socketId) {
    const session = this.sessions.get(socketId);
    if (!session || session.state !== 'matched' || !session.matchId) return null;
    const match = this.matches.get(session.matchId);
    if (!match) return null;
    const otherId = match.users.find((id) => id !== socketId);
    if (!otherId) return null;
    const other = this.sessions.get(otherId);
    if (!other || !other.socket || !other.socket.connected) return null;
    return { session: other, socket: other.socket, match };
  }

  /**
   * Tear a match down.
   * opts.requeueBoth      — "Next": both sides return to the queue
   * opts.requeueSurvivor  — partner-left/leave: only the connected survivor requeues
   * opts.gone / opts.initiator — who caused the teardown (no match:ended spam)
   */
  breakMatch(match, reason, opts = {}) {
    if (!this.matches.has(match.id)) return;
    this.matches.delete(match.id);

    // Both partners leave the match-scoped Socket.IO room.
    for (const id of match.users) {
      this.io.socketsLeave([`match_${match.id}`], [id]);
    }

    // Cooldown so Next/leave doesn't instantly re-pair the same two people.
    this.recentPairs.set([...match.users].sort().join('|'), Date.now());

    for (const id of match.users) {
      const s = this.sessions.get(id);
      if (!s) continue;
      s.matchId = null;

      const connected = s.socket && s.socket.connected;
      const isActor = id === opts.gone || id === opts.initiator;
      const shouldRequeue = connected && (opts.requeueBoth || (opts.requeueSurvivor && !isActor));

      if (shouldRequeue) {
        if (!isActor || opts.requeueBoth) s.socket.emit('match:ended', { reason });
        s.state = 'queued';
        s.queueKey = `${s.gender}:${s.mode}`;
        s.joinedAt = Date.now();
        this.queues[s.queueKey].push(id);
        s.socket.emit('session:queued', { gender: s.gender, mode: s.mode });
      } else {
        s.state = 'idle';
        s.queueKey = null;
        if (connected && !isActor) s.socket.emit('match:ended', { reason });
      }
    }

    this.broadcastStats();

    // Requeued users might immediately have a new partner available.
    for (const key of Object.keys(this.queues)) this.tryMatch(key);
  }

  /* ------------------------------------------------------------------ */
  /* Stale socket cleanup                                                */
  /* ------------------------------------------------------------------ */

  sweep() {
    let dirty = false;

    // Stale queue entries (socket gone / state drifted)
    for (const key of Object.keys(this.queues)) {
      const kept = this.queues[key].filter((id) => {
        const s = this.sessions.get(id);
        const alive = s && s.state === 'queued' && s.socket && s.socket.connected;
        if (!alive) dirty = true;
        return alive;
      });
      this.queues[key] = kept;
    }

    // Zombie matches (either side vanished without a disconnect event)
    for (const match of [...this.matches.values()]) {
      const goneId = match.users.find((id) => {
        const s = this.sessions.get(id);
        return !s || !s.socket || !s.socket.connected;
      });
      if (goneId) {
        this.breakMatch(match, 'partner-left', { requeueSurvivor: true, gone: goneId });
        dirty = true;
      }
    }

    if (dirty) this.broadcastStats();
  }

  /* ------------------------------------------------------------------ */
  /* Live statistics                                                     */
  /* ------------------------------------------------------------------ */

  getLiveStats() {
    const waiting = Object.values(this.queues).reduce((n, q) => n + q.length, 0);
    return {
      online: this.io.engine.clientsCount,
      waiting,
      activeMatches: this.matches.size,
    };
  }

  async broadcastStats() {
    const stats = this.getLiveStats();
    try {
      Object.assign(stats, await this.getCounterValues());
    } catch {
      /* counters optional */
    }
    this.io.emit('stats:live', stats);
  }

  destroy() {
    clearInterval(this.sweepTimer);
  }
}
