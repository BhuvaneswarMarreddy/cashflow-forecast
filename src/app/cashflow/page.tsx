'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { useTransactions } from '@/context/TransactionContext';
import { useUserProfile } from '@/context/UserProfileContext';
import Navbar from '@/components/Navbar';
import ChartSrTable from '@/components/ChartSrTable';
import { classifyTransaction, isPositive, isReward } from '@/lib/classify';
import { matchTransfers } from '@/lib/transfers';
import { displayCategory } from '@/types';
import { CAT_COLORS } from '@/lib/palette';
import { formatMoney } from '@/lib/money';
import { format, parseISO, subMonths, startOfMonth } from 'date-fns';
import { TrendingUp, ArrowDownRight, ArrowUpRight, Wallet } from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, Cell, CartesianGrid,
} from 'recharts';

// Validated categorical palette (CVD-safe in light mode with the direct labels present).
// The one money dialect: 2 decimals, tabular digits handled at the call sites.
const money = (n: number) => formatMoney(n, undefined, 2);

// <sm only: shrink recharts axis tick labels so crowded X axes stop colliding.
// CSS-gated (max-sm:) so desktop stays pixel-identical — no matchMedia in render.
const MOBILE_TICKS = 'max-sm:[&_.recharts-cartesian-axis-tick-value]:text-[10px]';

type Range = '12m' | 'ytd' | 'all';

export default function CashflowPage() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { transactions, isLoading: txnLoading } = useTransactions();
  const { profile } = useUserProfile();
  const router = useRouter();
  const [range, setRange] = useState<Range>('12m');

  useEffect(() => {
    if (!authLoading && !isAuthenticated) router.push('/login');
  }, [isAuthenticated, authLoading, router]);

  const accounts = profile?.paymentAccounts;
  const cls = (t: typeof transactions[number]) => classifyTransaction(t, accounts);

  // Transactions inside the selected window
  const rows = useMemo(() => {
    const now = new Date();
    const start =
      range === '12m' ? subMonths(startOfMonth(now), 11) :
      range === 'ytd' ? new Date(now.getFullYear(), 0, 1) :
      new Date(0);
    return transactions.filter(t => parseISO(t.date) >= start && parseISO(t.date) <= now);
  }, [transactions, range]);

  // Money that actually LEFT your accounts as transfers with no matching leg in one of
  // your own accounts — i.e. sent to other people / abroad. This is real money gone, and
  // the reason "income − spending" overstates what you kept.
  const flows = useMemo(() => {
    const m = matchTransfers(rows, accounts || []);
    // Exclusions, so "given away" is only money that truly left to other people:
    // - self-transfers (own name / "to me") = moving between your own accounts
    // - card/loan payments = settling spending already counted in "Spent"
    // And critically we NET money received against money sent — your big two-way family
    // flows (send to India, get repaid) cancel, leaving only what actually left.
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

  const totals = useMemo(() => {
    let income = 0, spending = 0;
    rows.forEach(t => {
      const c = cls(t);
      if (c === 'income') income += t.amount;
      else if (c === 'expense') spending += t.amount;
    });
    return { income, spending, kept: income - spending - flows.net };
  }, [rows, accounts, flows.net]);

  // Month-by-month income vs spending
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
      .map(([key, v]) => ({ month: format(parseISO(key + '-01'), 'MMM yy'), ...v, net: v.income - v.spending }));
  }, [rows, accounts]);

  // Where the money went — top spending categories
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
  }, [rows, accounts]);

  // Credit-card rewards / cashback earned, per card
  const rewardsByCard = useMemo(() => {
    const m: Record<string, number> = {};
    rows.forEach(t => {
      if (cls(t) === 'income' && isReward(t)) {
        const acct = accounts?.find(a => a.id === t.accountId);
        if (acct?.type === 'credit_card') m[acct.name] = (m[acct.name] || 0) + t.amount;
      }
    });
    return Object.entries(m).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }, [rows, accounts]);
  const totalRewards = rewardsByCard.reduce((s, r) => s + r.value, 0);

  // Gate on the transactions load too — without it the page flashes $0 on cold load.
  if (authLoading || txnLoading) {
    return <div className="min-h-screen flex items-center justify-center"><div className="animate-pulse-glow w-16 h-16 rounded-2xl bg-gradient-to-br from-[var(--accent-primary)] to-[var(--accent-secondary)]" /></div>;
  }
  if (!isAuthenticated) return null;

  if (transactions.length === 0) {
    return (
      <div className="min-h-screen relative">
        <div className="bg-pattern" />
        <Navbar />
        <main className="pt-24 pb-12 px-4 sm:px-6 lg:px-8 max-w-7xl mx-auto relative z-10">
          <h1 className="text-3xl font-bold text-[var(--foreground)] mb-6">Cashflow</h1>
          <div className="glass-card p-10 text-center">
            <p className="text-lg font-medium text-[var(--foreground)] mb-2">No transactions yet</p>
            <p className="text-sm text-[var(--foreground-secondary)] mb-5">Import your bank CSV to see where your income goes, month by month.</p>
            <Link href="/history" className="btn-primary inline-flex items-center gap-2">Import from History</Link>
          </div>
        </main>
      </div>
    );
  }

  const keptRate = totals.income > 0 ? Math.round((totals.kept / totals.income) * 100) : 0;

  return (
    <div className="min-h-screen relative">
      <div className="bg-pattern" />
      <Navbar />
      <main className="pt-24 pb-12 px-4 sm:px-6 lg:px-8 max-w-7xl mx-auto relative z-10">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
          <div>
            <h1 className="text-3xl font-bold text-[var(--foreground)]">Cashflow</h1>
            <p className="text-[var(--foreground-secondary)] mt-1">Where your income goes, month by month</p>
          </div>
          <div className="flex gap-1 p-1 bg-[var(--background)] rounded-lg border border-[var(--border-color)]">
            {([['12m', 'Last 12 mo'], ['ytd', 'This year'], ['all', 'All time']] as [Range, string][]).map(([k, label]) => (
              <button key={k} onClick={() => setRange(k)}
                className={`px-3 py-1.5 rounded text-sm font-medium transition-all ${range === k ? 'bg-[var(--accent-primary)] text-[#16181c]' : 'text-[var(--foreground-secondary)] hover:text-[var(--foreground)]'}`}>
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Summary tiles */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <Tile icon={<ArrowUpRight className="w-5 h-5" />} label="Income in" value={money(totals.income)} color="text-emerald-500" />
          <Tile icon={<ArrowDownRight className="w-5 h-5" />} label="Spent (on yourself)" value={money(totals.spending)} color="text-[var(--accent-danger)]" />
          <Tile icon={<TrendingUp className="w-5 h-5" />} label="Net to family / others" value={money(flows.net)} color="text-amber-500" sub={`sent ${money(flows.grossOut)} · got back ${money(flows.grossIn)}`} />
          <Tile icon={<Wallet className="w-5 h-5" />} label="Actually kept" value={money(totals.kept)} color={totals.kept >= 0 ? 'text-emerald-500' : 'text-[var(--accent-danger)]'} sub={`${keptRate}% · income − spent − net given`} />
        </div>

        {/* Monthly income vs spending */}
        <div className="glass-card p-5 mb-8">
          <h3 className="font-semibold text-[var(--foreground)] mb-1">Income vs Spending, by month</h3>
          <p className="text-sm text-[var(--foreground-secondary)] mb-4">The gap between the bars is what you kept. Transfers and card payments are excluded — they move money, they don&apos;t spend it.</p>
          <div
            className={`h-[240px] sm:h-[320px] ${MOBILE_TICKS}`}
            role="img"
            aria-label={`Monthly income vs spending bar chart: ${money(totals.income)} in, ${money(totals.spending)} spent, ${money(totals.kept)} kept.`}
          >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={monthly} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barGap={2}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize: 11, fill: 'var(--foreground-muted)' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: 'var(--foreground-muted)' }} axisLine={false} tickLine={false} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
              <Tooltip formatter={(v) => money(Number(v))} contentStyle={{ background: 'var(--background-secondary)', border: '1px solid var(--border-color)', borderRadius: 8 }} />
              <Legend />
              <Bar isAnimationActive={false} dataKey="income" name="Income" fill="#10b981" radius={[4, 4, 0, 0]} />
              <Bar isAnimationActive={false} dataKey="spending" name="Spending" fill="#ef4444" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
          </div>
          <ChartSrTable
            caption="Income vs spending, by month"
            columns={['Month', 'Income', 'Spending', 'Net']}
            rows={monthly.map(m => [m.month, money(m.income), money(m.spending), money(m.net)])}
          />
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
                <p className="text-sm text-[var(--foreground-secondary)]">Gross sent out (you also got {money(flows.grossIn)} back, so net given ≈ {money(flows.net)}). Card/loan payments and moves between your own accounts are excluded.</p>
              </div>
              <p className="text-2xl font-bold text-amber-500">{money(flows.grossOut)}</p>
            </div>
            <div className="divide-y divide-[var(--border-color)]">
              {flows.detail.map(r => (
                <div key={r.name} className="flex items-center justify-between py-2.5">
                  <span className="text-[var(--foreground)]">{r.name}</span>
                  <span className="font-semibold text-amber-500">{money(r.value)}</span>
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
                <p className="text-sm text-[var(--foreground-secondary)]">Cashback & statement credits — money the cards paid you.</p>
              </div>
              <p className="text-2xl font-bold text-[var(--accent-primary)]">{money(totalRewards)}</p>
            </div>
            <div className="divide-y divide-[var(--border-color)]">
              {rewardsByCard.map(r => (
                <div key={r.name} className="flex items-center justify-between py-2.5">
                  <span className="text-[var(--foreground)]">{r.name}</span>
                  <span className="font-semibold text-[var(--accent-primary)]">{money(r.value)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function Tile({ icon, label, value, color, sub }: { icon: React.ReactNode; label: string; value: string; color: string; sub?: string }) {
  return (
    <div className="stat-card">
      <div className="flex items-center gap-2 text-[var(--foreground-secondary)] mb-2">{icon}<span className="text-sm">{label}</span></div>
      <p className={`text-2xl font-bold ${color}`}>{value}</p>
      {sub && <p className="text-xs text-[var(--foreground-muted)] mt-1">{sub}</p>}
    </div>
  );
}
