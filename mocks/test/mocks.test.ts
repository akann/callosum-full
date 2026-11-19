import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGateway, buildMetering } from '../src/index.ts';

const json = { 'content-type': 'application/json' };

describe('gateway mock', () => {
  const { app, keys } = buildGateway({ timeScale: 1000, config: { transientRate: 0 } });
  beforeAll(() => app.ready());
  afterAll(() => app.close());

  it('requires an Idempotency-Key', async () => {
    const res = await app.inject({ method: 'PUT', url: '/internal/v1/keys/key_a', headers: json, payload: { customer_id: 'c', key_hash: 'h' } });
    expect(res.statusCode).toBe(400);
  });

  it('returns the same operation for a replay and applies it asynchronously', async () => {
    const req = { method: 'PUT' as const, url: '/internal/v1/keys/key_a', headers: { ...json, 'idempotency-key': 'k1' }, payload: { customer_id: 'c', key_hash: 'h' } };
    const first = await app.inject(req);
    const second = await app.inject(req);
    expect(first.statusCode).toBe(202);
    expect(second.json()).toEqual(first.json());
    await expect.poll(async () => (await app.inject({ url: `/internal/v1/operations/${first.json().operation_id}` })).json().status, { timeout: 3000 }).toBe('succeeded');
    expect(keys.has('key_a')).toBe(true);
  });

  it('treats DELETE of an unknown key as a successful no-op', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/internal/v1/keys/key_missing', headers: { 'idempotency-key': 'k2' } });
    await expect.poll(async () => (await app.inject({ url: `/internal/v1/operations/${res.json().operation_id}` })).json().status, { timeout: 3000 }).toBe('succeeded');
  });

  it('fails a PUT permanently when told to reject', async () => {
    await app.inject({ method: 'POST', url: '/__admin/config', headers: json, payload: { rejectNext: 1 } });
    const res = await app.inject({ method: 'PUT', url: '/internal/v1/keys/key_b', headers: { ...json, 'idempotency-key': 'k3' }, payload: { customer_id: 'c', key_hash: 'h2' } });
    await expect.poll(async () => (await app.inject({ url: `/internal/v1/operations/${res.json().operation_id}` })).json().status, { timeout: 3000 }).toBe('failed');
    expect(keys.has('key_b')).toBe(false);
  });
});

describe('metering mock', () => {
  const { app, config } = buildMetering({ timeScale: 1000, config: { errorRate: 0, hangRate: 0 } });
  beforeAll(() => app.ready());
  afterAll(() => app.close());
  const post = () => app.inject({ method: 'POST', url: '/internal/v2/meters', headers: json, payload: { customer_id: 'c', key_id: 'key_a', key_hash: 'h' } });
  const del = () => app.inject({ method: 'DELETE', url: '/internal/v2/meters/by-key/key_a' });

  it('has no idempotency: 201 then 409, 204 then 404', async () => {
    expect((await post()).statusCode).toBe(201);
    expect((await post()).statusCode).toBe(409);
    expect((await del()).statusCode).toBe(204);
    expect((await del()).statusCode).toBe(404);
  });

  it('returns 503 during an outage without applying', async () => {
    config.outage = true;
    expect((await post()).statusCode).toBe(503);
    config.outage = false;
    expect((await post()).statusCode).toBe(201);
  });
});
