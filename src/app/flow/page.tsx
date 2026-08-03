'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { SECONDARY_ITEMS } from '@/lib/nav';
import { askAbout, askAboutNode } from '@/lib/ask';
import {
  ResponsiveContainer, Sankey, Tooltip, LineChart, Line, XAxis, YAxis, CartesianGrid,
  Treemap, BarChart, Bar, Cell,
} from 'recharts';
import { Maximize2, Minimize2, Sparkles } from 'lucide-react';
import Navbar from '@/components/Navbar';
import ReconcileSheet from '@/components/ReconcileSheet';
import RecoveryReviewPanel from '@/components/RecoveryReviewPanel';
import {
  GroupDecision, MappingGroup, UNPAIRED_LEG_LANE_IDS,
  buildMappingGroups, confirmGroupMeaning, markGroupUnknown,
} from '@/lib/mapping-suggestions';
import { RelationBadgeRow } from '@/components/TransactionRelationBadge';
import { useAuth } from '@/context/AuthContext';
import { useTransactions } from '@/context/TransactionContext';
import { useUserProfile } from '@/context/UserProfileContext';
import { buildFlowGraph, counterpartyRowIds, detectRecurring, projectNetWorth, day, FlowGraph } from '@/lib/flows';
import {
  MONEY_BACK_LANE_IDS, NODE_PADDING_PX, fitLabel, labelMaxChars, nodeDepths, sankeyHeightFor,
} from '@/lib/flow-lanes';
import { flowNetting } from '@/lib/flow-netting';
import { FLOW_COLORS, FlowColorKey } from '@/lib/palette';
import { formatMoneyCents } from '@/lib/money';
import { CandidateStatus, ReviewCandidate, mergeCandidateRun } from '@/lib/candidates';
import { CARD_CREDIT_TO_INFLOW_MEANING, CardCreditKind } from '@/lib/card-credit';
import { selectInflowReviewQueue } from '@/lib/classify';
import { DuplicateCostEstimate, SubscriptionCancellation, emitDuplicateDecision, generateDuplicateCandidates } from '@/lib/duplicates';
import { emitRefundDecision, generateRefundCandidates } from '@/lib/refunds';
import { LinkDraft, REFUND_SOURCE_TYPES, TransactionLink, buildLink, toTxRef } from '@/lib/relations';
import { getLinks, getReviewCandidates, recordCandidateDecision, saveLink, saveReviewCandidate } from '@/lib/relations-store';
import { buildAliasIndex, resolveServiceIdentity } from '@/lib/service-identity';
import { useRecoveryObservability } from '@/lib/obs/useRecoveryObservability';
import { emit } from '@/lib/obs/events';
import { newTraceId } from '@/lib/obs/trace';
import {
  QueueContext, RecoveryDecision, REVIEW_SECTIONS, ReviewQueueItem, SectionId,
  buildReviewQueue, queueBadgeLabel, queueCounts, relationBadges, rowLabel, supersededLinks,
} from '@/lib/review-queue';

const money = (cents: number) => formatMoneyCents(cents);

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
  // Its own chip because it is its own thing: money coming back is not money earned.
  { kind: 'credit', label: 'Money back' },
  { kind: 'warning', label: '⚠ Gaps' },
];

// The Sankey lives in a horizontally scrolling box with this minimum width; label
// budgets are sized off the NARROWEST layout, so a wider screen only gives them room.
const SANKEY_MIN_WIDTH = 900;
const SANKEY_MARGIN = { top: 16, right: 230, bottom: 16, left: 16 };
const SANKEY_NODE_WIDTH = 12;

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

type NodePayload = { label?: string; kind?: FlowColorKey; value?: number; depth?: number };
type ChartKind = 'sankey' | 'treemap' | 'waterfall';
const CHART_KINDS: Array<{ key: ChartKind; label: string }> = [
  { key: 'sankey', label: 'Flow' },
  { key: 'treemap', label: 'Where it went' },
  { key: 'waterfall', label: 'Step by step' },
];

function TreemapCell(props: { x?: number; y?: number; width?: number; height?: number; name?: string; value?: number; fill?: string }) {
  const { x = 0, y = 0, width = 0, height = 0, name, value, fill } = props;
  if (width < 4 || height < 4) return <g />;
  return (
    <g>
      <rect x={x} y={y} width={width} height={height} fill={fill ?? '#64748b'} rx={3} opacity={0.85} stroke="rgba(0,0,0,0.25)" />
      {width > 82 && height > 30 && (
        <text x={x + 7} y={y + 18} style={{ fontSize: 11, fontWeight: 600, paintOrder: 'stroke' }} stroke="rgba(0,0,0,0.55)" strokeWidth={3} fill="#fff">{name}</text>
      )}
      {width > 82 && height > 48 && value !== undefined && (
        <text x={x + 7} y={y + 34} style={{ fontSize: 11, paintOrder: 'stroke' }} stroke="rgba(0,0,0,0.55)" strokeWidth={3} fill="#fff">
          {money(Math.round(value * 100))}
        </text>
      )}
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

/**
 * The cancellation effective date has no home in `ReviewCandidate` and
 * `recordCandidateDecision` has no field for it (FIN-DUPLICATE-001 limitation 1), while
 * `relations-store.ts`, `candidates.ts` and `firestore.rules` are all closed to this task.
 * It therefore rides on the candidate DOCUMENT as one extra field — the rules validate
 * with `keys().hasAll([...])`, so an additional key is legal — and is read back here into
 * `DuplicateOptions.cancellations`, which is what finally arms
 * `continued_charge_after_cancellation`.
 */
type CandidateDoc = ReviewCandidate & { cancelledEffectiveDate?: string };

interface UndoRecord {
  candidate: ReviewCandidate;
  previousStatus: CandidateStatus;
  links: TransactionLink[];
  label: string;
  eventName: string;
}

export default function FlowPage() {
  const { isAuthenticated, isLoading: authLoading, user } = useAuth();
  const { transactions, rules, addRule } = useTransactions();
  const { profile, reconcileAccount, incomeContext, setInflowReview, addIncomeSource } = useUserProfile();

  const [reconcileFor, setReconcileFor] = useState<{ accountId: string; name: string; derived: number } | null>(null);
  const router = useRouter();
  const [range, setRange] = useState<Range>('all');
  const [month, setMonth] = useState<string>(() => shiftMonth(new Date().toISOString().slice(0, 7), -1));
  const [chart, setChart] = useState<ChartKind>('sankey');
  const [maximized, setMaximized] = useState(false);
  const [hoverLabel, setHoverLabel] = useState<string | null>(null);
  const [pinLabel, setPinLabel] = useState<string | null>(null);
  const [focusKind, setFocusKind] = useState<FlowColorKey | null>(null);
  // Declared here, above the graph memo that reads them. A confirmed refund NETS the
  // category it reverses; `showGross` rebuilds the same graph with no links at all, so
  // gross cash movement is always one click away and is never destroyed to show net.
  const [links, setLinks] = useState<TransactionLink[]>([]);
  const [showGross, setShowGross] = useState(false);

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

  // Maximized overlay is a modal dialog: move focus in on open, keep Tab inside it, and
  // restore focus to the trigger on close (WCAG 2.4.3 focus order, 2.1.2 no keyboard trap).
  const overlayRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!maximized) return;
    const el = overlayRef.current;
    if (!el) return;
    const prev = document.activeElement as HTMLElement | null;
    const focusables = () => [...el.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input, [tabindex]:not([tabindex="-1"])'
    )];
    (focusables()[0] ?? el).focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const f = focusables();
      if (!f.length) { e.preventDefault(); return; }
      const first = f[0], lastEl = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); lastEl.focus(); }
      else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); first.focus(); }
    };
    el.addEventListener('keydown', onKey);
    return () => { el.removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, [maximized]);

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

  // Every month present in the data, newest → oldest, for the month picker.
  const monthOptions = useMemo(() => {
    if (maxMonth < minMonth) return [];
    const out: string[] = [];
    for (let m = maxMonth; m >= minMonth; m = shiftMonth(m, -1)) out.push(m);
    return out;
  }, [minMonth, maxMonth]);

  // The link-aware half of the lanes, resolved ONCE per (ledger, links) rather than per
  // render — it runs matchTransfers() and the ten-kind ladder, neither of which belongs
  // in a hover.
  const netting = useMemo(
    () => flowNetting(transactions, accounts, links, incomeContext),
    [transactions, accounts, links, incomeContext]
  );
  const graph: FlowGraph = useMemo(
    () => buildFlowGraph(transactions, accounts, periodFor(range, todayISO, month),
      showGross ? {} : { netting, income: incomeContext }),
    [transactions, accounts, range, todayISO, month, showGross, netting, incomeContext]
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

  // A pin from another period may not exist in this graph — treat it as no pin
  // (derived, not cleared via effect, so there is no extra render).
  const effectivePin = pinLabel && graph.nodes.some((n) => n.label === pinLabel) ? pinLabel : null;

  // The actual transactions behind a pinned node — the drill-down "see more detail".
  const pinnedTxns = useMemo(() => {
    if (!effectivePin) return null;
    const nodeId = graph.nodes.find((n) => n.label === effectivePin)?.id;
    const ids = nodeId ? new Set(graph.nodeTxnIds[nodeId] ?? []) : new Set<string>();
    if (ids.size === 0) return null;
    return transactions.filter((t) => ids.has(t.id)).sort((a, b) => b.date.localeCompare(a.date));
  }, [effectivePin, graph, transactions]);

  // Pinned node -> follow the money end-to-end: everything reachable downstream
  // (where it went) and upstream (where it came from).
  const reach = useMemo(() => {
    if (!effectivePin) return null;
    const bfs = (start: string, adj: Map<string, Set<string>>) => {
      const seen = new Set<string>();
      const q = [start];
      while (q.length) {
        const x = q.pop()!;
        for (const y of adj.get(x) ?? []) if (!seen.has(y)) { seen.add(y); q.push(y); }
      }
      return seen;
    };
    return { down: bfs(effectivePin, outAdj), up: bfs(effectivePin, inAdj) };
  }, [effectivePin, outAdj, inAdj]);

  const isNodeBright = useCallback((label: string, kind: FlowColorKey) => {
    if (hoverLabel) return label === hoverLabel || (neighborsOf.get(hoverLabel)?.has(label) ?? false);
    if (effectivePin && reach) return label === effectivePin || reach.down.has(label) || reach.up.has(label);
    if (focusKind) {
      if (kind === focusKind) return true;
      const focused = kindLabels.get(focusKind);
      if (!focused) return true;
      for (const n of neighborsOf.get(label) ?? []) if (focused.has(n)) return true;
      return false;
    }
    return true;
  }, [hoverLabel, effectivePin, reach, focusKind, neighborsOf, kindLabels]);

  const isLinkBright = useCallback((s?: NodePayload, t?: NodePayload) => {
    const sl = s?.label ?? '', tl = t?.label ?? '';
    if (hoverLabel) return sl === hoverLabel || tl === hoverLabel;
    if (effectivePin && reach) {
      // strictly on-path edges: downstream of the pin, or upstream into it —
      // never a shortcut between two reached nodes that bypasses the pin
      const downEdge = (sl === effectivePin || reach.down.has(sl)) && reach.down.has(tl);
      const upEdge = (tl === effectivePin || reach.up.has(tl)) && reach.up.has(sl);
      return downEdge || upEdge;
    }
    if (focusKind) return s?.kind === focusKind || t?.kind === focusKind;
    return true;
  }, [hoverLabel, effectivePin, reach, focusKind]);

  const anyFocus = hoverLabel !== null || effectivePin !== null || focusKind !== null;

  /**
   * Chart geometry, from the graph itself.
   *
   * `sankeyHeightFor` is the label-collision fix for the vertical case: recharts spaces a
   * column by `nodePadding` on the way down and then SQUEEZES it back inside the height
   * on the way up, so the moment a column needs more room than there is, labels start
   * printing through each other. Give the busiest column the room it needs and they
   * cannot. `maxDepth` is the horizontal half: it says which column draws its label
   * leftwards, and how much gutter the rest have before the next column starts.
   */
  const { chartHeight, maxDepth } = useMemo(() => {
    const depths = nodeDepths(graph.nodes, graph.links);
    return {
      chartHeight: sankeyHeightFor(graph.nodes, graph.links),
      maxDepth: Math.max(0, ...depths.values()),
    };
  }, [graph]);

  // Colored block + always-visible label; hover traces, click pins.
  const renderNode = useCallback((props: { x: number; y: number; width: number; height: number; payload: NodePayload }) => {
    const { x, y, width, height, payload } = props;
    const kind = payload.kind ?? 'stub';
    const bright = isNodeBright(payload.label ?? '', kind);
    const depth = payload.depth;
    const labelLeft = depth !== undefined && maxDepth > 0 ? depth >= maxDepth : x > 560;
    const full = `${payload.label}${payload.value ? ` · ${money(Math.round(payload.value * 100))}` : ''}`;
    // The label is drawn into the gutter beside the node, so a long one used to run
    // straight through the next column's node AND its label. Cut it to what fits and
    // keep the whole string in a <title> — nothing is lost, it is one hover away.
    const shown = fitLabel(full, labelMaxChars({
      depth: depth ?? 0,
      maxDepth,
      plotWidthPx: SANKEY_MIN_WIDTH - SANKEY_MARGIN.left - SANKEY_MARGIN.right,
      rightMarginPx: SANKEY_MARGIN.right,
      nodeWidthPx: SANKEY_NODE_WIDTH,
    }));
    return (
      <g
        className="flow-node"
        tabIndex={0}
        role="button"
        aria-label={`${payload.label ?? 'node'}${payload.value ? `, ${money(Math.round(payload.value * 100))}` : ''}. Press Enter to trace this money through the flow.`}
        aria-pressed={effectivePin === payload.label}
        opacity={bright ? 1 : 0.22}
        style={{ cursor: 'pointer', transition: 'opacity 150ms' }}
        onPointerEnter={(e) => { if (e.pointerType === 'mouse') setHoverLabel(payload.label ?? null); }}
        onPointerLeave={(e) => { if (e.pointerType === 'mouse') setHoverLabel(null); }}
        onFocus={() => setHoverLabel(payload.label ?? null)}
        onBlur={() => setHoverLabel(null)}
        onClick={() => setPinLabel((p) => (p === payload.label ? null : payload.label ?? null))}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setPinLabel((p) => (p === payload.label ? null : payload.label ?? null));
          }
        }}
      >
        {/* Invisible hit target so the 12px node is thumb-tappable (44px min). */}
        <rect
          x={x - 10}
          y={y + height / 2 - Math.max(height, 44) / 2}
          width={width + 20}
          height={Math.max(height, 44)}
          fill="transparent"
        />
        <rect x={x} y={y} width={width} height={height} fill={FLOW_COLORS[kind]} rx={2} />
        <text
          x={labelLeft ? x - 6 : x + width + 6}
          y={y + height / 2}
          textAnchor={labelLeft ? 'end' : 'start'}
          dominantBaseline="middle"
          // paintOrder halo: on a dense chart two labels can still come close, and a
          // stroked outline keeps both readable instead of one erasing the other.
          style={{ fontSize: 11, paintOrder: 'stroke' }}
          stroke="var(--background-secondary)"
          strokeWidth={3}
          strokeLinejoin="round"
          className="fill-[var(--foreground-secondary)]"
        >
          <title>{full}</title>
          {shown}
        </text>
      </g>
    );
  }, [isNodeBright, effectivePin, maxDepth]);

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

  // The reconciliation "Now" column actually shows the balance at the END of the selected
  // period. That equals today only when the period runs to (or past) today — for a bounded
  // PAST period it is a historical balance, so label it honestly.
  const periodEnd = periodFor(range, todayISO, month).end;
  const balanceColLabel = !periodEnd || periodEnd >= todayISO ? 'Now' : 'Period end';

  const rangeButtons = (
    <div className="flex items-center gap-2 flex-wrap">
      <div role="group" aria-label="Time range" className="flex gap-1 rounded-lg bg-[var(--background-tertiary)] p-1 flex-wrap">
        {RANGES.map((r) => (
          <button
            key={r.key}
            onClick={() => setRange(r.key)}
            aria-pressed={range === r.key}
            className={`px-3 py-1.5 rounded-md text-sm transition-colors ${range === r.key
              ? 'bg-[var(--accent-primary)] text-[#16181c]'
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
          <select
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            aria-label="Jump to month"
            className="px-2 py-1 text-sm font-medium bg-transparent text-[var(--foreground)] focus:outline-none cursor-pointer min-w-[8.5rem] text-center"
          >
            {monthOptions.map((m) => (
              <option key={m} value={m} className="bg-[var(--background-secondary)] text-[var(--foreground)]">
                {monthLabel(m)}
              </option>
            ))}
          </select>
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

  /**
   * Plain-language headline for the selected period — computed from the same links the
   * chart draws, so the story and the diagram can never disagree.
   *
   * "Money came in" is EARNED money only. A refund is spending coming back, cashback is
   * a rebate and a card charge is spending the issuer fronted; none of them is income,
   * so none of them is in this figure. And an UNCONFIRMED refund is not netted out of
   * spending either — you cannot net a match nobody has proved. It gets its own number.
   */
  const story = (() => {
    const sum = (pred: (l: { source: string; target: string; cents: number }) => boolean) =>
      graph.links.filter(pred).reduce((s, l) => s + l.cents, 0);
    const moneyIn = sum((l) => l.source.startsWith('inc:') || l.source.startsWith('person-in:'));
    const moneyBack = sum((l) => MONEY_BACK_LANE_IDS.includes(l.source));
    // `cat:` links already carry the CONFIRMED netting the graph applied.
    const spending = sum((l) => l.target.startsWith('cat:'));
    const toPeople = sum((l) => l.target.startsWith('person-out:'));
    return { moneyIn, spending, toPeople, moneyBack, netted: graph.nettedRefundCents };
  })();

  // Sink buckets (nodes money ends at) — feed the treemap and the waterfall.
  const sinkRows = useMemo(() => {
    const hasOut = new Set(graph.links.map((l) => l.source));
    const meta = new Map(graph.nodes.map((n) => [n.id, n]));
    const by = new Map<string, { cents: number; kind: FlowColorKey }>();
    for (const l of graph.links) {
      if (hasOut.has(l.target)) continue; // not a terminal node
      const n = meta.get(l.target)!;
      const e = by.get(n.label) ?? { cents: 0, kind: n.kind };
      e.cents += l.cents;
      by.set(n.label, e);
    }
    return [...by.entries()].map(([label, e]) => ({ label, ...e })).sort((a, b) => b.cents - a.cents);
  }, [graph]);

  const totalSourcesCents = useMemo(() => {
    const hasIn = new Set(graph.links.map((l) => l.target));
    return graph.links.filter((l) => !hasIn.has(l.source)).reduce((s, l) => s + l.cents, 0);
  }, [graph]);

  // Text alternative for the SVG chart: every ribbon as a From → To → amount row. The
  // diagram is unreadable to a screen reader; this table carries the same data (dataviz
  // requires a table view of every chart), and sighted users get an exact lookup too.
  const linkRows = useMemo(() => {
    const labelOf = new Map(graph.nodes.map((n) => [n.id, n.label]));
    return graph.links
      .map((l) => ({ from: labelOf.get(l.source) ?? l.source, to: labelOf.get(l.target) ?? l.target, cents: l.cents }))
      .sort((a, b) => b.cents - a.cents);
  }, [graph]);

  const treemapData = useMemo(() => {
    const top = sinkRows.slice(0, 14);
    const rest = sinkRows.slice(14).reduce((s, r) => s + r.cents, 0);
    const rows = [...top, ...(rest > 0 ? [{ label: 'Everything else', cents: rest, kind: 'stub' as FlowColorKey }] : [])];
    return rows.map((r) => ({ name: r.label, size: r.cents / 100, fill: FLOW_COLORS[r.kind] }));
  }, [sinkRows]);

  // Waterfall: money available minus each destination — lands on exactly $0,
  // which IS the "no dollar missed" proof (conservation is unit-tested).
  const waterfall = useMemo(() => {
    const top = sinkRows.slice(0, 9);
    const rest = sinkRows.slice(9).reduce((s, r) => s + r.cents, 0);
    const buckets = [...top, ...(rest > 0 ? [{ label: 'Everything else', cents: rest, kind: 'stub' as FlowColorKey }] : [])];
    const rows = [{ name: 'Money available', base: 0, value: totalSourcesCents / 100, fill: FLOW_COLORS.source }];
    let run = totalSourcesCents;
    for (const b of buckets) {
      run -= b.cents;
      rows.push({ name: b.label, base: run / 100, value: b.cents / 100, fill: FLOW_COLORS[b.kind] });
    }
    return rows;
  }, [sinkRows, totalSourcesCents]);

  const kindChips = (
    <div role="group" aria-label="Filter flow by kind" className="flex gap-1 flex-wrap items-center">
      {KIND_CHIPS.map((c) => (
        <button
          key={c.label}
          onClick={() => { setFocusKind(c.kind); setPinLabel(null); }}
          aria-pressed={focusKind === c.kind}
          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs border transition-colors ${focusKind === c.kind
            ? 'bg-[var(--accent-primary)] text-[#16181c] border-transparent'
            : 'border-[var(--border-color)] text-[var(--foreground-secondary)] hover:text-[var(--foreground)]'}`}
        >
          {c.kind && (
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: FLOW_COLORS[c.kind] }} aria-hidden="true" />
          )}
          {c.label}
        </button>
      ))}
      {effectivePin && (
        <button
          onClick={() => setPinLabel(null)}
          className="px-2.5 py-1 rounded-full text-xs bg-[var(--background-tertiary)] text-[var(--foreground)]"
          title="Click to clear"
        >
          📌 {effectivePin} ✕
        </button>
      )}
    </div>
  );

  /**
   * GROSS IS NEVER DESTROYED TO SHOW NET. The chart nets what the owner has CONFIRMED;
   * this puts the untouched cash movement one click away. It only appears once there is
   * something to net — otherwise it is a switch between two identical pictures.
   */
  const hasConfirmedRefunds = links.some(
    (l) => l.status === 'confirmed' && REFUND_SOURCE_TYPES.includes(l.linkType)
  );
  const grossToggle = hasConfirmedRefunds ? (
    <button
      onClick={() => setShowGross((g) => !g)}
      aria-pressed={showGross}
      className="px-2.5 py-1 rounded-full text-xs border border-[var(--border-color)] text-[var(--foreground-secondary)] hover:text-[var(--foreground)]"
      title="Confirmed refunds reduce the category they reverse. Switch to gross to see every dollar exactly as it moved."
    >
      {showGross ? 'Showing gross' : 'Show gross'}
    </button>
  ) : null;

  const chartToggle = (
    <div role="group" aria-label="Chart type" className="flex gap-1 rounded-lg bg-[var(--background-tertiary)] p-1">
      {CHART_KINDS.map((c) => (
        <button
          key={c.key}
          onClick={() => setChart(c.key)}
          aria-pressed={chart === c.key}
          className={`px-3 py-1.5 rounded-md text-sm transition-colors ${chart === c.key
            ? 'bg-[var(--accent-primary)] text-[#16181c]'
            : 'text-[var(--foreground-secondary)] hover:text-[var(--foreground)]'}`}
        >
          {c.label}
        </button>
      ))}
    </div>
  );

  const chartView = (heightPx: number | '100%') => {
    if (chart === 'treemap') {
      return (
        <ResponsiveContainer width="100%" height={heightPx}>
          <Treemap data={treemapData} dataKey="size" nameKey="name" content={<TreemapCell />} isAnimationActive={false}>
            <Tooltip formatter={(v) => money(Math.round(Number(v) * 100))} />
          </Treemap>
        </ResponsiveContainer>
      );
    }
    if (chart === 'waterfall') {
      return (
        <ResponsiveContainer width="100%" height={heightPx}>
          <BarChart data={waterfall} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
            <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.15} />
            <XAxis dataKey="name" interval={0} angle={-28} textAnchor="end" height={95} tick={{ fontSize: 10 }} />
            <YAxis tickFormatter={(v) => `$${Math.round(Number(v) / 1000)}k`} tick={{ fontSize: 11 }} width={52} />
            <Tooltip formatter={(v) => money(Math.round(Number(v) * 100))} />
            <Bar dataKey="base" stackId="w" fill="transparent" isAnimationActive={false} />
            <Bar dataKey="value" stackId="w" radius={[3, 3, 0, 0]} isAnimationActive={false}>
              {waterfall.map((r, i) => <Cell key={i} fill={r.fill} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      );
    }
    return (
      <ResponsiveContainer width="100%" height={heightPx}>
        <Sankey
          data={sankeyData}
          node={renderNode}
          link={renderLink}
          nodePadding={NODE_PADDING_PX}
          nodeWidth={SANKEY_NODE_WIDTH}
          margin={SANKEY_MARGIN}
        >
          <Tooltip content={<SankeyTooltip />} />
        </Sankey>
      </ResponsiveContainer>
    );
  };

  // =========================================================================
  // FIN-RECOVERY-UI-001 — the review surface.
  //
  // EVERY hook below is above the early return on purpose. `/flow` shipped React
  // error #310 once by adding a hook after it; the note two blocks down is the scar.
  // =========================================================================

  // `?tab=review` per the accepted IA. Read in the initializer, like /history does, so
  // there is no set-state-in-effect and no useSearchParams prerender bailout. Anything
  // that is not `review` — absent, unknown, `transactions`, `insights` — renders today's
  // Flow content unchanged. The wider consolidation is UX-NAV-002's, not this task's.
  const [tab, setTab] = useState<string>(() =>
    typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('tab') || 'flow' : 'flow'
  );
  const [storedCandidates, setStoredCandidates] = useState<CandidateDoc[]>([]);
  const [recoveryLoaded, setRecoveryLoaded] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [sectionFilter, setSectionFilter] = useState<SectionId | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [undoRecord, setUndoRecord] = useState<UndoRecord | null>(null);
  // Desktop gets a persistent side panel; mobile gets the existing `Sheet`. Read once in
  // the initializer and updated only from the media-query event, so no effect sets state.
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(min-width: 1024px)').matches
      : false
  );

  const obs = useRecoveryObservability({ userId: user?.id });

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(min-width: 1024px)');
    const onChange = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Browser back/forward and deep links both work because `?tab=` is in the URL.
  useEffect(() => {
    const onPop = () => setTab(new URLSearchParams(window.location.search).get('tab') || 'flow');
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // The two recovery collections, read ONCE per signed-in session. Nothing here writes a
  // transaction document — a relationship is stored beside a row, never inside it.
  useEffect(() => {
    if (!isAuthenticated || !user?.id) return;
    let cancelled = false;
    Promise.all([getLinks(user.id), getReviewCandidates(user.id)])
      .then(([l, c]) => {
        if (cancelled) return;
        setLinks(l);
        setStoredCandidates(c as CandidateDoc[]);
        setRecoveryLoaded(true);
      })
      .catch(() => { if (!cancelled) setRecoveryLoaded(true); });
    return () => { cancelled = true; };
  }, [isAuthenticated, user?.id]);

  // The owner's "I cancelled it on ⟨date⟩" answers, read back off the candidate documents
  // and resolved to a service family from the LOCAL ledger (a candidate carries no
  // merchant text by design).
  const cancellations: SubscriptionCancellation[] = useMemo(() => {
    const index = new Map(transactions.map((t) => [t.id, t]));
    const aliasIndex = buildAliasIndex([]);
    return storedCandidates.flatMap((c) => {
      if (!c.cancelledEffectiveDate) return [];
      const row = c.transactionIds.map((id) => index.get(id)).find(Boolean);
      if (!row) return [];
      return [{
        serviceFamilyId: resolveServiceIdentity(row, aliasIndex).serviceFamilyId,
        effectiveDate: c.cancelledEffectiveDate,
      }];
    });
  }, [storedCandidates, transactions]);

  // DETECTION IS NEVER PER RENDER. Both generators are pure functions of their inputs and
  // are memoized on exactly those inputs, so they run when the data changes and at no
  // other time — not on a hover, not on a filter change, not on a re-render.
  const refundRun = useMemo(
    () => (recoveryLoaded ? generateRefundCandidates(transactions, accounts, links, { income: incomeContext }) : null),
    [recoveryLoaded, transactions, accounts, links, incomeContext]
  );
  const duplicateRun = useMemo(
    () => (recoveryLoaded ? generateDuplicateCandidates(transactions, accounts, { todayISO, cancellations, income: incomeContext }) : null),
    [recoveryLoaded, transactions, accounts, todayISO, cancellations, incomeContext]
  );

  // A terminal decision suppresses its candidate forever, across an algorithm-version
  // bump included — that is `mergeCandidateRun`'s whole job.
  const candidates: ReviewCandidate[] = useMemo(() => {
    const generated = [...(refundRun?.candidates ?? []), ...(duplicateRun?.candidates ?? [])];
    const run = mergeCandidateRun(generated, storedCandidates);
    return [...run.writes, ...run.unchanged];
  }, [refundRun, duplicateRun, storedCandidates]);

  const estimates: DuplicateCostEstimate[] = useMemo(() => duplicateRun?.estimates ?? [], [duplicateRun]);

  // FIN-REVIEW-002's unknown-inflow items, composed as ONE MORE SOURCE in this queue —
  // never a second queue, never a second state machine.
  const inflowItems = useMemo(
    () => (recoveryLoaded ? selectInflowReviewQueue(transactions, accounts, incomeContext) : []),
    [recoveryLoaded, transactions, accounts, incomeContext]
  );

  // MAP-001 — the unmapped, gathered into patterns. Derived from the ledger the graph
  // already built, so the unpaired legs are exactly the rows sitting in the four
  // "other leg not found" lanes and not a second, differently-computed set.
  const unpairedLegIds = useMemo(
    () => UNPAIRED_LEG_LANE_IDS.flatMap((id) => graph.nodeTxnIds[id] ?? []),
    [graph]
  );
  // FIN-SETTLEMENT-003 — the rows behind the person nodes, read off the SAME graph, so
  // what the chart drew and what the queue asks about cannot drift. Before this the
  // person lanes were terminal: money went in and no question ever came out.
  const counterpartyIds = useMemo(() => counterpartyRowIds(graph), [graph]);
  const groups: MappingGroup[] = useMemo(
    () => (recoveryLoaded
      ? buildMappingGroups({
          // MAP-002 — FIN-REFUND-001's run, computed above for the recovery queue and
          // handed over rather than run a second time. One refund matcher, one result.
          transactions, accounts, inflowItems, unpairedLegIds, counterpartyRowIds: counterpartyIds, rules,
          refundCandidates: refundRun?.candidates ?? [],
          income: incomeContext, todayISO,
        })
      : []),
    [recoveryLoaded, transactions, accounts, inflowItems, unpairedLegIds, counterpartyIds, rules, incomeContext, todayISO, refundRun]
  );

  const queueCtx: QueueContext = useMemo(
    () => ({ transactions, accounts, links, candidates, inflowItems, estimates, groups }),
    [transactions, accounts, links, candidates, inflowItems, estimates, groups]
  );
  const queue = useMemo(() => buildReviewQueue(queueCtx), [queueCtx]);
  const counts = useMemo(() => queueCounts(queue), [queue]);
  const badgeCtx = useMemo(() => ({ links, transactions, accounts, candidates }), [links, transactions, accounts, candidates]);

  /** Confirmed refund pairs, for the flow-as-a-table text alternative. */
  const confirmedPairs = useMemo(() => {
    const index = new Map(transactions.map((t) => [t.id, t]));
    const label = (id: string) => {
      const t = index.get(id);
      return t ? `${rowLabel(t)}, ${day(t.date)}` : id;
    };
    return links
      .filter((l) => l.status === 'confirmed' && REFUND_SOURCE_TYPES.includes(l.linkType))
      .map((l) => ({ id: l.id, from: label(l.sourceTransactionId), to: label(l.targetTransactionId), cents: l.allocatedAmountCents }));
  }, [links, transactions]);

  const reviewOpen = tab === 'review';
  const queueOpenedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!reviewOpen || !recoveryLoaded) return;
    const signature = `${queue.length}`;
    if (queueOpenedFor.current === signature) return;
    queueOpenedFor.current = signature;
    obs.trackQueueOpened({ total: queue.length, countsByType: counts.bySection });
  }, [reviewOpen, recoveryLoaded, queue.length, counts.bySection, obs]);

  const setTabInUrl = useCallback((next: string) => {
    setTab(next);
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (next === 'flow') url.searchParams.delete('tab');
    else url.searchParams.set('tab', next);
    window.history.pushState({}, '', url);
  }, []);

  const openReview = useCallback((section: SectionId | null) => {
    setSectionFilter(section);
    setTabInUrl('review');
  }, [setTabInUrl]);

  const closeReview = useCallback(() => {
    setSelectedKey(null);
    setUndoRecord(null); // a stale undo is worse than none
    setAnnouncement('');
    setTabInUrl('flow');
  }, [setTabInUrl]);

  const selectItem = useCallback((key: string | null) => {
    setSelectedKey(key);
    setUndoRecord(null);
    const item = queue.find((i) => i.key === key);
    if (!item) return;
    obs.trackTransactionSelected({
      candidateType: item.candidate?.candidateType ?? 'unknown_inflow',
      queuePosition: queue.indexOf(item),
      state: item.state,
    });
    // The existing trace machinery, unchanged: pin the node these rows already sit
    // behind, so the linked pair lights up and the drill-down lists them — without
    // adding a single node or edge to the graph.
    const nodeId = Object.keys(graph.nodeTxnIds).find((id) =>
      (graph.nodeTxnIds[id] ?? []).some((tid) => item.transactionIds.includes(tid))
    );
    const label = graph.nodes.find((n) => n.id === nodeId)?.label;
    if (label) setPinLabel(label);
  }, [queue, obs, graph]);

  const txRefs = useMemo(() => transactions.map(toTxRef), [transactions]);

  /**
   * THE ONE PATH FROM A PROPOSAL TO A STORED FACT, and it is reachable only from a button
   * press. Persist, recompute, update counts, drop the item, announce, offer undo — in
   * that order, with no page reload, no router re-fetch, and no in-place mutation of any
   * transaction, link or candidate object.
   */
  const onDecide = useCallback(
    (item: ReviewQueueItem, decision: RecoveryDecision, override?: ReviewCandidate) => {
      const uid = user?.id;
      const startedAt = Date.now();
      const candidate = override ?? item.candidate;

      // A card credit the owner explains: the answer is a review record on that ROW, and
      // no card credit maps to earned income by any path (CARD_CREDIT_TO_INFLOW_MEANING).
      if (decision.cardCreditKind) {
        const kind = decision.cardCreditKind as CardCreditKind;
        const transactionId = candidate
          ? candidate.transactionIds.find((id) => transactions.find((t) => t.id === id)?.type === 'income') ?? item.transactionIds[0]
          : item.transactionIds[0];
        void setInflowReview({
          transactionId,
          state: 'confirmed',
          meaning: CARD_CREDIT_TO_INFLOW_MEANING[kind],
          source: 'user',
          updatedAt: new Date().toISOString(),
        }).catch(() => setAnnouncement('That answer could not be saved. Please try again.'));
        obs.trackClassificationConfirmed({ candidateType: item.candidate?.candidateType ?? 'unknown_inflow', decisionStatus: decision.status });
      }

      // A chargeback is real but NOT final: a provisional link, which reduces no spending.
      if (decision.chargebackTargetId && candidate && uid) {
        const draft: LinkDraft = {
          linkType: 'chargeback_for',
          sourceTransactionId: candidate.transactionIds.find((id) => id !== decision.chargebackTargetId) ?? candidate.transactionIds[0],
          targetTransactionId: decision.chargebackTargetId,
          allocatedAmountCents: candidate.proposedLinks[0]?.allocatedAmountCents ?? 0,
          status: 'provisional',
          confirmedAt: new Date().toISOString(),
          algorithmVersion: candidate.algorithmVersion,
          candidateId: candidate.candidateId,
        };
        const built = buildLink(draft, { transactions: txRefs, links });
        if (built.ok) {
          setLinks((prev) => [...prev, built.link]);
          void saveLink(uid, draft, { transactions: txRefs, links }).catch(() => {});
        }
      }

      const writtenLinks: TransactionLink[] = [];
      if (candidate && decision.status === 'confirmed' && decision.allocations?.length) {
        const confirmedAt = new Date().toISOString();
        const accumulated = [...links];
        for (const allocation of decision.allocations) {
          const draft: LinkDraft = {
            linkType: candidate.candidateType === 'partial_refund_match' ? 'partial_refund_of' : 'refund_of',
            sourceTransactionId: candidate.proposedLinks[0]?.sourceTransactionId ?? candidate.transactionIds[0],
            targetTransactionId: allocation.targetTransactionId,
            allocatedAmountCents: allocation.allocatedAmountCents,
            status: 'confirmed',
            confirmedAt,
            confirmedBy: 'user',
            algorithmVersion: candidate.algorithmVersion,
            candidateId: candidate.candidateId,
          };
          const built = buildLink(draft, { transactions: txRefs, links: accumulated });
          if (!built.ok) {
            setAnnouncement(`That allocation was refused (rule ${built.ruleId}). Nothing was saved.`);
            return;
          }
          accumulated.push(built.link);
          writtenLinks.push(built.link);
          if (uid) void saveLink(uid, draft, { transactions: txRefs, links: accumulated }).catch(() => {});
        }
        // §7.2 — re-allocating a credit SUPERSEDES the allocation it replaces; it never
        // deletes it. The link id is derived from the pair, so a changed amount on the
        // same pair is an upsert; only a changed TARGET produces a second document, and
        // that is exactly the case that needs an audit trail.
        const creditId = candidate.proposedLinks[0]?.sourceTransactionId ?? candidate.transactionIds[0];
        const superseded = supersededLinks(
          links,
          creditId,
          new Set(writtenLinks.map((l) => l.targetTransactionId)),
          writtenLinks[0].id,
          confirmedAt
        );
        for (const l of superseded) {
          if (uid) {
            void saveLink(
              uid,
              { id: l.id, linkType: l.linkType, sourceTransactionId: l.sourceTransactionId, targetTransactionId: l.targetTransactionId, allocatedAmountCents: l.allocatedAmountCents, status: 'superseded', supersededByLinkId: l.supersededByLinkId, algorithmVersion: l.algorithmVersion },
              { transactions: txRefs, links: accumulated }
            ).catch(() => {});
          }
        }

        // New arrays, new objects — no `t.category = …` anywhere in this feature.
        setLinks((prev) => [...prev.map((l) => superseded.find((s) => s.id === l.id) ?? l), ...writtenLinks]);
        obs.trackLinkConfirmed({
          candidateType: candidate.candidateType,
          allocationCount: writtenLinks.length,
          algorithmVersion: candidate.algorithmVersion,
          durationMs: Date.now() - startedAt,
        });
        emitRefundDecision({
          event: 'Refund.MatchConfirmed',
          candidateType: candidate.candidateType,
          allocationCount: writtenLinks.length,
          sameAccount: candidate.evidence.sameAccount,
          dayGap: candidate.evidence.dayGaps[0] ?? 0,
        });
      } else if (candidate && decision.status === 'dismissed' && !decision.cardCreditKind) {
        emitRefundDecision({
          event: 'Refund.MatchRejected',
          candidateType: candidate.candidateType,
          rejectionReasonCode: decision.reasonCode ?? 'rejected',
        });
      }

      if (candidate) {
        const previousStatus = candidate.status;
        const doc: CandidateDoc = {
          ...candidate,
          status: decision.status,
          reviewedBy: 'user',
          reviewedAt: new Date().toISOString(),
          ...(writtenLinks.length ? { linkIds: writtenLinks.map((l) => l.id) } : {}),
          ...(decision.effectiveDate ? { cancelledEffectiveDate: decision.effectiveDate } : {}),
        };
        setStoredCandidates((prev) => [...prev.filter((c) => c.id !== doc.id), doc]);
        if (uid) {
          void saveReviewCandidate(uid, doc)
            .then(() => recordCandidateDecision(uid, doc.id, decision.status, { linkIds: doc.linkIds }))
            .catch(() => setAnnouncement('That decision could not be saved. Please try again.'));
        }
        emitDuplicateDecision(candidate.candidateType, decision.status, decision.reasonCode);
        setUndoRecord({
          candidate,
          previousStatus,
          links: writtenLinks,
          label: 'Undo',
          eventName: decision.status === 'confirmed' ? 'MoneyReview.LinkConfirmed' : 'MoneyReview.ClassificationConfirmed',
        });
      }

      setAnnouncement(
        decision.status === 'confirmed' && writtenLinks.length
          ? `Confirmed — ${money(writtenLinks.reduce((s, l) => s + l.allocatedAmountCents, 0))} marked as returned.`
          : decision.status === 'intentional'
            ? 'Saved — we will stop asking about this one. Both transactions stay counted.'
            : 'Saved. Nothing else changed.'
      );
      setSelectedKey(null);
    },
    [user?.id, transactions, txRefs, links, setInflowReview, obs]
  );

  /** One step, panel-scoped. Undo never DELETES a link — FIN-RELATION-001 §6 denies it. */
  const onUndo = useCallback(() => {
    if (!undoRecord) return;
    const uid = user?.id;
    const startedAt = Date.now();
    const undoneIds = new Set(undoRecord.links.map((l) => l.id));
    setLinks((prev) => prev.map((l) => (undoneIds.has(l.id) ? { ...l, status: 'rejected' as const } : l)));
    setStoredCandidates((prev) => [
      ...prev.filter((c) => c.id !== undoRecord.candidate.id),
      { ...undoRecord.candidate, status: undoRecord.previousStatus },
    ]);
    if (uid) {
      for (const link of undoRecord.links) {
        void saveLink(
          uid,
          {
            id: link.id, linkType: link.linkType,
            sourceTransactionId: link.sourceTransactionId, targetTransactionId: link.targetTransactionId,
            allocatedAmountCents: link.allocatedAmountCents, status: 'rejected',
            algorithmVersion: link.algorithmVersion, candidateId: link.candidateId,
          },
          { transactions: txRefs, links }
        ).catch(() => {});
      }
      void recordCandidateDecision(uid, undoRecord.candidate.id, undoRecord.previousStatus).catch(() => {});
    }
    obs.trackUndoCompleted({ undoneEventName: undoRecord.eventName, durationMs: Date.now() - startedAt, resultStatus: 'ok' });
    setAnnouncement('Undone. Nothing was deleted — the links are recorded as rejected.');
    setUndoRecord(null);
  }, [undoRecord, user?.id, txRefs, links, obs]);

  /**
   * ONE answer for a whole pattern. Same store as every other decision on this surface:
   * a review record per row, plus — only when the owner asked for it and the engine can
   * express it — one MappingRule. Nothing is written before the Confirm button is pressed.
   */
  const onGroupDecide = useCallback(
    (item: ReviewQueueItem, decision: GroupDecision) => {
      const group = item.group;
      if (!group) return;
      const startedAt = Date.now();
      const at = new Date().toISOString();
      const writes =
        decision.action === 'unknown'
          ? markGroupUnknown(group, at)
          : confirmGroupMeaning(group, decision.meaning!, at, decision.incomeSourceId);

      for (const review of writes) {
        void setInflowReview(review).catch(() =>
          setAnnouncement('That answer could not be saved. Please try again.')
        );
      }
      if (decision.rule) void addRule(decision.rule).catch(() => {});
      // MAP-002 — the derived income source, present only when the owner ticked the offer.
      if (decision.incomeSourceOffer) {
        void addIncomeSource(decision.incomeSourceOffer).catch(() =>
          setAnnouncement('That income source could not be saved. Please try again.')
        );
      }

      // Counts, scope and confidence only — never a merchant, a counterparty or an amount.
      emit({
        eventName: decision.action === 'unknown' ? 'Mapping.MarkedUnknown' : 'Mapping.GroupConfirmed',
        traceId: newTraceId(),
        route: '/flow',
        component: 'FlowPage.onGroupDecide',
        durationMs: Date.now() - startedAt,
        recordCount: writes.length,
        resultStatus: 'ok',
        metadata: {
          kind: group.kind,
          scope: decision.scope,
          suggestionEvidence: group.suggestion?.evidence ?? 'none',
          suggestionConfidence: group.suggestion?.confidence ?? 0,
          ruleCreated: !!decision.rule,
          incomeSourceCreated: !!decision.incomeSourceOffer,
          findingCount: group.findings.length,
        },
      });
      if (decision.rule) {
        emit({
          eventName: 'Mapping.RuleCreated',
          traceId: newTraceId(),
          route: '/flow',
          component: 'FlowPage.onGroupDecide',
          resultStatus: 'ok',
          metadata: { scope: decision.scope, hasDirection: !!decision.rule.match.direction },
        });
      }

      setAnnouncement(
        decision.action === 'unknown'
          ? `Saved — we will stop asking about this pattern. All ${writes.length} rows stay in your history.`
          : `Saved for ${writes.length} ${writes.length === 1 ? 'row' : 'rows'}.${
              decision.rule ? ' Future imports will land the same way.' : ''
            }`
      );
      setSelectedKey(null);
    },
    [setInflowReview, addRule, addIncomeSource]
  );

  const reviewPanelProps = {
    items: queue,
    ctx: queueCtx,
    estimates,
    selectedKey,
    sectionFilter,
    announcement,
    undoLabel: undoRecord ? undoRecord.label : null,
    onSelect: selectItem,
    onSectionFilter: setSectionFilter,
    onDecide,
    onUndo,
    onAllocationEdited: obs.trackAllocationEdited,
    onGroupDecide,
    todayISO,
    onClose: closeReview,
  };

  // AFTER all hooks — an early return above any hook crashes React with
  // "rendered more hooks than during the previous render" (shipped once; never again).
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
          {rangeButtons}
        </header>

        {/* The story in plain language — same links as the chart, to the cent */}
        <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3">
          {[
            { label: 'Money came in', cents: story.moneyIn, sub: 'paychecks & money received — refunds, rewards and card charges are not income' },
            {
              label: 'Spent on living',
              cents: story.spending,
              sub: story.netted > 0
                ? `all categories, net of ${money(story.netted)} you confirmed as refunded`
                : 'all categories, gross — nothing netted until you confirm a refund',
            },
            {
              label: 'Money back (not income)',
              cents: story.moneyBack,
              sub: 'refunds, cashback and card credits waiting to be matched to a purchase',
            },
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

        {/* The review entry point, in the tile voice. Zero-count chips are hidden; when
            everything is reviewed one calm line replaces the strip. The total is
            ANNOUNCED, not merely painted. */}
        {recoveryLoaded && (
          <section aria-label="Review shortcuts" className="flex flex-wrap items-center gap-2">
            <span className="sr-only" aria-live="polite">{queueBadgeLabel(counts.total)}</span>
            {counts.total === 0 ? (
              <p className="text-sm text-[var(--foreground-muted)]">Nothing to review.</p>
            ) : (
              <>
                <button
                  onClick={() => openReview(null)}
                  aria-label={queueBadgeLabel(counts.total)}
                  className="min-h-[44px] px-3 py-2 rounded-full text-sm bg-[var(--accent-primary)] text-[#16181c]"
                >
                  Needs Review · {counts.total}
                </button>
                {REVIEW_SECTIONS.map((s) =>
                  counts.bySection[s.id] ? (
                    <button
                      key={s.id}
                      onClick={() => openReview(s.id)}
                      className="min-h-[44px] px-3 py-2 rounded-full text-sm border border-[var(--border-color)] text-[var(--foreground-secondary)] hover:text-[var(--foreground)]"
                    >
                      {s.chipLabel} · {counts.bySection[s.id]}
                    </button>
                  ) : null
                )}
              </>
            )}
          </section>
        )}

        <div className="lg:flex lg:items-start lg:gap-4">
        <div className="flex-1 min-w-0 space-y-10">
        {sankeyData.links.length === 0 ? (
          <div className="rounded-xl border border-[var(--border-color)] p-10 text-center text-[var(--foreground-muted)]">
            No transactions in this period.
          </div>
        ) : (
          <section className="rounded-xl border border-[var(--border-color)] bg-[var(--background-secondary)] p-4 relative">
            <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
              <div className="flex items-center gap-2 flex-wrap">
                {chartToggle}
                {chart === 'sankey' && kindChips}
                {chart === 'sankey' && grossToggle}
              </div>
              <button
                onClick={() => setMaximized(true)}
                className="p-2 rounded-lg text-[var(--foreground-secondary)] hover:text-[var(--foreground)] hover:bg-[var(--background-tertiary)]"
                title="Maximize"
                aria-label="Maximize chart"
              >
                <Maximize2 className="w-4 h-4" />
              </button>
            </div>
            {chart === 'sankey' && (
              <details className="mb-2 text-xs">
                <summary className="cursor-pointer min-h-[44px] flex items-center select-none text-[var(--foreground-secondary)] hover:text-[var(--foreground)]">
                  How to read this
                </summary>
                <div className="pt-1 space-y-1 text-[var(--foreground-muted)]">
                  <p>Read left → right: money comes <strong>in</strong> on the left, flows through your accounts, and goes <strong>out</strong> on the right. Ribbon thickness = dollars.</p>
                  <p>Color = kind (the chips above are the key). Tap any box to trace that money end-to-end and see the transactions behind it.</p>
                  <p>Gray = money that stayed in your accounts, or moved between your own accounts.</p>
                  <p>
                    Orange = money coming <strong>back</strong> — refunds, cashback, card credits. Real money, but not
                    income, so it never stands beside your paychecks. Once you confirm what a refund reverses, it stops
                    being a lane of its own and reduces the category it came from instead; <em>Show gross</em> puts every
                    dollar back exactly as it moved.
                  </p>
                  <p>“Borrowed on your cards” is card <strong>spending</strong> you have not paid off yet — the issuer fronted it, so it enters on the left.</p>
                </div>
              </details>
            )}
            <div
              className="overflow-x-auto"
              role="img"
              aria-label={`${CHART_KINDS.find((c) => c.key === chart)?.label ?? 'Flow'} chart tracing ${money(totalSourcesCents)} across ${graph.nodes.length} sources, accounts and destinations. The full breakdown is in the "View the flow as a table" section below.`}
            >
              <div style={{ minWidth: chart === 'sankey' ? SANKEY_MIN_WIDTH : 0 }}>
                {chartView(chart === 'sankey' ? chartHeight : 560)}
              </div>
            </div>
            <p className="text-xs text-[var(--foreground-muted)] mt-2">
              {chart === 'sankey' && 'Click or focus an income source (left side) and press Enter to follow that money to the end · hover for a quick peek · chips filter by kind · Esc clears'}
              {chart === 'treemap' && 'Box size = dollars. Where every dollar ended up in this period — including what stayed in your accounts.'}
              {chart === 'waterfall' && 'Start with all money available, subtract each destination — it lands on exactly $0 because every dollar is accounted for.'}
            </p>

            {/* Drill-down: the actual transactions behind the pinned node */}
            {pinnedTxns && pinnedTxns.length > 0 && (
              <div className="mt-3 rounded-xl border border-[var(--accent-primary)]/40 overflow-hidden">
                <div className="px-3 py-2 bg-[var(--background-tertiary)] flex items-center gap-3 flex-wrap">
                  <span className="text-sm font-medium text-[var(--foreground)] flex-1 min-w-0">
                    {pinnedTxns.length} transaction{pinnedTxns.length > 1 ? 's' : ''} behind “{effectivePin}”
                  </span>
                  {/* The owner is already looking at these rows — asking about them
                      should not mean retyping what the app can see. The question is
                      phrased from the pinned node and its own totals. */}
                  <button
                    type="button"
                    onClick={() => askAbout(askAboutNode(effectivePin!, pinnedTxns))}
                    className="shrink-0 min-h-[36px] flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--border-color)] bg-[var(--background-secondary)] text-xs font-medium text-[var(--foreground-secondary)] hover:text-[var(--foreground)] hover:bg-[var(--background)] transition-colors"
                  >
                    <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                    Ask about this
                  </button>
                </div>
                <div className="max-h-64 overflow-y-auto">
                  <table className="w-full text-sm">
                    <thead className="text-left text-[var(--foreground-muted)] sticky top-0 bg-[var(--background-secondary)]">
                      <tr>
                        <th scope="col" className="px-3 py-1.5 font-normal">Date</th>
                        <th scope="col" className="px-3 py-1.5 font-normal">Merchant</th>
                        <th scope="col" className="px-3 py-1.5 font-normal text-right">Amount</th>
                        <th scope="col" className="px-3 py-1.5 font-normal">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pinnedTxns.map((t) => (
                        <tr key={t.id} className="border-t border-[var(--border-color)]">
                          <td className="px-3 py-1.5 whitespace-nowrap">{t.date}</td>
                          <td className="px-3 py-1.5">{t.merchant || t.title}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{money(Math.round(t.amount * 100))}</td>
                          {/* Gross stays on the row. The badge says what happened to it. */}
                          <td className="px-3 py-1.5"><RelationBadgeRow badges={relationBadges(t, badgeCtx)} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Text alternative — the same ribbons as a real table (keyboard + screen-reader path) */}
            <details className="mt-3">
              <summary className="cursor-pointer text-sm text-[var(--foreground-secondary)] hover:text-[var(--foreground)] select-none">
                View the flow as a table ({linkRows.length} flows)
              </summary>
              <div className="overflow-x-auto rounded-xl border border-[var(--border-color)] mt-2">
                <table className="w-full text-sm">
                  <caption className="sr-only">Every money flow for this period, from source to destination, in dollars.</caption>
                  <thead className="bg-[var(--background-tertiary)] text-left">
                    <tr>
                      <th scope="col" className="px-3 py-2">From</th>
                      <th scope="col" className="px-3 py-2">To</th>
                      <th scope="col" className="px-3 py-2 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {linkRows.map((l, i) => (
                      <tr key={i} className="border-t border-[var(--border-color)]">
                        <td className="px-3 py-2">{l.from}</td>
                        <td className="px-3 py-2">{l.to}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{money(l.cents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Any relationship the diagram highlights must also be READABLE. The Sankey
                  gains no node and no edge for a confirmed refund — it renders as a linked
                  pair — so the pairs are listed here, where a screen reader can reach them. */}
              {confirmedPairs.length > 0 && (
                <div className="overflow-x-auto rounded-xl border border-[var(--border-color)] mt-2">
                  <table className="w-full text-sm">
                    <caption className="sr-only">Linked transactions: which credit reverses which purchase.</caption>
                    <thead className="bg-[var(--background-tertiary)] text-left">
                      <tr>
                        <th scope="col" className="px-3 py-2">Credit</th>
                        <th scope="col" className="px-3 py-2">Reverses</th>
                        <th scope="col" className="px-3 py-2 text-right">Allocated</th>
                      </tr>
                    </thead>
                    <tbody>
                      {confirmedPairs.map((p) => (
                        <tr key={p.id} className="border-t border-[var(--border-color)]">
                          <td className="px-3 py-2">{p.from}</td>
                          <td className="px-3 py-2">{p.to}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{money(p.cents)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </details>
          </section>
        )}
        </div>

        {/* Desktop: a persistent landmark beside the diagram, so the Sankey stays visible
            while the owner moves through items. Mobile gets the `Sheet` instead — the
            desktop sidebar is never ported down. */}
        {reviewOpen && isDesktop && <RecoveryReviewPanel {...reviewPanelProps} variant="panel" />}
        </div>

        {/* Maximized overlay */}
        {maximized && (
          <div
            ref={overlayRef}
            role="dialog"
            aria-modal="true"
            aria-label="Money flow, expanded view"
            tabIndex={-1}
            className="fixed inset-0 z-[70] bg-[var(--background)] p-3 sm:p-4 flex flex-col">
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
            <div className="mb-2 flex items-center gap-2 flex-wrap">{chartToggle}{chart === 'sankey' && kindChips}{chart === 'sankey' && grossToggle}</div>
            <div className="flex-1 min-h-0 overflow-auto rounded-xl border border-[var(--border-color)] bg-[var(--background-secondary)] p-2">
              {/* minHeight keeps the chart usable on short/landscape screens — it scrolls in
                  the overflow-auto parent instead of being crushed to a few pixels. */}
              {/* minHeight is the same collision guard as the inline chart: below it a
                  busy column gets squeezed and its labels overlap. */}
              <div
                style={{ minWidth: chart === 'sankey' ? SANKEY_MIN_WIDTH : 0, minHeight: chart === 'sankey' ? chartHeight : 420 }}
                className="h-full"
              >{chartView('100%')}</div>
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
                  <th className="px-3 py-2 text-right">{balanceColLabel}</th><th className="px-3 py-2">Verdict</th>
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
                        ? <button
                            onClick={() => setReconcileFor({ accountId: r.accountId, name: r.name, derived: r.closingCents / 100 })}
                            className="text-[var(--accent-danger)] hover:underline"
                            title="Enter your real balance to fix this gap"
                          >⚠ off by {money(r.gapCents)} — reconcile</button>
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
                <Line type="monotone" dataKey="value" stroke="#b08d3f" strokeWidth={2} dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </section>

        {/* The four screens that left the nav bar (UX-IA-001). Flow owns the past
            ledger, so this is where the other views of it are reached from. */}
        <nav aria-label="Other views of this data" className="mt-8 pt-6 border-t border-[var(--border-color)]">
          <h2 className="text-sm font-medium text-[var(--foreground-muted)] mb-3">Other views of this data</h2>
          <div className="flex flex-wrap gap-2">
            {SECONDARY_ITEMS.map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                className="min-h-[44px] flex items-center gap-2 px-4 py-2 rounded-xl border border-[var(--border-color)] bg-[var(--background-secondary)] text-sm text-[var(--foreground-secondary)] hover:text-[var(--foreground)] hover:bg-[var(--background-tertiary)] transition-colors"
              >
                <Icon className="w-4 h-4" aria-hidden="true" />
                {label}
              </Link>
            ))}
          </div>
        </nav>

        {reviewOpen && !isDesktop && <RecoveryReviewPanel {...reviewPanelProps} variant="sheet" />}

        {reconcileFor && (
          <ReconcileSheet
            accountName={reconcileFor.name}
            inputLabel="real balance right now"
            derivedCurrent={reconcileFor.derived}
            onConfirm={async (entered) => { await reconcileAccount(reconcileFor.accountId, entered, reconcileFor.derived); }}
            onClose={() => setReconcileFor(null)}
          />
        )}
      </main>
    </div>
  );
}
