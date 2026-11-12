/**
 * Per-socket rate limiting for Socket.IO events.
 *
 * Token-bucket tracker keyed by socket id. Prevents a single client from
 * flooding signaling, chat, or report events. Limits are deliberately tight
 * because Talkora is ephemeral 1-on-1 chat — legitimate traffic is low.
 */
export class RateLimiter {
  constructor({ maxPerWindow, windowMs }) {
    this.maxPerWindow = maxPerWindow;
    this.windowMs = windowMs;
    this.buckets = new Map(); // socketId -> { count, resetAt }
  }

  /** Returns true if the event is allowed, false if rate-limited. */
  check(socketId, event) {
    const now = Date.now();
    const key = `${socketId}:${event}`;
    let bucket = this.buckets.get(key);

    if (!bucket || now > bucket.resetAt) {
      bucket = { count: 0, resetAt: now + this.windowMs };
      this.buckets.set(key, bucket);
    }

    if (bucket.count >= this.maxPerWindow) return false;
    bucket.count += 1;
    return true;
  }

  /** Clean up expired buckets. Call periodically. */
  sweep() {
    const now = Date.now();
    for (const [key, bucket] of this.buckets.entries()) {
      if (now > bucket.resetAt) this.buckets.delete(key);
    }
  }
}

export const signalRateLimiter = new RateLimiter({
  maxPerWindow: 30, // 30 signaling events per window
  windowMs: 60_000, // per minute
});

export const chatRateLimiter = new RateLimiter({
  maxPerWindow: 20, // 20 chat messages per minute
  windowMs: 60_000,
});

export const reportRateLimiter = new RateLimiter({
  maxPerWindow: 5, // 5 reports per minute
  windowMs: 60_000,
});
