// Token-bucket rate limiter.
export class RateLimiter {
  constructor({ capacity, refillPerSecond, intervalMs = 1000, now = Date.now }) {
    this.capacity = capacity;
    this.refillPerSecond = refillPerSecond;
    this.intervalMs = intervalMs;
    this.now = now;
    this.tokens = capacity;
    this.updated = now();
    this.listeners = new Set();
    this.timer = undefined;
  }

  tryRemove(count = 1) {
    this.refill();
    if (this.tokens < count) return false;
    this.tokens -= count;
    return true;
  }

  get available() {
    this.refill();
    return Math.floor(this.tokens);
  }

  refill() {
    const time = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((time - this.updated) / 1000) * this.refillPerSecond);
    this.updated = time;
  }

  /** Call `listener(available)` after every refill interval. Returns an unsubscribe function. */
  onRefill(listener) {
    this.listeners.add(listener);
    if (!this.timer) {
      this.timer = setInterval(() => { for (const each of this.listeners) each(this.available); }, this.intervalMs);
      // A background refill timer must not keep the process alive on its own.
      this.timer.unref();
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) { clearInterval(this.timer); this.timer = undefined; }
    };
  }
}
