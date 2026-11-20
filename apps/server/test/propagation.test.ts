import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, sleep, waitFor, type Harness } from './harness.ts';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
  await h.startWorker();
});
afterAll(() => h.close());
beforeEach(() => {
  Object.assign(h.gateway.config, { outage: false, transientRate: 0, rejectNext: 0, rejectRate: 0 });
  Object.assign(h.metering.config, { outage: false, errorRate: 0, hangRate: 0 });
});

describe('create', () => {
  it('reaches both systems and becomes active; only the hash is stored or sent', async () => {
    const { key, secret } = await h.createKey('Prod backend');
    expect(key.status).toBe('provisioning');
    expect(secret.startsWith(key.prefix)).toBe(true);

    const active = await h.waitForStatus(key.key_id, 'active');
    expect(active.systems.map((s) => [s.system, s.action, s.state])).toEqual([
      ['gateway', 'create', 'succeeded'],
      ['metering', 'create', 'succeeded'],
    ]);

    const hash = createHash('sha256').update(secret).digest('hex');
    expect(h.gateway.keys.get(key.key_id)).toEqual({ customer_id: 'cus_test', key_hash: hash });
    expect(h.metering.meters.get(key.key_id)?.key_hash).toBe(hash);

    // The secret appears nowhere in the database.
    const dump = JSON.stringify([
      await h.sql`SELECT * FROM api_keys WHERE key_id = ${key.key_id}`,
      await h.sql`SELECT * FROM propagation_tasks WHERE key_id = ${key.key_id}`,
    ]);
    expect(dump).not.toContain(secret);
    expect(dump).not.toContain(secret.slice(12));
  });

  it('marks the key failed and removes its meter when the gateway rejects it', async () => {
    h.gateway.config.rejectNext = 1;
    const { key } = await h.createKey('Rejected');
    const failed = await h.waitForStatus(key.key_id, 'failed');
    expect(failed.systems.find((s) => s.system === 'gateway')).toMatchObject({ action: 'create', state: 'failed', last_error: 'key rejected by gateway policy' });

    await waitFor(async () => (await h.getKey(key.key_id)).systems.find((s) => s.system === 'metering')?.state === 'succeeded', 10_000, 'meter removal');
    expect((await h.getKey(key.key_id)).systems.find((s) => s.system === 'metering')).toMatchObject({ action: 'delete', state: 'succeeded' });
    expect(h.metering.meters.has(key.key_id)).toBe(false);
    expect(h.gateway.keys.has(key.key_id)).toBe(false);
    expect((await h.getKey(key.key_id)).status).toBe('failed');

    expect((await h.revoke(key.key_id)).status).toBe(409); // failed keys are not revocable
  });

  it('survives metering 503s and timeouts-after-apply without duplicating or losing the meter', async () => {
    Object.assign(h.metering.config, { errorRate: 0.4, hangRate: 0.3 });
    const created = await Promise.all(Array.from({ length: 15 }, (_, i) => h.createKey(`flaky ${i}`)));
    for (const { key } of created) await h.waitForStatus(key.key_id, 'active', 30_000);
    for (const { key } of created) expect(h.metering.meters.has(key.key_id)).toBe(true);
    const retried = await h.sql`SELECT count(*)::int AS n FROM propagation_tasks WHERE system = 'metering' AND attempts > 1`;
    expect(retried[0]!.n).toBeGreaterThan(0); // the chaos really did bite
  });
});

describe('revoke', () => {
  it('removes an active key from both systems', async () => {
    const { key } = await h.createKey();
    await h.waitForStatus(key.key_id, 'active');

    const res = await h.revoke(key.key_id);
    expect(res.status).toBe(202);
    expect(res.key?.status).toBe('revoking');

    const revoked = await h.waitForStatus(key.key_id, 'revoked');
    expect(revoked.revoked_at).not.toBeNull();
    expect(h.gateway.keys.has(key.key_id)).toBe(false);
    expect(h.metering.meters.has(key.key_id)).toBe(false);

    expect((await h.revoke(key.key_id)).status).toBe(200); // idempotent
  });

  it('beats an in-flight create: the key never ends up live, whatever order the gateway applies things in', async () => {
    // Revoke at assorted points during provisioning, with transient gateway errors in the mix.
    h.gateway.config.transientRate = 0.2;
    const keys = [];
    for (let i = 0; i < 40; i++) {
      const { key } = await h.createKey(`race ${i}`);
      keys.push(key.key_id);
      void sleep(i * 6).then(() => h.revoke(key.key_id));
    }
    for (const id of keys) await h.waitForStatus(id, 'revoked', 40_000);
    h.gateway.config.transientRate = 0;
    await h.gatewayQuiet();

    for (const id of keys) {
      expect(h.gateway.keys.has(id), `gateway still accepts ${id}`).toBe(false);
      expect(h.metering.meters.has(id), `meter still exists for ${id}`).toBe(false);
    }
    // Some creates were cancelled before being sent, others had to be settled first: both paths ran.
    const stats = await h.sql<{ state: string; n: number }[]>`
      SELECT state, count(*)::int AS n FROM propagation_tasks
      WHERE action = 'create' AND key_id = ANY(${keys}) GROUP BY state`;
    expect(stats.find((s) => s.state === 'succeeded')?.n ?? 0).toBeGreaterThan(0);
    // No key was ever flipped back: status history is not kept, but a revoking key can only move to revoked.
    const live = await h.sql`SELECT 1 FROM api_keys WHERE key_id = ANY(${keys}) AND status <> 'revoked'`;
    expect(live).toHaveLength(0);
  });

  it('cancels a create that was never sent instead of sending it', async () => {
    h.gateway.config.outage = true; // gateway answers 503: create provably had no effect
    const { key } = await h.createKey('never sent');
    await waitFor(async () => (await h.getKey(key.key_id)).systems.find((s) => s.system === 'gateway')?.last_error, 10_000, 'a gateway 503');
    await h.revoke(key.key_id);

    const tasks = await h.sql<{ action: string; state: string }[]>`
      SELECT action, state FROM propagation_tasks WHERE key_id = ${key.key_id} AND system = 'gateway' ORDER BY id`;
    expect(tasks[0]).toEqual({ action: 'create', state: 'cancelled' });

    h.gateway.config.outage = false;
    await h.waitForStatus(key.key_id, 'revoked');
    const ops = (await h.gateway.app.inject({ url: '/__admin/state' })).json() as { operations: { key_id: string; method: string }[] };
    expect(ops.operations.filter((o) => o.key_id === key.key_id).map((o) => o.method)).toEqual(['DELETE']);
  });
});

describe('uncertainty', () => {
  it('does not forget a timed-out send just because the retry got a clean 503', async () => {
    h.metering.config.hangRate = 1; // first POST applies, then hangs
    const { key } = await h.createKey('timeout then 503');
    const metering = async () => (await h.getKey(key.key_id)).systems.find((s) => s.system === 'metering')!;
    await waitFor(async () => (await metering()).last_error?.startsWith('timeout'), 10_000, 'a metering timeout');
    Object.assign(h.metering.config, { hangRate: 0, outage: true });
    await waitFor(async () => (await metering()).last_error?.startsWith('503'), 10_000, 'a metering 503');

    await h.revoke(key.key_id);
    // The create may have landed, so it must not be cancelled as "never sent".
    const [create] = await h.sql<{ state: string; outcome_uncertain: boolean }[]>`
      SELECT state, outcome_uncertain FROM propagation_tasks
      WHERE key_id = ${key.key_id} AND system = 'metering' AND action = 'create'`;
    expect(create).toEqual({ state: 'queued', outcome_uncertain: true });

    h.metering.config.outage = false;
    await h.waitForStatus(key.key_id, 'revoked', 15_000);
    expect(h.metering.meters.has(key.key_id)).toBe(false);
  });
});

describe('resilience', () => {
  it('loses nothing across an outage of both downstreams', async () => {
    const existing = await Promise.all(Array.from({ length: 5 }, (_, i) => h.createKey(`pre-outage ${i}`)));
    for (const { key } of existing) await h.waitForStatus(key.key_id, 'active');

    h.gateway.config.outage = true;
    h.metering.config.outage = true;
    const created = await Promise.all(Array.from({ length: 5 }, (_, i) => h.createKey(`during outage ${i}`)));
    for (const { key } of existing) await h.revoke(key.key_id);

    await sleep(1_500); // an hour of outage, scaled
    const during = await h.list();
    for (const { key } of created) expect(during.find((k) => k.key_id === key.key_id)?.status).toBe('provisioning');
    for (const { key } of existing) expect(during.find((k) => k.key_id === key.key_id)?.status).toBe('revoking');
    const errors = during.flatMap((k) => k.systems).filter((s) => s.last_error?.startsWith('503'));
    expect(errors.length).toBeGreaterThan(0); // the page can show why it is stuck

    h.gateway.config.outage = false;
    h.metering.config.outage = false;
    for (const { key } of created) await h.waitForStatus(key.key_id, 'active', 30_000);
    for (const { key } of existing) await h.waitForStatus(key.key_id, 'revoked', 30_000);
    for (const { key } of existing) expect(h.gateway.keys.has(key.key_id)).toBe(false);
    for (const { key } of created) expect(h.gateway.keys.has(key.key_id)).toBe(true);
  });

  it('recovers a task whose worker died mid-call once the lease expires', async () => {
    const solo = await createHarness();
    try {
      const { key } = await solo.createKey('orphaned');
      // What a worker leaves behind if it is killed between claiming and recording the result.
      await solo.sql`
        UPDATE propagation_tasks
        SET attempts = 1, outcome_uncertain = true, locked_until = now() + interval '700 milliseconds'
        WHERE key_id = ${key.key_id}`;

      await solo.startWorker();
      await sleep(300);
      expect((await solo.getKey(key.key_id)).status).toBe('provisioning'); // lease still held
      const active = await solo.waitForStatus(key.key_id, 'active');
      expect(active.systems.every((s) => s.attempts === 2)).toBe(true);
    } finally {
      await solo.close();
    }
  });

  it('is safe with several workers on the same queue', async () => {
    const extra = [await h.startWorker(), await h.startWorker()];
    const created = await Promise.all(Array.from({ length: 30 }, (_, i) => h.createKey(`multi ${i}`)));
    for (const { key } of created) await h.waitForStatus(key.key_id, 'active', 30_000);
    // Each task was sent exactly once: no worker picked up another's claim.
    const ids = created.map((c) => c.key.key_id);
    const multi = await h.sql`SELECT 1 FROM propagation_tasks WHERE key_id = ANY(${ids}) AND attempts <> 1`;
    expect(multi).toHaveLength(0);
    await Promise.all(extra.map((w) => w.stop()));
  });
});
