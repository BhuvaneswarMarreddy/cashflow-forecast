'use client';

import React, { useState } from 'react';
import Sheet from '@/components/Sheet';

const fmt = (n: number) => `$${Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

/**
 * Replaces the window.prompt/alert reconcile flow: enter the real balance,
 * see the drift against the app's derived number live, confirm to re-anchor.
 * The math stays in reconcileAccount — this is only the input surface.
 */
export default function ReconcileSheet({ accountName, inputLabel, derivedCurrent, onConfirm, onClose }: {
  accountName: string;
  /** e.g. "real balance right now" | "amount you currently owe" */
  inputLabel: string;
  derivedCurrent: number;
  onConfirm: (entered: number) => Promise<void>;
  onClose: () => void;
}) {
  const [value, setValue] = useState(() => String(Math.round(derivedCurrent * 100) / 100));
  const [busy, setBusy] = useState(false);
  const entered = parseFloat(value);
  const valid = !Number.isNaN(entered);
  const driftCents = valid ? Math.round((entered - derivedCurrent) * 100) : 0;

  const confirm = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      await onConfirm(entered);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open onClose={onClose} ariaLabel={`Reconcile ${accountName}`} className="p-5 sm:p-8">
      <h2 className="text-xl font-bold text-[var(--foreground)] mb-1">Reconcile {accountName}</h2>
      <p className="text-sm text-[var(--foreground-secondary)] mb-4">
        Enter the {inputLabel} — straight from your bank app.
      </p>

      <label htmlFor="reconcile-balance" className="block text-sm text-[var(--foreground-secondary)] mb-1">
        Balance
      </label>
      <input
        id="reconcile-balance"
        type="text"
        inputMode="decimal"
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') confirm(); }}
        className="input-field w-full mb-3"
      />

      {/* Live drift preview — this line is the feedback the old alert() gave, but BEFORE committing */}
      <p aria-live="polite" className="text-sm mb-5 min-h-[2.5rem]">
        {!valid ? (
          <span className="text-[var(--accent-danger)]">Enter a number.</span>
        ) : driftCents === 0 ? (
          <span className="text-[var(--accent-success)]">Matches the app — nothing will change.</span>
        ) : (
          <span className="text-[var(--foreground-secondary)]">
            App shows {fmt(derivedCurrent)} · off by{' '}
            <span className={driftCents > 0 ? 'text-[var(--accent-success)]' : 'text-[var(--accent-danger)]'}>
              {driftCents > 0 ? '+' : '−'}{fmt(driftCents / 100)}
            </span>
            . Confirming re-anchors this account to your number as of today.
          </span>
        )}
      </p>

      <div className="flex gap-3 justify-end">
        <button onClick={onClose} className="btn-secondary" disabled={busy}>Cancel</button>
        <button onClick={confirm} className="btn-primary disabled:opacity-50" disabled={!valid || busy}>
          {busy ? 'Saving…' : driftCents === 0 ? 'Confirm — no change' : 'Re-anchor balance'}
        </button>
      </div>
    </Sheet>
  );
}
