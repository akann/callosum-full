import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiKey, ListKeysResponse } from '@callosum/shared';
import { ADMIN, MEMBER, OTHER_ADMIN, createHarness, waitFor, type Harness } from './harness.ts';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
  await h.startWorker();
});
afterAll(() => h.close());

describe('roles and tenancy', () => {
  it('rejects unauthenticated requests', async () => {
    expect((await h.api.inject({ url: '/api/v1/keys' })).statusCode).toBe(401);
    expect((await h.api.inject({ method: 'POST', url: '/api/v1/keys', payload: { name: 'x' } })).statusCode).toBe(401);
  });

  it('lets members read but rejects their writes on the server', async () => {
    const { key } = await h.createKey('admin made this');
    expect((await h.list(MEMBER)).map((k) => k.key_id)).toContain(key.key_id);

    const create = await h.api.inject({ method: 'POST', url: '/api/v1/keys', headers: MEMBER, payload: { name: 'nope' } });
    expect(create.statusCode).toBe(403);
    expect((await h.revoke(key.key_id, MEMBER)).status).toBe(403);
    expect((await h.getKey(key.key_id)).status).not.toBe('revoking');
  });

  it('scopes everything to the caller\'s customer', async () => {
    const { key } = await h.createKey('ours');
    expect((await h.list(OTHER_ADMIN)).map((k) => k.key_id)).not.toContain(key.key_id);
    expect((await h.revoke(key.key_id, OTHER_ADMIN)).status).toBe(404);
  });
});

describe('create contract', () => {
  it('validates the name', async () => {
    for (const name of ['', '   ', 'x'.repeat(65)]) {
      const res = await h.api.inject({ method: 'POST', url: '/api/v1/keys', headers: ADMIN, payload: { name } });
      expect(res.statusCode).toBe(400);
    }
  });

  it('returns the secret once, uncacheable, and never from the list', async () => {
    const res = await h.api.inject({ method: 'POST', url: '/api/v1/keys', headers: ADMIN, payload: { name: 'once' } });
    expect(res.statusCode).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const { secret, key } = res.json() as { secret: string; key: ApiKey };
    expect(secret).toMatch(/^csk_live_/);
    const listed = await h.api.inject({ url: '/api/v1/keys', headers: ADMIN });
    expect(listed.body).not.toContain(secret);
    expect(listed.body).toContain(key.prefix);
  });

  it('does not create a second key or re-issue the secret when the request is replayed', async () => {
    const req = { method: 'POST' as const, url: '/api/v1/keys', headers: { ...ADMIN, 'idempotency-key': 'req-123' }, payload: { name: 'replayed' } };
    const first = await h.api.inject(req);
    const second = await h.api.inject(req);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: 'duplicate_request', key: { key_id: first.json().key.key_id } });
    expect(second.body).not.toContain('csk_live_' + first.json().secret.slice(9, 20));
    expect((await h.list()).filter((k) => k.name === 'replayed')).toHaveLength(1);
  });
});

/** Minimal SSE client over fetch, so tests see exactly what a browser would. */
async function openStream(url: string, headers: Record<string, string>) {
  const controller = new AbortController();
  const res = await fetch(url, { headers, signal: controller.signal });
  const events: { event: string; data: unknown; at: number }[] = [];
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const chunk of res.body!) {
        buffer += decoder.decode(chunk as Uint8Array, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (event && data) events.push({ event, data: JSON.parse(data), at: Date.now() });
        }
      }
    } catch {
      /* aborted */
    }
  })();
  return { res, events, close: () => controller.abort() };
}

describe('live updates', () => {
  it('sends a snapshot on connect, then every change, to all viewers of that customer only', async () => {
    const url = `${h.apiUrl}/api/v1/keys/events`;
    const admin = await openStream(url, ADMIN);
    const member = await openStream(url, MEMBER); // "other admins' changes": a second viewer
    const other = await openStream(url, OTHER_ADMIN);
    expect(admin.res.headers.get('content-type')).toBe('text/event-stream');

    await waitFor(async () => admin.events.length > 0 && member.events.length > 0 && other.events.length > 0, 5_000, 'snapshots');
    expect(admin.events[0]!.event).toBe('snapshot');
    const before = (admin.events[0]!.data as ListKeysResponse).keys.length;
    expect(before).toBeGreaterThan(0); // reload: state comes from the server, not from the stream history

    const createdAt = Date.now();
    const { key } = await h.createKey('watched');
    const seen = (s: typeof admin, status: string) =>
      s.events.find((e) => e.event === 'key' && (e.data as ApiKey).key_id === key.key_id && (e.data as ApiKey).status === status);

    const first = await waitFor(async () => seen(member, 'provisioning'), 5_000, 'provisioning event');
    expect(first.at - createdAt).toBeLessThan(2_000);
    await waitFor(async () => seen(admin, 'active') && seen(member, 'active'), 20_000, 'active event');

    await h.revoke(key.key_id);
    await waitFor(async () => seen(member, 'revoking'), 5_000, 'revoking event');
    await waitFor(async () => seen(member, 'revoked'), 20_000, 'revoked event');

    // Versions only ever go up, so a client can discard anything stale.
    const versions = member.events.filter((e) => e.event === 'key' && (e.data as ApiKey).key_id === key.key_id).map((e) => (e.data as ApiKey).version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    // Per-system detail travels with each event.
    const detail = member.events.map((e) => e.data as ApiKey).filter((d) => d.key_id === key.key_id).flatMap((d) => d.systems);
    expect(detail.some((s) => s.system === 'gateway' && s.state === 'submitted' && s.attempts === 1)).toBe(true);

    expect(other.events.filter((e) => e.event === 'key')).toHaveLength(0); // no cross-tenant leakage

    for (const s of [admin, member, other]) s.close();
    await waitFor(async () => ((await h.api.inject({ url: '/health' })).json() as { sse_subscribers: number }).sse_subscribers === 0, 5_000, 'subscribers to be released');
  });
});
