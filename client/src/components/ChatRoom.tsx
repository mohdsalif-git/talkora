import { useEffect, useRef, useState } from 'react';
import type { TalkoraState } from '../hooks/useTalkora';
import type { Mode } from '../types';

const TYPING_IDLE_MS = 1200;

export function ChatRoom({ talkora }: { talkora: TalkoraState }) {
  const mode: Mode = talkora.mode ?? 'text';
  if (mode === 'audio') return <AudioRoom talkora={talkora} />;
  return <TextRoom talkora={talkora} />;
}

/* ---------------------------------------------------------------------- */
/* Shared pieces                                                           */
/* ---------------------------------------------------------------------- */

function MessageList({ talkora }: { talkora: TalkoraState }) {
  const { messages, partnerTyping } = talkora;
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, partnerTyping]);

  return (
    <div className="messages" aria-live="polite">
      {messages.length === 0 && <p className="messages__empty">You're connected. Say hi 👋</p>}
      {messages.map((message) => (
        <div key={message.id} className={`bubble ${message.mine ? 'bubble--mine' : 'bubble--theirs'}`}>
          {message.text}
        </div>
      ))}
      {partnerTyping && (
        <div className="bubble bubble--theirs bubble--typing" aria-label="Partner is typing">
          <span className="dot" />
          <span className="dot" />
          <span className="dot" />
        </div>
      )}
      <div ref={endRef} />
    </div>
  );
}

function Composer({ talkora }: { talkora: TalkoraState }) {
  const { sendMessage, sendTyping } = talkora;
  const [draft, setDraft] = useState('');
  const typingRef = useRef(false);
  const idleTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(idleTimer.current), []);

  const handleChange = (value: string) => {
    setDraft(value);
    if (value && !typingRef.current) {
      typingRef.current = true;
      sendTyping(true);
    }
    window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => {
      if (typingRef.current) {
        typingRef.current = false;
        sendTyping(false);
      }
    }, TYPING_IDLE_MS);
  };

  const handleSend = () => {
    const text = draft.trim();
    if (!text) return;
    window.clearTimeout(idleTimer.current);
    if (typingRef.current) {
      typingRef.current = false;
      sendTyping(false);
    }
    sendMessage(text);
    setDraft('');
  };

  return (
    <div className="composer">
      <input
        className="composer__input"
        value={draft}
        onChange={(event) => handleChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            handleSend();
          }
        }}
        placeholder="Type a message…"
        maxLength={1000}
        autoFocus
      />
      <button className="btn btn--primary composer__send" onClick={handleSend} disabled={!draft.trim()}>
        Send
      </button>
    </div>
  );
}

function ChatActions({ talkora }: { talkora: TalkoraState }) {
  const { nextPartner, leaveChat, sendReport, sendBlock } = talkora;
  return (
    <div className="chat-actions">
      <button className="btn btn--secondary" onClick={nextPartner}>
        Next →
      </button>
      <button className="btn btn--danger" onClick={() => sendReport('inappropriate behavior')}>
        ⚑ Report
      </button>
      <button className="btn btn--ghost" onClick={sendBlock}>
        🚫 Block
      </button>
      <button className="btn btn--ghost" onClick={leaveChat}>
        Leave
      </button>
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Text layout                                                             */
/* ---------------------------------------------------------------------- */

function TextRoom({ talkora }: { talkora: TalkoraState }) {
  return (
    <main className="chat chat--text">
      <header className="chat__header">
        <div className="chat__identity">
          <span className="chat__avatar" aria-hidden>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </span>
          <div>
            <span className="chat__name">Stranger</span>
            <span className="chat__status chat__status--online">Text chat · connected</span>
          </div>
        </div>
        <ChatActions talkora={talkora} />
      </header>

      <MessageList talkora={talkora} />
      <Composer talkora={talkora} />
    </main>
  );
}

/* ---------------------------------------------------------------------- */
/* Audio layout (WebRTC microphone call)                                  */
/* ---------------------------------------------------------------------- */

function AudioRoom({ talkora }: { talkora: TalkoraState }) {
  const {
    callState,
    isMuted,
    micPermission,
    enableMicrophone,
    toggleMute,
    iceConfig,
    connected,
  } = talkora;

  const remoteAudioRef = useRef<HTMLAudioElement>(null);

  // Re-attempt autoplay whenever callState changes to 'connecting' or 'connected'
  // (srcObject may have been assigned after the element mounted).
  useEffect(() => {
    const el = remoteAudioRef.current;
    if (el && el.srcObject) {
      el.play().catch(() => {});
    }
  }, [callState]);

  const handleEnableMic = async () => {
    await enableMicrophone();
  };

  return (
    <main className="chat chat--audio">
      <header className="chat__header">
        <div className="chat__identity">
          <span className="chat__avatar" aria-hidden>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8" />
            </svg>
          </span>
          <div>
            <span className="chat__name">Stranger</span>
            <span className="chat__status chat__status--online">
              {callState === 'connected' ? 'Audio call · live' : 'Audio call · connecting…'}
            </span>
          </div>
        </div>
        <div className="call-controls">
          {micPermission === 'not-asked' && (
            <button className="btn btn--primary" onClick={handleEnableMic}>
              Allow microphone
            </button>
          )}
          {micPermission === 'granted' && (
            <>
              <button className="control control--active" onClick={toggleMute} title={isMuted ? 'Unmute' : 'Mute'}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  {isMuted ? (
                    <path d="M11 3l4 9v2c6 2 6 6 0 8v2l-4-9" />
                  ) : (
                    <>
                      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                      <path d="M12 19v4M8 23h8" />
                    </>
                  )}
                </svg>
                <span>{isMuted ? 'Unmute' : 'Mute'}</span>
              </button>
              <span className="call-status">{callState === 'connected' ? '🔊 Live' : callState === 'connecting' ? 'Connecting…' : '—'}</span>
            </>
          )}
          {micPermission === 'denied' && (
            <span className="call-status call-status--warn">Microphone access denied — text chat available</span>
          )}
        </div>
        <ChatActions talkora={talkora} />
      </header>

      <section className="stage">
        <audio id="remote-audio" autoPlay playsInline ref={remoteAudioRef} />
        <div className="stage__avatar">
          <span className={['stage__pulse', callState === 'connected' ? 'stage__pulse--live' : ''].join(' ')} />
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8" />
          </svg>
        </div>
        <p className="stage__title">
          {callState === 'connected' ? 'Audio call live' : 'Establishing audio…'}
        </p>
        <p className="stage__caption">
          Peer-to-peer audio (WebRTC). Nothing is recorded or stored.
          {iceConfig?.hasTurn ? 'Relay available.' : 'Direct / STUN path.'}
        </p>
        {!connected && (
          <p className="stage__caption stage__caption--warn">Signaling connection lost — audio may drop.</p>
        )}
      </section>

      <MessageList talkora={talkora} />
      <Composer talkora={talkora} />
    </main>
  );
}
