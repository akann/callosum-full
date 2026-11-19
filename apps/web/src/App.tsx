import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ApiKey, Role, Session } from '@callosum/shared';
import { CreateKeyDialog } from './components/CreateKeyDialog.tsx';
import { KeyRow } from './components/KeyRow.tsx';
import { LiveIndicator } from './components/LiveIndicator.tsx';
import { RevokeDialog } from './components/RevokeDialog.tsx';
import { SecretBanner } from './components/SecretBanner.tsx';
import { ensureSession, writeSession } from './lib/session.ts';
import { KEYS_QUERY, useKeys, useNow } from './lib/useKeys.ts';

export function App() {
  const client = useQueryClient();
  const [session, setSession] = useState<Session>(ensureSession);
  const canWrite = session.role === 'admin';
  const { data, isPending, isError, error, connection, lastEventAt } = useKeys(`${session.customer_id}|${session.role}`);

  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  // Held in memory only. Not in the query cache, not in storage: gone on reload.
  const [fresh, setFresh] = useState<{ name: string; secret: string } | null>(null);

  const now = useNow(true) + (data?.clockOffsetMs ?? 0);
  const keys = data?.keys ?? [];

  const switchRole = (role: Role) => {
    setSession(writeSession(role, session.customer_id));
    setFresh(null);
    void client.invalidateQueries({ queryKey: KEYS_QUERY });
  };

  return (
    <main className="mx-auto max-w-4xl px-4 py-8 font-sans text-neutral-900 sm:px-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">API keys</h1>
          <p className="mt-1 font-mono text-xs text-neutral-500">
            {session.customer_id} · signed in as {session.role}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-neutral-500" title="Auth is stubbed for this exercise">
            Dev role
            <select
              value={session.role}
              onChange={(e) => switchRole(e.target.value as Role)}
              className="rounded border border-neutral-300 bg-white px-1.5 py-1 text-xs text-neutral-800"
            >
              <option value="admin">admin</option>
              <option value="member">member</option>
            </select>
          </label>
          {canWrite && (
            <button type="button" onClick={() => setCreating(true)} className="rounded bg-neutral-900 px-3 py-2 text-sm font-medium text-white hover:bg-neutral-700">
              + Create key
            </button>
          )}
        </div>
      </header>

      <div className="mt-6">
        {fresh && <SecretBanner name={fresh.name} secret={fresh.secret} onDismiss={() => setFresh(null)} />}

        <div className="rounded-lg border border-neutral-200">
          <div className="hidden sm:grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_7.5rem_4.5rem_5rem] gap-3 border-b border-neutral-200 px-4 py-2 text-[0.6875rem] font-semibold tracking-wider text-neutral-500 uppercase">
            <span>Name</span>
            <span>Prefix</span>
            <span>Status</span>
            <span>Created</span>
            <span />
          </div>
          {isPending && <p className="px-4 py-6 text-sm text-neutral-500">Loading keys…</p>}
          {isError && (
            <p role="alert" className="px-4 py-6 text-sm text-red-700">
              Could not load keys: {error.message}
            </p>
          )}
          {!isPending && !isError && keys.length === 0 && (
            <p className="px-4 py-6 text-sm text-neutral-500">No API keys yet.{canWrite ? ' Create one to start calling the compute API.' : ''}</p>
          )}
          <ul className="px-4" aria-label="API keys">
            {keys.map((k) => (
              <KeyRow key={k.key_id} apiKey={k} now={now} canWrite={canWrite} onRevoke={setRevoking} />
            ))}
          </ul>
        </div>

        <footer className="mt-3 flex flex-wrap justify-between gap-2 text-xs text-neutral-500">
          <LiveIndicator connection={connection} lastEventAt={lastEventAt} now={now - (data?.clockOffsetMs ?? 0)} />
          {!canWrite && <span>Members see this page read-only</span>}
        </footer>
      </div>

      {creating && (
        <CreateKeyDialog
          onClose={() => setCreating(false)}
          onCreated={(res) => {
            setFresh({ name: res.key.name, secret: res.secret });
            setCreating(false);
          }}
        />
      )}
      {revoking && <RevokeDialog apiKey={revoking} onClose={() => setRevoking(null)} />}
    </main>
  );
}
