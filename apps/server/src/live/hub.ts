// Fans key changes out to SSE subscribers.
//
// One LISTEN connection per API instance, however many viewers are connected. A notification
// carries only ids; the hub re-reads the current snapshot and pushes that. Because subscribers get
// state rather than a log of events, a missed notification is repaired by the next one, and a
// reconnect (theirs or ours) is repaired by sending a full snapshot.
import type { ApiKey, ListKeysResponse } from '@callosum/shared';
import type { Sql } from '../db.ts';
import { KEY_CHANGED_CHANNEL, loadKeys } from '../keys/repo.ts';

export interface Subscriber {
  snapshot(data: ListKeysResponse): void;
  key(data: ApiKey): void;
}

const COALESCE_MS = 25;

export class Hub {
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  /** key_id -> customer_id, waiting for the next flush. */
  private readonly dirty = new Map<string, string>();
  private flushTimer: NodeJS.Timeout | undefined;
  private listener: { unlisten: () => Promise<void> } | undefined;

  constructor(private readonly sql: Sql) {}

  async start(): Promise<void> {
    this.listener = await this.sql.listen(
      KEY_CHANGED_CHANNEL,
      (payload) => this.onNotify(payload),
      // Runs on the first connect and on every reconnect: notifications sent while the listener
      // was down are gone, so everyone gets a fresh snapshot.
      () => void this.resyncAll(),
    );
  }

  async stop(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    await this.listener?.unlisten().catch(() => {});
  }

  get subscriberCount(): number {
    let n = 0;
    for (const set of this.subscribers.values()) n += set.size;
    return n;
  }

  async snapshot(customerId: string): Promise<ListKeysResponse> {
    const keys = await loadKeys(this.sql, { customerId });
    return { keys: keys.map(strip), server_time: new Date().toISOString() };
  }

  /** Register first, then send the snapshot, so no change can fall between the two. */
  async subscribe(customerId: string, subscriber: Subscriber): Promise<() => void> {
    let set = this.subscribers.get(customerId);
    if (!set) this.subscribers.set(customerId, (set = new Set()));
    set.add(subscriber);
    subscriber.snapshot(await this.snapshot(customerId));
    return () => {
      set.delete(subscriber);
      if (set.size === 0) this.subscribers.delete(customerId);
    };
  }

  private onNotify(payload: string): void {
    let msg: { customer_id?: string; key_id?: string };
    try {
      msg = JSON.parse(payload) as typeof msg;
    } catch {
      return;
    }
    if (!msg.customer_id || !msg.key_id || !this.subscribers.has(msg.customer_id)) return;
    this.dirty.set(msg.key_id, msg.customer_id);
    this.flushTimer ??= setTimeout(() => void this.flush(), COALESCE_MS);
  }

  private async flush(): Promise<void> {
    this.flushTimer = undefined;
    const keyIds = [...this.dirty.keys()];
    this.dirty.clear();
    if (keyIds.length === 0) return;
    try {
      for (const key of await loadKeys(this.sql, { keyIds })) {
        const set = this.subscribers.get(key.customer_id);
        if (set) for (const s of set) s.key(strip(key));
      }
    } catch {
      await this.resyncAll().catch(() => {});
    }
  }

  private async resyncAll(): Promise<void> {
    for (const [customerId, set] of this.subscribers) {
      const data = await this.snapshot(customerId);
      for (const s of set) s.snapshot(data);
    }
  }
}

function strip(key: ApiKey & { customer_id?: string }): ApiKey {
  const { customer_id: _customer, ...rest } = key;
  return rest;
}
