'use client';

import React, { useMemo } from 'react';
import { CheckCircle, Clock, AlertTriangle } from 'lucide-react';
import { PaymentAccount, Transaction } from '@/types';
import { detectRecurring, day } from '@/lib/flows';
import { formatMoney } from '@/lib/money';

/**
 * Subscriptions & autopay across every account: what recurs, which account it
 * hits, whether this month is already paid, and what's coming next.
 * Detection is the same engine as /flow's recurring table (detectRecurring).
 */
export default function SubscriptionsPanel({ accounts, transactions, currency }: {
  accounts: PaymentAccount[];
  transactions: Transaction[];
  currency?: string;
}) {
  const todayISO = day(new Date().toISOString());
  const thisMonth = todayISO.slice(0, 7);

  const { active, lapsed, monthlyTotal, upcoming7 } = useMemo(() => {
    const items = detectRecurring(transactions, accounts, todayISO);
    const active = items.filter((r) => r.active).sort((a, b) => a.nextDue.localeCompare(b.nextDue));
    const lapsed = items.filter((r) => !r.active);
    const monthlyTotal = active.reduce((s, r) => s + r.monthlyCents, 0);
    const in7 = new Date(Date.parse(`${todayISO}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
    const upcoming7 = active.filter((r) => r.nextDue >= todayISO && r.nextDue <= in7);
    return { active, lapsed, monthlyTotal, upcoming7 };
  }, [transactions, accounts, todayISO]);

  const acctName = (id: string | null) => accounts.find((a) => a.id === id)?.name ?? 'Unknown account';
  const money = (cents: number) => formatMoney(cents / 100, currency);

  const status = (r: (typeof active)[number]) => {
    if (r.lastSeen.slice(0, 7) === thisMonth && r.cadence !== 'weekly') {
      return <span className="inline-flex items-center gap-1 text-xs text-[var(--accent-success)]"><CheckCircle className="w-3.5 h-3.5" aria-hidden="true" /> Paid this month</span>;
    }
    if (r.nextDue < todayISO) {
      return <span className="inline-flex items-center gap-1 text-xs text-[var(--accent-warning)]"><AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" /> Expected {r.nextDue} — not seen yet</span>;
    }
    const days = Math.round((Date.parse(`${r.nextDue}T00:00:00Z`) - Date.parse(`${todayISO}T00:00:00Z`)) / 86_400_000);
    return <span className="inline-flex items-center gap-1 text-xs text-[var(--foreground-secondary)]"><Clock className="w-3.5 h-3.5" aria-hidden="true" /> Due {days === 0 ? 'today' : `in ${days}d`}</span>;
  };

  if (active.length === 0 && lapsed.length === 0) {
    return (
      <p className="text-[var(--foreground-muted)] text-center py-10">
        No recurring payments detected yet — they appear after 3+ charges from the same merchant.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="rounded-xl border border-[var(--border-color)] bg-[var(--background-secondary)] p-4">
          <p className="text-xs text-[var(--foreground-muted)]">Active subscriptions</p>
          <p className="text-xl font-bold text-[var(--foreground)] mt-1">{active.length}</p>
        </div>
        <div className="rounded-xl border border-[var(--border-color)] bg-[var(--background-secondary)] p-4">
          <p className="text-xs text-[var(--foreground-muted)]">Monthly cost</p>
          <p className="text-xl font-bold text-[var(--foreground)] mt-1">{money(monthlyTotal)}/mo</p>
        </div>
        <div className="rounded-xl border border-[var(--border-color)] bg-[var(--background-secondary)] p-4">
          <p className="text-xs text-[var(--foreground-muted)]">Due in the next 7 days</p>
          <p className="text-xl font-bold text-[var(--foreground)] mt-1">
            {upcoming7.length} · {money(upcoming7.reduce((s, r) => s + r.medianCents, 0))}
          </p>
        </div>
      </div>

      <ul role="list" className="rounded-xl border border-[var(--border-color)] divide-y divide-[var(--border-color)]">
        {active.map((r) => (
          <li key={r.merchant} className="p-3 sm:p-4 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
            <div className="flex-1 min-w-0">
              <p className="font-medium text-[var(--foreground)] truncate">{r.merchant}</p>
              <p className="text-xs text-[var(--foreground-muted)]">
                {r.cadence} · from {acctName(r.accountId)} · last paid {r.lastSeen}
              </p>
            </div>
            <div className="flex items-center justify-between sm:justify-end gap-4 sm:text-right">
              <p className="font-semibold tabular-nums text-[var(--foreground)]">{money(r.medianCents)}</p>
              {status(r)}
            </div>
          </li>
        ))}
      </ul>

      {lapsed.length > 0 && (
        <details>
          <summary className="cursor-pointer min-h-[44px] flex items-center text-sm text-[var(--foreground-secondary)] select-none">
            Lapsed / cancelled ({lapsed.length})
          </summary>
          <ul role="list" className="rounded-xl border border-[var(--border-color)] divide-y divide-[var(--border-color)] mt-2 opacity-70">
            {lapsed.map((r) => (
              <li key={r.merchant} className="p-3 flex items-center gap-4">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-[var(--foreground)] truncate">{r.merchant}</p>
                  <p className="text-xs text-[var(--foreground-muted)]">{r.cadence} · last seen {r.lastSeen}</p>
                </div>
                <p className="text-sm tabular-nums text-[var(--foreground-secondary)]">{money(r.medianCents)}</p>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
