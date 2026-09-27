/** Fixed-window in-memory rate limiter (per process). Keys are ids, never content. */
export class RateLimiter {
  private windowStart = 0;
  private counts = new Map<string, number>();

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns true if the call is allowed. */
  hit(key: string): boolean {
    const t = this.now();
    if (t - this.windowStart >= 60_000) {
      this.windowStart = t;
      this.counts.clear();
    }
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    return n <= this.perMinute;
  }
}
