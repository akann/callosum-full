// Shared helpers for the downstream mocks: latency distributions, time scaling, admin routes.
import type { FastifyInstance } from 'fastify';

/** Standard normal sample (Box-Muller). */
function gaussian(): number {
  const u = 1 - Math.random();
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const Z99 = 2.3263478740408408;

/** Sampler for a lognormal distribution pinned to a given p50 and p99 (milliseconds). */
export function lognormal(p50Ms: number, p99Ms: number): () => number {
  const mu = Math.log(p50Ms);
  const sigma = Math.log(p99Ms / p50Ms) / Z99;
  return () => Math.exp(mu + sigma * gaussian());
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function timeScale(explicit?: number): number {
  const n = explicit ?? Number(process.env.TIME_SCALE ?? 1);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * Registers the runtime control surface every mock exposes:
 *   GET  /__admin/state   what the mock has actually applied
 *   GET  /__admin/config  current chaos settings
 *   POST /__admin/config  shallow-merge new settings, e.g. {"outage": true}
 *   POST /__admin/reset   clear state (config is kept)
 */
export function registerAdmin<C extends object>(
  app: FastifyInstance,
  config: C,
  getState: () => unknown,
  reset: () => void,
): void {
  app.get('/__admin/state', async () => getState());
  app.get('/__admin/config', async () => config);
  app.post('/__admin/config', async (req) => {
    const patch = (req.body ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(patch)) {
      if (k in config) (config as Record<string, unknown>)[k] = v;
    }
    return config;
  });
  app.post('/__admin/reset', async () => {
    reset();
    return { ok: true };
  });
}
