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

  // WebRTC audio call state (Phase 3)
  const webrtcRef = useRef<WebRtcAudio | null>(null);
  const [callState, setCallState] = useState<'idle' | 'connecting' | 'connected' | 'ended'>('idle');
  const [isMuted, setIsMuted] = useState(false);
  const [micPermission, setMicPermission] = useState<'not-asked' | 'granted' | 'denied'>('not-asked');
  const [iceConfig, setIceConfig] = useState<{ iceServers: RTCIceServer[]; hasTurn: boolean } | null>(null);
  const signalingSentRef = useRef<Set<string>>(new Set()); // dedupe ICE candidate sends
  const partnerBlockedRef = useRef(false);
  const pendingOffersRef = useRef<Map<string, { from: string; sdp: string }>>(new Map());

  // Fetch ICE/turn config (metadata only, no credentials over the wire).
  // Called at mount as an optimization, and again per audio call so rotated
  // TURN credentials are picked up without reloading the page.
  const fetchIceConfig = useCallback(async () => {
    try {
      const r = await fetch('/api/ice-config');
      if (r.ok) {
        const cfg = await r.json();
        setIceConfig(cfg);
      }
    } catch {
      /* ICE config optional — STUN default is used */
    }
  }, []);

  useEffect(() => {
    fetchIceConfig();
  }, [fetchIceConfig]);

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
      setCallState('idle');
      setIsMuted(false);
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
      // Audio matches need mic consent before establishing.
      if (payload.mode === 'audio') {
        webrtcRef.current = new WebRtcAudio({
          iceServers: iceConfig?.iceServers,
          onStateChange: (state) => setCallState(state),
          onRemoteStream: (stream) => {
            const el = document.getElementById('remote-audio');
            if (el instanceof HTMLAudioElement) el.srcObject = stream;
          },
        });
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
      setCallState('idle');
      setIsMuted(false);
      // Don't reset screen here — match:ended arrives before session:queued on requeue.
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
    const onCallOffer = async (payload: { from: string; sdp: string; matchId: string }) => {
      pendingOffersRef.current.set(payload.matchId, { from: payload.from, sdp: payload.sdp });
      const audio = await ensureAudioForMatch(payload.matchId);
      if (micPermission !== 'granted') {
        // Waiting for explicit mic consent before answering.
        return;
      }
      (async () => {
        try {
          const answer = await audio.handleOffer(payload.sdp);
          socket.emit('call:answer', { matchId: payload.matchId, sdp: answer });
          signalingSentRef.current.clear();
          audio.getIceCandidates().forEach((c) => {
            socket.emit('call:ice-candidate', { matchId: payload.matchId, candidate: c });
          });
          audio.clearIceCandidates();
          setCallState('connecting');
          pendingOffersRef.current.delete(payload.matchId);
        } catch (err) {
          console.error('WebRTC answer failed', err);
          setNotice('Unable to start audio call. Text chat still works.');
        }
      })();
    };
    const onCallAnswer = (payload: { from: string; sdp: string; matchId: string }) => {
      const audio = webrtcRef.current;
      if (!audio) return;
      (async () => {
        try {
          await audio.handleAnswer(payload.sdp);
          signalingSentRef.current.clear();
          audio.getIceCandidates().forEach((c) => {
            socket.emit('call:ice-candidate', { matchId: payload.matchId, candidate: c });
          });
          audio.clearIceCandidates();
          setCallState('connecting');
        } catch (err) {
          console.error('WebRTC answer apply failed', err);
        }
      })();
    };
    const onCallIceCandidate = (payload: { from: string; candidate: RTCIceCandidateInit | null; matchId: string }) => {
      const audio = webrtcRef.current;
      if (!audio) return;
      audio.addIceCandidate(payload.candidate);
    };
    const onCallEnded = (payload: { reason: string; matchId: string }) => {
      webrtcRef.current?.dispose();
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gender, mode, micPermission]);

  const ensureAudioForMatch = async (matchId: string): Promise<WebRtcAudio> => {
    await fetchIceConfig();
    if (!webrtcRef.current || webrtcRef.current.boundMatchId !== matchId) {
      webrtcRef.current = new WebRtcAudio({
        iceServers: iceConfig?.iceServers,
        onStateChange: (state) => setCallState(state),
        onRemoteStream: (stream) => {
          const el = document.getElementById('remote-audio');
          if (el instanceof HTMLAudioElement) el.srcObject = stream;
        },
      });
      webrtcRef.current.boundMatchId = matchId;
    }
    return webrtcRef.current;
  };

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
    setCallState('idle');
    setIsMuted(false);
  }, []);

  /** Explicit mic consent — user gesture triggers getUserMedia. */
  const enableMicrophone = useCallback(async () => {
    if (micPermission === 'granted') return;
    try {
      const matchId = webrtcRef.current?.boundMatchId;
      if (!matchId) return;
      const audio = await ensureAudioForMatch(matchId);
      await audio.requestMicrophone();
      setMicPermission('granted');
      // Process any offer that arrived before mic consent.
      const pending = matchId ? pendingOffersRef.current.get(matchId) : null;
      if (pending) {
        pendingOffersRef.current.delete(matchId);
        try {
          const answer = await audio.handleOffer(pending.sdp);
          socket.emit('call:answer', { matchId, sdp: answer });
          signalingSentRef.current.clear();
          const pendingMatchId = matchId!;
          audio.getIceCandidates().forEach((c) => {
            socket.emit('call:ice-candidate', { matchId: pendingMatchId, candidate: c });
          });
          audio.clearIceCandidates();
          setCallState('connecting');
        } catch (err) {
          console.error('WebRTC answer failed', err);
          setNotice('Unable to start audio call. Text chat still works.');
        }
      } else if (screen === 'chat' && chatModeRef.current === 'audio') {
        setCallState('connecting');
      }
    } catch (err) {
      setMicPermission('denied');
      setNotice(
        err instanceof Error ? `Microphone access denied: ${err.message}` : 'Microphone access denied.',
      );
    }
  }, [micPermission, callState, screen]);

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

  /** Offerer side: create and send the WebRTC offer, then stream ICE candidates. */
  const initiateAudioCall = useCallback(async (matchId: string) => {
    const audio = await ensureAudioForMatch(matchId);
    webrtcRef.current = audio;
    if (micPermission !== 'granted') {
      setNotice('Please allow microphone access to start an audio call.');
      return;
    }
    try {
      setCallState('connecting');
      const sdp = await audio.prepareOffer();
      socket.emit('call:offer', { matchId, sdp });
      // Send ICE candidates as they gather (and any late ones).
      const sendCandidates = () => {
        const cands = audio.getIceCandidates();
        cands.forEach((c) => {
          const key = JSON.stringify(c);
          if (!signalingSentRef.current.has(key)) {
            signalingSentRef.current.add(key);
            socket.emit('call:ice-candidate', { matchId, candidate: c });
          }
        });
        audio.clearIceCandidates();
      };
      // Poll briefly for gathering completion; clients also send on icegatheringstatechange via WebRtcAudio.
      const timer = setInterval(sendCandidates, 500);
      setTimeout(() => {
        clearInterval(timer);
        sendCandidates();
      }, 5000);
    } catch (err) {
      console.error('WebRTC offer failed', err);
      setCallState('idle');
      setNotice('Unable to start audio call. Text chat still works.');
    }
  }, [micPermission]);

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
