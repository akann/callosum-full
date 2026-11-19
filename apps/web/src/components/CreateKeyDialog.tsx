import { useRef, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CreateKeyResponse } from '@callosum/shared';
import { api } from '../lib/api.ts';
import { upsertKey } from '../lib/useKeys.ts';
import { Dialog } from './Dialog.tsx';

export function CreateKeyDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (res: CreateKeyResponse) => void }) {
  const client = useQueryClient();
  const [name, setName] = useState('');
  // One idempotency key per open dialog: a double click or a retried request cannot mint two keys.
  const requestId = useRef(crypto.randomUUID());

  const create = useMutation({
    mutationFn: () => api.createKey(name.trim(), requestId.current),
    onSuccess: (res) => {
      upsertKey(client, res.key);
      onCreated(res);
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim() && !create.isPending) create.mutate();
  };

  return (
    <Dialog title="Create API key" onClose={onClose}>
      <form onSubmit={submit} className="mt-4">
        <label htmlFor="key-name" className="block text-sm font-medium text-neutral-800">
          Name
        </label>
        <input
          id="key-name"
          autoFocus
          maxLength={64}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Prod backend"
          className="mt-1 w-full rounded border border-neutral-400 px-3 py-2 text-sm"
        />
        <p className="mt-2 text-xs text-neutral-500">
          The secret is shown once, right after creation. The key starts working when its status reaches active.
        </p>
        {create.isError && (
          <p role="alert" className="mt-3 text-sm text-red-700">
            {create.error.message}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded border border-neutral-400 px-3 py-1.5 text-sm hover:bg-neutral-100">
            Cancel
          </button>
          <button
            type="submit"
            disabled={!name.trim() || create.isPending}
            className="rounded bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
          >
            {create.isPending ? 'Creating…' : 'Create key'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
