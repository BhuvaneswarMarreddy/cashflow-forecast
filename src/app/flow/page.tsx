'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ResponsiveContainer, Sankey, Tooltip, LineChart, Line, XAxis, YAxis, CartesianGrid,
} from 'recharts';
import { Maximize2, Minimize2 } from 'lucide-react';
import Navbar from '@/components/Navbar';
import { useAuth } from '@/context/AuthContext';
import { useTransactions } from '@/context/TransactionContext';
import { useUserProfile } from '@/context/UserProfileContext';
import { buildFlowGraph, detectRecurring, projectNetWorth, day, FlowGraph } from '@/lib/flows';
import { FLOW_COLORS, FlowColorKey } from '@/lib/palette';

const money = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

type Range = 'all' | '2024' | '2025' | '2026' | '12m' | 'month';
const RANGES: Array<{ key: Range; label: string }> = [
  { key: 'all', label: 'All time' }, { key: '2024', label: '2024' },
  { key: '2025', label: '2025' }, { key: '2026', label: '2026' },
  { key: '12m', label: 'Last 12 months' }, { key: 'month', label: 'Monthly' },
];

const shiftMonth = (ym: string, delta: number) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
};
const monthLabel = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
};

const KIND_CHIPS: Array<{ kind: FlowColorKey | null; label: string }> = [
  { kind: null, label: 'All' },
  { kind: 'bank', label: 'Banks' },
  { kind: 'card', label: 'Cards' },
  { kind: 'loan', label: 'Loans' },
  { kind: 'person', label: 'People' },
  { kind: 'category', label: 'Spending' },
  { kind: 'source', label: 'Income' },
  { kind: 'warning', label: '⚠ Gaps' },
];

function periodFor(range: Range, todayISO: string, month: string): { start?: string; end?: string } {
  if (range === 'all') return {};
  if (range === 'month') return { start: `${month}-01`, end: `${month}-31` };
  if (range === '12m') {
    const [y, m] = todayISO.slice(0, 7).split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 12, 1));
    return { start: d.toISOString().slice(0, 10) };
  }
  return { start: `${range}-01-01`, end: `${range}-12-31` };
}

type NodePayload = { label?: string; kind?: FlowColorKey; value?: number };

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
  const [month, setMonth] = useState<string>(() => shiftMonth(new Date().toISOString().slice(0, 7), -1));
  const [maximized, setMaximized] = useState(false);
  const [hoverLabel, setHoverLabel] = useState<string | null>(null);
  const [pinLabel, setPinLabel] = useState<string | null>(null);
  const [focusKind, setFocusKind] = useState<FlowColorKey | null>(null);

  useEffect(() => {
    if (!authLoading && !isAuthenticated) router.push('/login');
  }, [isAuthenticated, authLoading, router]);

  // Esc: clear pin first, then exit maximize
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setPinLabel((p) => {
        if (p) return null;
        setMaximized(false);
        return p;
      });
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  const accounts = useMemo(() => profile?.paymentAccounts ?? [], [profile]);
  const todayISO = day(new Date().toISOString());

  // bounds for the month stepper, from the data itself
  const { minMonth, maxMonth } = useMemo(() => {
    let lo = '9999-12', hi = '0000-01';
    for (const t of transactions) {
      const m = day(t.date).slice(0, 7);
      if (m < lo) lo = m;
      if (m > hi) hi = m;
    }
    return { minMonth: lo, maxMonth: hi };
  }, [transactions]);

  const graph: FlowGraph = useMemo(
    () => buildFlowGraph(transactions, accounts, periodFor(range, todayISO, month)),
    [transactions, accounts, range, todayISO, month]
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

  // label adjacency (directed + undirected) + kind sets, for hover/pin/kind-focus
  const { neighborsOf, outAdj, inAdj, kindLabels } = useMemo(() => {
    const labelOf = new Map(graph.nodes.map((n) => [n.id, n.label]));
    const neighborsOf = new Map<string, Set<string>>();
    const outAdj = new Map<string, Set<string>>();
    const inAdj = new Map<string, Set<string>>();
    const addTo = (m: Map<string, Set<string>>, a: string, b: string) => {
      if (!m.has(a)) m.set(a, new Set());
      m.get(a)!.add(b);
    };
    for (const l of graph.links) {
      const s = labelOf.get(l.source)!, t = labelOf.get(l.target)!;
      addTo(neighborsOf, s, t); addTo(neighborsOf, t, s);
      addTo(outAdj, s, t); addTo(inAdj, t, s);
    }
    const kindLabels = new Map<FlowColorKey, Set<string>>();
    for (const n of graph.nodes) {
      if (!kindLabels.has(n.kind)) kindLabels.set(n.kind, new Set());
      kindLabels.get(n.kind)!.add(n.label);
    }
    return { neighborsOf, outAdj, inAdj, kindLabels };
  }, [graph]);

  // Pinned node -> follow the money end-to-end: everything reachable downstream
  // (where it went) and upstream (where it came from).
  const reach = useMemo(() => {
    if (!pinLabel) return null;
    const bfs = (start: string, adj: Map<string, Set<string>>) => {
      const seen = new Set<string>();
      const q = [start];
      while (q.length) {
        const x = q.pop()!;
        for (const y of adj.get(x) ?? []) if (!seen.has(y)) { seen.add(y); q.push(y); }
      }
      return seen;
    };
    return { down: bfs(pinLabel, outAdj), up: bfs(pinLabel, inAdj) };
  }, [pinLabel, outAdj, inAdj]);

  // If the period changes and the pinned node no longer exists, unpin.
  useEffect(() => {
    if (pinLabel && !graph.nodes.some((n) => n.label === pinLabel)) setPinLabel(null);
  }, [graph, pinLabel]);

  const isNodeBright = useCallback((label: string, kind: FlowColorKey) => {
    if (hoverLabel) return label === hoverLabel || (neighborsOf.get(hoverLabel)?.has(label) ?? false);
    if (pinLabel && reach) return label === pinLabel || reach.down.has(label) || reach.up.has(label);
    if (focusKind) {
      if (kind === focusKind) return true;
      const focused = kindLabels.get(focusKind);
      if (!focused) return true;
      for (const n of neighborsOf.get(label) ?? []) if (focused.has(n)) return true;
      return false;
    }
    return true;
  }, [hoverLabel, pinLabel, reach, focusKind, neighborsOf, kindLabels]);

  const isLinkBright = useCallback((s?: NodePayload, t?: NodePayload) => {
    const sl = s?.label ?? '', tl = t?.label ?? '';
    if (hoverLabel) return sl === hoverLabel || tl === hoverLabel;
    if (pinLabel && reach) {
      // strictly on-path edges: downstream of the pin, or upstream into it —
      // never a shortcut between two reached nodes that bypasses the pin
      const downEdge = (sl === pinLabel || reach.down.has(sl)) && reach.down.has(tl);
      const upEdge = (tl === pinLabel || reach.up.has(tl)) && reach.up.has(sl);
      return downEdge || upEdge;
    }
    if (focusKind) return s?.kind === focusKind || t?.kind === focusKind;
    return true;
  }, [hoverLabel, pinLabel, reach, focusKind]);

  const anyFocus = hoverLabel !== null || pinLabel !== null || focusKind !== null;

  // Colored block + always-visible label; hover traces, click pins.
  const renderNode = useCallback((props: { x: number; y: number; width: number; height: number; payload: NodePayload }) => {
    const { x, y, width, height, payload } = props;
    const kind = payload.kind ?? 'stub';
    const bright = isNodeBright(payload.label ?? '', kind);
    const labelLeft = x > 560;
    return (
      <g
        opacity={bright ? 1 : 0.22}
        style={{ cursor: 'pointer', transition: 'opacity 150ms' }}
        onMouseEnter={() => setHoverLabel(payload.label ?? null)}
        onMouseLeave={() => setHoverLabel(null)}
        onClick={() => setPinLabel((p) => (p === payload.label ? null : payload.label ?? null))}
      >
        <rect x={x} y={y} width={width} height={height} fill={FLOW_COLORS[kind]} rx={2} />
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
  }, [isNodeBright]);

  // Ribbons colored by their source node; connected ones glow, the rest recede.
  const renderLink = useCallback((props: {
    sourceX: number; targetX: number; sourceY: number; targetY: number;
    sourceControlX: number; targetControlX: number; linkWidth: number; index: number;
    payload: { source: NodePayload; target: NodePayload };
  }) => {
    const { sourceX, targetX, sourceY, targetY, sourceControlX, targetControlX, linkWidth, payload } = props;
    const bright = isLinkBright(payload.source, payload.target);
    const stroke = FLOW_COLORS[payload.source?.kind ?? 'stub'];
    return (
      <path
        d={`M${sourceX},${sourceY} C${sourceControlX},${sourceY} ${targetControlX},${targetY} ${targetX},${targetY}`}
        fill="none"
        stroke={stroke}
        strokeWidth={Math.max(1, linkWidth)}
        strokeOpacity={bright ? (anyFocus ? 0.55 : 0.3) : 0.05}
        style={{ transition: 'stroke-opacity 150ms' }}
      />
    );
  }, [isLinkBright, anyFocus]);

  const nameOf = (accountId: string) => accounts.find((a) => a.id === accountId)?.name ?? accountId;
  const activeRecurringCents = recurring.filter((r) => r.active).reduce((s, r) => s + r.monthlyCents, 0);
  const gapTotal = graph.reconciliation.reduce((s, r) => s + r.gapCents, 0);
  const last = projection.points[projection.points.length - 1];

  if (authLoading || !isAuthenticated) return null;

  const rangeButtons = (
    <div className="flex items-center gap-2 flex-wrap">
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
      {range === 'month' && (
        <div className="flex items-center gap-1 rounded-lg bg-[var(--background-tertiary)] p-1">
          <button
            onClick={() => setMonth((m) => shiftMonth(m, -1))}
            disabled={month <= minMonth}
            className="px-2 py-1.5 rounded-md text-sm text-[var(--foreground-secondary)] hover:text-[var(--foreground)] disabled:opacity-30"
            aria-label="Previous month"
          >◀</button>
          <span className="px-2 text-sm font-medium text-[var(--foreground)] min-w-[8.5rem] text-center">
            {monthLabel(month)}
          </span>
          <button
            onClick={() => setMonth((m) => shiftMonth(m, 1))}
            disabled={month >= maxMonth}
            className="px-2 py-1.5 rounded-md text-sm text-[var(--foreground-secondary)] hover:text-[var(--foreground)] disabled:opacity-30"
            aria-label="Next month"
          >▶</button>
        </div>
      )}
    </div>
  );

  // Plain-language headline for the selected period — computed from the same
  // links the chart draws, so the story and the diagram can never disagree.
  const story = (() => {
    const sum = (pred: (l: { source: string; target: string; cents: number }) => boolean) =>
      graph.links.filter(pred).reduce((s, l) => s + l.cents, 0);
    const moneyIn = sum((l) =>
      l.source.startsWith('inc:') || l.source === 'refunds' || l.source === 'rewards' || l.source.startsWith('person-in:'));
    const spending = sum((l) => l.target.startsWith('cat:'));
    const toPeople = sum((l) => l.target.startsWith('person-out:'));
    return { moneyIn, spending, toPeople };
  })();

  const kindChips = (
    <div className="flex gap-1 flex-wrap items-center">
      {KIND_CHIPS.map((c) => (
        <button
          key={c.label}
          onClick={() => { setFocusKind(c.kind); setPinLabel(null); }}
          className={`px-2.5 py-1 rounded-full text-xs border transition-colors ${focusKind === c.kind
            ? 'bg-[var(--accent-primary)] text-white border-transparent'
            : 'border-[var(--border-color)] text-[var(--foreground-secondary)] hover:text-[var(--foreground)]'}`}
        >
          {c.label}
        </button>
      ))}
      {pinLabel && (
        <button
          onClick={() => setPinLabel(null)}
          className="px-2.5 py-1 rounded-full text-xs bg-[var(--background-tertiary)] text-[var(--foreground)]"
          title="Click to clear"
        >
          📌 {pinLabel} ✕
        </button>
      )}
    </div>
  );

  const sankeyChart = (heightPx: number | '100%') => (
    <ResponsiveContainer width="100%" height={heightPx}>
      <Sankey
        data={sankeyData}
        node={renderNode}
        link={renderLink}
        nodePadding={18}
        nodeWidth={12}
        margin={{ top: 16, right: 230, bottom: 16, left: 16 }}
      >
        <Tooltip content={<SankeyTooltip />} />
      </Sankey>
    </ResponsiveContainer>
  );

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
          {rangeButtons}
        </header>

        {/* The story in plain language — same links as the chart, to the cent */}
        <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {[
            { label: 'Money came in', cents: story.moneyIn, sub: 'paychecks, refunds, rewards & money received' },
            { label: 'Spent on living', cents: story.spending, sub: 'groceries, shopping, bills — every category' },
            { label: 'Sent to people & family', cents: story.toPeople, sub: 'Zelle + Remitly to India' },
            { label: gapTotal > 0 ? '⚠ Not yet in the data' : 'Data complete', cents: gapTotal, sub: gapTotal > 0 ? 'export gaps — shown in the chart, being re-exported' : 'every dollar accounted for' },
          ].map((t) => (
            <div key={t.label} className="rounded-xl border border-[var(--border-color)] bg-[var(--background-secondary)] p-4">
              <p className="text-xs text-[var(--foreground-muted)]">{t.label}</p>
              <p className={`text-xl font-bold mt-1 ${t.label.startsWith('⚠') ? 'text-[var(--accent-danger)]' : 'text-[var(--foreground)]'}`}>
                {money(t.cents)}
              </p>
              <p className="text-xs text-[var(--foreground-muted)] mt-1">{t.sub}</p>
            </div>
          ))}
        </section>

        {sankeyData.links.length === 0 ? (
          <div className="rounded-xl border border-[var(--border-color)] p-10 text-center text-[var(--foreground-muted)]">
            No transactions in this period.
          </div>
        ) : (
          <section className="rounded-xl border border-[var(--border-color)] bg-[var(--background-secondary)] p-4 relative">
            <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
              {kindChips}
              <button
                onClick={() => setMaximized(true)}
                className="p-2 rounded-lg text-[var(--foreground-secondary)] hover:text-[var(--foreground)] hover:bg-[var(--background-tertiary)]"
                title="Maximize"
                aria-label="Maximize chart"
              >
                <Maximize2 className="w-4 h-4" />
              </button>
            </div>
            <div className="overflow-x-auto">
              <div style={{ minWidth: 900 }}>{sankeyChart(560)}</div>
            </div>
            <p className="text-xs text-[var(--foreground-muted)] mt-2">
              Click an income source (left side) to follow that money to the end · hover for a quick peek ·
              chips filter by kind · Esc clears
            </p>
          </section>
        )}

        {/* Maximized overlay */}
        {maximized && (
          <div className="fixed inset-0 z-[70] bg-[var(--background)] p-3 sm:p-4 flex flex-col">
            <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
              <h2 className="text-lg font-semibold text-[var(--foreground)]">Money flow</h2>
              <div className="flex items-center gap-2 flex-wrap">
                {rangeButtons}
                <button
                  onClick={() => setMaximized(false)}
                  className="p-2 rounded-lg text-[var(--foreground-secondary)] hover:text-[var(--foreground)] hover:bg-[var(--background-tertiary)]"
                  title="Minimize (Esc)"
                  aria-label="Minimize chart"
                >
                  <Minimize2 className="w-4 h-4" />
                </button>
              </div>
            </div>
            <div className="mb-2">{kindChips}</div>
            <div className="flex-1 min-h-0 overflow-auto rounded-xl border border-[var(--border-color)] bg-[var(--background-secondary)] p-2">
              <div style={{ minWidth: 900 }} className="h-full">{sankeyChart('100%')}</div>
            </div>
          </div>
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
