// Integration harness: a throwaway Postgres database, both downstream mocks on ephemeral ports
// (time-scaled so spec timings run in milliseconds), the API in-process and a fast worker.
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { buildGateway, buildMetering } from '@callosum/mocks';
import type { ApiKey } from '@callosum/shared';
import { buildApi } from '../src/app.ts';
import { config } from '../src/config.ts';
import { createDb, type Sql } from '../src/db.ts';
import { migrate } from '../src/db/migrate.ts';
import { Hub } from '../src/live/hub.ts';
import { PropagationWorker, type WorkerOptions } from '../src/propagation/worker.ts';

export const ADMIN = { 'x-customer-id': 'cus_test', 'x-role': 'admin', 'x-user': 'alice' };
export const MEMBER = { 'x-customer-id': 'cus_test', 'x-role': 'member', 'x-user': 'bob' };
export const OTHER_ADMIN = { 'x-customer-id': 'cus_other', 'x-role': 'admin', 'x-user': 'carol' };

export interface Harness {
  sql: Sql;
  api: FastifyInstance;
  apiUrl: string;
  gateway: ReturnType<typeof buildGateway>;
  metering: ReturnType<typeof buildMetering>;
  timeScale: number;
  startWorker(overrides?: Partial<WorkerOptions>): Promise<PropagationWorker>;
  createKey(name?: string, headers?: Record<string, string>): Promise<{ key: ApiKey; secret: string }>;
  revoke(keyId: string, headers?: Record<string, string>): Promise<{ status: number; key?: ApiKey }>;
  list(headers?: Record<string, string>): Promise<ApiKey[]>;
  getKey(keyId: string): Promise<ApiKey>;
  waitForStatus(keyId: string, status: ApiKey['status'], timeoutMs?: number): Promise<ApiKey>;
  /** Resolves once the gateway mock has no pending operations left. */
  gatewayQuiet(timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function waitFor<T>(fn: () => Promise<T | false | undefined | null>, timeoutMs = 20_000, what = 'condition'): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(15);
  }
}

export async function createHarness(opts: { timeScale?: number } = {}): Promise<Harness> {
  const timeScale = opts.timeScale ?? 50;
  const dbName = `callosum_test_${randomBytes(6).toString('hex')}`;
  const admin = createDb(config.databaseUrl, 1);
  await admin.unsafe(`CREATE DATABASE ${dbName}`);
  const url = new URL(config.databaseUrl);
  url.pathname = `/${dbName}`;
  const sql = createDb(url.toString(), 20);
  await migrate(sql);

  // Mocks start with random failures off; tests turn on exactly the chaos they are about.
  const gateway = buildGateway({ timeScale, config: { transientRate: 0 } });
  const metering = buildMetering({ timeScale, config: { errorRate: 0, hangRate: 0 } });
  await gateway.app.listen({ port: 0, host: '127.0.0.1' });
  await metering.app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app: FastifyInstance) => (app.server.address() as AddressInfo).port;

  const hub = new Hub(sql);
  await hub.start();
  const api = await buildApi({ sql, hub });
  await api.listen({ port: 0, host: '127.0.0.1' });

  const workers: PropagationWorker[] = [];
  const fast: Partial<WorkerOptions> = {
    tickMs: 20,
    leaseMs: 1_500,
    meteringTimeoutMs: 300,
    gatewayTimeoutMs: 500,
    gatewayPollMs: 20,
    backoff: { baseMs: 20, capMs: 200 },
    breaker: { threshold: 5, cooldownMs: 100, maxCooldownMs: 400 },
  };

  const h: Harness = {
    sql,
    api,
    apiUrl: `http://127.0.0.1:${port(api)}`,
    gateway,
    metering,
    timeScale,
    async startWorker(overrides = {}) {
      const worker = new PropagationWorker(sql, {
        gatewayUrl: `http://127.0.0.1:${port(gateway.app)}`,
        meteringUrl: `http://127.0.0.1:${port(metering.app)}`,
        ...fast,
        ...overrides,
      });
      await worker.start();
      workers.push(worker);
      return worker;
    },
    async createKey(name = 'test key', headers = ADMIN) {
      const res = await api.inject({ method: 'POST', url: '/api/v1/keys', headers, payload: { name } });
      if (res.statusCode !== 201) throw new Error(`create failed: ${res.statusCode} ${res.body}`);
      return res.json();
    },
    async revoke(keyId, headers = ADMIN) {
      const res = await api.inject({ method: 'POST', url: `/api/v1/keys/${keyId}/revoke`, headers });
      return { status: res.statusCode, key: (res.json() as { key?: ApiKey }).key };
    },
    async list(headers = ADMIN) {
      const res = await api.inject({ url: '/api/v1/keys', headers });
      return (res.json() as { keys: ApiKey[] }).keys;
    },
    async getKey(keyId) {
      const key = (await h.list()).find((k) => k.key_id === keyId);
      if (!key) throw new Error(`key ${keyId} not listed`);
      return key;
    },
    waitForStatus(keyId, status, timeoutMs) {
      return waitFor(async () => {
        const key = await h.getKey(keyId);
        return key.status === status ? key : false;
      }, timeoutMs, `${keyId} to become ${status}`);
    },
    async gatewayQuiet(timeoutMs) {
      await waitFor(async () => {
        const state = (await gateway.app.inject({ url: '/__admin/state' })).json() as { operations: { status: string }[] };
        return state.operations.every((o) => o.status !== 'pending');
      }, timeoutMs, 'gateway operations to finish');
    },
    async close() {
      await Promise.all(workers.map((w) => w.stop()));
      await api.close();
      await hub.stop();
      await gateway.app.close();
      await metering.app.close();
      await sql.end();
      await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await admin.end();
    },
  };
  return h;
}
