import type { TalkoraState } from '../hooks/useTalkora';
import type { Mode } from '../types';
import { Logo } from './Home';

const OPTIONS: Array<{ value: Mode; title: string; caption: string; icon: string }> = [
  {
    value: 'text',
    title: 'Text chat',
    caption: 'Classic typed conversation, with live typing indicators.',
    icon: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  },
  {
    value: 'audio',
    title: 'Audio call',
    caption: 'Talk out loud. Hands free, no camera, no video.',
    icon: 'M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8',
  },
];

export function ModeSelect({ talkora }: { talkora: TalkoraState }) {
  const { gender, chooseMode, start } = talkora;

  return (
    <main className="screen screen--narrow">
      <Logo />
      <header className="step">
        <p className="step__eyebrow">Step 2 of 2</p>
        <h2 className="step__title">How do you want to talk?</h2>
        <p className="step__caption">
          You'll be matched with someone of the opposite gender using the same mode.
        </p>
      </header>

      <div className="cards cards--two">
        {OPTIONS.map((option) => (
          <button key={option.value} className="card card--select" onClick={() => chooseMode(option.value)}>
            <span className="card__icon" aria-hidden>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d={option.icon} />
              </svg>
            </span>
            <span className="card__title">{option.title}</span>
            <span className="card__caption">{option.caption}</span>
          </button>
        ))}
      </div>

      <button className="back-link" onClick={start}>
        ← Change gender{gender ? ` (${gender})` : ''}
      </button>
    </main>
  );
}
