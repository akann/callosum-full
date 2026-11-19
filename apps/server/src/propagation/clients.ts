// HTTP clients for the two downstreams. Each call is reduced to an Outcome the worker can act on;
// nothing here touches the database.
import type { TaskAction } from '@callosum/shared';

export type Outcome =
  /** The change is confirmed applied (or was already in the desired state). */
  | { kind: 'done' }
  /** Gateway accepted the request and gave us an operation to poll. */
  | { kind: 'accepted'; operationId: string }
  /** Gateway operation is still pending. */
  | { kind: 'pending' }
  /** Permanent rejection. Never retried. */
  | { kind: 'rejected'; error: string }
  /**
   * Transient failure. `certain` is true when the downstream answered and so definitely did not
   * apply the change (a 5xx), false when we cannot tell (timeout, dropped connection).
   */
  | { kind: 'retry'; error: string; certain: boolean }
  /** Polling failed; the operation itself is unaffected. */
  | { kind: 'poll_error'; error: string }
  /** Gateway no longer knows the operation: submit again with the same Idempotency-Key. */
  | { kind: 'lost_operation' };

export interface KeyMaterial {
  key_id: string;
  customer_id: string;
  key_hash: string;
}

const json = { 'content-type': 'application/json' };
const describe = (res: Response) => `${res.status} ${res.statusText || 'error'}`.trim();

/** fetch with a hard timeout. Failures come back as a value, with whether the request can have landed. */
async function call(url: string, init: RequestInit, timeoutMs: number): Promise<Response | { error: string; certain: boolean }> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } };
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return { error: `timeout after ${timeoutMs} ms`, certain: false };
    const code = e.cause?.code;
    // The connection was never established, so the request cannot have been processed.
    const neverSent = code === 'ECONNREFUSED' || code === 'ENOTFOUND';
    return { error: `network error${code ? ` (${code})` : ''}`, certain: neverSent };
  }
}

export class MeteringClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
  ) {}

  async apply(action: TaskAction, key: KeyMaterial): Promise<Outcome> {
    const res =
      action === 'create'
        ? await call(`${this.baseUrl}/internal/v2/meters`, { method: 'POST', headers: json, body: JSON.stringify(key) }, this.timeoutMs)
        : await call(`${this.baseUrl}/internal/v2/meters/by-key/${encodeURIComponent(key.key_id)}`, { method: 'DELETE' }, this.timeoutMs);
    if (!(res instanceof Response)) return { kind: 'retry', ...res };
    await res.body?.cancel();

    // No idempotency downstream, so we make it idempotent here: key_id is ours and unique, so a
    // 409 on create can only be our own earlier call, and a 404 on delete means it is already gone.
    if (action === 'create' && (res.status === 201 || res.status === 409)) return { kind: 'done' };
    if (action === 'delete' && (res.status === 204 || res.status === 404)) return { kind: 'done' };
    // Metering never rejects a key, so anything else is treated as transient.
    return { kind: 'retry', error: describe(res), certain: true };
  }
}

export class GatewayClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
  ) {}

  async submit(action: TaskAction, key: KeyMaterial, idempotencyKey: string): Promise<Outcome> {
    const url = `${this.baseUrl}/internal/v1/keys/${encodeURIComponent(key.key_id)}`;
    const headers = { 'idempotency-key': idempotencyKey };
    const res =
      action === 'create'
        ? await call(url, { method: 'PUT', headers: { ...headers, ...json }, body: JSON.stringify({ customer_id: key.customer_id, key_hash: key.key_hash }) }, this.timeoutMs)
        : await call(url, { method: 'DELETE', headers }, this.timeoutMs);
    if (!(res instanceof Response)) return { kind: 'retry', ...res };

    if (res.status === 202) {
      const body = (await res.json().catch(() => null)) as { operation_id?: string } | null;
      if (body?.operation_id) return { kind: 'accepted', operationId: body.operation_id };
      return { kind: 'retry', error: '202 without operation_id', certain: false };
    }
    await res.body?.cancel();
    if (res.status >= 500 || res.status === 429) return { kind: 'retry', error: describe(res), certain: true };
    return { kind: 'rejected', error: describe(res) };
  }

  async poll(operationId: string): Promise<Outcome> {
    const res = await call(`${this.baseUrl}/internal/v1/operations/${encodeURIComponent(operationId)}`, {}, this.timeoutMs);
    if (!(res instanceof Response)) return { kind: 'poll_error', error: res.error };
    if (res.status === 404) {
      await res.body?.cancel();
      return { kind: 'lost_operation' };
    }
    if (res.status !== 200) {
      await res.body?.cancel();
      return { kind: 'poll_error', error: describe(res) };
    }
    const body = (await res.json().catch(() => null)) as { status?: string; error?: string | null } | null;
    if (body?.status === 'succeeded') return { kind: 'done' };
    if (body?.status === 'failed') return { kind: 'rejected', error: body.error ?? 'rejected by gateway' };
    if (body?.status === 'pending') return { kind: 'pending' };
    return { kind: 'poll_error', error: 'unreadable operation status' };
  }
}
