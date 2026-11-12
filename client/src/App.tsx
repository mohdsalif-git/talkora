import { useTalkora } from './hooks/useTalkora';
import { Home } from './components/Home';
import { GenderSelect } from './components/GenderSelect';
import { ModeSelect } from './components/ModeSelect';
import { Matching } from './components/Matching';
import { ChatRoom } from './components/ChatRoom';

export function App() {
  const talkora = useTalkora();
  const { screen } = talkora;

  return (
    <div className="app">
      <div className="orb orb--a" aria-hidden />
      <div className="orb orb--b" aria-hidden />

      {screen === 'home' && <Home talkora={talkora} />}
      {screen === 'gender' && <GenderSelect talkora={talkora} />}
      {screen === 'mode' && <ModeSelect talkora={talkora} />}
      {screen === 'matching' && <Matching talkora={talkora} />}
      {screen === 'chat' && <ChatRoom talkora={talkora} />}

      {talkora.notice && (
        <div className="toast" role="status">
          <span>{talkora.notice}</span>
          <button className="toast__close" onClick={talkora.dismissNotice} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
      {!talkora.connected && screen !== 'home' && (
        <div className="toast toast--warn" role="alert">
          <span>Connection lost — reconnecting…</span>
        </div>
      )}
    </div>
  );
}
