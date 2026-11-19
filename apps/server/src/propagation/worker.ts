// The propagation worker: drains propagation_tasks with at-least-once delivery.
//
//   claim  (short transaction, FOR UPDATE SKIP LOCKED, takes a lease)
//   call   the downstream with no transaction open
//   apply  the outcome in a transaction that locks the key row, re-derives key status and notifies
//
// A crash between claim and apply just lets the lease expire; another worker repeats the call, which
// is safe because every downstream call is idempotent from our side (see clients.ts).
import type { SystemName, TaskAction } from '@callosum/shared';
import type { Sql } from '../db.ts';
import { inMs } from '../db.ts';
import { TASKS_CHANNEL, notifyWorkers, touchKey } from '../keys/repo.ts';
import { lockKey, settleKey } from '../keys/service.ts';
import { backoffMs, type BackoffOptions } from './backoff.ts';
import { Breaker, type BreakerOptions } from './breaker.ts';
import { GatewayClient, MeteringClient, type KeyMaterial, type Outcome } from './clients.ts';

export interface WorkerOptions {
  gatewayUrl: string;
  meteringUrl: string;
  /** Concurrent downstream calls per system. */
  concurrency: number;
  /** Fallback poll for due tasks; NOTIFY wakes the worker sooner. */
  tickMs: number;
  leaseMs: number;
  /** Metering p99 is 2 s, so 3 s cuts off only the hung ~1%. */
  meteringTimeoutMs: number;
  gatewayTimeoutMs: number;
  /** How often a pending gateway operation is polled. Bounds how stale the page can be. */
  gatewayPollMs: number;
  backoff: BackoffOptions;
  breaker: BreakerOptions;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

export const defaultWorkerOptions: Omit<WorkerOptions, 'gatewayUrl' | 'meteringUrl'> = {
  concurrency: 20,
  tickMs: 250,
  leaseMs: 30_000,
  meteringTimeoutMs: 3_000,
  gatewayTimeoutMs: 5_000,
  gatewayPollMs: 1_000,
  backoff: { baseMs: 500, capMs: 30_000 },
  breaker: { threshold: 5, cooldownMs: 2_000, maxCooldownMs: 15_000 },
  log: () => {},
};

interface ClaimedTask {
  id: number;
  key_id: string;
  system: SystemName;
  action: TaskAction;
  /** State when claimed: 'queued' means this run sends, 'submitted' means it polls. */
  state: 'queued' | 'submitted';
  attempts: number;
  idempotency_key: string;
  operation_id: string | null;
}

const SYSTEMS: SystemName[] = ['gateway', 'metering'];

export class PropagationWorker {
  private readonly opts: WorkerOptions;
  private readonly gateway: GatewayClient;
  private readonly metering: MeteringClient;
  private readonly breakers: Record<SystemName, Breaker>;
  private readonly inflight: Record<SystemName, number> = { gateway: 0, metering: 0 };
  private readonly running = new Set<Promise<void>>();
  private timer: NodeJS.Timeout | undefined;
  private listener: { unlisten: () => Promise<void> } | undefined;
  private ticking = false;
  private tickAgain = false;
  private stopped = true;

  constructor(
    private readonly sql: Sql,
    opts: Partial<WorkerOptions> & Pick<WorkerOptions, 'gatewayUrl' | 'meteringUrl'>,
  ) {
    this.opts = { ...defaultWorkerOptions, ...opts };
    this.gateway = new GatewayClient(this.opts.gatewayUrl, this.opts.gatewayTimeoutMs);
    this.metering = new MeteringClient(this.opts.meteringUrl, this.opts.meteringTimeoutMs);
    this.breakers = { gateway: new Breaker(this.opts.breaker), metering: new Breaker(this.opts.breaker) };
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.listener = await this.sql.listen(TASKS_CHANNEL, () => this.requestTick());
    this.timer = setInterval(() => this.requestTick(), this.opts.tickMs);
    this.requestTick();
  }

  /** Stop claiming and wait for in-flight calls. Anything unfinished is picked up again after its lease. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.listener?.unlisten().catch(() => {});
    await Promise.allSettled([...this.running]);
  }

  /** Simulates a crash for tests: stop without waiting, leaving leases in place. */
  kill(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    void this.listener?.unlisten().catch(() => {});
  }

  private requestTick(): void {
    if (this.stopped) return;
    if (this.ticking) {
      this.tickAgain = true;
      return;
    }
    this.ticking = true;
    void this.tick()
      .catch((err: unknown) => this.opts.log('tick failed', { error: String(err) }))
      .finally(() => {
        this.ticking = false;
        if (this.tickAgain) {
          this.tickAgain = false;
          this.requestTick();
        }
      });
  }

  private async tick(): Promise<void> {
    for (const system of SYSTEMS) {
      const breaker = this.breakers[system];
      const allowance = breaker.allowance(this.opts.concurrency - this.inflight[system]);
      if (allowance <= 0) continue;
      const tasks = await this.claim(system, allowance);
      for (const task of tasks) {
        if (this.stopped) return; // lease expires and another worker takes it
        breaker.started();
        this.inflight[system] += 1;
        const run = this.run(task).finally(() => {
          this.inflight[system] -= 1;
          this.running.delete(run);
          this.requestTick();
        });
        this.running.add(run);
      }
    }
  }

  /**
   * Claim due tasks for one system. A task is runnable only when every earlier task for the same
   * key and system has settled, which serialises operations per key. Deletes go first so a revoke
   * burst is never stuck behind creates.
   *
   * Claiming a send (state queued) records the attempt and marks the outcome uncertain before any
   * request leaves, so a crash mid-call can never be mistaken for "never sent".
   */
  private async claim(system: SystemName, limit: number): Promise<ClaimedTask[]> {
    const sql = this.sql;
    const tasks = await sql<(ClaimedTask & { was_queued: boolean })[]>`
      WITH picked AS (
        SELECT t.id, t.state AS prior_state
        FROM propagation_tasks t
        WHERE t.system = ${system}
          AND t.state IN ('queued', 'submitted')
          AND t.next_run_at <= now()
          AND (t.locked_until IS NULL OR t.locked_until < now())
          AND NOT EXISTS (
            SELECT 1 FROM propagation_tasks e
            WHERE e.key_id = t.key_id AND e.system = t.system AND e.id < t.id
              AND e.state IN ('queued', 'submitted'))
        ORDER BY (t.action = 'delete') DESC, t.next_run_at
        LIMIT ${limit}
        FOR UPDATE OF t SKIP LOCKED
      )
      UPDATE propagation_tasks t
      SET locked_until = ${inMs(sql, this.opts.leaseMs)},
          started_at = COALESCE(t.started_at, now()),
          attempts = t.attempts + (t.state = 'queued')::int,
          outcome_uncertain = t.outcome_uncertain OR t.state = 'queued'
      FROM picked
      WHERE t.id = picked.id
      RETURNING t.id::int AS id, t.key_id, t.system, t.action, t.state, t.attempts,
                t.idempotency_key, t.operation_id, (picked.prior_state = 'queued') AS was_queued`;

    // Show "attempt N" on the page. Done after the claim commits so the claim never holds task
    // locks while waiting for a key lock (writers always lock the key first).
    for (const keyId of new Set(tasks.filter((t) => t.was_queued).map((t) => t.key_id))) {
      await touchKey(sql, keyId);
    }
    return tasks;
  }

  private async run(task: ClaimedTask): Promise<void> {
    let outcome: Outcome;
    try {
      outcome = await this.execute(task);
    } catch (err) {
      outcome = { kind: 'retry', error: `worker error: ${String(err)}`, certain: false };
    }
    try {
      await this.apply(task, outcome);
    } catch (err) {
      // Leave the lease to expire; the task will be claimed and executed again.
      this.opts.log('apply failed', { task: task.id, error: String(err) });
    }
  }

  private async execute(task: ClaimedTask): Promise<Outcome> {
    if (task.system === 'gateway' && task.state === 'submitted' && task.operation_id) {
      return this.gateway.poll(task.operation_id);
    }
    // Only the hash is ever sent downstream; it is read here rather than copied into the task.
    const [key] = await this.sql<KeyMaterial[]>`
      SELECT key_id, customer_id, key_hash FROM api_keys WHERE key_id = ${task.key_id}`;
    if (!key) return { kind: 'rejected', error: 'key row missing' };
    return task.system === 'metering'
      ? this.metering.apply(task.action, key)
      : this.gateway.submit(task.action, key, task.idempotency_key);
  }

  private async apply(task: ClaimedTask, outcome: Outcome): Promise<void> {
    const sql = this.sql;
    const breaker = this.breakers[task.system];
    const pollAt = inMs(sql, this.opts.gatewayPollMs);

    switch (outcome.kind) {
      case 'done':
      case 'rejected': {
        breaker.success();
        const state = outcome.kind === 'done' ? 'succeeded' : 'failed';
        const error = outcome.kind === 'rejected' ? outcome.error : null;
        await sql.begin(async (tx) => {
          await lockKey(tx, task.key_id);
          const done = await tx`
            UPDATE propagation_tasks
            SET state = ${state}, last_error = ${error}, outcome_uncertain = false,
                finished_at = now(), locked_until = NULL
            WHERE id = ${task.id} AND state IN ('queued', 'submitted')
            RETURNING id`;
          if (done.length === 0) return; // already settled by another worker
          await settleKey(tx, task.key_id);
          await touchKey(tx, task.key_id);
          await notifyWorkers(tx); // a follow-up task may have been queued or unblocked
        });
        return;
      }

      case 'accepted': {
        breaker.success();
        await sql.begin(async (tx) => {
          await lockKey(tx, task.key_id);
          await tx`
            UPDATE propagation_tasks
            SET state = 'submitted', operation_id = ${outcome.operationId}, outcome_uncertain = false,
                last_error = NULL, next_run_at = ${pollAt}, locked_until = NULL
            WHERE id = ${task.id} AND state = 'queued'`;
          await touchKey(tx, task.key_id);
        });
        return;
      }

      case 'pending': {
        breaker.success();
        await sql`
          UPDATE propagation_tasks SET next_run_at = ${pollAt}, locked_until = NULL
          WHERE id = ${task.id} AND state = 'submitted'`;
        return;
      }

      case 'retry': {
        breaker.failure();
        const delay = backoffMs(task.attempts, this.opts.backoff);
        this.opts.log('retrying', { task: task.id, system: task.system, action: task.action, attempt: task.attempts, error: outcome.error });
        await sql.begin(async (tx) => {
          await lockKey(tx, task.key_id);
          await tx`
            UPDATE propagation_tasks
            SET last_error = ${outcome.error}, outcome_uncertain = ${!outcome.certain},
                next_run_at = ${inMs(tx, delay)}, locked_until = NULL
            WHERE id = ${task.id} AND state = 'queued'`;
          await touchKey(tx, task.key_id);
        });
        return;
      }

      case 'poll_error': {
        breaker.failure();
        await sql`
          UPDATE propagation_tasks
          SET last_error = ${outcome.error}, next_run_at = ${pollAt}, locked_until = NULL
          WHERE id = ${task.id} AND state = 'submitted'`;
        return;
      }

      case 'lost_operation': {
        // Re-submit with the same Idempotency-Key; the outcome is unknown until the gateway answers.
        await sql`
          UPDATE propagation_tasks
          SET state = 'queued', operation_id = NULL, outcome_uncertain = true,
              next_run_at = now(), locked_until = NULL
          WHERE id = ${task.id} AND state = 'submitted'`;
        return;
      }
    }
  }
}
