/**
 * flowSnapshot — where the money came from and where it went, derived server-side.
 *
 * `buildFlowGraph` (src/lib/flows.ts) is the whole engine and it runs here
 * unchanged, on the same ledger read `homeSnapshot` uses. The phone draws bars
 * from the result; it does not compute one figure of it.
 *
 * The reductions below (`sources`, `sinks`, `story`) exist as local consts
 * inside the web's `/flow/page.tsx`. They are short — five to ten lines each —
 * which is exactly why they are computed here rather than on the phone: a
 * second implementation of a money reduce is a second opinion, and that is the
 * thing this whole callable architecture exists to prevent.
 */

import { HttpsError, onCall } from 'firebase-functions/v2/https';

import { withDerivedBalances } from '@/lib/forecast';
import { buildFlowGraph, type FlowGraph } from '@/lib/flows';
import { simplifyFlowGraph } from '@/lib/flow-simple';
import type { IncomeContext } from '@/lib/classify';

import { mapTransaction, readLedger } from './snapshot';

type Range = 'all' | 'year' | 'month';

interface Request {
  range?: Range;
  /** `2026-06` when range is `month`; `2026` when range is `year`. */
  key?: string;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Last day of a month, without date maths that can roll into the next one. */
const endOfMonth = (year: number, month: number): string =>
  new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);

function periodFor(range: Range, key: string | undefined, months: string[]) {
  if (range === 'month' && key) {
    const [y, m] = key.split('-').map(Number);
    return {
      start: `${key}-01`,
      end: endOfMonth(y!, m!),
      label: `${MONTHS[m! - 1]} ${y}`,
    };
  }
  if (range === 'year' && key) {
    return { start: `${key}-01-01`, end: `${key}-12-31`, label: key };
  }
  const first = months[0];
  const last = months[months.length - 1];
  return {
    start: undefined,
    end: undefined,
    label: first && last ? `All time · ${first} to ${last}` : 'All time',
  };
}

/**
 * Depth-0 sources and terminal sinks, biggest first.
 *
 * A source is a node nothing flows INTO; a sink is one nothing flows OUT of.
 * Between them sit the accounts, which is the layer a bar chart cannot show —
 * hence `betweenAccounts` travelling separately as a list.
 */
function endpoints(graph: FlowGraph) {
  const inflow = new Map<string, number>();
  const outflow = new Map<string, number>();
  for (const link of graph.links) {
    outflow.set(link.source, (outflow.get(link.source) ?? 0) + link.cents);
    inflow.set(link.target, (inflow.get(link.target) ?? 0) + link.cents);
  }

  const label = (id: string) => graph.nodes.find((n) => n.id === id);

  const sources = [...outflow.entries()]
    .filter(([id]) => !inflow.has(id))
    .map(([id, cents]) => ({ id, label: label(id)?.label ?? id, kind: label(id)?.kind ?? 'stub', cents }))
    .sort((a, b) => b.cents - a.cents);

  const sinks = [...inflow.entries()]
    .filter(([id]) => !outflow.has(id))
    .map(([id, cents]) => ({ id, label: label(id)?.label ?? id, kind: label(id)?.kind ?? 'stub', cents }))
    .sort((a, b) => b.cents - a.cents);

  return {
    sources,
    sinks,
    totals: {
      sourcesCents: sources.reduce((sum, n) => sum + n.cents, 0),
      sinksCents: sinks.reduce((sum, n) => sum + n.cents, 0),
    },
  };
}

/** The headline tiles, read off the DETAILED graph before simplification. */
function story(graph: FlowGraph) {
  const sum = (test: (id: string) => boolean, side: 'source' | 'target') =>
    graph.links.filter((l) => test(l[side])).reduce((total, l) => total + l.cents, 0);

  return {
    earnedInCents: sum((id) => id.startsWith('inc:'), 'source'),
    fromPeopleCents: sum((id) => id.startsWith('person-in:'), 'source'),
    moneyBackCents: sum((id) => id.startsWith('back:'), 'source'),
    spendingCents: sum((id) => id.startsWith('cat:'), 'target'),
    toPeopleCents: sum((id) => id.startsWith('person-out:'), 'target'),
    // Both already computed by the engine — never recounted here.
    nettedRefundCents: graph.nettedRefundCents,
    personExpenseCents: graph.personExpenseCents,
  };
}

export const flowSnapshot = onCall({ cors: true, memory: '512MiB' }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in to see your money flow.');
  }

  const { range = 'all', key } = (request.data ?? {}) as Request;
  const ledger = await readLedger(request.auth.uid);

  const policy: IncomeContext = {
    sources: ledger.incomeSources,
    reviews: ledger.reviews,
    includePending: ledger.includePending,
  };

  // DERIVED balances, deliberately: every other figure the phone receives is
  // derived, and a `closingCents` here that contradicted the `balanceCents` in
  // the same app would be two answers to one question.
  const accounts = withDerivedBalances(ledger.accounts, ledger.transactions, policy);

  const months = [...new Set(ledger.transactions.map((t) => t.date.slice(0, 7)))].sort();
  const period = periodFor(range, key, months);

  // Netting off for v1 — this is the web's own "Show gross" view. Turning it on
  // means reading users/{uid}/links and is a change of meaning, not a detail.
  const detailed = buildFlowGraph(
    ledger.transactions,
    accounts,
    { ...(period.start ? { start: period.start } : {}), ...(period.end ? { end: period.end } : {}) },
    { income: policy },
  );

  // Folds person lanes, money-back lanes and the tail of the category list.
  // Pure relabel-and-merge: no cents are lost, which is what makes it safe to
  // draw the simplified graph and quote the detailed totals beside it.
  const simple = simplifyFlowGraph(detailed);

  return {
    generatedAt: new Date().toISOString(),
    period,
    bounds: { minMonth: months[0] ?? null, maxMonth: months[months.length - 1] ?? null },
    ...endpoints(simple),
    story: story(detailed),
    betweenAccounts: detailed.between,
    reconciliation: detailed.reconciliation,
    nodes: simple.nodes,
    links: simple.links,
    // `nodeTxnIds` is deliberately absent: it is most of the payload's bytes and
    // nothing reads it until tap-through exists.
  };
});

/**
 * The rows behind one node — the drill-down.
 *
 * `buildFlowGraph` already records `nodeTxnIds` (node id → the transaction ids
 * that produced it), so "what is inside Income?" is answered by the engine, not
 * by the phone filtering a list it happens to hold. That distinction matters:
 * the client only ever has the 200 most recent rows, and a category lane can
 * reach back years.
 *
 * A separate callable rather than shipping `nodeTxnIds` inside `flowSnapshot`:
 * it is most of that payload's bytes and is worth nothing until a tap happens.
 */
export const flowNodeDetail = onCall({ cors: true, memory: '512MiB' }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in to see your money flow.');
  }

  const { range = 'all', key, nodeId } = (request.data ?? {}) as Request & { nodeId?: string };
  if (!nodeId) throw new HttpsError('invalid-argument', 'Which node?');

  const ledger = await readLedger(request.auth.uid);
  const policy: IncomeContext = {
    sources: ledger.incomeSources,
    reviews: ledger.reviews,
    includePending: ledger.includePending,
  };
  const accounts = withDerivedBalances(ledger.accounts, ledger.transactions, policy);
  const months = [...new Set(ledger.transactions.map((t) => t.date.slice(0, 7)))].sort();
  const period = periodFor(range, key, months);

  const graph = buildFlowGraph(
    ledger.transactions,
    accounts,
    { ...(period.start ? { start: period.start } : {}), ...(period.end ? { end: period.end } : {}) },
    { income: policy },
  );

  // `simplifyFlowGraph` MERGES some nodes, and a merged lane keeps no pointer
  // back to the ids it absorbed. So an EXACT hit against the detailed graph is
  // the only thing trusted here. A folded lane returns `folded: true` and the
  // screen says so — guessing by kind would have handed back every category's
  // rows under one category's name, which is worse than an honest empty state.
  const simple = simplifyFlowGraph(graph);
  const label = simple.nodes.find((n) => n.id === nodeId)?.label ?? nodeId;
  const ids = new Set<string>(graph.nodeTxnIds[nodeId] ?? []);
  const folded = !Object.prototype.hasOwnProperty.call(graph.nodeTxnIds, nodeId);

  const byId = new Map(ledger.transactions.map((t) => [t.id, t]));
  const rows = [...ids]
    .map((id) => byId.get(id))
    .filter((t): t is NonNullable<typeof t> => Boolean(t))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 200)
    .map((t) => mapTransaction(t, accounts));

  return {
    nodeId,
    label,
    period,
    count: ids.size,
    folded,
    rows,
  };
});
