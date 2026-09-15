'use client';

/**
 * #201 — the assumption knobs, in one place instead of scattered over Forecast:
 *
 * - assumedMonthlySpend: when set, it replaces the derived 6-month average everywhere
 *   runway is computed (Home, Forecast, homeSnapshot). Chat's set_monthly_spend writes
 *   the same field. `null` means "use what I actually spend".
 * - emergencyFundGoal: reserve months, the goal EmergencyFundPanel measures against
 *   (3 when unset). A saved month goal also clears a fixed-amount goal, because the
 *   panel lets an amount win over months and the owner just said "months".
 *
 * Validation is the engine's own: sanitizeAssumedSpend keeps only a finite value > 0,
 * so a blank, zero or negative entry can never become a fabricated burn.
 */
import React, { useState } from 'react';
import { useUserProfile } from '@/context/UserProfileContext';
import { formatMoney } from '@/lib/money';
import { sanitizeAssumedSpend, type ProfileSettings } from '@/lib/profile-settings';

const DEFAULT_RESERVE_MONTHS = 3;

export default function AssumptionsSettings() {
  const { profile, updateProfile } = useUserProfile();
  const stored = sanitizeAssumedSpend(profile?.settings?.assumedMonthlySpend);
  const fixedReserve = profile?.settings?.emergencyFundAmount || null;
  const [spend, setSpend] = useState(stored !== null ? String(stored) : '');
  const [months, setMonths] = useState(String(profile?.settings?.emergencyFundGoal || DEFAULT_RESERVE_MONTHS));
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);

  // updateProfile merges settings itself and reports a confirmed failure as `false`
  // (it rolls the optimistic change back), so the result is checked, not caught.
  const save = async (patch: Partial<ProfileSettings>, done: string) => {
    setMessage(null);
    const ok = await updateProfile({ settings: patch });
    setMessage(ok ? { error: false, text: done } : { error: true, text: 'Could not save that setting. Check your connection and try again.' });
  };

  const spendValue = sanitizeAssumedSpend(spend.trim() === '' ? null : Number(spend));
  const monthsValue = Number(months);
  const monthsValid = Number.isInteger(monthsValue) && monthsValue >= 1 && monthsValue <= 24;

  return (
    <div className="glass-card p-4 space-y-5">
      <div>
        <label htmlFor="assumed-spend" className="font-medium text-[var(--foreground)]">Monthly spending for runway</label>
        <p className="text-sm text-[var(--foreground-muted)] mt-1">
          {stored !== null
            ? `Runway uses your number, ${formatMoney(stored, profile?.currency, 0)} a month, instead of what you actually spend.`
            : 'Runway uses what you actually spend (6-month average). Enter a number to plan with your own.'}
        </p>
        <div className="mt-2 flex items-center gap-2 flex-wrap">
          <input
            id="assumed-spend"
            type="number"
            inputMode="decimal"
            min="0"
            value={spend}
            onChange={(e) => setSpend(e.target.value)}
            placeholder="Actual spending"
            className="input-field max-w-[12rem]"
          />
          <button
            onClick={() => save({ assumedMonthlySpend: spendValue }, spendValue === null ? 'Runway now uses your actual spending.' : 'Saved.')}
            disabled={spend.trim() !== '' && spendValue === null}
            className="btn-secondary min-h-[44px] px-4 text-sm disabled:opacity-50"
          >
            Save
          </button>
          {stored !== null && (
            <button
              onClick={() => { setSpend(''); save({ assumedMonthlySpend: null }, 'Runway now uses your actual spending.'); }}
              className="tap-target text-sm font-medium text-[var(--accent-primary)]"
            >
              Use actual spending
            </button>
          )}
        </div>
      </div>

      <div className="border-t border-[var(--border-color)] pt-5">
        <label htmlFor="reserve-months" className="font-medium text-[var(--foreground)]">Reserve goal</label>
        <p className="text-sm text-[var(--foreground-muted)] mt-1">
          {fixedReserve
            ? `Your reserve goal is a fixed ${formatMoney(fixedReserve, profile?.currency, 0)}. Saving months here replaces it.`
            : 'How many months of spending you want to keep as an emergency fund.'}
        </p>
        <div className="mt-2 flex items-center gap-2 flex-wrap">
          <input
            id="reserve-months"
            type="number"
            inputMode="numeric"
            min="1"
            max="24"
            step="1"
            value={months}
            onChange={(e) => setMonths(e.target.value)}
            className="input-field max-w-[6rem]"
          />
          <span className="text-sm text-[var(--foreground-secondary)]">months</span>
          <button
            onClick={() => save({ emergencyFundGoal: monthsValue, emergencyFundAmount: null }, 'Saved.')}
            disabled={!monthsValid}
            className="btn-secondary min-h-[44px] px-4 text-sm disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </div>

      {message && (
        <p role={message.error ? 'alert' : 'status'} className={`text-sm ${message.error ? 'text-[var(--money-out)]' : 'text-[var(--foreground-secondary)]'}`}>
          {message.text}
        </p>
      )}
    </div>
  );
}
