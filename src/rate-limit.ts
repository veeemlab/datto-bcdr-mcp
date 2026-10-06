/**
 * Sliding-window limiter. Datto BCDR allows roughly 120 requests/minute per API key;
 * a fleet-wide scan (one /asset call per device) would hit 429s without this.
 * Callers are served in FIFO order.
 */
export class RateLimiter {
  private readonly timestamps: number[] = [];
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {}

  acquire(): Promise<void> {
    const slot = this.queue.then(() => this.waitForSlot());
    this.queue = slot.catch(() => undefined);
    return slot;
  }

  private async waitForSlot(): Promise<void> {
    for (;;) {
      const t = this.now();
      while (this.timestamps.length && this.timestamps[0] <= t - this.windowMs)
        this.timestamps.shift();
      if (this.timestamps.length < this.maxRequests) {
        this.timestamps.push(t);
        return;
      }
      await this.sleep(this.timestamps[0] + this.windowMs - t);
    }
  }
}
