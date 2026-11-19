// Live key list. The SSE stream is the source of truth: it sends a full snapshot on every
// (re)connect and then one event per changed key, so reloads and dropped connections heal themselves.
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { ApiKey, ListKeysResponse } from '@callosum/shared';
import { api } from './api.ts';

export const KEYS_QUERY = ['keys'] as const;

export interface KeysState {
  keys: ApiKey[];
  /** server clock minus local clock, so elapsed timers do not depend on the viewer's clock */
  clockOffsetMs: number;
}

export type Connection = 'connecting' | 'live' | 'reconnecting';

const byNewest = (a: ApiKey, b: ApiKey) => b.created_at.localeCompare(a.created_at) || b.key_id.localeCompare(a.key_id);

/** Merge one key into the cache, ignoring anything older than what is already shown. */
export function upsertKey(client: QueryClient, key: ApiKey): void {
  client.setQueryData<KeysState>(KEYS_QUERY, (prev) => {
    const keys = prev?.keys ?? [];
    const existing = keys.find((k) => k.key_id === key.key_id);
    if (existing && existing.version >= key.version) return prev;
    return {
      clockOffsetMs: prev?.clockOffsetMs ?? 0,
      keys: [...keys.filter((k) => k.key_id !== key.key_id), key].sort(byNewest),
    };
  });
}

function applySnapshot(client: QueryClient, snapshot: ListKeysResponse): void {
  client.setQueryData<KeysState>(KEYS_QUERY, (prev) => {
    const known = new Map(prev?.keys.map((k) => [k.key_id, k]));
    return {
      clockOffsetMs: new Date(snapshot.server_time).getTime() - Date.now(),
      // A key event can overtake the snapshot it raced with: keep whichever version is newer.
      keys: snapshot.keys
        .map((k) => {
          const mine = known.get(k.key_id);
          return mine && mine.version > k.version ? mine : k;
        })
        .sort(byNewest),
    };
  });
}

export function useKeys(sessionKey: string) {
  const client = useQueryClient();
  const [connection, setConnection] = useState<Connection>('connecting');
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);

  const query = useQuery({
    queryKey: KEYS_QUERY,
    queryFn: async (): Promise<KeysState> => {
      const snapshot = await api.listKeys();
      return { keys: snapshot.keys.sort(byNewest), clockOffsetMs: new Date(snapshot.server_time).getTime() - Date.now() };
    },
    staleTime: Infinity, // kept fresh by the stream
  });

  useEffect(() => {
    const source = new EventSource('/api/v1/keys/events');
    source.onopen = () => setConnection('live');
    source.onerror = () => setConnection('reconnecting'); // EventSource retries on its own
    source.addEventListener('snapshot', (e) => {
      applySnapshot(client, JSON.parse((e as MessageEvent<string>).data) as ListKeysResponse);
      setLastEventAt(Date.now());
    });
    source.addEventListener('key', (e) => {
      upsertKey(client, JSON.parse((e as MessageEvent<string>).data) as ApiKey);
      setLastEventAt(Date.now());
    });
    return () => source.close();
  }, [client, sessionKey]);

  return { ...query, connection, lastEventAt };
}

/** Re-render every `ms` while `active`, for ticking elapsed timers. */
export function useNow(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [active, ms]);
  return now;
}
