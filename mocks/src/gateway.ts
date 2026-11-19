// Mock of INPUT A, the Gateway Auth Store (brief section 02). Async: 202 + poll.
//
//   PUT    /internal/v1/keys/{key_id}     Idempotency-Key required, body { customer_id, key_hash }
//   DELETE /internal/v1/keys/{key_id}     Idempotency-Key required
//   -> 202 { operation_id }
//   GET    /internal/v1/operations/{operation_id}
//   -> 200 { status: pending|succeeded|failed, error }
//
// Behaviour reproduced:
//   - completion p50 5 s / p99 60 s after the 202; each operation applies when its own timer fires,
//     so two operations on one key_id can apply out of order
//   - same Idempotency-Key and body within 24 h returns the same operation
//   - DELETE of an unknown key succeeds as a no-op
//   - failed = permanent rejection (PUT only); 5xx = transient
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { ulid } from 'ulid';
import { lognormal, registerAdmin, timeScale } from './chaos.ts';

export interface GatewayConfig {
  /** Every request returns 503 while true. */
  outage: boolean;
  /** Probability that any single request returns a transient 503. */
  transientRate: number;
  /** Probability that a PUT operation ends as a permanent `failed`. */
  rejectRate: number;
  /** The next N PUT operations end as `failed` (decrements as used). */
  rejectNext: number;
  p50Ms: number;
  p99Ms: number;
}

interface Operation {
  operation_id: string;
  method: 'PUT' | 'DELETE';
  key_id: string;
  status: 'pending' | 'succeeded' | 'failed';
  error: string | null;
  accepted_at: number;
  completed_at: number | null;
}

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export function buildGateway(opts: { timeScale?: number; logger?: boolean; config?: Partial<GatewayConfig> } = {}): {
  app: FastifyInstance;
  config: GatewayConfig;
  keys: Map<string, { customer_id: string; key_hash: string }>;
} {
  const scale = timeScale(opts.timeScale);
  const config: GatewayConfig = {
    outage: false,
    transientRate: 0.02,
    rejectRate: 0,
    rejectNext: 0,
    p50Ms: 5_000,
    p99Ms: 60_000,
    ...opts.config,
  };
  const keys = new Map<string, { customer_id: string; key_hash: string }>();
  const operations = new Map<string, Operation>();
  const idempotency = new Map<string, { fingerprint: string; operation_id: string; at: number }>();
  const timers = new Set<NodeJS.Timeout>();

  const app = Fastify({ logger: opts.logger ?? false });

  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/__admin')) return;
    if (config.outage || Math.random() < config.transientRate) {
      return reply.code(503).send({ error: 'Service Unavailable' });
    }
  });

  function submit(
    method: 'PUT' | 'DELETE',
    keyId: string,
    idempotencyKey: string,
    body: { customer_id: string; key_hash: string } | null,
  ): { code: number; payload: unknown } {
    const fingerprint = JSON.stringify([method, keyId, body]);
    const seen = idempotency.get(idempotencyKey);
    if (seen && Date.now() - seen.at < IDEMPOTENCY_TTL_MS) {
      if (seen.fingerprint !== fingerprint) {
        return { code: 422, payload: { error: 'Idempotency-Key reused with a different request' } };
      }
      return { code: 202, payload: { operation_id: seen.operation_id } };
    }

    const op: Operation = {
      operation_id: 'op_' + ulid(),
      method,
      key_id: keyId,
      status: 'pending',
      error: null,
      accepted_at: Date.now(),
      completed_at: null,
    };
    operations.set(op.operation_id, op);
    idempotency.set(idempotencyKey, { fingerprint, operation_id: op.operation_id, at: Date.now() });

    let reject = false;
    if (method === 'PUT') {
      if (config.rejectNext > 0) {
        config.rejectNext -= 1;
        reject = true;
      } else if (Math.random() < config.rejectRate) {
        reject = true;
      }
    }

    const delay = lognormal(config.p50Ms, config.p99Ms)() / scale;
    const timer = setTimeout(() => {
      timers.delete(timer);
      op.completed_at = Date.now();
      if (reject) {
        op.status = 'failed';
        op.error = 'key rejected by gateway policy';
        return;
      }
      if (method === 'PUT' && body) keys.set(keyId, body);
      else keys.delete(keyId); // unknown key: no-op success
      op.status = 'succeeded';
    }, delay);
    timers.add(timer);

    return { code: 202, payload: { operation_id: op.operation_id } };
  }

  app.put<{ Params: { key_id: string }; Body: { customer_id?: string; key_hash?: string } }>(
    '/internal/v1/keys/:key_id',
    async (req, reply) => {
      const idem = req.headers['idempotency-key'];
      if (typeof idem !== 'string' || !idem) return reply.code(400).send({ error: 'Idempotency-Key required' });
      const { customer_id, key_hash } = req.body ?? {};
      if (!customer_id || !key_hash) return reply.code(400).send({ error: 'customer_id and key_hash required' });
      const r = submit('PUT', req.params.key_id, idem, { customer_id, key_hash });
      return reply.code(r.code).send(r.payload);
    },
  );

  app.delete<{ Params: { key_id: string } }>('/internal/v1/keys/:key_id', async (req, reply) => {
    const idem = req.headers['idempotency-key'];
    if (typeof idem !== 'string' || !idem) return reply.code(400).send({ error: 'Idempotency-Key required' });
    const r = submit('DELETE', req.params.key_id, idem, null);
    return reply.code(r.code).send(r.payload);
  });

  app.get<{ Params: { operation_id: string } }>('/internal/v1/operations/:operation_id', async (req, reply) => {
    const op = operations.get(req.params.operation_id);
    if (!op) return reply.code(404).send({ error: 'unknown operation' });
    return { status: op.status, error: op.error };
  });

  registerAdmin(
    app,
    config,
    () => ({ keys: Object.fromEntries(keys), operations: [...operations.values()] }),
    () => {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      keys.clear();
      operations.clear();
      idempotency.clear();
    },
  );
  app.addHook('onClose', async () => {
    for (const t of timers) clearTimeout(t);
  });

  return { app, config, keys };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.GATEWAY_PORT ?? 4001);
  const { app } = buildGateway({ logger: true });
  await app.listen({ port, host: '0.0.0.0' });
}
