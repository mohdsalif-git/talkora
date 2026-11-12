import type { TalkoraState } from '../hooks/useTalkora';
import type { Gender } from '../types';
import { Logo } from './Home';

const OPTIONS: Array<{ value: Gender; title: string; caption: string; icon: string }> = [
  {
    value: 'male',
    title: 'Male',
    caption: "I'd like to talk with a female",
    icon: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  },
  {
    value: 'female',
    title: 'Female',
    caption: "I'd like to talk with a male",
    icon: 'M12 3a6 6 0 1 0 0 12 6 6 0 0 0 0-12zM12 15v6M9 18h6',
  },
];

export function GenderSelect({ talkora }: { talkora: TalkoraState }) {
  const { chooseGender, backToHome } = talkora;

  return (
    <main className="screen screen--narrow">
      <Logo />
      <header className="step">
        <p className="step__eyebrow">Step 1 of 2</p>
        <h2 className="step__title">I am a…</h2>
        <p className="step__caption">You'll be matched with the opposite gender. Nothing about you is recorded.</p>
      </header>

      <div className="cards cards--two">
        {OPTIONS.map((option) => (
          <button key={option.value} className="card card--select" onClick={() => chooseGender(option.value)}>
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

      <button className="back-link" onClick={backToHome}>
        ← Back
      </button>
    </main>
  );
}
