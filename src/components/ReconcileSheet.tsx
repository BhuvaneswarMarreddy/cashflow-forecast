'use client';

import React, { useState } from 'react';
import Sheet from '@/components/Sheet';
import { formatMoneyCents } from '@/lib/money';
import { DriftStatus } from '@/types';

const fmt = (n: number) => `$${Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

interface ReconcileResult {
  driftCents: number;
  status: DriftStatus;
  /** True only when reconcileAccount could not even attempt a measurement (no
   *  profile loaded, or the account no longer exists) — #83 round 4a Defect 4.
   *  Absent on every real call, including a legitimate NOT_APPLICABLE, which (after
   *  Defect 1) DOES write a reanchor — so "absent" correctly still means "happened". */
  failed?: true;
}

/**
 * INV-1 Fix 3 — the wording reconcile()'s measurement finally gets. Each status means
 * something different about THIS INSTANT and must not be flattened into one generic
 * "Saved":
 *  - VIOLATION is not an error. A non-zero drift is the reason the owner opened this
 *    sheet — recording it is the whole point, so this reads as a recorded fact, never
 *    a failure or a warning (styled that way in the caller below too).
 *  - STALE_INPUT says plainly that the provider data predates the last scheduled sync,
 *    so the drift can't be confidently pinned on the account rather than a lag.
 *  - NOT_APPLICABLE is honest that there was no prior claim to have been wrong about.
 *
 * `enteredCents` is what the OWNER just typed (already in scope in the caller), not
 * part of the reconcile result — PASS and NOT_APPLICABLE want to show it directly
 * rather than a $0.00 "drift" that would read as a measurement nobody made.
 *
 * `failed` is checked FIRST, ahead of the status switch: the two guard clauses in
 * reconcileAccount hard-code status: 'NOT_APPLICABLE' when there's no profile or the
 * account vanished, and that branch's copy below claims "it's now anchored" — true
 * for a real NOT_APPLICABLE (which does write), false when nothing ran at all
 * (#83 round 4a Defect 4).
 */
function resultMessage(r: ReconcileResult, enteredCents: number, currency: string): string {
  if (r.failed) return "That couldn't be checked — nothing was saved. Please try again.";
  const off = formatMoneyCents(Math.abs(r.driftCents), currency);
  const entered = formatMoneyCents(enteredCents, currency);
  switch (r.status) {
    case 'PASS':
      return `Matches what you entered — ${entered}. Nothing to fix.`;
    case 'VIOLATION':
      return `Off by ${off}. Recorded — this account is now anchored to ${entered}.`;
    case 'STALE_INPUT':
      return `Off by ${off}, but the last provider check is older than the next scheduled sync, so this difference can't be confidently attributed yet. Recorded anyway — the account is now anchored to ${entered}.`;
    case 'NOT_APPLICABLE':
      return `No starting balance was set before, so there was nothing to compare against. It's now anchored to ${entered}.`;
    default:
      // Unreached for a real DriftStatus; guards a test double or a future enum
      // member from rendering nothing rather than crashing the sheet.
      return `Saved — ${entered}.`;
  }
}

/** PASS is reassurance (success green); nothing else is styled as good/bad — a real
 *  drift is an expected outcome of reconciling, not a pass/fail result. `failed` IS
 *  a real failure (the call never ran), unlike every DriftStatus, so it alone gets
 *  the danger tone. */
function resultTone(r: ReconcileResult): string {
  if (r.failed) return 'text-[var(--accent-danger)]';
  return r.status === 'PASS' ? 'text-[var(--accent-success)]' : 'text-[var(--foreground-secondary)]';
}

/**
 * Replaces the window.prompt/alert reconcile flow: enter the real balance,
 * see the drift against the app's derived number live, confirm to re-anchor.
 * The math stays in reconcileAccount — this is only the input surface.
 *
 * After Confirm, shows what reconcile() actually found (INV-1 Fix 3) instead of
 * closing straight away — the observation is the only reason this screen exists.
 */
export default function ReconcileSheet({ accountName, inputLabel, derivedCurrent, currency = 'USD', onConfirm, onClose }: {
  accountName: string;
  /** e.g. "real balance right now" | "amount you currently owe" */
  inputLabel: string;
  derivedCurrent: number;
  currency?: string;
  onConfirm: (entered: number) => Promise<ReconcileResult>;
  onClose: () => void;
}) {
  const [value, setValue] = useState(() => String(Math.round(derivedCurrent * 100) / 100));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ReconcileResult | null>(null);
  const entered = parseFloat(value);
  const valid = !Number.isNaN(entered);
  const driftCents = valid ? Math.round((entered - derivedCurrent) * 100) : 0;

  const confirm = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      setResult(await onConfirm(entered));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open onClose={onClose} ariaLabel={`Reconcile ${accountName}`} className="p-5 sm:p-8">
      <h2 className="text-xl font-bold text-[var(--foreground)] mb-1">Reconcile {accountName}</h2>

      {result ? (
        <>
          <p role="status" aria-live="polite" className={`text-sm mb-5 ${resultTone(result)}`}>
            {resultMessage(result, Math.round(entered * 100), currency)}
          </p>
          <div className="flex justify-end">
            <button onClick={onClose} className="btn-primary">Done</button>
          </div>
        </>
      ) : (
        <>
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
        </>
      )}
    </Sheet>
  );
}
