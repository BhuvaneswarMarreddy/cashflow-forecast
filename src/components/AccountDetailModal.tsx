'use client';

import React, { useMemo, useState } from 'react';
import {
  ResponsiveContainer, ComposedChart, Line, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { X } from 'lucide-react';
import { PaymentAccount, Transaction } from '@/types';
import { isPositive } from '@/lib/classify';
import { currentOf } from '@/lib/accounts';
import { formatMoney } from '@/lib/money';
import Sheet from '@/components/Sheet';
import ChartSrTable from '@/components/ChartSrTable';

type Range = 'all' | '12m' | 'ytd';
const RANGES: Array<{ key: Range; label: string }> = [
  { key: 'all', label: 'All time' },
  { key: '12m', label: 'Last 12 months' },
  { key: 'ytd', label: 'This year' },
];

const money = (n: number) => formatMoney(n);
const monthLabel = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
};

export default function AccountDetailModal({ account, transactions, onClose }: {
  account: PaymentAccount; transactions: Transaction[]; onClose: () => void;
}) {
  const [range, setRange] = useState<Range>('all');
  const isDebt = account.type === 'credit_card' || account.type === 'personal_loan';
  const current = currentOf(account);

  // What "money in / out" means depends on the account: a card payment is money PAID,
  // a purchase is money SPENT; a loan draw is BORROWED, a loan payment is PAID.
  const [inLabel, outLabel] =
    account.type === 'credit_card' ? ['Paid', 'Spent'] :
    account.type === 'personal_loan' ? ['Borrowed', 'Paid'] :
    ['In', 'Out'];

  const rows = useMemo(
    () => transactions
      .filter((t) => t.accountId === account.id)
      .sort((a, b) => a.date.localeCompare(b.date)),
    [transactions, account.id]
  );

  // Per-month money in / out, and the end-of-month running balance (a trajectory that
  // ends at the account's real current balance — so the endpoint is always correct).
  const data = useMemo(() => {
    const signed = (t: Transaction) => (isPositive(t, [account]) ? t.amount : -t.amount);
    const totalNet = rows.reduce((s, t) => s + signed(t), 0);
    // impliedStart makes the running balance land exactly on `current` at the end.
    let running = isDebt ? current + totalNet : current - totalNet;

    const byMonth = new Map<string, { month: string; in: number; out: number; balance: number }>();
    for (const t of rows) {
      const m = t.date.slice(0, 7);
      const s = signed(t);
      running = isDebt ? running - s : running + s; // debt: a payment (+s) lowers owed
      const e = byMonth.get(m) ?? { month: m, in: 0, out: 0, balance: 0 };
      if (s >= 0) e.in += t.amount; else e.out += t.amount;
      e.balance = running; // last write in the month = end-of-month balance
      byMonth.set(m, e);
    }
    let series = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));

    const now = new Date();
    if (range === '12m') {
      const cut = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1)).toISOString().slice(0, 7);
      series = series.filter((d) => d.month >= cut);
    } else if (range === 'ytd') {
      series = series.filter((d) => d.month >= `${now.getUTCFullYear()}-01`);
    }
    return series.map((d) => ({ ...d, label: monthLabel(d.month), out: -d.out }));
  }, [rows, account, isDebt, current, range]);

  const totalIn = data.reduce((s, d) => s + d.in, 0);
  const totalOut = data.reduce((s, d) => s + Math.abs(d.out), 0);

  return (
    <Sheet open onClose={onClose} ariaLabel={`${account.name} — balance and activity`} maxWidth="48rem">
        <div className="flex items-start justify-between p-5 border-b border-[var(--border-color)]">
          <div>
            <h2 className="text-xl font-bold text-[var(--foreground)]">{account.name}</h2>
            <p className={`text-lg font-semibold mt-1 ${isDebt ? 'text-[var(--accent-danger)]' : 'text-[var(--accent-success)]'}`}>
              {isDebt ? 'Owe ' : ''}{money(Math.abs(current))}
              {account.openingDate && <span className="text-xs text-[var(--foreground-muted)] font-normal"> · as of {account.openingDate.slice(0, 10)}</span>}
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-2 rounded-lg text-[var(--foreground-muted)] hover:bg-[var(--background-tertiary)]">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5">
          <div className="flex gap-1 rounded-lg bg-[var(--background-tertiary)] p-1 w-fit mb-4">
            {RANGES.map((r) => (
              <button
                key={r.key}
                onClick={() => setRange(r.key)}
                className={`px-3 py-1.5 rounded-md text-sm ${range === r.key ? 'bg-[var(--accent-primary)] text-[#16181c]' : 'text-[var(--foreground-secondary)]'}`}
              >
                {r.label}
              </button>
            ))}
          </div>

          {data.length === 0 ? (
            <p className="text-[var(--foreground-muted)] text-center py-12">No transactions for this account in this period.</p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 mb-4">
                <div className="rounded-xl bg-[var(--background-tertiary)] p-3">
                  <p className="text-xs text-[var(--foreground-muted)]">{inLabel}</p>
                  <p className="text-lg font-bold text-[var(--accent-success)]">{money(totalIn)}</p>
                </div>
                <div className="rounded-xl bg-[var(--background-tertiary)] p-3">
                  <p className="text-xs text-[var(--foreground-muted)]">{outLabel}</p>
                  <p className="text-lg font-bold text-[var(--accent-danger)]">{money(totalOut)}</p>
                </div>
              </div>

              {/* max-sm: shrinks tick labels on phones only; desktop stays pixel-identical */}
              <div
                className="h-[240px] sm:h-[300px] max-sm:[&_.recharts-cartesian-axis-tick-value]:text-[10px]"
                role="img"
                aria-label={`${account.name} monthly activity chart: ${money(totalIn)} ${inLabel.toLowerCase()}, ${money(totalOut)} ${outLabel.toLowerCase()}, ending at ${money(Math.abs(current))}${isDebt ? ' owed' : ''}.`}
              >
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.15} />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `$${Math.round(Number(v) / 1000)}k`} width={48} />
                  <Tooltip formatter={(v) => money(Math.abs(Number(v)))} contentStyle={{ background: 'var(--background-secondary)', border: '1px solid var(--border-color)', borderRadius: 8 }} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="in" name={inLabel} fill="#0d9488" radius={[3, 3, 0, 0]} isAnimationActive={false} />
                  <Bar dataKey="out" name={outLabel} fill="#be185d" radius={[3, 3, 0, 0]} isAnimationActive={false} />
                  <Line type="monotone" dataKey="balance" name={isDebt ? 'Owed' : 'Balance'} stroke="#b08d3f" strokeWidth={2} dot={false} isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
              </div>
              <ChartSrTable
                caption={`${account.name} — monthly ${inLabel.toLowerCase()} / ${outLabel.toLowerCase()} and end-of-month ${isDebt ? 'balance owed' : 'balance'}`}
                columns={['Month', inLabel, outLabel, isDebt ? 'Owed' : 'Balance']}
                rows={data.map((d) => [d.label, money(d.in), money(Math.abs(d.out)), money(d.balance)])}
              />
              <p className="text-xs text-[var(--foreground-muted)] mt-2">
                Bars = {inLabel.toLowerCase()} / {outLabel.toLowerCase()} each month · gold line = {isDebt ? 'balance owed' : 'account balance'} over time
                (ends at your real balance{isDebt ? ' owed' : ''}).
              </p>
            </>
          )}
        </div>
    </Sheet>
  );
}
