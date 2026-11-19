import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ApiKey } from '@callosum/shared';
import { api } from '../lib/api.ts';
import { upsertKey } from '../lib/useKeys.ts';
import { Dialog } from './Dialog.tsx';

export function RevokeDialog({ apiKey, onClose }: { apiKey: ApiKey; onClose: () => void }) {
  const client = useQueryClient();
  const revoke = useMutation({
    mutationFn: () => api.revokeKey(apiKey.key_id),
    onSuccess: (res) => {
      upsertKey(client, res.key);
      onClose();
    },
  });

  return (
    <Dialog title={`Revoke “${apiKey.name}”?`} onClose={onClose}>
      <p className="mt-3 text-sm text-neutral-700">
        <code className="font-mono">{apiKey.prefix}…</code> will stop working and cannot be restored.
      </p>
      <p className="mt-3 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
        Revocation is not instant. The key may still be accepted until the gateway confirms, usually within seconds and
        occasionally up to a minute and a half. This page shows when it has.
      </p>
      {revoke.isError && (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {revoke.error.message}
        </p>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="rounded border border-neutral-400 px-3 py-1.5 text-sm hover:bg-neutral-100">
          Cancel
        </button>
        <button
          type="button"
          disabled={revoke.isPending}
          onClick={() => revoke.mutate()}
          className="rounded bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-800 disabled:opacity-50"
        >
          {revoke.isPending ? 'Revoking…' : 'Revoke key'}
        </button>
      </div>
    </Dialog>
  );
}
