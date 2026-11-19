// Mock of INPUT B, the Metering Service (brief section 03). Synchronous and unreliable.
//
//   POST   /internal/v2/meters                  body { customer_id, key_id, key_hash }
//   -> 201 | 409 meter exists | 503 | timeout
//   DELETE /internal/v2/meters/by-key/{key_id}
//   -> 204 | 404 no meter | 503 | timeout
//
// Behaviour reproduced:
//   - latency p50 150 ms / p99 2 s
//   - ~5% of calls return 503 (nothing applied); it never rejects a key
//   - ~1% of calls apply the change and then never answer (client-side timeout)
//   - no idempotency: a repeated POST returns 409, a repeated DELETE returns 404
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { lognormal, registerAdmin, sleep, timeScale } from './chaos.ts';

export interface MeteringConfig {
  /** Every request returns 503 while true. */
  outage: boolean;
  /** Probability of a 503 with nothing applied. */
  errorRate: number;
  /** Probability that the change is applied and the response then hangs. */
  hangRate: number;
  /** How long a hung response is held open before the socket is dropped. */
  hangMs: number;
  p50Ms: number;
  p99Ms: number;
}

interface Meter {
  customer_id: string;
  key_id: string;
  key_hash: string;
  created_at: number;
}

export function buildMetering(opts: { timeScale?: number; logger?: boolean; config?: Partial<MeteringConfig> } = {}): {
  app: FastifyInstance;
  config: MeteringConfig;
  meters: Map<string, Meter>;
} {
  const scale = timeScale(opts.timeScale);
  const config: MeteringConfig = {
    outage: false,
    errorRate: 0.05,
    hangRate: 0.01,
    hangMs: 30_000,
    p50Ms: 150,
    p99Ms: 2_000,
    ...opts.config,
  };
  const meters = new Map<string, Meter>();
  const app = Fastify({ logger: opts.logger ?? false });

  /** Shared request lifecycle: latency, 503s, apply, optional hang after apply. */
  async function handle(apply: () => number): Promise<{ code: number } | 'hang'> {
    await sleep(lognormal(config.p50Ms, config.p99Ms)() / scale);
    if (config.outage || Math.random() < config.errorRate) return { code: 503 };
    const code = apply();
    if (Math.random() < config.hangRate) {
      await sleep(config.hangMs / scale);
      return 'hang';
    }
    return { code };
  }

  app.post<{ Body: { customer_id?: string; key_id?: string; key_hash?: string } }>(
    '/internal/v2/meters',
    async (req, reply) => {
      const { customer_id, key_id, key_hash } = req.body ?? {};
      if (!customer_id || !key_id || !key_hash) {
        return reply.code(400).send({ error: 'customer_id, key_id and key_hash required' });
      }
      const r = await handle(() => {
        if (meters.has(key_id)) return 409;
        meters.set(key_id, { customer_id, key_id, key_hash, created_at: Date.now() });
        return 201;
      });
      if (r === 'hang') return reply.raw.destroy();
      if (r.code === 503) return reply.code(503).send({ error: 'Service Unavailable' });
      if (r.code === 409) return reply.code(409).send({ error: 'meter exists' });
      return reply.code(201).send({ key_id });
    },
  );

  app.delete<{ Params: { key_id: string } }>('/internal/v2/meters/by-key/:key_id', async (req, reply) => {
    const r = await handle(() => (meters.delete(req.params.key_id) ? 204 : 404));
    if (r === 'hang') return reply.raw.destroy();
    if (r.code === 503) return reply.code(503).send({ error: 'Service Unavailable' });
    if (r.code === 404) return reply.code(404).send({ error: 'no meter' });
    return reply.code(204).send();
  });

  registerAdmin(
    app,
    config,
    () => ({ meters: Object.fromEntries(meters) }),
    () => meters.clear(),
  );

  return { app, config, meters };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.METERING_PORT ?? 4002);
  const { app } = buildMetering({ logger: true });
  await app.listen({ port, host: '0.0.0.0' });
}
