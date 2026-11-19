// Contract shared by the console API and the page.
import { z } from 'zod';

export const KeyStatus = z.enum(['provisioning', 'active', 'revoking', 'revoked', 'failed']);
export type KeyStatus = z.infer<typeof KeyStatus>;

export const SystemName = z.enum(['gateway', 'metering']);
export type SystemName = z.infer<typeof SystemName>;

export const TaskAction = z.enum(['create', 'delete']);
export type TaskAction = z.infer<typeof TaskAction>;

export const TaskState = z.enum(['queued', 'submitted', 'succeeded', 'failed', 'cancelled']);
export type TaskState = z.infer<typeof TaskState>;

export const Role = z.enum(['admin', 'member']);
export type Role = z.infer<typeof Role>;

/** Latest propagation task for one downstream system. */
export const SystemStatus = z.object({
  system: SystemName,
  action: TaskAction,
  state: TaskState,
  attempts: z.number().int(),
  last_error: z.string().nullable(),
  /** True while an earlier task for the same key and system has not settled yet. */
  blocked: z.boolean(),
  created_at: z.string(),
  finished_at: z.string().nullable(),
});
export type SystemStatus = z.infer<typeof SystemStatus>;

export const ApiKey = z.object({
  key_id: z.string(),
  name: z.string(),
  prefix: z.string(),
  status: KeyStatus,
  created_at: z.string(),
  revoke_requested_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
  version: z.number().int(),
  systems: z.array(SystemStatus),
});
export type ApiKey = z.infer<typeof ApiKey>;

export const CreateKeyRequest = z.object({ name: z.string().trim().min(1).max(64) });
export type CreateKeyRequest = z.infer<typeof CreateKeyRequest>;

/** The only response that ever carries the secret. */
export const CreateKeyResponse = z.object({ key: ApiKey, secret: z.string() });
export type CreateKeyResponse = z.infer<typeof CreateKeyResponse>;

export const ListKeysResponse = z.object({ keys: z.array(ApiKey), server_time: z.string() });
export type ListKeysResponse = z.infer<typeof ListKeysResponse>;

export const Session = z.object({ customer_id: z.string(), role: Role, user: z.string() });
export type Session = z.infer<typeof Session>;

/** SSE events on GET /api/v1/keys/events. */
export type KeysEvent =
  | { type: 'snapshot'; data: ListKeysResponse }
  | { type: 'key'; data: ApiKey };

/** What the page shows for one system, derived from its latest task. */
export type SystemDisplayState = 'waiting' | 'pending' | 'in progress' | 'retrying' | 'done' | 'failed' | 'cancelled';

export function systemDisplayState(s: Pick<SystemStatus, 'state' | 'attempts' | 'blocked' | 'last_error'>): SystemDisplayState {
  switch (s.state) {
    case 'succeeded':
      return 'done';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'submitted':
      return 'in progress';
    case 'queued':
      if (s.blocked) return 'waiting';
      return s.last_error ? 'retrying' : 'pending';
  }
}

export const isTerminalTaskState = (s: TaskState) => s === 'succeeded' || s === 'failed' || s === 'cancelled';
