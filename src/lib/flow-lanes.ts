/**
 * FIN-FLOW-001 — WHICH LANE does a row belong in, and can two labels collide.
 *
 * Two jobs, both pure, both testable without React or Firestore:
 *
 *  1. LANES. `/flow`'s left column used to be one undifferentiated "money in" family, so
 *     a refund, a cashback credit, a card charge and a paycheck all sat in the same
 *     visual slot. A refund is money you already spent coming back; cashback is a
 *     rebate; a card charge is SPENDING that only looks like an inflow because the
 *     issuer fronted the cash. None of them is income and none of them may sit beside
 *     Paychecks. This module decides, once, for every surface that asks.
 *
 *  2. LABELS. The Sankey draws each node's label into the gutter to its right, so a long
 *     label ran straight through the next column's node and its label. The budget math
 *     and the "does this column even fit" rule live here so they can be asserted.
 *
 * NOTHING here re-implements a classifier. `interpretTransaction()`, `isRefund()` and
 * `isReward()` are consumed as they stand; this file only maps their answers onto lanes.
 * The LINK-aware rungs — `classifyCardCredit()`'s ten kinds and the confirmed refund
 * arithmetic — live in `flow-netting.ts` and arrive here as data, because `relations.ts`
 * imports `flows.ts` and `flows.ts` imports this file: reaching back into `relations.ts`
 * from here closes an import cycle that dies in a temporal dead zone. See flow-netting.ts.
 *
 * PURE module, and a LEAF: `classify.ts`, `@/types` and the palette type, nothing else.
 * FIN-FLOW-001 owns this file.
 */

import { PaymentAccount, Transaction, displayCategory } from '@/types';
import {
  IncomeContext,
  classifyTransaction,
  interpretTransaction,
  isPosted,
  isRefund,
  isReward,
} from '@/lib/classify';
import type { FlowColorKey } from '@/lib/palette';

// ---------------------------------------------------------------------------
// The lanes themselves
// ---------------------------------------------------------------------------

export interface Lane {
  id: string;
  label: string;
  kind: FlowColorKey;
}

/**
 * Money coming back that no CONFIRMED link explains yet.
 *
 * The id stays `refunds` on purpose: FIN-REFUND-001's Flow contract (G2/G3) and the
 * drill-down both address this node by id, and renaming it would rewrite their
 * expectations rather than fix the defect. What changes is the LANE — a `credit` kind
 * and a label that says out loud that this is not income.
 */
export const MONEY_BACK: Lane = { id: 'refunds', label: 'Money back (unreviewed)', kind: 'credit' };

/** Cashback, statement credits, promotional credits. A rebate is not earnings. */
export const REWARDS: Lane = { id: 'rewards', label: 'Card rewards & cashback', kind: 'credit' };

/**
 * The owner's CONFIRMED non-income meanings, as lanes of their own.
 *
 * Found on the owner's live screen: after the 2026-08-04 batch named the loan, the chit
 * pool, the tax refunds and the dispute credits, the "Money came in — earned" tile still
 * read $246,998.82 against a true $211,967.63. Every TOTAL excluded them (the one
 * earned-income gate held) but this router had no branch for the new meanings, so they
 * fell through to the `inc:` fallback and were DRAWN as income. A lane the totals
 * exclude and the chart includes is a lie with an alibi.
 */
export const MONEY_BORROWED: Lane = { id: 'borrowed-in', label: 'Money you borrowed', kind: 'card' };
export const CHIT_PAYOUT: Lane = { id: 'chit-in', label: 'Chit pool payout', kind: 'credit' };
export const CREDITS_OTHER: Lane = { id: 'credits-other', label: 'Credits — not income', kind: 'credit' };
/** Merges with the existing unpaired self-transfer stub, so one node, not two. */
export const SELF_MOVE_IN: Lane = { id: 'self-ext-in', label: 'From your accounts elsewhere', kind: 'stub' };
/** Counts into the "received from people" half of the story tile, where it belongs. */
export const FROM_PEOPLE: Lane = { id: 'person-in:others', label: 'Others (people)', kind: 'source' };

const CONFIRMED_MEANING_LANES: Partial<Record<string, Lane>> = {
  loan_proceeds: MONEY_BORROWED,
  chit_fund_payout: CHIT_PAYOUT,
  other_non_income_credit: CREDITS_OTHER,
  internal_transfer: SELF_MOVE_IN,
  card_payment: SELF_MOVE_IN,
  receivable_repayment: FROM_PEOPLE,
  shared_expense_reimbursement: FROM_PEOPLE,
  gift_or_personal_transfer: FROM_PEOPLE,
};

/** Rung 6/7 of the card-credit ladder: real money, and nothing explains it yet. */
export const CARD_CREDIT_UNEXPLAINED: Lane = {
  id: 'card-credit-unexplained',
  label: 'Card credits not yet explained',
  kind: 'credit',
};

/**
 * The balancing source behind card purchases the owner has not paid off.
 *
 * It has to exist — the issuer really did front that cash, and without it a card node
 * has more outflow than inflow and conservation breaks. What was wrong was the FRAMING:
 * kind `source` put "New card charges" in the same family as Paychecks and lit it up
 * under the Income filter. It is card money, so it is coloured and filtered as card
 * money, and the label says borrowing rather than earning.
 */
export const BORROWED_ON_CARDS: Lane = { id: 'debt-up', label: 'Borrowed on your cards', kind: 'card' };

/**
 * The lanes that are money COMING BACK — the story tile's figure. Borrowing and an
 * opening balance are not income either, but neither of them is money back, so neither
 * is here.
 */
export const MONEY_BACK_LANE_IDS: readonly string[] = [
  MONEY_BACK.id, REWARDS.id, CARD_CREDIT_UNEXPLAINED.id,
];

/** One CONFIRMED reversal: this credit gave back this much of that purchase. */
export interface RefundAllocation {
  creditId: string;
  purchaseId: string;
  cents: number;
}

/**
 * What the link-aware layer resolved, as plain data. Built by `flowNetting()` in
 * flow-netting.ts; absent means "no links", which is exactly the gross picture.
 */
export interface FlowNetting {
  allocations: readonly RefundAllocation[];
  /** Card credits the ten-kind ladder already placed — rungs 1-4 need the links. */
  laneOf: ReadonlyMap<string, Lane>;
}

export interface LaneContext {
  accounts: PaymentAccount[];
  /** `FlowNetting.laneOf` — the card-credit ladder's answer, when a caller supplied it. */
  laneOf?: ReadonlyMap<string, Lane>;
  income?: IncomeContext;
  /**
   * Every category this ledger also SPENDS in. A credit tagged `Insurance` while
   * `Insurance` is a spending category is money coming back in that category, not an
   * income source called Insurance — which is exactly how `Shopping`, `Internet & Cable`
   * and `Loan Payment` ended up standing next to Paychecks.
   */
  spendingCategories: ReadonlySet<string>;
}

const isDebt = (a?: PaymentAccount) => a?.type === 'credit_card' || a?.type === 'personal_loan';

/**
 * Every category the ledger spends in, over the WHOLE ledger rather than the selected
 * period — otherwise a credit changes lane when the owner switches to a month in which
 * that category happens to have no spending.
 */
export function spendingCategoryIndex(
  transactions: readonly Transaction[],
  accounts: PaymentAccount[]
): Set<string> {
  const out = new Set<string>();
  for (const t of transactions) {
    if (!isPosted(t)) continue;
    if (classifyTransaction(t, accounts) !== 'expense') continue;
    const c = displayCategory(t);
    if (c) out.add(c);
  }
  return out;
}

/**
 * What to call an INCOME lane.
 *
 * NOT `displayCategory`. That answers with the row's EXPENSE category when the provider
 * gave none, and `category` defaults to `'other'` — so three payroll deposits from "The
 * Canton Payroll" landed in a lane the chart drew as **Other**. The `|| 'Other income'`
 * guard that was supposed to catch this could never fire, because `"Other"` is a
 * perfectly truthy string.
 *
 * An income lane is a PAYER, not a spending bucket. Provider category first — it is what
 * produces the good labels already on the chart (Paychecks, Business Income, Interest) —
 * then whoever actually sent the money, and only then a shrug.
 */
const incomeLaneName = (t: Transaction): string =>
  (t.sourceCategory || '').trim()
  || (t.merchant || '').trim()
  || (t.title || '').trim()
  || 'Other income';

/**
 * The lane a CREDIT belongs in. Rule order is load-bearing.
 *
 *  0. The ten-kind ladder, when a caller resolved it. Its range EXCLUDES `earned_income`,
 *     so nothing it answers can reach an `inc:` lane.
 *  1. On a card, a credit is never income — refund text or a spending category says
 *     which non-income lane, and the honest default says nobody knows yet.
 *  2. Off a card, an owner-CONFIRMED meaning or an approved income source wins: that is
 *     the owner's own decision, and the only thing allowed to name money as income.
 *  3. Reward text, then refund text, then "this category is one you spend in".
 *  4. Only what survives all of it is an income source.
 */
export function inflowLane(t: Transaction, ctx: LaneContext): Lane {
  const account = ctx.accounts.find((a) => a.id === t.accountId);
  const named = { title: t.title, merchant: t.merchant, sourceCategory: t.sourceCategory };

  const resolved = ctx.laneOf?.get(t.id);
  if (resolved) return resolved;

  if (isDebt(account)) {
    // Text or the category can still say "this came back", which beats a shrug.
    if (isReward(named)) return REWARDS;
    if (isRefund(named) || ctx.spendingCategories.has(displayCategory(t))) return MONEY_BACK;
    return CARD_CREDIT_UNEXPLAINED;
  }

  const { financialMeaning } = interpretTransaction(t, ctx.accounts, ctx.income);
  if (financialMeaning === 'refund') return MONEY_BACK;
  // A meaning the OWNER confirmed routes to its own lane — see CONFIRMED_MEANING_LANES.
  const confirmedLane = CONFIRMED_MEANING_LANES[financialMeaning];
  if (confirmedLane) return confirmedLane;
  if (isReward(named)) return REWARDS;
  if (financialMeaning === 'earned_income') {
    const c = incomeLaneName(t);
    return { id: `inc:${c}`, label: c, kind: 'source' };
  }
  // The PROVIDER's category, not `displayCategory`. This rung exists to catch a credit
  // the provider tagged `Insurance` while `Insurance` is a category you spend in — real
  // evidence that money came back. `displayCategory` substitutes the row's expense
  // category when the provider gave none, and since uncategorised SPENDING also reads as
  // "Other", that index contains "Other" — so every inflow arriving without a provider
  // category matched this test and was drawn as money coming back. A missing category is
  // not evidence of anything, so with none this rung simply does not apply.
  const providerCategory = (t.sourceCategory || '').trim();
  if (isRefund(named) || (providerCategory && ctx.spendingCategories.has(providerCategory))) return MONEY_BACK;

  const c = incomeLaneName(t);
  return { id: `inc:${c}`, label: c, kind: 'source' };
}

// ---------------------------------------------------------------------------
// Unpaired transfer legs — what used to be "Other money in/out"
// ---------------------------------------------------------------------------

/**
 * A leg whose partner `matchTransfers()` could not find.
 *
 * DIAGNOSIS (owner's own export, aggregate counts only): of 103 such legs, only 15 have
 * an opposite-direction leg anywhere in the data at the same amount, and those sit
 * 6–798 days apart — i.e. coincidences, not a pairing window that is too narrow. The
 * other ~85% have no counterpart at all: the far side lives in an account that was
 * never imported, or the export cut the pair in half. Nothing about the ROW is unknown
 * though — it still says whether it is a card settlement or a plain transfer, and which
 * way the money went. Four honest lanes, not one anonymous bucket.
 *
 * The two `self-ext-*` ids survive as the plain-transfer lanes so that the existing
 * assertions on them keep testing what they were written to test.
 *
 * ponytail: four lanes from the row's own category and direction. The statement text
 * often names the far account too ("PAYMENT FROM CHK ####"), which would let each lane
 * say WHICH account is missing — that is a second family of statement regexes and a
 * separate task; the drill-down already lists the rows.
 */
const CARD_PAYMENT_CATEGORY = /credit\s*card\s*payment|card\s*payment/i;

export function unpairedLegLane(t: Transaction, direction: 'in' | 'out'): Lane {
  const settlement = CARD_PAYMENT_CATEGORY.test(t.sourceCategory ?? '');
  if (settlement) {
    return direction === 'in'
      ? { id: 'cardpay-in', label: 'Card payment in · other leg not found', kind: 'stub' }
      : { id: 'cardpay-out', label: 'Card payment out · other leg not found', kind: 'stub' };
  }
  return direction === 'in'
    ? { id: 'self-ext-in', label: 'Transfer in · other leg not found', kind: 'stub' }
    : { id: 'self-ext-out', label: 'Transfer out · other leg not found', kind: 'stub' };
}

// ---------------------------------------------------------------------------
// Spending lanes — what used to be "Other spending" and "Other"
// ---------------------------------------------------------------------------

/**
 * How many spending categories get their own lane before the tail is folded.
 *
 * Measured on the owner's export: 8 left 23.6% of spending in the residual, 20 leaves
 * 4.1%. The residual then names its own size, so nothing is hidden behind the word
 * "other" — it says how many categories it is.
 */
export const TOP_CATEGORIES = 20;

export const residualCategoryLabel = (count: number) =>
  count === 1 ? '1 smaller category' : `${count} smaller categories`;

/** Category names that say nothing. A name is only useful if it narrows something down. */
const VAGUE_CATEGORY = new Set([
  '', 'other', 'others', 'uncategorized', 'uncategorised', 'misc', 'miscellaneous', 'no category',
]);

export const isVagueCategory = (c: string) => VAGUE_CATEGORY.has(c.trim().toLowerCase());

/**
 * The lane a spending row belongs in.
 *
 * A category the export itself calls "Other" explains nothing, so the row falls back to
 * WHO WAS PAID — data the owner already has, never an invented category. Merchants too
 * small to earn a lane land in the same self-describing residual as small categories.
 *
 * `merchant` is passed in already normalised so this module need not import `flows.ts`
 * (which imports this one).
 */
export function spendingLane(category: string, merchant: string): { key: string; label: string } {
  if (!isVagueCategory(category)) return { key: category, label: category };
  if (merchant) return { key: `nocat:${merchant}`, label: `${merchant} · no category` };
  return { key: 'nocat:', label: 'No category in your export' };
}

// ---------------------------------------------------------------------------
// Label geometry — defect C
// ---------------------------------------------------------------------------

/** recharts' `nodePadding`: the guaranteed gap between two nodes in one column. */
export const NODE_PADDING_PX = 18;
/** A node still has to be visible after the padding is taken out. */
export const MIN_NODE_PX = 4;
/** 11px system sans, averaged over the real label set. Deliberately generous. */
export const CHAR_PX = 6;
/** Label offset from the node plus a little air before the next column. */
export const LABEL_GUTTER_PAD_PX = 14;

/**
 * Column index per node, by recharts' own rule (Sankey.js `getNodesTree`): longest path
 * from a root, then anything with no outgoing link is pushed to the last column.
 */
export function nodeDepths(
  nodes: ReadonlyArray<{ id: string }>,
  links: ReadonlyArray<{ source: string; target: string }>
): Map<string, number> {
  const out = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const n of nodes) { out.set(n.id, []); indeg.set(n.id, 0); }
  for (const l of links) {
    out.get(l.source)?.push(l.target);
    indeg.set(l.target, (indeg.get(l.target) ?? 0) + 1);
  }
  const depth = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  // Longest path, relaxed in topological order. A cycle would stall the queue; the
  // graph is asserted acyclic elsewhere, and stalling degrades to depth 0 rather than
  // looping forever.
  const queue = nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  const remaining = new Map(indeg);
  while (queue.length) {
    const id = queue.shift()!;
    for (const t of out.get(id) ?? []) {
      depth.set(t, Math.max(depth.get(t) ?? 0, (depth.get(id) ?? 0) + 1));
      const r = (remaining.get(t) ?? 0) - 1;
      remaining.set(t, r);
      if (r === 0) queue.push(t);
    }
  }
  const maxDepth = Math.max(0, ...depth.values());
  for (const n of nodes) if (!(out.get(n.id) ?? []).length) depth.set(n.id, maxDepth);
  return depth;
}

/** How many nodes share each column. The busiest column is what sets the height. */
export function columnCounts(
  nodes: ReadonlyArray<{ id: string }>,
  links: ReadonlyArray<{ source: string; target: string }>
): number[] {
  const depth = nodeDepths(nodes, links);
  const counts: number[] = [];
  for (const n of nodes) {
    const d = depth.get(n.id) ?? 0;
    counts[d] = (counts[d] ?? 0) + 1;
  }
  return counts.map((c) => c ?? 0);
}

/**
 * Does a column of `count` nodes fit in `heightPx` without recharts clamping them on
 * top of each other?
 *
 * `resolveCollisions()` spaces nodes by `nodePadding` on the way down and then squeezes
 * them back inside the height on the way up — so the moment the column needs more room
 * than there is, labels start printing through each other. This is that condition.
 */
export const columnFits = (count: number, heightPx: number) =>
  count <= 1 || heightPx >= count * MIN_NODE_PX + (count - 1) * NODE_PADDING_PX;

/** The smallest chart height at which every column still fits. */
export function sankeyHeightFor(
  nodes: ReadonlyArray<{ id: string }>,
  links: ReadonlyArray<{ source: string; target: string }>,
  minHeightPx = 560
): number {
  const busiest = Math.max(1, ...columnCounts(nodes, links));
  const needed = busiest * MIN_NODE_PX + (busiest - 1) * NODE_PADDING_PX;
  return Math.max(minHeightPx, needed);
}

/**
 * How many characters fit between this node and the next column.
 *
 * Sized off the NARROWEST layout the page can render (the Sankey lives in a horizontally
 * scrolling box with a fixed minimum width), so a wider screen only ever gives the label
 * more room than it took.
 */
export function labelMaxChars(opts: {
  depth: number;
  maxDepth: number;
  plotWidthPx: number;
  rightMarginPx: number;
  nodeWidthPx: number;
}): number {
  const { depth, maxDepth, plotWidthPx, rightMarginPx, nodeWidthPx } = opts;
  // The last column draws its label leftwards into the reserved right margin.
  const gutter = depth >= maxDepth && maxDepth > 0
    ? rightMarginPx
    : maxDepth > 0
      ? (plotWidthPx - nodeWidthPx) / maxDepth - nodeWidthPx
      : rightMarginPx;
  return Math.max(8, Math.floor((gutter - LABEL_GUTTER_PAD_PX) / CHAR_PX));
}

/** Truncation with an ellipsis. The caller puts the full text in a `<title>`. */
export function fitLabel(text: string, maxChars: number): string {
  if (maxChars <= 1 || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1).trimEnd()}…`;
}
