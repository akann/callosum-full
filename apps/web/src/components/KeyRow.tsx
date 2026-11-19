import type { ApiKey } from '@callosum/shared';
import { formatCreated } from '../lib/format.ts';
import { StatusPill } from './StatusPill.tsx';
import { SystemLine } from './SystemLine.tsx';

const REVOCABLE = new Set<ApiKey['status']>(['provisioning', 'active']);

export function KeyRow({ apiKey, now, canWrite, onRevoke }: { apiKey: ApiKey; now: number; canWrite: boolean; onRevoke: (key: ApiKey) => void }) {
  const muted = apiKey.status === 'revoked';
  const gateway = apiKey.systems.find((s) => s.system === 'gateway');
  const gatewayConfirmed = gateway?.action === 'delete' && gateway.state === 'succeeded';
  // Detail is shown while something is in motion, and kept for failures so the reason stays visible.
  const showSystems = apiKey.systems.length > 0 && (apiKey.status === 'provisioning' || apiKey.status === 'revoking' || apiKey.status === 'failed');

  return (
    <li data-testid="key-row" data-key-id={apiKey.key_id} className="border-t border-neutral-200 py-3 first:border-t-0">
      {/* Phone: name + action on one line, details on the next. From sm up: the five table columns. */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 text-sm sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_7.5rem_4.5rem_5rem]">
        <span className={`order-1 truncate ${muted ? 'text-neutral-400' : 'font-medium text-neutral-900'}`}>{apiKey.name}</span>
        <div className="order-3 col-span-2 flex flex-wrap items-center gap-x-3 gap-y-1 sm:contents">
          <code className={`truncate font-mono text-xs sm:order-2 ${muted ? 'text-neutral-400' : 'text-neutral-600'}`}>{apiKey.prefix}</code>
          <span className="sm:order-2">
            <StatusPill status={apiKey.status} />
          </span>
          <span className={`text-xs sm:order-2 ${muted ? 'text-neutral-400' : 'text-neutral-600'}`}>{formatCreated(apiKey.created_at, new Date(now))}</span>
        </div>
        <span className="order-2 text-right sm:order-3">
          {canWrite && REVOCABLE.has(apiKey.status) && (
            <button
              type="button"
              onClick={() => onRevoke(apiKey)}
              className="rounded border border-neutral-400 px-2.5 py-1 text-xs hover:bg-neutral-100"
              aria-label={`Revoke ${apiKey.name}`}
            >
              Revoke
            </button>
          )}
        </span>
      </div>

      {showSystems && (
        <div className="mt-2 rounded bg-neutral-50 px-3 py-2">
          {apiKey.status === 'provisioning' && <p className="mb-1.5 text-xs text-neutral-600">Not usable yet: waiting for both systems.</p>}
          {apiKey.status === 'revoking' && !gatewayConfirmed && (
            <p className="mb-1.5 text-xs font-semibold text-amber-800" data-testid="revoke-warning">
              ⚠ May still be accepted until the gateway confirms
            </p>
          )}
          {apiKey.status === 'revoking' && gatewayConfirmed && (
            <p className="mb-1.5 text-xs text-neutral-600">Gateway has confirmed: this key is no longer accepted.</p>
          )}
          {apiKey.status === 'failed' && <p className="mb-1.5 text-xs text-red-700">The gateway rejected this key. It was never usable; create a new one.</p>}
          <div className="grid gap-1 sm:grid-cols-2">
            {apiKey.systems.map((s) => (
              <SystemLine key={s.system} system={s} now={now} />
            ))}
          </div>
        </div>
      )}
    </li>
  );
}
