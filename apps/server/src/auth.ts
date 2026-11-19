// STUBBED AUTH. The brief allows it; a real console would validate a session or JWT here.
// Identity comes from a dev cookie (so EventSource works) or, for curl and tests, from headers.
// Everything downstream of this file treats the Session as trusted.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Role, type Session } from '@callosum/shared';

export const SESSION_COOKIE = 'callosum_dev_session';

/** Cookie format: customer_id|role|user */
export function encodeSession(s: Session): string {
  return [s.customer_id, s.role, s.user].join('|');
}

export function getSession(req: FastifyRequest): Session | null {
  const header = (name: string) => {
    const v = req.headers[name];
    return typeof v === 'string' ? v : undefined;
  };
  let customer = header('x-customer-id');
  let role = header('x-role');
  let user = header('x-user');
  const cookie = req.cookies[SESSION_COOKIE];
  if (!customer && cookie) [customer, role, user] = cookie.split('|');

  const parsedRole = Role.safeParse(role);
  if (!customer || !parsedRole.success) return null;
  return { customer_id: customer, role: parsedRole.data, user: user || parsedRole.data };
}

export function requireSession(req: FastifyRequest, reply: FastifyReply): Session | null {
  const session = getSession(req);
  if (!session) void reply.code(401).send({ error: 'unauthenticated' });
  return session;
}

/** Writes are admin-only. Enforced here on the server; the page hiding buttons is only cosmetic. */
export function requireAdmin(req: FastifyRequest, reply: FastifyReply): Session | null {
  const session = requireSession(req, reply);
  if (session && session.role !== 'admin') {
    void reply.code(403).send({ error: 'forbidden', message: 'members have read-only access' });
    return null;
  }
  return session;
}
