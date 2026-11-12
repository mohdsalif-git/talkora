/**
 * Ephemeral report store.
 *
 * Talkora persists no users and no conversations. Reports are kept in memory
 * for the lifetime of the process only: a counter per reason category plus the
 * most recent report metadata (socket ids, timestamp, mode). No PII, no
 * message content, no audio data is ever stored.
 */
export class ReportStore {
  constructor() {
    this.reports = []; // array of { at, reporter, target, reason, mode }
    this.reasonCounts = new Map(); // reason -> count
  }

  add({ reporter, target, reason, mode, at }) {
    const entry = { at, reporter: this.shortId(reporter), target: this.shortId(target), reason, mode };
    this.reports.push(entry);
    if (this.reports.length > 1000) this.reports.shift(); // bounded ring buffer
    const key = reason.toLowerCase().slice(0, 60);
    this.reasonCounts.set(key, (this.reasonCounts.get(key) || 0) + 1);
    return entry;
  }

  getStats() {
    return {
      totalReports: this.reports.length,
      reasonCounts: Object.fromEntries(this.reasonCounts),
      recent: this.reports.slice(-10),
    };
  }

  /** Shortened id for logging — never the raw socket id in logs or responses. */
  shortId(id) {
    if (!id) return '-';
    return id.slice(0, 6) + '…';
  }
}

export const reportStore = new ReportStore();
