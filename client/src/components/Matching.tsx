import type { TalkoraState } from '../hooks/useTalkora';
import { Logo } from './Home';

export function Matching({ talkora }: { talkora: TalkoraState }) {
  const { mode, stats, cancelSearch } = talkora;

  return (
    <main className="screen screen--narrow screen--center">
      <Logo />

      <div className="radar" role="status" aria-live="polite">
        <span className="radar__ring" />
        <span className="radar__ring" />
        <span className="radar__ring" />
        <span className="radar__core" aria-hidden>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path
              d={
                mode === 'audio'
                  ? 'M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8'
                  : 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'
              }
            />
          </svg>
        </span>
      </div>

      <header className="step step--center">
        <h2 className="step__title">Finding someone{mode === 'audio' ? ' for an audio call' : ''}…</h2>
        <p className="step__caption">
          Searching the {mode === 'audio' ? 'audio' : 'text'} queue for the opposite gender.
          Hang tight — usually just a few seconds.
        </p>
      </header>

      <div className="queue-meta">
        <span>{stats ? `${stats.waiting} people waiting` : 'connecting…'}</span>
        <span className="queue-meta__sep">·</span>
        <span>{stats ? `${stats.online} online` : '—'}</span>
      </div>

      <button className="btn btn--ghost" onClick={cancelSearch}>
        Cancel search
      </button>
    </main>
  );
}
