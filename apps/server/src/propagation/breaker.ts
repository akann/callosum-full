// Per-downstream circuit breaker. While a system is down the worker stops sending to it
// (tasks stay queued in Postgres) and probes with a single task until one call succeeds.
export interface BreakerOptions {
  /** Consecutive transient failures before opening. */
  threshold: number;
  /** First open period; doubles on each failed probe up to maxCooldownMs. */
  cooldownMs: number;
  maxCooldownMs: number;
}

export class Breaker {
  private failures = 0;
  private openUntil = 0;
  private currentCooldown: number;
  private probing = false;

  constructor(
    private readonly opts: BreakerOptions,
    private readonly now: () => number = Date.now,
  ) {
    this.currentCooldown = opts.cooldownMs;
  }

  get state(): 'closed' | 'open' | 'half-open' {
    if (this.failures < this.opts.threshold) return 'closed';
    return this.now() < this.openUntil ? 'open' : 'half-open';
  }

  /** How many new calls may start right now, given `free` worker slots. */
  allowance(free: number): number {
    const s = this.state;
    if (s === 'closed') return free;
    if (s === 'open' || this.probing) return 0;
    return Math.min(1, free);
  }

  /** Call when a task is started under a half-open breaker. */
  started(): void {
    if (this.state === 'half-open') this.probing = true;
  }

  success(): void {
    this.failures = 0;
    this.probing = false;
    this.currentCooldown = this.opts.cooldownMs;
  }

  failure(): void {
    const wasProbe = this.probing;
    this.probing = false;
    this.failures += 1;
    if (this.failures >= this.opts.threshold) {
      if (wasProbe) this.currentCooldown = Math.min(this.opts.maxCooldownMs, this.currentCooldown * 2);
      this.openUntil = this.now() + this.currentCooldown;
    }
  }
}
