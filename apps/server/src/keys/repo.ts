// Read side: the key snapshot the page renders, plus the version bump + NOTIFY every write goes through.
import type { ApiKey } from '@callosum/shared';
import type { Queryable } from '../db.ts';

export const KEY_CHANGED_CHANNEL = 'key_changed';
export const TASKS_CHANNEL = 'tasks';

interface KeyRow {
  key_id: string;
  customer_id: string;
  name: string;
  prefix: string;
  status: ApiKey['status'];
  created_at: Date;
  revoke_requested_at: Date | null;
  revoked_at: Date | null;
  version: number;
  systems: {
    system: ApiKey['systems'][number]['system'];
    action: ApiKey['systems'][number]['action'];
    state: ApiKey['systems'][number]['state'];
    attempts: number;
    last_error: string | null;
    blocked: boolean;
    created_at: string;
    finished_at: string | null;
  }[];
}

const iso = (d: Date | string | null) => (d === null ? null : new Date(d).toISOString());

function toApiKey(r: KeyRow): ApiKey {
  return {
    key_id: r.key_id,
    name: r.name,
    prefix: r.prefix,
    status: r.status,
    created_at: iso(r.created_at)!,
    revoke_requested_at: iso(r.revoke_requested_at),
    revoked_at: iso(r.revoked_at),
    version: r.version,
    systems: r.systems.map((s) => ({ ...s, created_at: iso(s.created_at)!, finished_at: iso(s.finished_at) })),
  };
}

/**
 * Keys with the latest propagation task per system. Filter by customer, by ids, or both.
 * `blocked` marks a queued task that is waiting for an earlier task on the same key and system.
 */
export async function loadKeys(
  q: Queryable,
  filter: { customerId?: string; keyIds?: string[] },
): Promise<(ApiKey & { customer_id: string })[]> {
  const rows = await q<KeyRow[]>`
    SELECT k.key_id, k.customer_id, k.name, k.prefix, k.status, k.created_at,
           k.revoke_requested_at, k.revoked_at, k.version::int AS version,
           COALESCE((
             SELECT json_agg(s ORDER BY s.system)
             FROM (
               SELECT DISTINCT ON (t.system)
                      t.system, t.action, t.state, t.attempts, t.last_error, t.created_at, t.finished_at,
                      (t.state = 'queued' AND EXISTS (
                         SELECT 1 FROM propagation_tasks e
                         WHERE e.key_id = t.key_id AND e.system = t.system AND e.id < t.id
                           AND e.state IN ('queued', 'submitted'))) AS blocked
               FROM propagation_tasks t
               WHERE t.key_id = k.key_id
               ORDER BY t.system, t.id DESC
             ) s
           ), '[]'::json) AS systems
    FROM api_keys k
    WHERE ${filter.customerId === undefined ? q`TRUE` : q`k.customer_id = ${filter.customerId}`}
      AND ${filter.keyIds === undefined ? q`TRUE` : q`k.key_id = ANY(${filter.keyIds})`}
    ORDER BY k.created_at DESC, k.key_id DESC`;
  return rows.map((r) => ({ ...toApiKey(r), customer_id: r.customer_id }));
}

/** Bump the key's version and tell every API instance it changed. Delivered when the transaction commits. */
export async function touchKey(q: Queryable, keyId: string): Promise<void> {
  const [row] = await q<{ customer_id: string }[]>`
    UPDATE api_keys SET version = version + 1, updated_at = now() WHERE key_id = ${keyId} RETURNING customer_id`;
  if (!row) return;
  await q`SELECT pg_notify(${KEY_CHANGED_CHANNEL}, ${JSON.stringify({ customer_id: row.customer_id, key_id: keyId })})`;
}

/** Wake the workers; a fallback poll covers the case where nobody is listening. */
export async function notifyWorkers(q: Queryable): Promise<void> {
  await q`SELECT pg_notify(${TASKS_CHANNEL}, '')`;
}
