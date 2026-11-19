// The console API. Nothing in a request handler calls a downstream system: writes are one
// Postgres transaction, which is what keeps the API fast while the downstreams are slow or down.
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { CreateKeyRequest, type ApiKey, type ListKeysResponse } from '@callosum/shared';
import { requireAdmin, requireSession } from './auth.ts';
import type { Sql } from './db.ts';
import { createKey, revokeKey } from './keys/service.ts';
import type { Hub } from './live/hub.ts';

const HEARTBEAT_MS = 15_000;

export async function buildApi(deps: { sql: Sql; hub: Hub; logger?: boolean }): Promise<FastifyInstance> {
  const { sql, hub } = deps;
  const app = Fastify({
    // Fastify logs request metadata only, never bodies, so the secret cannot reach the log.
    // Redaction is a second line of defence for the session cookie.
    logger: deps.logger ? { redact: ['req.headers.cookie', 'req.headers.authorization'] } : false,
  });
  await app.register(cookie);

  app.get('/health', async () => {
    await sql`SELECT 1`;
    return { ok: true, sse_subscribers: hub.subscriberCount };
  });

  app.get('/api/v1/me', async (req, reply) => {
    const session = requireSession(req, reply);
    if (!session) return;
    return session;
  });

  app.get('/api/v1/keys', async (req, reply): Promise<ListKeysResponse | undefined> => {
    const session = requireSession(req, reply);
    if (!session) return;
    return hub.snapshot(session.customer_id);
  });

  app.post('/api/v1/keys', async (req, reply) => {
    const session = requireAdmin(req, reply);
    if (!session) return;
    const body = CreateKeyRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request', message: 'name must be 1 to 64 characters' });

    const header = req.headers['idempotency-key'];
    const requestId = typeof header === 'string' && header.length > 0 && header.length <= 128 ? header : null;
    const result = await createKey(sql, session, body.data.name, requestId);

    if (result.kind === 'duplicate') {
      // The secret was never stored, so a replay cannot return it.
      return reply.code(409).send({
        error: 'duplicate_request',
        message: 'This request already created a key. Its secret cannot be shown again; revoke it and create a new one if it was lost.',
        key: result.key,
      });
    }
    return reply
      .code(201)
      .header('cache-control', 'no-store')
      .send({ key: result.key, secret: result.secret });
  });

  app.post<{ Params: { key_id: string } }>('/api/v1/keys/:key_id/revoke', async (req, reply) => {
    const session = requireAdmin(req, reply);
    if (!session) return;
    const result = await revokeKey(sql, session, req.params.key_id);
    switch (result.kind) {
      case 'not_found':
        return reply.code(404).send({ error: 'not_found' });
      case 'not_revocable':
        return reply.code(409).send({ error: 'not_revocable', message: 'This key failed to provision and was never usable.', key: result.key });
      case 'already':
        return reply.code(200).send({ key: result.key }); // idempotent
      case 'accepted':
        return reply.code(202).send({ key: result.key });
    }
  });

  // Server-Sent Events: a full snapshot first, then one event per changed key.
  app.get('/api/v1/keys/events', async (req, reply) => {
    const session = requireSession(req, reply);
    if (!session) return;

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 1000\n\n');

    const send = (event: string, data: unknown, id?: number) => {
      if (res.writableEnded) return;
      res.write(`${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const unsubscribe = await hub.subscribe(session.customer_id, {
      snapshot: (data: ListKeysResponse) => send('snapshot', data),
      key: (data: ApiKey) => send('key', data, data.version),
    });
    const heartbeat = setInterval(() => send('ping', { server_time: new Date().toISOString() }), HEARTBEAT_MS);
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  return app;
}
