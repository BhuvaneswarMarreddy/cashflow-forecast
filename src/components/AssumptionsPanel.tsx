'use client';

import React from 'react';
import { Lightbulb, ChevronDown } from 'lucide-react';
import { Assumptions, AssumptionOverrides, IncomeCadence } from '@/lib/behavior';
import { saveOverrides } from '@/lib/assumption-overrides';
import { formatMoney } from '@/lib/money';
import { format, parseISO } from 'date-fns';

/**
 * "What this forecast believes" — the behavior engine's assumptions, each row
 * correctable. Every correction is an AssumptionOverride: persisted to
 * localStorage and pushed up so the parent regenerates the forecast live.
 */

const CADENCE_LABEL: Record<string, string> = {
  weekly: 'every week',
  biweekly: 'every 2 weeks',
  semimonthly: 'twice a month',
  monthly: 'every month',
  quarterly: 'every 3 months',
  yearly: 'every year',
};

function ConfidenceDot({ confidence }: { confidence: number }) {
  const color =
    confidence >= 0.8 ? 'var(--accent-success)'
    : confidence >= 0.5 ? 'var(--accent-warning)'
    : 'var(--accent-danger)';
  const pct = Math.round(confidence * 100);
  return (
    <span
      role="img"
      aria-label={`Confidence ${pct}%`}
      title={`Confidence ${pct}%`}
      className="inline-block w-2 h-2 rounded-full shrink-0"
      style={{ backgroundColor: color }}
    />
  );
}

/** Uncontrolled dollar input that commits on blur/Enter — typing must not regenerate the forecast per keystroke. */
function AmountInput({ label, value, onCommit }: {
  label: string;
  value: number;
  onCommit: (n: number) => void;
}) {
  return (
    <input
      key={value} // reset the DOM value when a regenerated assumption changes it
      type="text"
      inputMode="decimal"
      aria-label={label}
      defaultValue={String(Math.round(value * 100) / 100)}
      onBlur={(e) => {
        const n = parseFloat(e.target.value);
        if (!Number.isNaN(n) && n >= 0 && n !== value) onCommit(n);
      }}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      className="input-field w-28 min-h-[44px] text-right tabular-nums"
    />
  );
}

const sectionTitle = 'text-xs font-semibold text-[var(--foreground-muted)] uppercase tracking-wide mb-2';
const listClass = 'rounded-xl border border-[var(--border-color)] divide-y divide-[var(--border-color)]';
const quietBtn = 'min-h-[44px] px-3 text-xs font-semibold rounded-lg border border-[var(--border-color)] text-[var(--foreground-secondary)] hover:text-[var(--foreground)] hover:bg-[var(--background-tertiary)] transition-colors';

export default function AssumptionsPanel({ assumptions, onOverridesChange }: {
  assumptions: Assumptions;
  onOverridesChange: (o: AssumptionOverrides) => void;
}) {
  const o = assumptions.overrides;
  const commit = (next: AssumptionOverrides) => {
    saveOverrides(next);
    onOverridesChange(next);
  };

  // --- mutation helpers ------------------------------------------------
  const patchIncome = (patch: { amount?: number; cadence?: IncomeCadence }) =>
    commit({ ...o, income: { ...(o.income ?? {}), ...patch } });
  const removeIncome = () => commit({ ...o, income: null });
  const undoRemoveIncome = () => {
    const { income: _removed, ...rest } = o;
    commit(rest);
  };
  const patchBill = (merchant: string, patch: { amount?: number; disabled?: boolean }) =>
    commit({ ...o, bills: { ...o.bills, [merchant]: { ...o.bills?.[merchant], ...patch } } });
  const setBaseline = (category: string, v: number | null) =>
    commit({ ...o, baselines: { ...o.baselines, [category]: v } });
  const restoreBaseline = (category: string) => {
    const rest = { ...o.baselines };
    delete rest[category];
    commit({ ...o, baselines: rest });
  };

  const disabledBills = Object.entries(o.bills ?? {}).filter(([, v]) => v.disabled);
  const removedBaselines = Object.entries(o.baselines ?? {}).filter(([, v]) => v === null);
  const ex = assumptions.exclusions;
  const inc = assumptions.income;

  return (
    <details open className="group bg-[var(--background-secondary)] border border-[var(--border-color)] rounded-xl shadow-sm">
      <summary className="cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden p-6 flex items-center gap-3 min-h-[44px]">
        <div className="w-12 h-12 rounded-xl bg-[var(--accent-primary)]/10 flex items-center justify-center border border-[var(--accent-primary)]/20 shrink-0">
          <Lightbulb className="w-6 h-6 text-[var(--accent-primary)]" aria-hidden="true" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-xl font-bold text-[var(--foreground)]">What this forecast believes</h3>
          <p className="text-sm text-[var(--foreground-muted)] mt-0.5">
            Detected from your transactions — correct anything that looks wrong
          </p>
        </div>
        <ChevronDown
          className="w-5 h-5 text-[var(--foreground-muted)] transition-transform group-open:rotate-180 shrink-0"
          aria-hidden="true"
        />
      </summary>

      <div className="px-6 pb-6 space-y-6">
        {/* Income */}
        <section aria-label="Income assumption">
          <h4 className={sectionTitle}>Income</h4>
          {inc ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <ConfidenceDot confidence={inc.confidence} />
              <p className="text-sm text-[var(--foreground)]">
                {inc.label} ~{formatMoney(inc.medianAmount)} {CADENCE_LABEL[inc.cadence]} · next
                expected {format(parseISO(inc.nextDate), 'MMM d')}
              </p>
              <div className="flex items-center gap-2 ml-auto">
                <AmountInput
                  label="Paycheck amount in dollars"
                  value={inc.medianAmount}
                  onCommit={(n) => patchIncome({ amount: n })}
                />
                <select
                  aria-label="Pay cadence"
                  value={inc.cadence}
                  onChange={(e) => patchIncome({ cadence: e.target.value as IncomeCadence })}
                  className="input-field min-h-[44px] text-sm"
                >
                  <option value="weekly">Weekly</option>
                  <option value="biweekly">Every 2 weeks</option>
                  <option value="semimonthly">Twice a month</option>
                  <option value="monthly">Monthly</option>
                </select>
                <button onClick={removeIncome} className={`${quietBtn} text-[var(--accent-danger)]`}>
                  Remove
                </button>
              </div>
            </div>
          ) : o.income === null ? (
            <p className="text-sm text-[var(--foreground-muted)]">
              Income removed from the forecast.{' '}
              <button onClick={undoRemoveIncome} className="min-h-[44px] px-2 text-sm font-semibold text-[var(--accent-primary)] hover:underline">
                Undo
              </button>
            </p>
          ) : (
            <p className="text-sm text-[var(--foreground-muted)]">
              No paycheck pattern detected yet — appears after 3+ paychecks in your history.
            </p>
          )}
        </section>

        {/* Fixed bills */}
        <section aria-label="Fixed bills">
          <h4 className={sectionTitle}>Fixed bills</h4>
          {assumptions.fixedBills.length === 0 && disabledBills.length === 0 ? (
            <p className="text-sm text-[var(--foreground-muted)]">No recurring bills detected.</p>
          ) : (
            <ul role="list" className={listClass}>
              {assumptions.fixedBills.map((b) => (
                <li key={b.merchant} className="p-3 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <ConfidenceDot confidence={b.confidence} />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-[var(--foreground)] truncate">{b.merchant}</p>
                      <p className="text-xs text-[var(--foreground-muted)]">
                        {b.cadence} · next due {format(parseISO(b.nextDue), 'MMM d')}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <AmountInput
                      label={`${b.merchant} amount in dollars`}
                      value={b.amount}
                      onCommit={(n) => patchBill(b.merchant, { amount: n })}
                    />
                    <button
                      aria-pressed={false}
                      aria-label={`Disable ${b.merchant} in the forecast`}
                      onClick={() => patchBill(b.merchant, { disabled: true })}
                      className={quietBtn}
                    >
                      Disable
                    </button>
                  </div>
                </li>
              ))}
              {disabledBills.map(([merchant]) => (
                <li key={merchant} className="p-3 flex items-center gap-3 opacity-70">
                  <p className="flex-1 text-sm text-[var(--foreground-muted)] line-through truncate">{merchant}</p>
                  <button
                    aria-pressed={true}
                    aria-label={`Re-enable ${merchant} in the forecast`}
                    onClick={() => patchBill(merchant, { disabled: false })}
                    className={quietBtn}
                  >
                    Enable
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Spending baselines */}
        <section aria-label="Spending baselines">
          <h4 className={sectionTitle}>Spending baselines</h4>
          {assumptions.categoryBaselines.length === 0 && removedBaselines.length === 0 ? (
            <p className="text-sm text-[var(--foreground-muted)]">No spending baselines yet.</p>
          ) : (
            <ul role="list" className={listClass}>
              {assumptions.categoryBaselines.slice(0, 8).map((b) => (
                <li key={b.category} className="p-3 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-[var(--foreground)] truncate">{b.category}</p>
                    <p className="text-xs text-[var(--foreground-muted)]">
                      {formatMoney(b.monthlyMedian)}/mo
                      {b.monthsObserved > 0 ? ` · seen in ${b.monthsObserved} of the last 6 months` : ' · added by you'}
                    </p>
                  </div>
                  <AmountInput
                    label={`${b.category} monthly baseline in dollars`}
                    value={b.monthlyMedian}
                    onCommit={(n) => setBaseline(b.category, n)}
                  />
                  <button
                    aria-label={`Remove ${b.category} baseline from the forecast`}
                    onClick={() => setBaseline(b.category, null)}
                    className={`${quietBtn} text-[var(--accent-danger)]`}
                  >
                    Remove
                  </button>
                </li>
              ))}
              {removedBaselines.map(([category]) => (
                <li key={category} className="p-3 flex items-center gap-3 opacity-70">
                  <p className="flex-1 text-sm text-[var(--foreground-muted)] line-through truncate">{category}</p>
                  <button
                    aria-label={`Add ${category} baseline back to the forecast`}
                    onClick={() => restoreBaseline(category)}
                    className={quietBtn}
                  >
                    Add back
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Exclusions */}
        <section aria-label="Excluded from projections">
          <p className="text-xs text-[var(--foreground-muted)]">
            Ignored: {ex.transfers} transfers · {ex.cardPayments} card payments · {ex.refunds} refunds
            applied · {ex.oneTimes.length} one-time purchases excluded
          </p>
          {ex.oneTimes.length > 0 && (
            <details className="mt-1">
              <summary className="cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden min-h-[44px] flex items-center text-xs font-semibold text-[var(--foreground-secondary)] hover:text-[var(--foreground)]">
                Show excluded one-time purchases
              </summary>
              <ul role="list" className="mt-1 space-y-1">
                {ex.oneTimes.map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-3 text-xs text-[var(--foreground-muted)]">
                    <span className="truncate">
                      {format(parseISO(t.date), 'MMM d, yyyy')} · {t.title}
                    </span>
                    <span className="tabular-nums shrink-0">{formatMoney(t.amount, 'USD', 2)}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      </div>
    </details>
  );
}
