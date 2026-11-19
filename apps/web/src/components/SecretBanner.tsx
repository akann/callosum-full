import { useState } from 'react';

/**
 * The one and only time the secret is visible. It lives in React state, never in storage,
 * so a reload or "I've saved it" drops it for good.
 */
export function SecretBanner({ name, secret, onDismiss }: { name: string; secret: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(secret);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <section role="status" aria-label="New key secret" className="mb-4 rounded-lg border border-neutral-300 bg-neutral-50 p-4">
      <p className="text-sm font-semibold text-neutral-900">
        New key “{name}”: copy the secret now. It won’t be shown again.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <code data-testid="secret" className="min-w-0 flex-1 overflow-x-auto rounded border border-neutral-300 bg-white px-3 py-1.5 font-mono text-sm whitespace-nowrap">
          {secret}
        </code>
        <button type="button" onClick={() => void copy()} className="rounded border border-neutral-400 bg-white px-3 py-1.5 text-sm hover:bg-neutral-100">
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" onClick={onDismiss} className="rounded border border-neutral-400 bg-white px-3 py-1.5 text-sm hover:bg-neutral-100">
          I’ve saved it
        </button>
      </div>
      <p className="mt-3 text-xs text-neutral-600">
        This key won’t work yet. Requests using it are rejected until its status below changes to <strong>active</strong>.
      </p>
    </section>
  );
}
