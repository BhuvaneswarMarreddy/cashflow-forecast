'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ResponsiveContainer, Sankey, Tooltip, LineChart, Line, XAxis, YAxis, CartesianGrid,
} from 'recharts';
import Navbar from '@/components/Navbar';
import { useAuth } from '@/context/AuthContext';
import { useTransactions } from '@/context/TransactionContext';
import { useUserProfile } from '@/context/UserProfileContext';
import { buildFlowGraph, detectRecurring, projectNetWorth, day, FlowGraph } from '@/lib/flows';
import { FLOW_COLORS, FlowColorKey } from '@/lib/palette';

const money = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

type Range = 'all' | '2024' | '2025' | '2026' | '12m';
const RANGES: Array<{ key: Range; label: string }> = [
  { key: 'all', label: 'All time' }, { key: '2024', label: '2024' },
  { key: '2025', label: '2025' }, { key: '2026', label: '2026' },
  { key: '12m', label: 'Last 12 months' },
];

function periodFor(range: Range, todayISO: string): { start?: string; end?: string } {
  if (range === 'all') return {};
  if (range === '12m') {
    const [y, m] = todayISO.slice(0, 7).split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 12, 1));
    return { start: d.toISOString().slice(0, 10) };
  }
  return { start: `${range}-01-01`, end: `${range}-12-31` };
}

// Custom sankey node: colored block + always-visible label (the palette's contrast
// WARN relief — identity is never carried by color alone).
function renderNode(props: { x: number; y: number; width: number; height: number; payload: { label?: string; kind?: FlowColorKey; value?: number } }) {
  const { x, y, width, height, payload } = props;
  const fill = FLOW_COLORS[payload.kind ?? 'stub'];
  const labelLeft = x > 560; // right half: label sits left of the block
  return (
    <g>
      <rect x={x} y={y} width={width} height={height} fill={fill} rx={2} />
      <text
        x={labelLeft ? x - 6 : x + width + 6}
        y={y + height / 2}
        textAnchor={labelLeft ? 'end' : 'start'}
        dominantBaseline="middle"
        style={{ fontSize: 11 }}
        className="fill-[var(--foreground-secondary)]"
      >
        {payload.label}{payload.value ? ` · ${money(Math.round(payload.value * 100))}` : ''}
      </text>
    </g>
  );
}

function SankeyTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload?: Record<string, unknown> }> }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload as {
    source?: { label?: string }; target?: { label?: string };
    cents?: number; grossForwardCents?: number; grossReverseCents?: number; label?: string;
  };
  return (
    <div className="rounded-lg border border-[var(--border-color)] bg-[var(--background-secondary)] px-3 py-2 text-sm shadow-lg">
      {p?.source && p?.target ? (
        <>
          <p className="font-medium">{p.source.label} → {p.target.label}</p>
          <p>{money(p.cents ?? 0)}</p>
          {p.grossForwardCents !== undefined && (
            <p className="text-[var(--foreground-muted)]">
              gross → {money(p.grossForwardCents)} · ← {money(p.grossReverseCents ?? 0)}
            </p>
          )}
        </>
      ) : (
        <p className="font-medium">{p?.label as string}</p>
      )}
    </div>
  );
}

export default function FlowPage() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { transactions } = useTransactions();
  const { profile } = useUserProfile();
  const router = useRouter();
  const [range, setRange] = useState<Range>('all');

  useEffect(() => {
    if (!authLoading && !isAuthenticated) router.push('/login');
  }, [isAuthenticated, authLoading, router]);

  const accounts = useMemo(() => profile?.paymentAccounts ?? [], [profile]);
  const todayISO = day(new Date().toISOString());

  const graph: FlowGraph = useMemo(
    () => buildFlowGraph(transactions, accounts, periodFor(range, todayISO)),
    [transactions, accounts, range, todayISO]
  );
  const recurring = useMemo(
    () => detectRecurring(transactions, accounts, todayISO),
    [transactions, accounts, todayISO]
  );
  const projection = useMemo(
    () => projectNetWorth(transactions, accounts, todayISO),
    [transactions, accounts, todayISO]
  );

  // recharts wants index-based links; keep our metadata on both nodes and links.
  const sankeyData = useMemo(() => {
    const index = new Map(graph.nodes.map((n, i) => [n.id, i]));
    return {
      nodes: graph.nodes.map((n) => ({ name: n.label, label: n.label, kind: n.kind })),
      links: graph.links.map((l) => ({
        source: index.get(l.source)!, target: index.get(l.target)!,
        value: l.cents / 100, cents: l.cents,
        grossForwardCents: l.grossForwardCents, grossReverseCents: l.grossReverseCents,
      })),
    };
  }, [graph]);

  const nameOf = (accountId: string) => accounts.find((a) => a.id === accountId)?.name ?? accountId;
  const activeRecurringCents = recurring.filter((r) => r.active).reduce((s, r) => s + r.monthlyCents, 0);
  const gapTotal = graph.reconciliation.reduce((s, r) => s + r.gapCents, 0);
  const last = projection.points[projection.points.length - 1];

  if (authLoading || !isAuthenticated) return null;

  return (
    <div className="min-h-screen relative">
      <div className="bg-pattern" />
      <Navbar />
      <main className="pt-24 pb-12 px-4 sm:px-6 lg:px-8 max-w-7xl mx-auto relative z-10 space-y-10">
        <header className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-3xl font-bold text-[var(--foreground)]">Money flow</h1>
            <p className="text-[var(--foreground-secondary)] mt-1">
              Every dollar traced — income → between accounts → out. Gaps shown, never hidden.
            </p>
          </div>
          <div className="flex gap-1 rounded-lg bg-[var(--background-tertiary)] p-1 flex-wrap">
            {RANGES.map((r) => (
              <button
                key={r.key}
                onClick={() => setRange(r.key)}
                className={`px-3 py-1.5 rounded-md text-sm transition-colors ${range === r.key
                  ? 'bg-[var(--accent-primary)] text-white'
                  : 'text-[var(--foreground-secondary)] hover:text-[var(--foreground)]'}`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </header>

        {sankeyData.links.length === 0 ? (
          <div className="rounded-xl border border-[var(--border-color)] p-10 text-center text-[var(--foreground-muted)]">
            No transactions in this period.
          </div>
        ) : (
          <section className="rounded-xl border border-[var(--border-color)] bg-[var(--background-secondary)] p-4 overflow-x-auto">
            <div style={{ minWidth: 900 }}>
              <ResponsiveContainer width="100%" height={560}>
                <Sankey
                  data={sankeyData}
                  node={renderNode}
                  nodePadding={18}
                  nodeWidth={12}
                  link={{ stroke: '#8884d8', strokeOpacity: 0.25 }}
                  margin={{ top: 16, right: 230, bottom: 16, left: 16 }}
                >
                  <Tooltip content={<SankeyTooltip />} />
                </Sankey>
              </ResponsiveContainer>
            </div>
          </section>
        )}

        {/* Does it add up? */}
        <section>
          <h2 className="text-lg font-semibold mb-1 text-[var(--foreground)]">Does it add up?</h2>
          <p className="text-sm text-[var(--foreground-muted)] mb-3">
            Opening + in − out = balance at period end, rolled back from your real balances.
            {gapTotal > 0 && (
              <> Export is missing{' '}
                <span className="text-[var(--accent-danger)] font-medium">{money(gapTotal)}</span>{' '}
                of history (Monarch gaps — the ⚠ nodes in the chart).</>
            )}
          </p>
          <div className="overflow-x-auto rounded-xl border border-[var(--border-color)]">
            <table className="w-full text-sm">
              <thead className="bg-[var(--background-tertiary)] text-left">
                <tr>
                  <th className="px-3 py-2">Account</th><th className="px-3 py-2 text-right">Opening</th>
                  <th className="px-3 py-2 text-right">In</th><th className="px-3 py-2 text-right">Out</th>
                  <th className="px-3 py-2 text-right">Now</th><th className="px-3 py-2">Verdict</th>
                </tr>
              </thead>
              <tbody>
                {graph.reconciliation.map((r) => (
                  <tr key={r.accountId} className="border-t border-[var(--border-color)]">
                    <td className="px-3 py-2">{r.name}</td>
                    <td className="px-3 py-2 text-right">{money(r.openingCents)}</td>
                    <td className="px-3 py-2 text-right">{money(r.inCents)}</td>
                    <td className="px-3 py-2 text-right">{money(r.outCents)}</td>
                    <td className="px-3 py-2 text-right">{money(r.closingCents)}</td>
                    <td className="px-3 py-2">
                      {r.verdict === 'missing-rows'
                        ? <span className="text-[var(--accent-danger)]">⚠ missing {money(r.gapCents)}</span>
                        : <span className="text-[var(--foreground-muted)]">
                            {r.verdict === 'pre-export-debt' ? 'debt predates export' : r.verdict === 'opening' ? 'opening balance' : 'reconciles'}
                          </span>}
                    </td>
                  </tr>
                ))}
                <tr className="border-t border-[var(--border-color)] font-semibold">
                  <td className="px-3 py-2">Net worth</td><td /><td /><td />
                  <td className="px-3 py-2 text-right">
                    {money(graph.reconciliation.reduce((s, r) => s + r.closingCents, 0))}
                  </td>
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        {/* Between your accounts — gross both directions */}
        {graph.between.length > 0 && (
          <section>
            <h2 className="text-lg font-semibold mb-3 text-[var(--foreground)]">
              Between your accounts (gross, both directions)
            </h2>
            <div className="overflow-x-auto rounded-xl border border-[var(--border-color)]">
              <table className="w-full text-sm">
                <thead className="bg-[var(--background-tertiary)] text-left">
                  <tr><th className="px-3 py-2">From</th><th className="px-3 py-2">To</th>
                  <th className="px-3 py-2 text-right">Moves</th><th className="px-3 py-2 text-right">Total</th></tr>
                </thead>
                <tbody>
                  {graph.between.map((b, i) => (
                    <tr key={i} className="border-t border-[var(--border-color)]">
                      <td className="px-3 py-2">{nameOf(b.from)}</td>
                      <td className="px-3 py-2">{nameOf(b.to)}</td>
                      <td className="px-3 py-2 text-right">{b.moves}</td>
                      <td className="px-3 py-2 text-right">{money(b.cents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* Recurring */}
        <section>
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-lg font-semibold text-[var(--foreground)]">Recurring payments</h2>
            <p className="text-sm text-[var(--foreground-secondary)]">
              Active subscriptions cost{' '}
              <span className="font-semibold text-[var(--foreground)]">{money(activeRecurringCents)}/mo</span>
            </p>
          </div>
          <div className="overflow-x-auto rounded-xl border border-[var(--border-color)]">
            <table className="w-full text-sm">
              <thead className="bg-[var(--background-tertiary)] text-left">
                <tr><th className="px-3 py-2">Merchant</th><th className="px-3 py-2">Cadence</th>
                <th className="px-3 py-2 text-right">Typical</th><th className="px-3 py-2 text-right">Cost/mo</th>
                <th className="px-3 py-2">Last seen</th><th className="px-3 py-2">Status</th></tr>
              </thead>
              <tbody>
                {recurring.map((r) => (
                  <tr key={r.merchant} className="border-t border-[var(--border-color)]">
                    <td className="px-3 py-2">{r.merchant}</td>
                    <td className="px-3 py-2">{r.cadence}</td>
                    <td className="px-3 py-2 text-right">{money(r.medianCents)}</td>
                    <td className="px-3 py-2 text-right">{money(r.monthlyCents)}</td>
                    <td className="px-3 py-2">{r.lastSeen}</td>
                    <td className="px-3 py-2">
                      {r.active
                        ? <span className="text-[var(--accent-success)]">● active</span>
                        : <span className="text-[var(--foreground-muted)]">lapsed</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Projection */}
        <section>
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-lg font-semibold text-[var(--foreground)]">At this rate</h2>
            <p className="text-sm text-[var(--foreground-secondary)]">
              {money(projection.monthlyRateCents)}/mo →{' '}
              <span className="font-semibold text-[var(--foreground)]">{money(last.cents)}</span> by {last.month}
            </p>
          </div>
          <div className="rounded-xl border border-[var(--border-color)] bg-[var(--background-secondary)] p-4">
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={projection.points.map((p) => ({ month: p.month, value: p.cents / 100 }))}>
                <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.2} />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `$${Math.round(Number(v) / 1000)}k`} width={56} />
                <Tooltip formatter={(v) => money(Math.round(Number(v) * 100))} />
                <Line type="monotone" dataKey="value" stroke="#2563eb" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </section>
      </main>
    </div>
  );
}
