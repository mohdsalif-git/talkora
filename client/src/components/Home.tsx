import type { TalkoraState } from '../hooks/useTalkora';

export function Logo() {
  return (
    <div className="logo">
      <span className="logo__mark" aria-hidden>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
        </svg>
      </span>
      <span className="logo__word">Talkora</span>
    </div>
  );
}

export function Home({ talkora }: { talkora: TalkoraState }) {
  const { stats, start, connected } = talkora;

  return (
    <main className="screen screen--home">
      <Logo />

      <section className="hero">
        <p className="hero__eyebrow">Random · Anonymous · Ephemeral</p>
        <h1 className="hero__title">
          Talk to someone new.
          <br />
          <span className="hero__title-accent">Right now.</span>
        </h1>
        <p className="hero__subtitle">
          One tap, one stranger, one conversation. No accounts, no profiles,
          no history — nothing you say here is ever stored.
        </p>

        <button className="btn btn--primary btn--xl" onClick={start} disabled={!connected}>
          {connected ? 'Start a conversation' : 'Connecting…'}
        </button>

        <ul className="chips" aria-label="How it works">
          <li className="chip">
            <span className="chip__dot" /> Matched with the opposite gender
          </li>
          <li className="chip">
            <span className="chip__dot" /> Text or audio — your choice
          </li>
          <li className="chip">
            <span className="chip__dot" /> Nothing is saved. Ever.
          </li>
        </ul>
      </section>

      {stats && (
        <footer className="stats" aria-label="Live statistics">
          <div className="stat">
            <span className="stat__value">{stats.online}</span>
            <span className="stat__label">online now</span>
          </div>
          <div className="stat">
            <span className="stat__value">{stats.waiting}</span>
            <span className="stat__label">waiting to talk</span>
          </div>
          <div className="stat">
            <span className="stat__value">{formatCount(stats.totalConnections)}</span>
            <span className="stat__label">connections made</span>
          </div>
          <div className="stat">
            <span className="stat__value">{formatCount(stats.totalVisits)}</span>
            <span className="stat__label">visits</span>
          </div>
        </footer>
      )}
    </main>
  );
}

function formatCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
