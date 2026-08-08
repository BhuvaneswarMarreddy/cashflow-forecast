'use client';

/**
 * UI-103 — /cashflow's body, now the Forecast screen's third tab, with
 * /calendar folded in as a tap-a-month drill-down (its one unique value).
 * Copy and colors brought onto the system while moving: chart bars wear the
 * validated --chart-in/--chart-out tokens, "≈" is gone (the number is exact),
 * and the button that only navigated no longer claims to import.
 */

import React, { useMemo, useState } from 'react';
import Link from 'next/link';
import { useTransactions } from '@/context/TransactionContext';
import { useUserProfile } from '@/context/UserProfileContext';
import ChartSrTable from '@/components/ChartSrTable';
import { classifyTransaction, interpretTransaction, isPosted, isPositive, isReward, sumExpenseCents, sumIncomeCents } from '@/lib/classify';
import { matchTransfers } from '@/lib/transfers';
import { displayCategory } from '@/types';
import { CAT_COLORS } from '@/lib/palette';
import { formatMoney } from '@/lib/money';
import { MONEY_ROLES, ROLE_LABELS, ROLE_BLURBS, totalsByRole } from '@/lib/money-roles';
import { format, parseISO, subMonths, startOfMonth } from 'date-fns';
import { TrendingUp, ArrowDownRight, ArrowUpRight, Wallet, X } from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, Cell, CartesianGrid,
} from 'recharts';

const money = (n: number) => formatMoney(n, undefined, 2);

// <sm only: shrink recharts axis tick labels so crowded X axes stop colliding.
const MOBILE_TICKS = 'max-sm:[&_.recharts-cartesian-axis-tick-value]:text-[10px]';

type Range = '12m' | 'ytd' | 'all';

export default function CashflowTab() {
  const { transactions } = useTransactions();
  const { profile, incomeContext } = useUserProfile();
  const [range, setRange] = useState<Range>('12m');
  // Calendar's inheritance: tap a month bar, see that month's days.
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);

  const accounts = profile?.paymentAccounts;
  const cls = (t: typeof transactions[number]) => classifyTransaction(t, accounts);

  const rows = useMemo(() => {
    const now = new Date();
    const start =
      range === '12m' ? subMonths(startOfMonth(now), 11) :
      range === 'ytd' ? new Date(now.getFullYear(), 0, 1) :
      new Date(0);
    return transactions.filter(t => parseISO(t.date) >= start && parseISO(t.date) <= now);
  }, [transactions, range]);

  const flows = useMemo(() => {
    const m = matchTransfers(rows, accounts || []);
    const nameParts = (profile?.name || '').toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const isSelf = (t: typeof rows[number]) => {
      const txt = `${t.title} ${t.description || ''} ${t.merchant || ''}`.toLowerCase();
      return /\bto me\b|from me\b/.test(txt) || nameParts.some(n => txt.includes(n));
    };
    const isCardLoan = (t: typeof rows[number]) => {
      const a = accounts?.find(x => x.id === t.accountId);
      return a?.type === 'credit_card' || a?.type === 'personal_loan';
    };
    const detail: Record<string, number> = {};
    let grossOut = 0, grossIn = 0;
    m.unmatchedOut.forEach(t => {
      if (isSelf(t) || isCardLoan(t)) return;
      grossOut += t.amount;
      const ti = `${t.title} ${t.description || ''} ${t.merchant || ''}`.toLowerCase();
      const key = /remitly|rmtly/.test(ti) ? 'Remitly (India)' : /zelle/.test(ti) ? 'Zelle to a person' : 'Other sent out';
      detail[key] = (detail[key] || 0) + t.amount;
    });
    m.unmatchedIn.forEach(t => {
      if (isSelf(t) || isCardLoan(t)) return;
      grossIn += t.amount;
    });
    return { grossOut, grossIn, net: grossOut - grossIn, detail: Object.entries(detail).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value) };
  }, [rows, accounts, profile?.name]);

  /**
   * #76 — ONE income rule.
   *
   * This used to count every row the coarse classifier called an inflow, while
   * Activity used sumIncomeCents() with the approved-source check. Two rules over
   * one dataset, so the same ledger read $12,900.39 here and $12,900.00 there —
   * a rounding-sized gap on the fixture, and a large one on a real ledger full of
   * refunds, rewards and Zelle credits, none of which are pay.
   *
   * Both screens now ask the engine the same question.
   */
  const totals = useMemo(() => {
    const income = sumIncomeCents(rows, accounts, incomeContext) / 100;
    const spending = sumExpenseCents(rows, accounts, incomeContext) / 100;
    return { income, spending, kept: income - spending - flows.net };
  }, [rows, accounts, incomeContext, flows.net]);

  const monthly = useMemo(() => {
    const m: Record<string, { income: number; spending: number }> = {};
    rows.forEach(t => {
      const key = format(parseISO(t.date), 'yyyy-MM');
      m[key] ??= { income: 0, spending: 0 };
      const c = cls(t);
      if (c === 'income') m[key].income += t.amount;
      else if (c === 'expense') m[key].spending += t.amount;
    });
    return Object.entries(m).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, v]) => ({ ym: key, month: format(parseISO(key + '-01'), 'MMM yy'), ...v, net: v.income - v.spending }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, accounts]);

  const byCategory = useMemo(() => {
    const c: Record<string, number> = {};
    rows.filter(t => cls(t) === 'expense').forEach(t => {
      const k = displayCategory(t); c[k] = (c[k] || 0) + t.amount;
    });
    const sorted = Object.entries(c).sort((a, b) => b[1] - a[1]);
    const top = sorted.slice(0, 7);
    const other = sorted.slice(7).reduce((s, [, v]) => s + v, 0);
    const out = top.map(([name, value]) => ({ name, value }));
    if (other > 0) out.push({ name: 'Other', value: other });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, accounts]);

  const rewardsByCard = useMemo(() => {
    const m: Record<string, number> = {};
    rows.forEach(t => {
      if (cls(t) === 'income' && isReward(t)) {
        const acct = accounts?.find(a => a.id === t.accountId);
        if (acct?.type === 'credit_card') m[acct.name] = (m[acct.name] || 0) + t.amount;
      }
    });
    return Object.entries(m).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, accounts]);
  const totalRewards = rewardsByCard.reduce((s, r) => s + r.value, 0);

  // MODEL-004 (#45). Consumes financialMeaning from interpretTransaction() and
  // only adds up — no second opinion about what a row means.
  const roleRows = useMemo(() => {
    const posted = rows
      .filter(isPosted)
      .map((t) => ({ meaning: interpretTransaction(t, accounts ?? [], incomeContext).financialMeaning, amount: t.amount }));
    const totalsByR = totalsByRole(posted);
    const rolled = MONEY_ROLES
      // A role with nothing behind it is left out, not printed as $0.00 — the
      // app has a habit of rendering absence as a measured zero.
      .filter((role) => totalsByR[role] > 0)
      .map((role) => ({
        role,
        label: ROLE_LABELS[role],
        blurb: ROLE_BLURBS[role],
        value: totalsByR[role],
      }));

    // Deposits the app could not confirm as pay. They are correctly kept OUT of
    // Earned — calling an unrecognised credit income is how income inflates —
    // but rolling them silently into Moved reads as though a paycheck merely
    // shuffled between accounts. Name the amount and the way to fix it.
    const unconfirmed = posted
      .filter((r) => r.meaning === 'unknown_inflow' || r.meaning === 'other_non_income_credit')
      .reduce((sum, r) => sum + r.amount, 0);

    return { rolled, unconfirmed };
  }, [rows, accounts, incomeContext]);

  // The drill-down: the selected month's rows, newest first (calendar's day view).
  const monthRows = useMemo(() => {
    if (!selectedMonth) return [];
    return rows
      .filter(t => format(parseISO(t.date), 'yyyy-MM') === selectedMonth)
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      .slice(0, 120);
  }, [rows, selectedMonth]);

  if (transactions.length === 0) {
    return (
      <div className="glass-card p-10 text-center">
        <p className="text-lg font-medium text-[var(--foreground)] mb-2">No transactions yet</p>
        <p className="text-sm text-[var(--foreground-secondary)] mb-5">Import your bank CSV to see where your income goes, month by month.</p>
        <Link href="/history" className="btn-primary inline-flex items-center gap-2">Go to History to import</Link>
      </div>
    );
  }

  const keptRate = totals.income > 0 ? Math.round((totals.kept / totals.income) * 100) : 0;


  return (
    <div>
      <div className="flex justify-end mb-4">
        <div className="flex gap-1 p-1 bg-[var(--background)] rounded-control border border-[var(--border-color)]">
          {([['12m', 'Last 12 mo'], ['ytd', 'This year'], ['all', 'All time']] as [Range, string][]).map(([k, label]) => (
            <button key={k} onClick={() => setRange(k)}
              className={`min-h-[44px] px-3 rounded-control text-sm font-medium transition-all ${range === k ? 'bg-[var(--accent-primary)] text-[#16181c]' : 'text-[var(--foreground-secondary)] hover:text-[var(--foreground)]'}`}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Summary tiles */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <Tile icon={<ArrowUpRight className="w-5 h-5" />} label="Income in" value={money(totals.income)} color="text-[var(--money-in)]" />
        <Tile icon={<ArrowDownRight className="w-5 h-5" />} label="Spent (on yourself)" value={money(totals.spending)} color="text-[var(--money-out)]" />
        <Tile icon={<TrendingUp className="w-5 h-5" />} label="Net to family / others" value={money(flows.net)} color="text-[var(--accent-primary)]" sub={`sent ${money(flows.grossOut)} · got back ${money(flows.grossIn)}`} />
        <Tile icon={<Wallet className="w-5 h-5" />} label="Actually kept" value={money(totals.kept)} color={totals.kept >= 0 ? 'text-[var(--money-in)]' : 'text-[var(--money-out)]'} sub={`${keptRate}% of income`} />
      </div>

      {/* MODEL-004 (#45): every dollar in the period, in the six words the engine
          already thinks in. This is where a huge settlement number becomes
          visibly harmless — it lands in "Moved", beside Spent rather than inside
          it. Roles with no data behind them are omitted rather than shown as a
          confident $0.00. */}
      {roleRows.rolled.length > 0 && (
        <div className="glass-card p-4 mb-8">
          <h3 className="font-semibold text-[var(--foreground)] mb-1">Where every dollar went</h3>
          <p className="text-sm text-[var(--foreground-secondary)] mb-4">
            Moving money is not spending it — a card payment settles what you already spent.
          </p>
          <dl className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {roleRows.rolled.map(({ role, label, blurb, value }) => (
              <div key={role}>
                <dt className="text-sm text-[var(--foreground-secondary)]">{label}</dt>
                <dd className="text-lg font-semibold tnum text-[var(--foreground)]">{money(value)}</dd>
                <dd className="text-xs text-[var(--foreground-muted)]">{blurb}</dd>
              </div>
            ))}
          </dl>
          {roleRows.unconfirmed > 0 && (
            <p className="text-xs text-[var(--accent-warning)] mt-4">
              {money(roleRows.unconfirmed)} of deposits aren&apos;t linked to an income source yet, so
              they don&apos;t count as Earned.{' '}
              <Link href="/accounts" className="underline underline-offset-2">Link them</Link>
            </p>
          )}
        </div>
      )}

      {/* Monthly income vs spending — tap a month for its days */}
      <div className="glass-card p-5 mb-8">
        <h3 className="font-semibold text-[var(--foreground)] mb-1">Income vs Spending, by month</h3>
        <p className="text-sm text-[var(--foreground-secondary)] mb-4">The gap between the bars is what you kept. Tap a month to see its days. Transfers and card payments are excluded — they move money, they don&apos;t spend it.</p>
        <div
          className={`h-[240px] sm:h-[320px] ${MOBILE_TICKS}`}
          role="img"
          aria-label={`Monthly income vs spending bar chart: ${money(totals.income)} in, ${money(totals.spending)} spent, ${money(totals.kept)} kept. Tap a month for its transactions.`}
        >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={monthly} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barGap={2}
            onClick={(e) => {
              const state = e as { activePayload?: Array<{ payload?: { ym?: string } }> } | undefined;
              const ym = state?.activePayload?.[0]?.payload?.ym;
              if (ym) setSelectedMonth(m => (m === ym ? null : ym));
            }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" vertical={false} />
            <XAxis dataKey="month" tick={{ fontSize: 11, fill: 'var(--foreground-muted)' }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fontSize: 11, fill: 'var(--foreground-muted)' }} axisLine={false} tickLine={false} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
            <Tooltip formatter={(v) => money(Number(v))} contentStyle={{ background: 'var(--background-secondary)', border: '1px solid var(--border-color)', borderRadius: 8 }} />
            <Legend />
            <Bar isAnimationActive={false} dataKey="income" name="Income" fill="var(--chart-in)" radius={[4, 4, 0, 0]} />
            <Bar isAnimationActive={false} dataKey="spending" name="Spending" fill="var(--chart-out)" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
        </div>
        <ChartSrTable
          caption="Income vs spending, by month"
          columns={['Month', 'Income', 'Spending', 'Net']}
          rows={monthly.map(m => [m.month, money(m.income), money(m.spending), money(m.net)])}
        />

        {/* Calendar's inheritance: the month drill-down */}
        {selectedMonth && (
          <div className="mt-4 pt-4 border-t border-[var(--border-color)]">
            <div className="flex items-center justify-between mb-2">
              <h4 className="font-semibold text-[var(--foreground)]">
                {format(parseISO(selectedMonth + '-01'), 'MMMM yyyy')}
              </h4>
              <button
                onClick={() => setSelectedMonth(null)}
                aria-label="Close month detail"
                className="w-11 h-11 flex items-center justify-center rounded-control text-[var(--foreground-muted)] hover:text-[var(--foreground)] hover:bg-[var(--background-tertiary)]"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="divide-y divide-[var(--border-color)] max-h-96 overflow-y-auto">
              {monthRows.map(t => (
                <div key={t.id} className="flex items-baseline justify-between gap-3 py-2 text-sm">
                  <span className="text-[var(--foreground-muted)] tnum shrink-0">{format(parseISO(t.date), 'MMM d')}</span>
                  <span className="text-[var(--foreground)] truncate flex-1">{t.title}</span>
                  <span className={`tnum font-medium shrink-0 ${isPositive(t, accounts) ? 'text-[var(--money-in)]' : 'text-[var(--money-out)]'}`}>
                    {isPositive(t, accounts) ? '+' : '−'}{money(t.amount)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Where the money went */}
      <div className="below-fold-chart glass-card p-5">
        <h3 className="font-semibold text-[var(--foreground)] mb-1">Where your money went</h3>
        <p className="text-sm text-[var(--foreground-secondary)] mb-4">Top spending categories for this period.</p>
        <div
          className={MOBILE_TICKS}
          role="img"
          aria-label={`Top spending categories bar chart: ${money(totals.spending)} total, led by ${byCategory[0]?.name ?? 'nothing'} at ${money(byCategory[0]?.value ?? 0)}.`}
        >
        <ResponsiveContainer width="100%" height={Math.max(220, byCategory.length * 44)}>
          <BarChart data={byCategory} layout="vertical" margin={{ top: 4, right: 60, left: 8, bottom: 4 }}>
            <XAxis type="number" hide />
            <YAxis type="category" dataKey="name" width={130} tick={{ fontSize: 12, fill: 'var(--foreground-secondary)' }} axisLine={false} tickLine={false} />
            <Tooltip formatter={(v) => money(Number(v))} contentStyle={{ background: 'var(--background-secondary)', border: '1px solid var(--border-color)', borderRadius: 8 }} />
            <Bar isAnimationActive={false} dataKey="value" radius={[0, 4, 4, 0]} label={{ position: 'right', formatter: (v: number | string) => money(Number(v)), fontSize: 11, fill: 'var(--foreground-secondary)' } as never}>
              {byCategory.map((_, i) => <Cell key={i} fill={CAT_COLORS[i % CAT_COLORS.length]} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
        </div>
        <ChartSrTable
          caption="Top spending categories for this period"
          columns={['Category', 'Spent']}
          rows={byCategory.map(c => [c.name, money(c.value)])}
        />
      </div>

      {/* Where your money left to */}
      {flows.detail.length > 0 && (
        <div className="glass-card p-5 mt-8">
          <div className="flex items-baseline justify-between mb-4">
            <div>
              <h3 className="font-semibold text-[var(--foreground)]">Money sent to family &amp; others</h3>
              <p className="text-sm text-[var(--foreground-secondary)]">Sent out in total; you also got {money(flows.grossIn)} back, so the net given is {money(flows.net)}. Card payments and moves between your own accounts are excluded.</p>
            </div>
            <p className="text-2xl font-bold text-[var(--accent-primary)] tnum">{money(flows.grossOut)}</p>
          </div>
          <div className="divide-y divide-[var(--border-color)]">
            {flows.detail.map(r => (
              <div key={r.name} className="flex items-center justify-between py-3">
                <span className="text-[var(--foreground)]">{r.name}</span>
                <span className="font-semibold text-[var(--accent-primary)] tnum">{money(r.value)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Credit-card rewards earned */}
      {rewardsByCard.length > 0 && (
        <div className="glass-card p-5 mt-8">
          <div className="flex items-baseline justify-between mb-4">
            <div>
              <h3 className="font-semibold text-[var(--foreground)]">Card rewards earned</h3>
              <p className="text-sm text-[var(--foreground-secondary)]">Cashback &amp; statement credits — money the cards paid you.</p>
            </div>
            <p className="text-2xl font-bold text-[var(--accent-primary)] tnum">{money(totalRewards)}</p>
          </div>
          <div className="divide-y divide-[var(--border-color)]">
            {rewardsByCard.map(r => (
              <div key={r.name} className="flex items-center justify-between py-3">
                <span className="text-[var(--foreground)]">{r.name}</span>
                <span className="font-semibold text-[var(--accent-primary)] tnum">{money(r.value)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Tile({ icon, label, value, color, sub }: { icon: React.ReactNode; label: string; value: string; color: string; sub?: string }) {
  return (
    <div className="stat-card">
      <div className="flex items-center gap-2 text-[var(--foreground-secondary)] mb-2">{icon}<span className="text-sm">{label}</span></div>
      <p className={`text-2xl font-bold tnum ${color}`}>{value}</p>
      {sub && <p className="text-xs text-[var(--foreground-muted)] mt-1">{sub}</p>}
    </div>
  );
}
