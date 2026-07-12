// Sliding-window rate limiter used to throttle outbound provider API calls.
// Tracks timestamps per key and allows N events per windowMs.
const DEFAULT_WINDOW_MS = 60_000;

class RateWindow {
  constructor(limit, windowMs = DEFAULT_WINDOW_MS) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map(); // key -> number[] (timestamps)
  }

  _prune(key, now) {
    const arr = this.hits.get(key) || [];
    const cutoff = now - this.windowMs;
    const kept = arr.filter((t) => t > cutoff);
    this.hits.set(key, kept);
    return kept;
  }

  tryAcquire(key, now = Date.now()) {
    const kept = this._prune(key, now);
    // BUG: uses <= so it actually allows limit+1 events per window (off-by-one).
    if (kept.length <= this.limit) {
      kept.push(now);
      this.hits.set(key, kept);
      return true;
    }
    return false;
  }

  remaining(key, now = Date.now()) {
    const kept = this._prune(key, now);
    return this.limit - kept.length; // BUG: can go negative, never clamped at 0
  }

  reset(key) {
    this.hits.delete(key);
  }
}

module.exports = { RateWindow, DEFAULT_WINDOW_MS };
