import { formatAgo } from '../lib/format.ts';
import type { Connection } from '../lib/useKeys.ts';

export function LiveIndicator({ connection, lastEventAt, now }: { connection: Connection; lastEventAt: number | null; now: number }) {
  const live = connection === 'live';
  return (
    <span className="flex items-center gap-2" data-testid="live-indicator" data-connection={connection}>
      <span aria-hidden className={`inline-block size-2 rounded-full ${live ? 'bg-emerald-600' : 'animate-pulse bg-amber-500'}`} />
      {live ? 'Live' : connection === 'connecting' ? 'Connecting…' : 'Reconnecting… statuses may be out of date'}
      {live && lastEventAt !== null && <span>· updated {formatAgo(now - lastEventAt)}</span>}
    </span>
  );
}
