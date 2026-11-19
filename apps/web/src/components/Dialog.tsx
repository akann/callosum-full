import { useEffect, useRef, type ReactNode } from 'react';

/** Thin wrapper over the native <dialog>, which gives focus trapping and Escape for free. */
export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-label={title}
      className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-lg border border-neutral-300 p-0 shadow-xl backdrop:bg-neutral-900/40"
    >
      <div className="p-5">
        <h2 className="text-base font-semibold text-neutral-900">{title}</h2>
        {children}
      </div>
    </dialog>
  );
}
