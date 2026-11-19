// Write side. Every function here is one Postgres transaction; none of them calls a downstream.
import { ulid } from 'ulid';
import type { ApiKey, Session, SystemName } from '@callosum/shared';
import type { Queryable, Sql } from '../db.ts';
import { inMs } from '../db.ts';
import { loadKeys, notifyWorkers, touchKey } from './repo.ts';
import { displayPrefix, generateSecret, hashSecret } from './secret.ts';
import { nextKeyStatus, type TaskView } from './status.ts';

const SYSTEMS: SystemName[] = ['gateway', 'metering'];
/** Wait before re-sending a gateway DELETE that the gateway permanently rejected. */
export const GATEWAY_DELETE_RETRY_MS = 30_000;

export type CreateResult =
  | { kind: 'created'; key: ApiKey; secret: string }
  /** Same Idempotency-Key seen before: the key exists but its secret cannot be shown again. */
  | { kind: 'duplicate'; key: ApiKey };

export async function createKey(sql: Sql, session: Session, name: string, requestId: string | null): Promise<CreateResult> {
  // The secret exists only in this stack frame and in the HTTP response. Only its hash is stored.
  const secret = generateSecret();
  const keyId = 'key_' + ulid();

  const inserted = await sql.begin(async (tx) => {
    const rows = await tx`
      INSERT INTO api_keys (key_id, customer_id, name, prefix, key_hash, status, created_at, created_by, create_request_id)
      VALUES (${keyId}, ${session.customer_id}, ${name}, ${displayPrefix(secret)}, ${hashSecret(secret)},
              'provisioning', now(), ${session.user}, ${requestId})
      ON CONFLICT (customer_id, create_request_id) WHERE create_request_id IS NOT NULL DO NOTHING
      RETURNING key_id`;
    if (rows.length === 0) return false;
    for (const system of SYSTEMS) {
      await tx`INSERT INTO propagation_tasks (key_id, system, action) VALUES (${keyId}, ${system}, 'create')`;
    }
    await touchKey(tx, keyId);
    await notifyWorkers(tx);
    return true;
  });

  if (!inserted) {
    const [existing] = await sql<{ key_id: string }[]>`
      SELECT key_id FROM api_keys WHERE customer_id = ${session.customer_id} AND create_request_id = ${requestId}`;
    const [key] = await loadKeys(sql, { customerId: session.customer_id, keyIds: [existing!.key_id] });
    return { kind: 'duplicate', key: key! };
  }
  const [key] = await loadKeys(sql, { keyIds: [keyId] });
  return { kind: 'created', key: key!, secret };
}

export type RevokeResult =
  | { kind: 'not_found' }
  | { kind: 'not_revocable'; key: ApiKey }
  | { kind: 'accepted'; key: ApiKey }
  | { kind: 'already'; key: ApiKey };

export async function revokeKey(sql: Sql, session: Session, keyId: string): Promise<RevokeResult> {
  const outcome = await sql.begin(async (tx) => {
    // Scoped by customer: another customer's key is indistinguishable from a missing one.
    const [row] = await tx<{ status: ApiKey['status'] }[]>`
      SELECT status FROM api_keys WHERE key_id = ${keyId} AND customer_id = ${session.customer_id} FOR UPDATE`;
    if (!row) return 'not_found' as const;
    if (row.status === 'revoking' || row.status === 'revoked') return 'already' as const;
    if (row.status === 'failed') return 'not_revocable' as const;

    await tx`
      UPDATE api_keys SET status = 'revoking', revoke_requested_at = now(), revoked_by = ${session.user}
      WHERE key_id = ${keyId}`;
    for (const system of SYSTEMS) await enqueueDelete(tx, keyId, system);
    await touchKey(tx, keyId);
    await notifyWorkers(tx);
    return 'accepted' as const;
  });

  if (outcome === 'not_found') return { kind: 'not_found' };
  const [key] = await loadKeys(sql, { keyIds: [keyId] });
  return { kind: outcome, key: key! };
}

/**
 * Queue a delete for one system.
 *
 * A create that is still queued and has provably had no downstream effect is cancelled, so it is
 * never sent. Any other unfinished create stays in front of the delete: the worker only runs a
 * task once every earlier task for the same key and system has settled. That ordering is what
 * stops the gateway (which may apply operations out of order) from applying the PUT after the DELETE.
 */
async function enqueueDelete(tx: Queryable, keyId: string, system: SystemName, delayMs = 0): Promise<void> {
  await tx`
    UPDATE propagation_tasks SET state = 'cancelled', finished_at = now()
    WHERE key_id = ${keyId} AND system = ${system} AND action = 'create'
      AND state = 'queued' AND NOT outcome_uncertain`;
  await tx`
    INSERT INTO propagation_tasks (key_id, system, action, next_run_at)
    VALUES (${keyId}, ${system}, 'delete', ${inMs(tx, delayMs)})`;
}

/**
 * Re-derive the key's status from its tasks after one of them changed.
 * The caller must already hold the api_keys row lock (lock order is always key, then tasks).
 */
export async function settleKey(tx: Queryable, keyId: string): Promise<void> {
  const [key] = await tx<{ status: ApiKey['status'] }[]>`SELECT status FROM api_keys WHERE key_id = ${keyId}`;
  if (!key) return;
  const tasks = await tx<TaskView[]>`
    SELECT id::int AS id, system, action, state FROM propagation_tasks WHERE key_id = ${keyId}`;
  const decision = nextKeyStatus(key.status, tasks);

  if (decision.status !== key.status) {
    await tx`
      UPDATE api_keys
      SET status = ${decision.status},
          revoked_at = CASE WHEN ${decision.status} = 'revoked' THEN now() ELSE revoked_at END
      WHERE key_id = ${keyId}`;
  }
  for (const followUp of decision.followUps) {
    if (followUp.kind === 'remove_meter') await enqueueDelete(tx, keyId, 'metering');
    else await enqueueDelete(tx, keyId, 'gateway', GATEWAY_DELETE_RETRY_MS);
  }
}

/** Lock the key row. First statement of every transaction that changes a key's tasks or status. */
export async function lockKey(tx: Queryable, keyId: string): Promise<void> {
  await tx`SELECT 1 FROM api_keys WHERE key_id = ${keyId} FOR UPDATE`;
}
