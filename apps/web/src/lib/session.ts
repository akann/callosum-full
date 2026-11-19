// STUBBED AUTH, matching apps/server/src/auth.ts: identity is a dev cookie the page sets itself.
import type { Role, Session } from '@callosum/shared';

const COOKIE = 'callosum_dev_session';
const DEFAULT_CUSTOMER = 'cus_8f3a2b71';

export function readSession(): Session | null {
  const raw = document.cookie.split('; ').find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!raw) return null;
  const [customer_id, role, user] = decodeURIComponent(raw).split('|');
  if (!customer_id || (role !== 'admin' && role !== 'member')) return null;
  return { customer_id, role, user: user || role };
}

export function writeSession(role: Role, customerId = DEFAULT_CUSTOMER): Session {
  const session: Session = { customer_id: customerId, role, user: role === 'admin' ? 'admin@example.test' : 'member@example.test' };
  document.cookie = `${COOKIE}=${encodeURIComponent([session.customer_id, session.role, session.user].join('|'))}; path=/; SameSite=Lax`;
  return session;
}

export function ensureSession(): Session {
  return readSession() ?? writeSession('admin');
}
