'use client';

/**
 * UI-104 — Analytics' unique survivors, as a tab of Activity.
 *
 * After the Cashflow tab shipped (UI-103), Analytics' monthly bars and
 * category breakdown were duplicates. What earns its life here: spending
 * PACE against budget (daily bars + projection) and top merchants. Fixed on
 * the way in (audit): weekly budget is monthly×7/30.44 (not ÷4 — a month is
 * not 4 weeks), the daily line divides by the month's REAL day count, the
 * 'Composed' chart option (pixel-identical to Bar) is gone, and the 10-color
 * palette collapses to the validated single hue.
 */

import React, { useMemo, useState } from 'react';
import { useTransactions } from '@/context/TransactionContext';
import { useUserProfile } from '@/context/UserProfileContext';
import ChartSrTable from '@/components/ChartSrTable';
import { classifyTransaction } from '@/lib/classify';
import { monthlyAverages } from '@/lib/forecast';
import { formatMoney } from '@/lib/money';
import { Transaction } from '@/types';
import {
  format, parseISO, startOfWeek, endOfWeek, startOfMonth, endOfMonth,
  subWeeks, subMonths, addWeeks, addMonths, eachDayOfInterval,
  isWithinInterval, isSameDay, getDaysInMonth, isSameWeek, isSameMonth,
} from 'date-fns';
import { ChevronLeft, ChevronRight, TrendingUp, TrendingDown } from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine,
} from 'recharts';

const MOBILE_TICKS = 'max-sm:[&_.recharts-cartesian-axis-tick-value]:text-[10px]';
const AVG_DAYS_PER_WEEK_MONTH = 30.44 / 7; // weeks in an average month

type ViewMode = 'weekly' | 'monthly';

export default function InsightsTab() {
  const { transactions } = useTransactions();
  const { profile, incomeContext } = useUserProfile();
  const [viewMode, setViewMode] = useState<ViewMode>('monthly');
  const [currentDate, setCurrentDate] = useState(new Date());

  const money = (n: number) => formatMoney(n, profile?.currency, 2);
  const isExpense = (t: Transaction) => classifyTransaction(t, profile?.paymentAccounts) === 'expense';

  const derivedMonthly = useMemo(
    () => monthlyAverages(transactions, profile?.paymentAccounts || [], 6, incomeContext),
    [transactions, profile?.paymentAccounts, incomeContext]
  );
  const monthlyBudget =
    (profile?.monthlyBudget || 0) > 0 ? profile!.monthlyBudget! : derivedMonthly.spending;

  const range = useMemo(() => (
    viewMode === 'weekly'
      ? { start: startOfWeek(currentDate, { weekStartsOn: 0 }), end: endOfWeek(currentDate, { weekStartsOn: 0 }) }
      : { start: startOfMonth(currentDate), end: endOfMonth(currentDate) }
  ), [viewMode, currentDate]);

  // The budget for THIS period, honestly derived: months use the real day
  // count; weeks use monthly×(7/30.44).
  const periodBudget = viewMode === 'weekly'
    ? monthlyBudget / AVG_DAYS_PER_WEEK_MONTH
    : monthlyBudget;
  const dailyBudget = viewMode === 'weekly'
    ? periodBudget / 7
    : monthlyBudget / getDaysInMonth(currentDate);

  const daily = useMemo(() => {
    const today = new Date();
    return eachDayOfInterval(range).map(day => {
      const spent = transactions
        .filter(t => isSameDay(parseISO(t.date), day) && isExpense(t))
        .reduce((s, t) => s + t.amount, 0);
      const isPast = day <= today;
      return { date: format(day, viewMode === 'weekly' ? 'EEE' : 'd'), spent: isPast ? spent : null, isPast };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transactions, range, viewMode, profile?.paymentAccounts]);

  const spentSoFar = daily.reduce((s, d) => s + (d.spent ?? 0), 0);
  const daysElapsed = daily.filter(d => d.isPast).length;
  const daysTotal = daily.length;
  const avgDailySpend = daysElapsed > 0 ? spentSoFar / daysElapsed : 0;
  const projectedTotal = avgDailySpend * daysTotal;
  const isCurrentPeriod = viewMode === 'weekly'
    ? isSameWeek(currentDate, new Date(), { weekStartsOn: 0 })
    : isSameMonth(currentDate, new Date());

  // Pace trend: this period's daily average vs the previous full period's.
  const trend = useMemo(() => {
    const prevRange = viewMode === 'weekly'
      ? { start: startOfWeek(subWeeks(currentDate, 1), { weekStartsOn: 0 }), end: endOfWeek(subWeeks(currentDate, 1), { weekStartsOn: 0 }) }
      : { start: startOfMonth(subMonths(currentDate, 1)), end: endOfMonth(subMonths(currentDate, 1)) };
    const prevSpent = transactions
      .filter(t => isWithinInterval(parseISO(t.date), prevRange) && isExpense(t))
      .reduce((s, t) => s + t.amount, 0);
    const prevDays = eachDayOfInterval(prevRange).length;
    const prevAvg = prevDays > 0 ? prevSpent / prevDays : 0;
    return prevAvg > 0 ? ((avgDailySpend - prevAvg) / prevAvg) * 100 : 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transactions, currentDate, viewMode, avgDailySpend, profile?.paymentAccounts]);

  const topMerchants = useMemo(() => {
    const m: Record<string, number> = {};
    transactions
      .filter(t => isWithinInterval(parseISO(t.date), range) && isExpense(t))
      .forEach(t => {
        const k = t.merchant || t.title;
        m[k] = (m[k] || 0) + t.amount;
      });
    return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([name, value]) => ({ name, value }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transactions, range, profile?.paymentAccounts]);
  const maxMerchant = Math.max(...topMerchants.map(m => m.value), 0.01);

  const step = (dir: -1 | 1) =>
    setCurrentDate(d => (viewMode === 'weekly' ? addWeeks(d, dir) : addMonths(d, dir)));

  const budgetUsedPct = periodBudget > 0 ? Math.min((spentSoFar / periodBudget) * 100, 999) : 0;
  const overPace = isCurrentPeriod && periodBudget > 0 && projectedTotal > periodBudget;

  return (
    <div className="space-y-6">
      {/* Period controls — one idiom */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1 p-1 bg-[var(--background)] rounded-control border border-[var(--border-color)]">
          {(['weekly', 'monthly'] as const).map(v => (
            <button key={v} onClick={() => { setViewMode(v); setCurrentDate(new Date()); }}
              aria-pressed={viewMode === v}
              className={`min-h-[44px] px-4 rounded-control text-sm font-semibold transition-all ${viewMode === v ? 'bg-[var(--accent-primary)] text-[#16181c]' : 'text-[var(--foreground-secondary)] hover:text-[var(--foreground)]'}`}>
              {v === 'weekly' ? 'Week' : 'Month'}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => step(-1)} aria-label="Previous period"
            className="w-11 h-11 flex items-center justify-center rounded-control text-[var(--foreground-secondary)] hover:bg-[var(--background-tertiary)]">
            <ChevronLeft className="w-5 h-5" />
          </button>
          <span className="text-sm font-semibold text-[var(--foreground)] min-w-[10ch] text-center tnum">
            {viewMode === 'weekly'
              ? `${format(range.start, 'MMM d')} – ${format(range.end, 'MMM d')}`
              : format(currentDate, 'MMMM yyyy')}
          </span>
          <button onClick={() => step(1)} aria-label="Next period"
            className="w-11 h-11 flex items-center justify-center rounded-control text-[var(--foreground-secondary)] hover:bg-[var(--background-tertiary)]">
            <ChevronRight className="w-5 h-5" />
          </button>
          {!isCurrentPeriod && (
            <button onClick={() => setCurrentDate(new Date())}
              className="min-h-[44px] px-3 rounded-control text-sm font-medium text-[var(--accent-primary)] hover:bg-[var(--background-tertiary)]">
              Today
            </button>
          )}
        </div>
      </div>

      {/* Budget pace — ONE budget rendering */}
      <div className="glass-card p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-3 mb-3">
          <div>
            <h3 className="font-semibold text-[var(--foreground)]">Spending pace</h3>
            <p className="text-sm text-[var(--foreground-secondary)] tnum">
              {money(spentSoFar)} of {money(periodBudget)} this {viewMode === 'weekly' ? 'week' : 'month'}
            </p>
          </div>
          <div className={`flex items-center gap-1.5 text-sm font-semibold tnum ${trend >= 0 ? 'text-[var(--money-out)]' : 'text-[var(--money-in)]'}`}>
            {trend >= 0 ? <TrendingUp className="w-4 h-4" aria-hidden="true" /> : <TrendingDown className="w-4 h-4" aria-hidden="true" />}
            {trend >= 0 ? '+' : ''}{trend.toFixed(1)}% vs last {viewMode === 'weekly' ? 'week' : 'month'}
          </div>
        </div>
        <div className="h-2 rounded-pill bg-[var(--background-tertiary)] overflow-hidden" role="img"
          aria-label={`${Math.round(budgetUsedPct)}% of the ${viewMode} budget used`}>
          <div className={`h-full rounded-pill transition-all ${budgetUsedPct > 100 ? 'bg-[var(--money-out)]' : 'bg-[var(--progress)]'}`}
            style={{ width: `${Math.min(budgetUsedPct, 100)}%` }} />
        </div>
        {overPace && (
          <p className="text-sm text-[var(--foreground-secondary)] mt-3 tnum">
            At this pace ({money(avgDailySpend)}/day) you&apos;ll spend about {money(projectedTotal)} —
            {' '}{money(projectedTotal - periodBudget)} over.
          </p>
        )}
      </div>

      {/* Daily spending — one chart, real daily budget line */}
      <div className="glass-card p-5">
        <h3 className="font-semibold text-[var(--foreground)] mb-4">Daily spending</h3>
        <div className={`h-[220px] ${MOBILE_TICKS}`} role="img"
          aria-label={`Daily spending bars for the ${viewMode === 'weekly' ? 'week' : 'month'}: ${money(spentSoFar)} so far against a ${money(dailyBudget)} per-day budget.`}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={daily} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'var(--foreground-muted)' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: 'var(--foreground-muted)' }} axisLine={false} tickLine={false} tickFormatter={(v) => `$${v}`} />
              <Tooltip formatter={(v) => money(Number(v))} contentStyle={{ background: 'var(--background-secondary)', border: '1px solid var(--border-color)', borderRadius: 8 }} />
              <ReferenceLine y={dailyBudget} stroke="var(--foreground-muted)" strokeDasharray="4 4"
                label={{ value: `${money(dailyBudget)}/day`, position: 'insideTopRight', fontSize: 10, fill: 'var(--foreground-muted)' }} />
              <Bar isAnimationActive={false} dataKey="spent" name="Spent" fill="var(--chart-out)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <ChartSrTable
          caption="Daily spending"
          columns={['Day', 'Spent']}
          rows={daily.filter(d => d.isPast).map(d => [d.date, money(d.spent ?? 0)])}
        />
      </div>

      {/* Top merchants — quiet bars, no pie, no rainbow */}
      {topMerchants.length > 0 && (
        <div className="glass-card p-5">
          <h3 className="font-semibold text-[var(--foreground)] mb-1">Where it went most</h3>
          <p className="text-sm text-[var(--foreground-secondary)] mb-4">
            Top merchants this {viewMode === 'weekly' ? 'week' : 'month'}.
          </p>
          <div className="space-y-2.5">
            {topMerchants.map(m => (
              <div key={m.name} className="flex items-center gap-3">
                <span className="w-36 truncate text-sm text-[var(--foreground-secondary)]">{m.name}</span>
                <span className="w-24 text-right text-sm font-medium tnum text-[var(--foreground)]">{money(m.value)}</span>
                <div className="flex-1 h-1.5 rounded-control bg-[var(--background-tertiary)]">
                  <div className="h-1.5 rounded-control bg-[var(--chart-out)]" style={{ width: `${(m.value / maxMerchant) * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
