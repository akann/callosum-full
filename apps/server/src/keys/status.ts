// The key state machine as a pure function, so it can be unit-tested without a database.
//
//   provisioning -> active     both create tasks succeeded
//   provisioning -> failed     the gateway permanently rejected the key (then remove its meter)
//   provisioning|active -> revoking   (done by the revoke request itself, not here)
//   revoking -> revoked        both delete tasks succeeded
//
// Revocation is monotonic: nothing here ever leaves revoking/revoked for an earlier state.
import type { KeyStatus, SystemName, TaskAction, TaskState } from '@callosum/shared';

export interface TaskView {
  id: number;
  system: SystemName;
  action: TaskAction;
  state: TaskState;
}

export type FollowUp =
  /** Compensation after a gateway rejection. */
  | { kind: 'remove_meter' }
  /** A gateway DELETE was permanently rejected: revocation is never abandoned, so queue a fresh one. */
  | { kind: 'retry_gateway_delete' };

export interface Decision {
  status: KeyStatus;
  followUps: FollowUp[];
}

/** Latest task (highest id) per system+action. */
function latest(tasks: TaskView[], system: SystemName, action: TaskAction): TaskView | undefined {
  let found: TaskView | undefined;
  for (const t of tasks) {
    if (t.system === system && t.action === action && (!found || t.id > found.id)) found = t;
  }
  return found;
}

export function nextKeyStatus(status: KeyStatus, tasks: TaskView[]): Decision {
  if (status === 'provisioning') {
    const gateway = latest(tasks, 'gateway', 'create');
    const metering = latest(tasks, 'metering', 'create');
    if (gateway?.state === 'failed') return { status: 'failed', followUps: [{ kind: 'remove_meter' }] };
    if (gateway?.state === 'succeeded' && metering?.state === 'succeeded') return { status: 'active', followUps: [] };
    return { status, followUps: [] };
  }

  if (status === 'revoking') {
    const gateway = latest(tasks, 'gateway', 'delete');
    const metering = latest(tasks, 'metering', 'delete');
    if (gateway?.state === 'failed') return { status, followUps: [{ kind: 'retry_gateway_delete' }] };
    if (gateway?.state === 'succeeded' && metering?.state === 'succeeded') return { status: 'revoked', followUps: [] };
    return { status, followUps: [] };
  }

  // active, revoked and failed are only left by an explicit revoke request.
  return { status, followUps: [] };
}
