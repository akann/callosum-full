import type { ApiKey, CreateKeyResponse, ListKeysResponse, Session } from '@callosum/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', ...init });
  const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
  if (!res.ok) throw new ApiError(res.status, body.message ?? body.error ?? `Request failed (${res.status})`);
  return body as T;
}

export const api = {
  me: () => request<Session>('/api/v1/me'),
  listKeys: () => request<ListKeysResponse>('/api/v1/keys'),
  createKey: (name: string, idempotencyKey: string) =>
    request<CreateKeyResponse>('/api/v1/keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
      body: JSON.stringify({ name }),
    }),
  revokeKey: (keyId: string) => request<{ key: ApiKey }>(`/api/v1/keys/${encodeURIComponent(keyId)}/revoke`, { method: 'POST' }),
};
