import { describe, expect, it } from 'vitest';
import { systemDisplayState } from '@callosum/shared';
import { displayPrefix, generateSecret, hashSecret } from '../src/keys/secret.ts';
import { nextKeyStatus, type TaskView } from '../src/keys/status.ts';
import { backoffMs } from '../src/propagation/backoff.ts';
import { Breaker } from '../src/propagation/breaker.ts';

let id = 0;
const task = (system: TaskView['system'], action: TaskView['action'], state: TaskView['state']): TaskView => ({ id: ++id, system, action, state });

describe('nextKeyStatus', () => {
  it('stays provisioning until both systems confirm', () => {
    expect(nextKeyStatus('provisioning', [task('gateway', 'create', 'succeeded'), task('metering', 'create', 'queued')]).status).toBe('provisioning');
    expect(nextKeyStatus('provisioning', [task('gateway', 'create', 'submitted'), task('metering', 'create', 'succeeded')]).status).toBe('provisioning');
  });

  it('becomes active when both creates succeeded', () => {
    expect(nextKeyStatus('provisioning', [task('gateway', 'create', 'succeeded'), task('metering', 'create', 'succeeded')])).toEqual({ status: 'active', followUps: [] });
  });

  it('fails and removes the meter when the gateway rejects the key', () => {
    expect(nextKeyStatus('provisioning', [task('gateway', 'create', 'failed'), task('metering', 'create', 'succeeded')])).toEqual({ status: 'failed', followUps: [{ kind: 'remove_meter' }] });
  });

  it('never returns to active once revoking, even if the creates succeed late', () => {
    const tasks = [task('gateway', 'create', 'succeeded'), task('metering', 'create', 'succeeded'), task('gateway', 'delete', 'queued'), task('metering', 'delete', 'queued')];
    expect(nextKeyStatus('revoking', tasks).status).toBe('revoking');
  });

  it('does not mark a revoking key failed when the gateway rejects the racing create', () => {
    const tasks = [task('gateway', 'create', 'failed'), task('gateway', 'delete', 'queued'), task('metering', 'delete', 'succeeded')];
    expect(nextKeyStatus('revoking', tasks)).toEqual({ status: 'revoking', followUps: [] });
  });

  it('becomes revoked only when both deletes succeeded', () => {
    expect(nextKeyStatus('revoking', [task('gateway', 'delete', 'submitted'), task('metering', 'delete', 'succeeded')]).status).toBe('revoking');
    expect(nextKeyStatus('revoking', [task('gateway', 'delete', 'succeeded'), task('metering', 'delete', 'succeeded')]).status).toBe('revoked');
  });

  it('re-queues a gateway delete that was permanently rejected, using the latest attempt', () => {
    const failed = task('gateway', 'delete', 'failed');
    const metering = task('metering', 'delete', 'succeeded');
    expect(nextKeyStatus('revoking', [failed, metering]).followUps).toEqual([{ kind: 'retry_gateway_delete' }]);
    expect(nextKeyStatus('revoking', [failed, metering, task('gateway', 'delete', 'queued')]).followUps).toEqual([]);
  });

  it('leaves terminal and active keys alone', () => {
    for (const status of ['active', 'revoked', 'failed'] as const) {
      expect(nextKeyStatus(status, [task('gateway', 'create', 'failed')])).toEqual({ status, followUps: [] });
    }
  });
});

describe('secret', () => {
  it('generates distinct csk_live_ secrets with a 12 character display prefix', () => {
    const a = generateSecret();
    const b = generateSecret();
    expect(a).toMatch(/^csk_live_[0-9A-Za-z]{40}$/);
    expect(a).not.toBe(b);
    expect(displayPrefix(a)).toHaveLength(12);
    expect(hashSecret(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSecret(a)).not.toBe(hashSecret(b));
  });
});

describe('backoffMs', () => {
  it('doubles up to the cap, with jitter of at most 25%', () => {
    const opts = { baseMs: 500, capMs: 30_000 };
    expect(backoffMs(1, opts, () => 0.5)).toBe(500);
    expect(backoffMs(3, opts, () => 0.5)).toBe(2000);
    expect(backoffMs(50, opts, () => 0.5)).toBe(30_000);
    expect(backoffMs(1, opts, () => 0)).toBe(375);
    expect(backoffMs(1, opts, () => 1)).toBe(625);
  });
});

describe('Breaker', () => {
  it('opens after consecutive failures, probes once, and closes on success', () => {
    let now = 0;
    const b = new Breaker({ threshold: 3, cooldownMs: 100, maxCooldownMs: 400 }, () => now);
    expect(b.allowance(10)).toBe(10);
    b.failure();
    b.failure();
    expect(b.state).toBe('closed');
    b.failure();
    expect(b.state).toBe('open');
    expect(b.allowance(10)).toBe(0);

    now = 100;
    expect(b.state).toBe('half-open');
    expect(b.allowance(10)).toBe(1);
    b.started();
    expect(b.allowance(10)).toBe(0); // only one probe at a time

    b.failure(); // failed probe: cooldown doubles
    now = 250;
    expect(b.state).toBe('open');
    now = 300;
    expect(b.allowance(10)).toBe(1);
    b.started();
    b.success();
    expect(b.state).toBe('closed');
    expect(b.allowance(10)).toBe(10);
  });
});

describe('systemDisplayState', () => {
  it('maps task state to what the page shows', () => {
    const base = { attempts: 1, blocked: false, last_error: null };
    expect(systemDisplayState({ ...base, state: 'queued' })).toBe('pending');
    expect(systemDisplayState({ ...base, state: 'queued', last_error: '503 Service Unavailable' })).toBe('retrying');
    expect(systemDisplayState({ ...base, state: 'queued', blocked: true })).toBe('waiting');
    expect(systemDisplayState({ ...base, state: 'submitted' })).toBe('in progress');
    expect(systemDisplayState({ ...base, state: 'succeeded' })).toBe('done');
    expect(systemDisplayState({ ...base, state: 'failed' })).toBe('failed');
  });
});
