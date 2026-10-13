// Token-bucket rate limiter.
export class RateLimiter {
  constructor({ capacity, refillPerSecond, intervalMs = 1000, now = Date.now }) {
    this.capacity = capacity;
    this.refillPerSecond = refillPerSecond;
    this.intervalMs = intervalMs;
    this.now = now;
    this.tokens = capacity;
    this.updated = now();
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

  /** Call `listener(available)` after every refill interval. */
  onRefill(listener) {
    throw new Error('onRefill is not implemented yet');
  }
}
