export interface BackoffOptions {
  baseMs: number;
  capMs: number;
}

/** Exponential backoff with +/-25% jitter. `attempt` is 1 for the first retry. */
export function backoffMs(attempt: number, opts: BackoffOptions, random: () => number = Math.random): number {
  const exp = Math.min(opts.capMs, opts.baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp * (0.75 + random() * 0.5));
}
