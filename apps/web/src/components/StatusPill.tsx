import type { KeyStatus } from '@callosum/shared';

const styles: Record<KeyStatus, string> = {
  provisioning: 'border-dashed border-neutral-400 text-neutral-700',
  active: 'border-neutral-900 text-neutral-900',
  revoking: 'border-2 border-neutral-900 font-semibold text-neutral-900',
  revoked: 'border-neutral-200 bg-neutral-100 text-neutral-400',
  failed: 'border-red-300 bg-red-50 text-red-700',
};

export function StatusPill({ status }: { status: KeyStatus }) {
  return (
    <span data-testid="key-status" className={`inline-block rounded-full border px-3 py-0.5 text-xs ${styles[status]}`}>
      {status}
    </span>
  );
}
