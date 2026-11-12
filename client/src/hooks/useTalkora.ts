import { useCallback, useEffect, useRef, useState } from 'react';
import { socket } from '../lib/socket';
import type { ChatMessage, Gender, LiveStats, Mode, Screen } from '../types';
import { WebRtcAudio } from '../lib/webrtc';

let messageSeq = 0;
const nextMessageId = () => `msg_${Date.now().toString(36)}_${(messageSeq += 1)}`;

export function useTalkora() {
  const [screen, setScreen] = useState<Screen>('home');
  const [gender, setGender] = useState<Gender | null>(null);
  const [mode, setMode] = useState<Mode | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [partnerTyping, setPartnerTyping] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [stats, setStats] = useState<LiveStats | null>(null);
  const [connected, setConnected] = useState(socket.connected);
  const chatModeRef = useRef<Mode>('text');
  const screenRef = useRef<Screen>('home');
  screenRef.current = screen;

  // WebRTC audio call state
  const webrtcRef = useRef<WebRtcAudio | null>(null);
  const [callState, setCallState] = useState<'idle' | 'connecting' | 'connected' | 'ended'>('idle');
  const [isMuted, setIsMuted] = useState(false);
  const [micPermission, setMicPermission] = useState<'not-asked' | 'granted' | 'denied'>('not-asked');
  const [iceConfig, setIceConfig] = useState<{ iceServers: RTCIceServer[]; hasTurn: boolean } | null>(null);
  const signalingSentRef = useRef<Set<string>>(new Set());
  const partnerBlockedRef = useRef(false);
  const pendingOffersRef = useRef<Map<string, { from: string; sdp: string }>>(new Map());

  // Use refs to always have fresh values inside async callbacks / socket handlers
  // without needing them as useEffect dependencies.
  const micPermissionRef = useRef<'not-asked' | 'granted' | 'denied'>('not-asked');
  const iceConfigRef = useRef<{ iceServers: RTCIceServer[]; hasTurn: boolean } | null>(null);
  const currentMatchIdRef = useRef<string | null>(null);

  // Keep refs in sync with state
  micPermissionRef.current = micPermission;
  iceConfigRef.current = iceConfig;

  // Fetch ICE/turn config — called at mount and before every audio call.
  const fetchIceConfig = useCallback(async () => {
    try {
      const SERVER_URL = (import.meta.env.VITE_SERVER_URL as string | undefined) ?? 'http://localhost:4000';
      const r = await fetch(`${SERVER_URL}/api/ice-config`);
      if (r.ok) {
        const cfg = await r.json();
        setIceConfig(cfg);
        iceConfigRef.current = cfg;
      }
    } catch {
      /* ICE config optional — STUN default is used */
    }
  }, []);

  useEffect(() => {
    fetchIceConfig();
  }, [fetchIceConfig]);

  // Helper: get or create a WebRtcAudio instance for a given matchId.
  // Always uses the latest iceConfig from the ref.
  const ensureAudioForMatch = useCallback(async (matchId: string): Promise<WebRtcAudio> => {
    await fetchIceConfig();
    if (!webrtcRef.current || webrtcRef.current.boundMatchId !== matchId) {
      webrtcRef.current?.dispose();
      webrtcRef.current = new WebRtcAudio({
        iceServers: iceConfigRef.current?.iceServers,
        onStateChange: (state) => setCallState(state),
        onRemoteStream: (stream) => {
          const el = document.getElementById('remote-audio');
          if (el instanceof HTMLAudioElement) {
            el.srcObject = stream;
            el.play().catch(() => {});
          }
        },
      });
      webrtcRef.current.boundMatchId = matchId;
    }
    return webrtcRef.current;
  }, [fetchIceConfig]);

  // Send all buffered ICE candidates and register an ongoing flush interval.
  // Returns a cleanup function that stops the interval.
  const startIceFlush = useCallback((matchId: string): (() => void) => {
    const flush = () => {
      const audio = webrtcRef.current;
      if (!audio || audio.boundMatchId !== matchId) return;
      audio.getIceCandidates().forEach((c) => {
        const key = JSON.stringify(c);
        if (!signalingSentRef.current.has(key)) {
          signalingSentRef.current.add(key);
          socket.emit('call:ice-candidate', { matchId, candidate: c });
        }
      });
      audio.clearIceCandidates();
    };
    flush();
    const timer = setInterval(flush, 500);
    const stop = setTimeout(() => {
      clearInterval(timer);
      flush();
    }, 6000);
    return () => { clearInterval(timer); clearTimeout(stop); };
  }, []);

  useEffect(() => {
    const onConnect = () => {
      setConnected(true);
      setNotice(null);
      const current = screenRef.current;
      if (gender && mode && current !== 'home' && current !== 'chat') {
        socket.emit('session:join', { gender, mode });
      }
    };
    const onDisconnect = () => setConnected(false);

    const onQueued = () => {
      setMessages([]);
      setPartnerTyping(false);
      setScreen('matching');
      webrtcRef.current?.dispose();
      webrtcRef.current = null;
      setCallState('idle');
      setIsMuted(false);
      // Reset mic state so the button re-appears on the next audio match.
      setMicPermission('not-asked');
      micPermissionRef.current = 'not-asked';
      currentMatchIdRef.current = null;
      pendingOffersRef.current.clear();
      signalingSentRef.current.clear();
    };

    const onMatchFound = async (payload: { matchId: string; mode: Mode }) => {
      await fetchIceConfig();
      chatModeRef.current = payload.mode;
      setMode(payload.mode);
      setMessages([]);
      setPartnerTyping(false);
      setNotice(null);
      setScreen('chat');
      setCallState('idle');
      partnerBlockedRef.current = false;
      currentMatchIdRef.current = payload.matchId;
      pendingOffersRef.current.clear();
      signalingSentRef.current.clear();

      if (payload.mode === 'audio') {
        // Always reset mic state on a new match so the Allow button is visible.
        setMicPermission('not-asked');
        micPermissionRef.current = 'not-asked';
        // Pre-create the WebRtcAudio instance with its matchId bound,
        // so enableMicrophone can find it immediately.
        const audio = new WebRtcAudio({
          iceServers: iceConfigRef.current?.iceServers,
          onStateChange: (state) => setCallState(state),
          onRemoteStream: (stream) => {
            const el = document.getElementById('remote-audio');
            if (el instanceof HTMLAudioElement) {
              el.srcObject = stream;
              el.play().catch(() => {});
            }
          },
        });
        audio.boundMatchId = payload.matchId;
        webrtcRef.current = audio;
      }
    };

    const onMatchEnded = (payload: { reason: string }) => {
      setPartnerTyping(false);
      setNotice(
        payload.reason === 'partner-next'
          ? 'Your partner moved on to someone new.'
          : 'Your partner left the chat.',
      );
      webrtcRef.current?.dispose();
      webrtcRef.current = null;
      setCallState('idle');
      setIsMuted(false);
      currentMatchIdRef.current = null;
    };

    const onCancelled = () => setNotice(null);

    const onChatMessage = (payload: { text: string; at: number }) => {
      setMessages((prev) => [
        ...prev,
        { id: nextMessageId(), text: payload.text, at: payload.at, mine: false },
      ]);
      setPartnerTyping(false);
    };
    const onTyping = (payload: { typing: boolean }) => setPartnerTyping(payload.typing);
    const onStats = (payload: LiveStats) => setStats(payload);
    const onSystemError = (payload: { message: string }) => setNotice(payload.message);

    /* WebRTC signaling handlers */

    // Answerer path: remote peer sent us an offer.
    const onCallOffer = async (payload: { from: string; sdp: string; matchId: string }) => {
      // Buffer the offer — we might not have mic access yet.
      pendingOffersRef.current.set(payload.matchId, { from: payload.from, sdp: payload.sdp });

      // If mic is already granted, answer immediately.
      if (micPermissionRef.current !== 'granted') return;

      const audio = await ensureAudioForMatch(payload.matchId);
      pendingOffersRef.current.delete(payload.matchId);
      try {
        const answer = await audio.handleOffer(payload.sdp);
        socket.emit('call:answer', { matchId: payload.matchId, sdp: answer });
        signalingSentRef.current.clear();
        startIceFlush(payload.matchId);
        setCallState('connecting');
      } catch (err) {
        console.error('WebRTC answer failed', err);
        setNotice('Unable to start audio call. Text chat still works.');
      }
    };

    // Offerer path: remote peer accepted our offer.
    const onCallAnswer = (payload: { from: string; sdp: string; matchId: string }) => {
      const audio = webrtcRef.current;
      if (!audio) return;
      (async () => {
        try {
          await audio.handleAnswer(payload.sdp);
          signalingSentRef.current.clear();
          startIceFlush(payload.matchId);
          setCallState('connecting');
        } catch (err) {
          console.error('WebRTC answer apply failed', err);
        }
      })();
    };

    const onCallIceCandidate = (payload: {
      from: string;
      candidate: RTCIceCandidateInit | null;
      matchId: string;
    }) => {
      const audio = webrtcRef.current;
      if (!audio) return;
      audio.addIceCandidate(payload.candidate);
    };

    const onCallEnded = (payload: { reason: string; matchId: string }) => {
      webrtcRef.current?.dispose();
      webrtcRef.current = null;
      setCallState('idle');
      setIsMuted(false);
      setNotice(payload.reason === 'partner-ended' ? 'Call ended by your partner.' : 'Call ended.');
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('session:queued', onQueued);
    socket.on('match:found', onMatchFound);
    socket.on('match:ended', onMatchEnded);
    socket.on('match:cancelled', onCancelled);
    socket.on('chat:message', onChatMessage);
    socket.on('chat:typing', onTyping);
    socket.on('stats:live', onStats);
    socket.on('system:error', onSystemError);
    socket.on('call:offer', onCallOffer);
    socket.on('call:answer', onCallAnswer);
    socket.on('call:ice-candidate', onCallIceCandidate);
    socket.on('call:ended', onCallEnded);

    socket.connect();

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('session:queued', onQueued);
      socket.off('match:found', onMatchFound);
      socket.off('match:ended', onMatchEnded);
      socket.off('match:cancelled', onCancelled);
      socket.off('chat:message', onChatMessage);
      socket.off('chat:typing', onTyping);
      socket.off('stats:live', onStats);
      socket.off('system:error', onSystemError);
      socket.off('call:offer', onCallOffer);
      socket.off('call:answer', onCallAnswer);
      socket.off('call:ice-candidate', onCallIceCandidate);
      socket.off('call:ended', onCallEnded);
    };
    // Note: micPermission intentionally NOT in deps — handlers read micPermissionRef.current instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gender, mode]);

  /* ------------------------------- actions ------------------------------- */

  const start = useCallback(() => setScreen('gender'), []);
  const backToHome = useCallback(() => setScreen('home'), []);

  const chooseGender = useCallback((g: Gender) => {
    setGender(g);
    setScreen('mode');
  }, []);

  const chooseMode = useCallback(
    (m: Mode) => {
      setMode(m);
      if (gender) socket.emit('session:join', { gender, mode: m });
    },
    [gender],
  );

  const cancelSearch = useCallback(() => {
    socket.emit('match:cancel');
    setNotice(null);
    setScreen('mode');
  }, []);

  const nextPartner = useCallback(() => socket.emit('match:next'), []);

  const leaveChat = useCallback(() => {
    socket.emit('match:leave');
    setMessages([]);
    setPartnerTyping(false);
    setNotice(null);
    setScreen('home');
    webrtcRef.current?.dispose();
    webrtcRef.current = null;
    setCallState('idle');
    setIsMuted(false);
    setMicPermission('not-asked');
    micPermissionRef.current = 'not-asked';
    currentMatchIdRef.current = null;
    pendingOffersRef.current.clear();
    signalingSentRef.current.clear();
  }, []);

  /**
   * Called when the user clicks "Allow microphone".
   * 1. Requests mic access via getUserMedia (must be a user gesture).
   * 2. If we have a pending offer → answer it (answerer path).
   * 3. If no pending offer → send our own offer (offerer path).
   */
  const enableMicrophone = useCallback(async () => {
    if (micPermissionRef.current === 'granted') return;

    const matchId = currentMatchIdRef.current ?? webrtcRef.current?.boundMatchId;
    if (!matchId) {
      setNotice('Not in a match yet. Please wait for a partner.');
      return;
    }

    try {
      const audio = await ensureAudioForMatch(matchId);
      await audio.requestMicrophone();

      // Update both state and ref synchronously.
      setMicPermission('granted');
      micPermissionRef.current = 'granted';

      const pending = pendingOffersRef.current.get(matchId);

      if (pending) {
        // Answerer path: partner sent offer before we had mic access.
        pendingOffersRef.current.delete(matchId);
        const answer = await audio.handleOffer(pending.sdp);
        socket.emit('call:answer', { matchId, sdp: answer });
        signalingSentRef.current.clear();
        startIceFlush(matchId);
        setCallState('connecting');
      } else {
        // Offerer path: we got mic first, now initiate the call.
        setCallState('connecting');
        const sdp = await audio.prepareOffer();
        socket.emit('call:offer', { matchId, sdp });
        signalingSentRef.current.clear();
        startIceFlush(matchId);
      }
    } catch (err) {
      setMicPermission('denied');
      micPermissionRef.current = 'denied';
      setNotice(
        err instanceof Error ? `Microphone access denied: ${err.message}` : 'Microphone access denied.',
      );
    }
  }, [ensureAudioForMatch, startIceFlush]);

  const toggleMute = useCallback(() => {
    webrtcRef.current?.setMuted(!isMuted);
    setIsMuted((prev) => !prev);
  }, [isMuted]);

  const sendMessage = useCallback((text: string) => {
    socket.emit('chat:message', { text });
    setMessages((prev) => [...prev, { id: nextMessageId(), text, at: Date.now(), mine: true }]);
  }, []);

  const sendTyping = useCallback((typing: boolean) => {
    socket.emit('chat:typing', { typing });
  }, []);

  const dismissNotice = useCallback(() => setNotice(null), []);

  const sendReport = useCallback((reason: string) => {
    socket.emit('report', { reason });
  }, []);

  const sendBlock = useCallback(() => {
    socket.emit('block');
  }, []);

  /**
   * @deprecated – mic permission now handles initiating the offer automatically.
   * Kept for compatibility in case it is called from outside.
   */
  const initiateAudioCall = useCallback(async (matchId: string) => {
    if (micPermissionRef.current !== 'granted') {
      setNotice('Please allow microphone access first.');
      return;
    }
    try {
      const audio = await ensureAudioForMatch(matchId);
      setCallState('connecting');
      const sdp = await audio.prepareOffer();
      socket.emit('call:offer', { matchId, sdp });
      signalingSentRef.current.clear();
      startIceFlush(matchId);
    } catch (err) {
      console.error('WebRTC offer failed', err);
      setCallState('idle');
      setNotice('Unable to start audio call. Text chat still works.');
    }
  }, [ensureAudioForMatch, startIceFlush]);

  return {
    screen,
    gender,
    mode,
    chatMode: chatModeRef.current,
    messages,
    partnerTyping,
    notice,
    stats,
    connected,
    callState,
    isMuted,
    micPermission,
    iceConfig,
    start,
    backToHome,
    chooseGender,
    chooseMode,
    cancelSearch,
    nextPartner,
    leaveChat,
    sendMessage,
    sendTyping,
    dismissNotice,
    enableMicrophone,
    toggleMute,
    sendReport,
    sendBlock,
    initiateAudioCall,
  };
}

export type TalkoraState = ReturnType<typeof useTalkora>;
