import { systemDisplayState, type SystemStatus } from '@callosum/shared';
import { formatElapsed } from '../lib/format.ts';

const labels = { gateway: 'Gateway', metering: 'Metering' } as const;

/** One downstream system: state, attempts, last error, elapsed. */
export function SystemLine({ system, now }: { system: SystemStatus; now: number }) {
  const state = systemDisplayState(system);
  const settled = system.finished_at !== null;
  const elapsed = (settled ? new Date(system.finished_at!).getTime() : now) - new Date(system.created_at).getTime();
  const verb = system.action === 'delete' ? 'remove' : 'add';

  const parts: string[] = [state];
  if (state === 'waiting') parts.push(`for the earlier ${system.action === 'delete' ? 'add' : 'remove'} to settle`);
  if (system.attempts > 0 && !settled) parts.push(`attempt ${system.attempts}`);
  if (system.attempts > 1 && settled && state === 'done') parts.push(`${system.attempts} attempts`);
  if (system.last_error && state !== 'done') parts.push(system.last_error);
  if (state !== 'cancelled') parts.push(formatElapsed(elapsed));

  return (
    <div className="flex gap-2 text-xs" data-testid={`system-${system.system}`} data-state={state}>
      <span className="w-16 shrink-0 font-semibold text-neutral-900">{labels[system.system]}</span>
      <span className={state === 'failed' ? 'text-red-700' : state === 'retrying' ? 'text-amber-700' : 'text-neutral-600'}>
        <span className="sr-only">{verb}: </span>
        {parts.join(' · ')}
      </span>
    </div>
  );
}
