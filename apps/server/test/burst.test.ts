// The incident burst from section 06: 2,000 revokes in 10 minutes, replayed at 20x speed
// (30 s wall clock). Checks the two numbers that depend on our side of the system:
// revocation effective in the gateway p99 <= 90 s, and console API latency p95 < 200 ms.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ADMIN, createHarness, sleep, waitFor, type Harness } from './harness.ts';

const SCALE = 20;
const KEYS = 2_000;
const BURST_MS = (10 * 60_000) / SCALE;

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ timeScale: SCALE });
  await h.startWorker({ tickMs: 25, gatewayPollMs: 1_000 / SCALE, meteringTimeoutMs: 3_000 / SCALE, gatewayTimeoutMs: 1_000 });
});
afterAll(() => h.close());

const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))]!;

it('drains a 2,000-revoke burst inside the revocation budget while the API stays fast', async () => {
  // Realistic chaos: the documented 5% metering 503s and 1% hangs, plus some gateway 5xx.
  Object.assign(h.metering.config, { errorRate: 0.05, hangRate: 0.01 });
  h.gateway.config.transientRate = 0.02;

  const ids = Array.from({ length: KEYS }, (_, i) => `key_burst_${String(i).padStart(5, '0')}`);
  await h.sql`
    INSERT INTO api_keys (key_id, customer_id, name, prefix, key_hash, status, created_at)
    SELECT id, 'cus_test', 'burst ' || id, 'csk_live_xxx', encode(sha256(id::bytea), 'hex'), 'active', now()
    FROM unnest(${ids}::text[]) AS id`;
  for (const id of ids) {
    const key_hash = createHash('sha256').update(id).digest('hex');
    h.gateway.keys.set(id, { customer_id: 'cus_test', key_hash });
    h.metering.meters.set(id, { customer_id: 'cus_test', key_id: id, key_hash, created_at: Date.now() });
  }

  const apiLatency: number[] = [];
  const requestedAt = new Map<string, number>();
  const started = Date.now();
  await Promise.all(
    ids.map(async (id, i) => {
      await sleep((i / KEYS) * BURST_MS);
      const t0 = performance.now();
      requestedAt.set(id, Date.now());
      const res = await h.api.inject({ method: 'POST', url: `/api/v1/keys/${id}/revoke`, headers: ADMIN });
      apiLatency.push(performance.now() - t0);
      expect(res.statusCode).toBe(202);
    }),
  );

  await waitFor(async () => {
    const [row] = await h.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM api_keys WHERE key_id = ANY(${ids}) AND status = 'revoked'`;
    return row!.n === KEYS;
  }, 60_000, 'all keys revoked');
  const wall = Date.now() - started;

  expect(h.gateway.keys.size).toBe(0);
  expect(h.metering.meters.size).toBe(0);

  // "Effective in the gateway" = when the gateway applied the DELETE, measured from the revoke request.
  const state = (await h.gateway.app.inject({ url: '/__admin/state' })).json() as {
    operations: { key_id: string; method: string; completed_at: number }[];
  };
  const effective = state.operations
    .filter((o) => o.method === 'DELETE')
    .map((o) => (o.completed_at - requestedAt.get(o.key_id)!) * SCALE);
  const p50 = percentile(effective, 0.5) / 1000;
  const p99 = percentile(effective, 0.99) / 1000;
  const apiP95 = percentile(apiLatency, 0.95);
  console.log(`burst: ${KEYS} revokes in ${(wall / 1000).toFixed(1)} s wall; gateway-effective p50 ${p50.toFixed(1)} s, p99 ${p99.toFixed(1)} s (spec-scaled); revoke API p95 ${apiP95.toFixed(1)} ms`);

  expect(effective).toHaveLength(KEYS);
  expect(p99).toBeLessThanOrEqual(90);
  expect(apiP95).toBeLessThan(200);
});
