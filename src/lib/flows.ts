/**
 * Flow-graph math for the /flow page. Everything here is integer CENTS —
 * dollars exist only at the render layer. Pure functions, no React.
 */
import { PaymentAccount, Transaction } from '@/types';
import { isPositive, countsUnder } from './classify';

export const toCents = (n: number) => Math.round(n * 100);
export const day = (iso: string) => iso.slice(0, 10);

export const isDebtAccount = (a?: PaymentAccount) =>
  a?.type === 'credit_card' || a?.type === 'personal_loan';

export const signedRealNowCents = (a: PaymentAccount) =>
  isDebtAccount(a) ? -toCents(currentOf(a)) : toCents(currentOf(a));

export const signedCents = (t: Transaction, accounts: PaymentAccount[]) =>
  (isPositive(t, accounts) ? 1 : -1) * toCents(t.amount);

/** Account balance at the END of `endDay`, rolled back from the user-entered balance. */
export function balanceAtEndOfDay(
  a: PaymentAccount, transactions: Transaction[], accounts: PaymentAccount[], endDay: string
): number {
  let later = 0;
  for (const t of transactions) {
    if (t.accountId === a.id && day(t.date) > endDay) later += signedCents(t, accounts);
  }
  return signedRealNowCents(a) - later;
}

// --- person extraction ---
// Moved to counterparty.ts so classify.ts can use it without importing this module
// (flows -> classify already exists; the other direction would be a cycle). Re-exported
// here so every existing `from '@/lib/flows'` import keeps working unchanged.
export { personFrom, isSelfPerson, displayPerson, namesExternalCounterparty } from './counterparty';
import { personFrom, isSelfPerson, displayPerson } from './counterparty';

// ============================================================
// buildFlowGraph — the Sankey data + reconciliation
// ============================================================
import { IncomeContext, classifyTransaction } from './classify';
import { matchTransfers } from './transfers';
import { displayCategory } from '@/types';
import type { FlowColorKey } from './palette';
import { currentOf } from '@/lib/accounts';
import { emit } from '@/lib/obs/events';
import {
  BORROWED_ON_CARDS, FlowNetting, TOP_CATEGORIES, inflowLane, residualCategoryLabel,
  spendingCategoryIndex, spendingLane, unpairedLegLane,
} from '@/lib/flow-lanes';

export interface FlowNode { id: string; label: string; kind: FlowColorKey }
export interface FlowLink {
  source: string; target: string; cents: number;
  grossForwardCents?: number; grossReverseCents?: number;
}
export interface BetweenRow { from: string; to: string; moves: number; cents: number }
export interface ReconRow {
  accountId: string; name: string;
  openingCents: number; inCents: number; outCents: number; closingCents: number;
  gapCents: number; verdict: 'opening' | 'pre-export-debt' | 'missing-rows' | 'flat';
}
export interface FlowGraph {
  nodes: FlowNode[]; links: FlowLink[];
  reconciliation: ReconRow[]; between: BetweenRow[];
  nodeTxnIds: Record<string, string[]>; // node id -> transaction ids behind it (drill-down)
  /**
   * How much CONFIRMED refund money was netted out of the category links in this period.
   * Gross is still reachable — build the graph again with no links (the page's "gross"
   * toggle does exactly that), or read the rows in the drill-down, which never change.
   */
  nettedRefundCents: number;
  /**
   * Money in the `person-out:` lanes that the classifier calls an EXPENSE — a real
   * cost that happens to be paid to a named person rather than a merchant.
   *
   * The Sankey routes those rows by recipient, so they never reach a `cat:` node.
   * A page summing only `cat:` links therefore under-reports spending: measured on
   * the owner's 2026 rows, 6 of 559 expense rows worth $6,893.25 were invisible,
   * which is exactly why "what did I spend" answered $46,447.36 on /flow and
   * $53,340.61 in chat. cat-links + this === the classifier's expense total.
   */
  personExpenseCents: number;
}

const TOP_PEOPLE = 5;

/** What the graph may read beyond the ledger itself. Both optional; both default to off. */
export interface FlowOptions {
  /**
   * `flowNetting()`'s resolved links (flow-netting.ts, which the page owns). A CONFIRMED
   * allocation nets its cents out of the category it reverses and the credit stops being
   * a left-side lane; `suggested` and `provisional` links never reach here at all,
   * because you cannot net an unproven match. Absent = the gross picture.
   */
  netting?: FlowNetting;
  income?: IncomeContext;
}

export function buildFlowGraph(
  transactions: Transaction[],
  accounts: PaymentAccount[],
  period: { start?: string; end?: string } = {},
  options: FlowOptions = {}
): FlowGraph {
  const startedAt = Date.now();
  const start = period.start ?? '0000-00-00';
  const end = period.end ?? '9999-12-31';
  // PENDING: follows the owner's policy, and MUST. Flow reconciles gross movement
  // against the derived account balances — so the moment those balances count holds
  // (FIN-PENDING-001), excluding holds here would put the reconciliation out by
  // exactly their amount. The two have to make the same choice or neither is right.
  const rows = transactions.filter(
    (t) => countsUnder(t, options.income) && day(t.date) >= start && day(t.date) <= end
  );
  const byId = new Map(accounts.map((a) => [a.id, a]));

  const nodes = new Map<string, FlowNode>();
  const links = new Map<string, FlowLink>();
  const node = (id: string, label: string, kind: FlowColorKey) => {
    if (!nodes.has(id)) nodes.set(id, { id, label, kind });
    return id;
  };
  const link = (source: string, target: string, cents: number) => {
    if (cents <= 0) return;
    const k = `${source}→${target}`;
    const l = links.get(k);
    if (l) l.cents += cents;
    else links.set(k, { source, target, cents });
  };

  for (const a of accounts) {
    node(`acct:${a.id}`, a.name,
      a.type === 'credit_card' ? 'card' : a.type === 'personal_loan' ? 'loan' : 'bank');
  }

  // --- transfers: pair, gross matrix, hub-or-direct nets ---
  // A leg naming an external person (Zelle/Remitly) is by definition NOT an internal
  // move — keep it away from the pairer, which otherwise false-pairs it with any
  // unrelated same-amount leg inside the 4-day window (cost the audit exactly $2,000).
  const externalPersonLeg = (t: Transaction) => {
    const p = personFrom(t.description ?? t.title);
    return p !== null && !isSelfPerson(p);
  };
  const { pairs, unmatchedOut, unmatchedIn } = matchTransfers(
    rows.filter((t) => !(classifyTransaction(t, accounts) === 'transfer' && externalPersonLeg(t))),
    accounts
  );
  const personTransferLegs = rows.filter(
    (t) => classifyTransaction(t, accounts) === 'transfer' && externalPersonLeg(t)
  );
  const gross = new Map<string, { moves: number; cents: number }>();
  const strayLegs: Transaction[] = [];
  for (const p of pairs) {
    if (!p.fromAccountId || !p.toAccountId) { strayLegs.push(p.out, p.inbound); continue; }
    const k = `${p.fromAccountId}|${p.toAccountId}`;
    const g = gross.get(k) ?? { moves: 0, cents: 0 };
    g.moves += 1; g.cents += toCents(p.amount);
    gross.set(k, g);
  }
  const between: BetweenRow[] = [...gross.entries()].map(([k, g]) => {
    const [from, to] = k.split('|');
    return { from, to, moves: g.moves, cents: g.cents };
  }).sort((a, b) => b.cents - a.cents);

  const hubNet = new Map<string, number>(); // +cents = net sender into hub
  const done = new Set<string>();
  for (const [k, g] of gross) {
    const [fromId, toId] = k.split('|');
    if (done.has(`${toId}|${fromId}`)) continue;
    done.add(k);
    const rev = gross.get(`${toId}|${fromId}`);
    const net = g.cents - (rev?.cents ?? 0);
    if (net === 0) continue;
    const [srcId, dstId, cents, fwd, back] = net > 0
      ? ([fromId, toId, net, g.cents, rev?.cents ?? 0] as const)
      : ([toId, fromId, -net, rev!.cents, g.cents] as const);
    const src = byId.get(srcId), dst = byId.get(dstId);
    const bothBanks = src && dst && !isDebtAccount(src) && !isDebtAccount(dst);
    const backwards = src && dst && isDebtAccount(src) && !isDebtAccount(dst);
    if (bothBanks || backwards) {
      hubNet.set(srcId, (hubNet.get(srcId) ?? 0) + cents);
      hubNet.set(dstId, (hubNet.get(dstId) ?? 0) - cents);
    } else {
      links.set(`acct:${srcId}→acct:${dstId}`, {
        source: `acct:${srcId}`, target: `acct:${dstId}`,
        cents, grossForwardCents: fwd, grossReverseCents: back,
      });
    }
  }
  if ([...hubNet.values()].some((v) => v !== 0)) node('hub', '⇄ between accounts', 'hub');
  for (const [id, v] of hubNet) {
    if (v > 0) link(`acct:${id}`, 'hub', v);
    else if (v < 0) link('hub', `acct:${id}`, -v);
  }

  // --- income / expense / unmatched legs: accumulate, then materialize top-N ---
  const catCents = new Map<string, Map<string, number>>();  // lane key -> accNode -> cents
  const catLabels = new Map<string, string>();               // lane key -> what to print
  const sent = new Map<string, Map<string, number>>();       // person -> accNode -> cents
  const recv = new Map<string, Map<string, number>>();
  const add = (m: Map<string, Map<string, number>>, key: string, accNode: string, cents: number) => {
    const inner = m.get(key) ?? new Map<string, number>();
    inner.set(accNode, (inner.get(accNode) ?? 0) + cents);
    m.set(key, inner);
  };
  // Parallel to the cent maps: which transaction ids landed at each category/person key,
  // and (for income sources / stubs) directly at a node id — powers the /flow drill-down.
  const catTxns = new Map<string, string[]>();
  const sentTxns = new Map<string, string[]>();
  const recvTxns = new Map<string, string[]>();
  const nodeTxns = new Map<string, string[]>();
  const pushId = (m: Map<string, string[]>, key: string, id: string) => {
    const a = m.get(key); if (a) a.push(id); else m.set(key, [id]);
  };
  const tagTxn = (nodeId: string, id: string) => pushId(nodeTxns, nodeId, id);
  const accNodeOf = (t: Transaction, dir: 'in' | 'out') => {
    const a = t.accountId ? byId.get(t.accountId) : undefined;
    if (a) return `acct:${a.id}`;
    return dir === 'in'
      ? node('unlinked-in', 'No account tagged (in)', 'stub')
      : node('unlinked-out', 'No account tagged (out)', 'stub');
  };

  // --- FIN-FLOW-001: lanes, and what a CONFIRMED link is allowed to net ------
  // flow-lanes.ts owns "which lane"; this loop only routes what it is told. The one
  // rule enforced here is the netting rule: a confirmed refund link reduces the
  // category it reverses and its credit stops being a left-side lane — and it may only
  // do that when BOTH rows are inside the rendered period, or the credit would vanish
  // from an account whose matching purchase is off-screen and the account would stop
  // balancing. `suggested`/`provisional` links net nothing, ever.
  const rowIds = new Set(rows.map((r) => r.id));
  const allocations = (options.netting?.allocations ?? []).filter(
    (a) => rowIds.has(a.creditId) && rowIds.has(a.purchaseId)
  );
  const refundedByPurchase = new Map<string, number>();
  const allocatedByCredit = new Map<string, number>();
  for (const a of allocations) {
    refundedByPurchase.set(a.purchaseId, (refundedByPurchase.get(a.purchaseId) ?? 0) + a.cents);
    allocatedByCredit.set(a.creditId, (allocatedByCredit.get(a.creditId) ?? 0) + a.cents);
  }
  let nettedRefundCents = 0;

  const laneCtx = {
    accounts,
    laneOf: options.netting?.laneOf,
    income: options.income,
    // The WHOLE ledger, not the period: otherwise a credit changes lane when the owner
    // switches to a month in which that category happens to have no spending.
    spendingCategories: spendingCategoryIndex(transactions, accounts),
  };

  for (const t of rows) {
    const cls = classifyTransaction(t, accounts);
    if (cls === 'transfer') continue; // handled via the matchTransfers partition
    const gross = toCents(t.amount);
    const person = personFrom(t.description ?? t.title);
    if (cls === 'income') {
      const an = accNodeOf(t, 'in');
      if (person && !isSelfPerson(person)) { add(recv, person, an, gross); pushId(recvTxns, person, t.id); continue; }
      const cents = Math.max(0, gross - (allocatedByCredit.get(t.id) ?? 0));
      const lane = inflowLane(t, laneCtx);
      const src = node(lane.id, lane.label, lane.kind);
      link(src, an, cents);
      tagTxn(src, t.id); // gross stays reachable: the drill-down lists the row at full size
    } else {
      const an = accNodeOf(t, 'out');
      const refunded = Math.min(refundedByPurchase.get(t.id) ?? 0, gross);
      const cents = gross - refunded;
      nettedRefundCents += refunded;
      if (person && isSelfPerson(person)) {
        const lane = unpairedLegLane(t, 'out');
        link(an, node(lane.id, lane.label, lane.kind), cents);
        tagTxn(lane.id, t.id);
        continue;
      }
      if (person) { add(sent, person, an, cents); pushId(sentTxns, person, t.id); continue; }
      const lane = spendingLane(displayCategory(t), normalizeMerchant(t.merchant || t.title));
      add(catCents, lane.key, an, cents);
      pushId(catTxns, lane.key, t.id);
      catLabels.set(lane.key, lane.label);
    }
  }
  // stray pair legs (dangling accountId) and the person legs excluded from pairing
  // rejoin the unmatched pools by direction
  const looseLegs = [...strayLegs, ...personTransferLegs];
  const strayOut = looseLegs.filter((t) => (t.transferDirection ?? (isPositive(t, accounts) ? 'in' : 'out')) === 'out');
  const strayIn = looseLegs.filter((t) => !strayOut.includes(t));
  // An unpaired leg is not "other": the row still says whether it is a card settlement
  // or a plain transfer, and which way the money went. Four named lanes, one reason.
  for (const t of [...unmatchedOut, ...strayOut]) {
    const cents = toCents(t.amount);
    const an = accNodeOf(t, 'out');
    const person = personFrom(t.description ?? t.title);
    if (person && !isSelfPerson(person)) { add(sent, person, an, cents); pushId(sentTxns, person, t.id); }
    else {
      const lane = unpairedLegLane(t, 'out');
      link(an, node(lane.id, lane.label, lane.kind), cents);
      tagTxn(lane.id, t.id);
    }
  }
  for (const t of [...unmatchedIn, ...strayIn]) {
    const cents = toCents(t.amount);
    const an = accNodeOf(t, 'in');
    const person = personFrom(t.description ?? t.title);
    if (person && !isSelfPerson(person)) { add(recv, person, an, cents); pushId(recvTxns, person, t.id); }
    else {
      const lane = unpairedLegLane(t, 'in');
      link(node(lane.id, lane.label, lane.kind), an, cents);
      tagTxn(lane.id, t.id);
    }
  }

  // Categories: the top TOP_CATEGORIES get their own lane; the tail folds into ONE
  // residual that states its own size, so "other" can never again hide a quarter of the
  // spending without saying how many things it is.
  const catTotals = [...catCents.entries()]
    .map(([c, m]) => [c, [...m.values()].reduce((s, v) => s + v, 0)] as const)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const namedCats = new Set(catTotals.slice(0, TOP_CATEGORIES).map(([c]) => c));
  const residualCount = catTotals.filter(([c, v]) => !namedCats.has(c) && v > 0).length;
  const residualId = () => node('cat:other', residualCategoryLabel(residualCount), 'category');
  for (const [cat, m] of catCents) {
    const id = namedCats.has(cat)
      ? node(`cat:${cat}`, catLabels.get(cat) ?? cat, 'category')
      : residualId();
    for (const [an, cents] of m) link(an, id, cents);
    for (const tid of catTxns.get(cat) ?? []) tagTxn(id, tid); // merges into the residual for free
  }

  // people: Remitly always named; top-5 others named; rest folded
  const vol = new Map<string, number>();
  for (const m of [sent, recv]) for (const [p, inner] of m)
    vol.set(p, (vol.get(p) ?? 0) + [...inner.values()].reduce((s, v) => s + v, 0));
  const named = new Set(
    [...vol.entries()].filter(([p]) => p !== 'REMITLY')
      .sort((a, b) => b[1] - a[1]).slice(0, TOP_PEOPLE).map(([p]) => p)
  );
  if (vol.has('REMITLY')) named.add('REMITLY');
  const personNode = (p: string, dir: 'in' | 'out') => {
    if (!named.has(p)) return node(`person-${dir}:others`, 'Others (people)', 'person');
    return node(`person-${dir}:${p}`, displayPerson(p), 'person');
  };
  for (const [p, inner] of recv) { const id = personNode(p, 'in'); for (const [an, cents] of inner) link(id, an, cents); for (const tid of recvTxns.get(p) ?? []) tagTxn(id, tid); }
  for (const [p, inner] of sent) { const id = personNode(p, 'out'); for (const [an, cents] of inner) link(an, id, cents); for (const tid of sentTxns.get(p) ?? []) tagTxn(id, tid); }

  // --- balancing stubs + reconciliation (verified against all 9 real accounts) ---
  const reconciliation: ReconRow[] = [];
  for (const a of accounts) {
    const id = `acct:${a.id}`;
    let inC = 0, outC = 0;
    for (const l of links.values()) {
      if (l.target === id) inC += l.cents;
      if (l.source === id) outC += l.cents;
    }
    const residual = inC - outC;
    const closing = balanceAtEndOfDay(a, transactions, accounts, end);
    const opening = closing - residual;
    const bank = !isDebtAccount(a);
    const plausible = bank ? opening >= 0 : opening <= 0;
    let verdict: ReconRow['verdict'];
    let gap = 0;
    if (plausible) {
      // 'stub', not 'source': an opening balance is money you already had. It is the
      // mirror of 'held' at the other end, and it is not income either.
      if (opening > 0) link(node('opening', 'Starting balance', 'stub'), id, opening);
      const r2 = residual + Math.max(opening, 0);
      if (r2 > 0) link(id, bank ? node('held', 'Still in your accounts', 'stub') : node('debt-down', 'Paid down existing balance', 'stub'), r2);
      else if (r2 < 0) link(node(BORROWED_ON_CARDS.id, BORROWED_ON_CARDS.label, BORROWED_ON_CARDS.kind), id, -r2);
      verdict = opening === 0 ? 'flat' : bank ? 'opening' : 'pre-export-debt';
    } else {
      gap = Math.abs(opening);
      verdict = 'missing-rows';
      if (bank) {
        link(id, node('missing-out', '⚠ Not in your data yet', 'warning'), gap);
        // Hold the real closing so the node balances. A positive balance stays in the
        // account; a rare overdrawn (negative) balance is an inflow — clamping it to zero
        // (the old bug) left |closing| of outflow with no source and broke conservation.
        if (closing >= 0) link(id, node('held', 'Still in your accounts', 'stub'), closing);
        else link(node('overdrawn', '⚠ Overdrawn (negative balance)', 'warning'), id, -closing);
      } else {
        link(node('missing-in', '⚠ Not in your data yet', 'warning'), id, gap);
        // A normal card owes (negative closing → new-debt inflow); an overpaid card holds a
        // positive balance that must LEAVE the node as held, else sources exceed sinks.
        if (closing <= 0) link(node(BORROWED_ON_CARDS.id, BORROWED_ON_CARDS.label, BORROWED_ON_CARDS.kind), id, -closing);
        else link(id, node('held', 'Still in your accounts', 'stub'), closing);
      }
    }
    reconciliation.push({
      accountId: a.id, name: a.name,
      openingCents: opening, inCents: inC, outCents: outC, closingCents: closing,
      gapCents: gap, verdict,
    });
  }

  // drop nodes that ended up with no links (defensive; recharts rejects islands)
  const used = new Set<string>();
  for (const l of links.values()) { used.add(l.source); used.add(l.target); }

  // ONE event for the whole build (OBS-001's performance rule). Lane IDS (ours, not the
  // owner's words), counts and a duration — no label the owner typed, no amount, no
  // account, no transaction id.
  const LANE_IDS = [
    'refunds', 'rewards', 'card-credit-unexplained', 'debt-up',
    'self-ext-in', 'self-ext-out', 'cardpay-in', 'cardpay-out', 'cat:other',
  ];
  emit({
    eventName: 'Flow.GraphBuilt',
    eventCategory: 'activity',
    severity: 'debug',
    traceId: '',
    component: 'FlowLanes',
    route: '/flow',
    calculationName: 'buildFlowGraph',
    durationMs: Date.now() - startedAt,
    recordCount: rows.length,
    resultStatus: links.size ? 'ok' : 'empty',
    metadata: {
      nodeCount: used.size,
      linkCount: links.size,
      residualCategoryCount: residualCount,
      confirmedLinkCount: allocations.length,
      nettedAnything: nettedRefundCents > 0,
      lanesPresent: LANE_IDS.filter((id) => used.has(id)),
    },
  });

  // Rows routed to a person by recipient that are nonetheless a COST. Counted here,
  // once, from the same node map the drill-down uses — so the figure and the rows
  // behind it can never disagree. Deduped: a row can tag more than one person node.
  const personExpenseIds = new Set<string>();
  for (const [nodeId, ids] of nodeTxns) {
    if (!nodeId.startsWith('person-out:')) continue;
    for (const id of ids) personExpenseIds.add(id);
  }
  const txnById = new Map(transactions.map((t) => [t.id, t]));
  let personExpenseCents = 0;
  for (const id of personExpenseIds) {
    const t = txnById.get(id);
    if (t && classifyTransaction(t, accounts) === 'expense') personExpenseCents += toCents(t.amount);
  }

  return {
    nodes: [...nodes.values()].filter((n) => used.has(n.id)),
    links: [...links.values()],
    reconciliation, between,
    nodeTxnIds: Object.fromEntries(nodeTxns),
    nettedRefundCents,
    personExpenseCents,
  };
}

/** Every person node this graph makes, named or folded into "Others (people)". */
const PERSON_NODE_PREFIX = 'person-';

/**
 * The rows sitting behind the `person-in:` / `person-out:` nodes — FIN-SETTLEMENT-003's
 * feed into the mapping queue, the exact mirror of `UNPAIRED_LEG_LANE_IDS`.
 *
 * Measured before this existed: those lanes were TERMINAL. A counterparty leg is routed
 * to a person node instead of an unpaired-leg lane, and the queue is fed only by unknown
 * inflows and unpaired legs — so 7 of 284 counterparty rows reached the queue and 0 of
 * the 155 outbound ones did. Reading the graph's own `nodeTxnIds` (rather than
 * re-deriving the set) is what keeps "what /flow drew" and "what the queue asks about"
 * from drifting apart.
 */
export const counterpartyRowIds = (g: Pick<FlowGraph, 'nodeTxnIds'>): string[] =>
  Object.entries(g.nodeTxnIds)
    .filter(([id]) => id.startsWith(PERSON_NODE_PREFIX))
    .flatMap(([, ids]) => ids);

// ============================================================
// detectRecurring — the four rules exist because each killed a
// verified false result on the real data (see design spec).
// ============================================================
export interface RecurringItem {
  merchant: string;
  cadence: 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'yearly';
  medianCents: number; monthlyCents: number;
  occurrences: number; firstSeen: string; lastSeen: string; active: boolean;
  /** The account most of this merchant's charges hit (autopay source). */
  accountId: string | null;
  /** Next expected charge: lastSeen + the observed median gap. */
  nextDue: string;
  /** In-band gap ratio (0..1): how regular the cadence actually is. */
  confidence: number;
}

export const BANDS: Array<[RecurringItem['cadence'], number, number, number]> = [
  ['weekly', 6, 8, 4.33], ['biweekly', 12, 16, 2.17], ['monthly', 26, 35, 1],
  ['quarterly', 80, 100, 1 / 3], ['yearly', 350, 380, 1 / 12],
];

export const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : Math.round((s[n / 2 - 1] + s[n / 2]) / 2);
};
export const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

// Strip #…/*… suffixes and TRAILING digit runs only — "650 INDUSTRIES" is a real brand.
export const normalizeMerchant = (s: string) =>
  s.toUpperCase().replace(/[#*]\S*/g, '').replace(/\s+\d{3,}$/, '').replace(/\s+/g, ' ').trim();

export function detectRecurring(
  transactions: Transaction[], accounts: PaymentAccount[], todayISO: string
): RecurringItem[] {
  const groups = new Map<string, Transaction[]>();
  for (const t of transactions) {
    if (classifyTransaction(t, accounts) !== 'expense') continue;
    const m = normalizeMerchant(t.merchant || t.title);
    if (!m) continue;
    const g = groups.get(m);
    if (g) g.push(t); else groups.set(m, [t]);
  }
  const out: RecurringItem[] = [];
  for (const [merchant, txs] of groups) {
    const dates = [...new Set(txs.map((t) => day(t.date)))].sort();
    if (dates.length < 3) continue;                                  // rule 1: unique days
    const amts = txs.map((t) => toCents(t.amount));
    const med = median(amts);
    if (med < 500) continue;                                         // rule 3: >= $5
    if (median(amts.map((a) => Math.abs(a - med))) > med * 0.25) continue;
    const gaps = dates.slice(1).map((d, i) => daysBetween(dates[i], d));
    const mg = median(gaps);
    const band = BANDS.find(([, lo, hi]) => mg >= lo && mg <= hi);
    if (!band) continue;
    const [cadence, lo, hi, mult] = band;
    const inBand = gaps.filter((g) => g >= lo && g <= hi).length / gaps.length;
    if (inBand < 0.6) continue; // rule 2
    const lastSeen = dates[dates.length - 1];
    const acctCount = new Map<string, number>();
    for (const t of txs) if (t.accountId) acctCount.set(t.accountId, (acctCount.get(t.accountId) ?? 0) + 1);
    out.push({
      merchant, cadence, medianCents: med, monthlyCents: Math.round(med * mult),
      occurrences: dates.length, firstSeen: dates[0], lastSeen,
      // Active = seen within ~1.5 of its own cycle length, not a flat 45 days — else a
      // healthy quarterly/yearly subscription reads as lapsed and drops off the /mo total.
      active: daysBetween(lastSeen, day(todayISO)) <= hi * 1.5,
      accountId: [...acctCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
      nextDue: new Date(Date.parse(`${lastSeen}T00:00:00Z`) + mg * 86_400_000).toISOString().slice(0, 10),
      confidence: inBand,
    });
  }
  return out.sort((a, b) => b.monthlyCents - a.monthlyCents);
}

// ============================================================
// projectNetWorth — "at this rate": trailing 6 full calendar
// months of (income − expenses − net person outflow).
// ============================================================
export function projectNetWorth(
  transactions: Transaction[], accounts: PaymentAccount[], todayISO: string, months = 12
): { monthlyRateCents: number; startCents: number; points: Array<{ month: string; cents: number }> } {
  const currentMonth = day(todayISO).slice(0, 7);
  const monthKey = (offsetFromCurrent: number) => {
    const [y, m] = currentMonth.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + offsetFromCurrent, 1));
    return d.toISOString().slice(0, 7);
  };
  const window = new Set([-6, -5, -4, -3, -2, -1].map(monthKey));

  let net = 0;
  const personLeg = (t: Transaction) => {
    const p = personFrom(t.description ?? t.title);
    return p !== null && !isSelfPerson(p);
  };
  // person legs never enter the pairer (same false-pair guard as buildFlowGraph)
  const isPersonTransfer = (t: Transaction) =>
    classifyTransaction(t, accounts) === 'transfer' && personLeg(t);
  const { unmatchedOut, unmatchedIn } = matchTransfers(
    transactions.filter((t) => !isPersonTransfer(t)), accounts
  );
  const personLegs = transactions.filter(isPersonTransfer);
  for (const t of transactions) {
    if (!window.has(day(t.date).slice(0, 7))) continue;
    const cls = classifyTransaction(t, accounts);
    if (cls === 'income') net += toCents(t.amount);
    else if (cls === 'expense') net -= toCents(t.amount);
  }
  const outLegs = [...unmatchedOut.filter(personLeg),
    ...personLegs.filter((t) => (t.transferDirection ?? (isPositive(t, accounts) ? 'in' : 'out')) === 'out')];
  const inLegs = [...unmatchedIn.filter(personLeg),
    ...personLegs.filter((t) => (t.transferDirection ?? (isPositive(t, accounts) ? 'in' : 'out')) === 'in')];
  for (const t of outLegs) if (window.has(day(t.date).slice(0, 7))) net -= toCents(t.amount);
  for (const t of inLegs) if (window.has(day(t.date).slice(0, 7))) net += toCents(t.amount);

  const monthlyRateCents = Math.round(net / 6);
  const startCents = accounts.reduce((s, a) => s + signedRealNowCents(a), 0);
  const points = Array.from({ length: months + 1 }, (_, i) => ({
    month: monthKey(i), cents: startCents + monthlyRateCents * i,
  }));
  return { monthlyRateCents, startCents, points };
}
