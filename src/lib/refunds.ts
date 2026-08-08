/**
 * What did this purchase actually COST me?
 *
 * `story.refunds` (src/app/flow/page.tsx:431) already nets refunds out of AGGREGATE
 * spending, which is right at the top and useless at the row: it cannot say a $1,100.00
 * purchase came back in full, or that $200.00 of it did not. This module can.
 *
 * Everything is INTEGER CENTS, like src/lib/flows.ts. `110000 + 10000 === 120000`,
 * exactly — no floats, no tolerance, no epsilon. A combined refund either sums or it is
 * not a combined refund.
 *
 * TWO RULES THIS FILE EXISTS TO KEEP:
 *  1. GROSS HISTORY IS NEVER DESTROYED TO SHOW NET. Nothing here writes to a
 *     transaction document. Gross stays on the row; net is derived on read.
 *  2. NOTHING AUTO-APPLIES. There is no REFUND_AUTOCONFIRM_THRESHOLD and no score at
 *     which the generator writes a link. It proposes `unreviewed` candidates; the owner
 *     confirms. `provisional` dispute credits reduce no final spending at all.
 *
 * PURE module: no Firestore, no React, no I/O. FIN-REFUND-001 owns this file.
 */

import { ExpenseCategory, EXPENSE_CATEGORIES, PaymentAccount, Transaction } from '@/types';
import { IncomeContext, interpretTransaction, isPosted, isRefund } from './classify';
import { daysBetween, day, normalizeMerchant, toCents } from './flows';
import {
  CandidateEvidence,
  CandidateType,
  ProposedLink,
  ReviewCandidate,
  buildCandidateId,
  buildIdentityKey,
  rankCandidates,
  sanitizeEvidence,
} from './candidates';
import {
  REFUND_SOURCE_TYPES,
  TransactionLink,
  confirmedAllocatedFromSource,
} from './relations';
import { cardPaymentPairedIds, classifyCardCredit } from './card-credit';
import { emit } from './obs/events';
import { startSpan } from './obs/trace';

// ---------------------------------------------------------------------------
// The caps §4.2/§5.2 — owner-confirmed, and what makes the §5.3 bound hold
// ---------------------------------------------------------------------------

export const MAX_CANDIDATE_PURCHASES = 12;
export const MAX_COMBINATION_SIZE = 4;
export const MAX_COMBINATIONS = 5;
/** A long return window and a slow merchant. One window for everyone (§12.4). */
export const REFUND_WINDOW_DAYS = 180;
/** Posting-order inversion: the credit can land before the charge finishes settling. */
export const POSTING_INVERSION_DAYS = 5;
/**
 * Unreachable by construction since FIN-REFUND-002: candidate selection now refuses
 * a purchase on any account but the credited one, so `sameAccount` is always true
 * here. Kept as defence in depth — if the filter is ever loosened, a cross-account
 * match is still scored down rather than arriving at full confidence.
 */
export const DIFFERENT_ACCOUNT_PENALTY = 0.2;
/** Two candidates this close are alternatives, not an answer (§4.4). */
export const AMBIGUITY_BAND = 0.05;

export const REFUND_MATCH_VERSION = 'refund-match-v1';
export const COMBINED_REFUND_VERSION = 'combined-refund-v1';

/** High/Medium/Low, from the same explainable ladder — never a model output. */
export type RefundConfidence = 'high' | 'medium' | 'low';
export const refundConfidence = (score: number): RefundConfidence =>
  score >= 0.8 ? 'high' : score >= 0.5 ? 'medium' : 'low';

// ---------------------------------------------------------------------------
// §5 — combined refund matching: bounded subset-sum in integer cents
// ---------------------------------------------------------------------------

export interface CombinationInput {
  id: string;
  amountCents: number;
}

export interface CombinationSearch {
  combinations: CombinationInput[][];
  /**
   * Every subset the walk actually formed. This is the instrumented counter test M20
   * asserts the bound with, so §5.3's 793 is TESTED rather than argued in prose.
   */
  subsetsVisited: number;
}

/**
 * Depth-first, integer cents, two prunes and one size cap.
 *
 * THE BOUND (§5.3). `n` here is never the ledger: §4.2 hands this at most
 * K = MAX_CANDIDATE_PURCHASES = 12 purchases, so with S = MAX_COMBINATION_SIZE = 4 the
 * walk can EVER form at most
 *
 *     Σ(k=1..4) C(12,k) = 12 + 66 + 220 + 495 = 793 subsets
 *
 * — a compile-time constant, independent of ledger size, at most 4 integer additions
 * each. The prunes only ever remove work; the bound holds without them, which is why it
 * is stated without them.
 *
 * No DP over cents: for a $1,200.00 credit that is 12 x 120,000 = 1.44M cells, worse
 * than 793, and it loses "which purchases" without backtracking.
 *
 * Subsets of size 1 are deliberately NOT returned — that is a `refund_match` (§4.3),
 * produced by the exact-amount path, not by this walk.
 */
export function findCombinations(
  targetCents: number,
  purchases: readonly CombinationInput[]
): CombinationSearch {
  // Step 1: a purchase bigger than the credit can never fit (all amounts positive).
  // Step 2: descending, so the prunes bite early. Id breaks ties, so the walk is
  // deterministic and reversing the input cannot change the answer.
  const pool = purchases
    .filter((p) => p.amountCents > 0 && p.amountCents <= targetCents)
    .sort((a, b) => b.amountCents - a.amountCents || a.id.localeCompare(b.id));

  // suffix[i] = Σ pool[i..end], for the "cannot reach the target" prune.
  const suffix = new Array<number>(pool.length + 1).fill(0);
  for (let i = pool.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + pool[i].amountCents;

  const combinations: CombinationInput[][] = [];
  const picked: CombinationInput[] = [];
  let subsetsVisited = 0;

  const walk = (start: number, runningSum: number): void => {
    for (let i = start; i < pool.length && combinations.length < MAX_COMBINATIONS; i++) {
      const next = pool[i];
      if (runningSum + next.amountCents > targetCents) continue; // prune: overshoots
      if (runningSum + suffix[i] < targetCents) return; // prune: unreachable from here on

      subsetsVisited++;
      picked.push(next);
      const sum = runningSum + next.amountCents;
      if (sum === targetCents) {
        if (picked.length >= 2) combinations.push([...picked]);
      } else if (picked.length < MAX_COMBINATION_SIZE) {
        walk(i + 1, sum);
      }
      picked.pop();
    }
  };

  if (targetCents > 0) walk(0, 0);
  return { combinations, subsetsVisited };
}

// ---------------------------------------------------------------------------
// §6 — net economic cost
// ---------------------------------------------------------------------------

export type RefundStatus =
  | 'not_refunded'
  | 'partially_refunded'
  | 'fully_refunded' // the "Returned" badge
  | 'over_refunded' // never silent clamping — it surfaces for review
  | 'provisional_dispute_credit';

export interface PurchaseEconomics {
  grossPurchaseCents: number; // never changes, never stored back on the row
  confirmedRefundedCents: number;
  provisionalRefundedCents: number;
  netEconomicCostCents: number; // gross − CONFIRMED only
  /**
   * The "if the dispute is upheld" view, deliberately a SEPARATE name.
   * May be rendered only alongside the word *provisional*. It never feeds Analytics
   * totals, Budgets or the forecast baseline.
   */
  netEconomicCostIfDisputeUpheldCents: number;
  status: RefundStatus;
  /** `provisional_dispute_credit` COMPOSES with the others; neither collapses the other. */
  statuses: RefundStatus[];
}

/**
 * `provisionalRefundedCents` is deliberately absent from `netEconomicCostCents`.
 *
 * A dispute credit is money the bank may take back. Subtracting it from final personal
 * spending would report a saving the owner has not made.
 */
export function purchaseEconomics(
  purchase: Pick<Transaction, 'id' | 'amount'>,
  links: readonly TransactionLink[]
): PurchaseEconomics {
  const grossPurchaseCents = toCents(purchase.amount);

  let confirmedRefundedCents = 0;
  let provisionalRefundedCents = 0;
  for (const l of links) {
    if (l.targetTransactionId !== purchase.id) continue;
    if (!REFUND_SOURCE_TYPES.includes(l.linkType)) continue;
    // A `suggested` link contributes to nothing. That is the mechanical form of
    // "nothing applies before confirmation".
    if (l.status === 'confirmed') confirmedRefundedCents += l.allocatedAmountCents;
    else if (l.status === 'provisional' && l.linkType === 'chargeback_for') {
      provisionalRefundedCents += l.allocatedAmountCents;
    }
  }

  const netEconomicCostCents = grossPurchaseCents - confirmedRefundedCents;

  const status: RefundStatus =
    confirmedRefundedCents === 0 ? 'not_refunded'
    : confirmedRefundedCents < grossPurchaseCents ? 'partially_refunded'
    : confirmedRefundedCents === grossPurchaseCents ? 'fully_refunded'
    : 'over_refunded';

  return {
    grossPurchaseCents,
    confirmedRefundedCents,
    provisionalRefundedCents,
    netEconomicCostCents,
    netEconomicCostIfDisputeUpheldCents: netEconomicCostCents - provisionalRefundedCents,
    status,
    statuses: provisionalRefundedCents > 0 ? [status, 'provisional_dispute_credit'] : [status],
  };
}

export interface RefundEconomics {
  refundAmountCents: number;
  allocatedRefundCents: number;
  unallocatedRefundCents: number;
}

/** The credit side of the same arithmetic. Confirmed allocations only. */
export function refundEconomics(
  credit: Pick<Transaction, 'id' | 'amount'>,
  links: readonly TransactionLink[]
): RefundEconomics {
  const refundAmountCents = toCents(credit.amount);
  const allocatedRefundCents = confirmedAllocatedFromSource(links, credit.id);
  return {
    refundAmountCents,
    allocatedRefundCents,
    unallocatedRefundCents: refundAmountCents - allocatedRefundCents,
  };
}

/**
 * Per-category spending NET of confirmed refunds, integer cents.
 *
 * Budgets and Analytics read this beside the gross figure — the purchase row stays in
 * History at full size either way. `src/lib/budgets.ts` consuming it is a deliberate
 * follow-up (§12.1 precondition 8): that file is not FIN-REFUND-001's to edit, so the
 * function is exposed here and the wiring is recorded rather than silently dropped.
 */
export function netCategorySpendingCents(
  transactions: readonly Transaction[],
  links: readonly TransactionLink[],
  accounts?: PaymentAccount[]
): Record<ExpenseCategory, number> {
  const out = Object.fromEntries(EXPENSE_CATEGORIES.map((c) => [c.value, 0])) as Record<ExpenseCategory, number>;
  for (const t of transactions) {
    if (interpretTransaction(t, accounts).budget !== 'counted') continue;
    out[t.category] = (out[t.category] ?? 0) + toCents(t.amount) - purchaseEconomics(t, links).confirmedRefundedCents;
  }
  return out;
}

// ---------------------------------------------------------------------------
// §4 — candidate generation
// ---------------------------------------------------------------------------

/** Kinds whose credit is a refund of SOMETHING. A settlement and a cashback are not. */
const REFUNDABLE_KINDS = ['merchant_refund', 'partial_refund', 'charge_reversal', 'unknown_card_credit'];

const merchantKey = (t: Transaction) => normalizeMerchant(t.merchant || t.title);

/** Shared order/reference tokens, computed locally. Only the ENUM is ever stored. */
function referenceOverlap(credit: Transaction, purchases: readonly Transaction[]): CandidateEvidence['referenceOverlap'] {
  const tokens = (t: Transaction) =>
    new Set(`${t.title} ${t.description ?? ''}`.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);
  const creditTokens = tokens(credit);
  let shared = 0;
  for (const p of purchases) for (const tok of tokens(p)) if (creditTokens.has(tok)) shared++;
  return shared >= 2 ? 'strong' : shared === 1 ? 'weak' : 'none';
}

/**
 * §4.4's ladder — explainable, deterministic, hand-written on purpose (§12.4 rules a
 * machine-learned matcher out). NEVER merchant text alone: every tier below requires an
 * amount relationship as well.
 *
 * The −0.2 different-account penalty is applied last, so "same evidence on another card"
 * is exactly 0.2 weaker and nothing else changes.
 */
function scoreOf(
  shape: 'exact' | 'partial' | 'combined',
  merchantMatch: CandidateEvidence['merchantMatch'],
  dayGap: number,
  sameAccount: boolean
): number {
  let base: number;
  if (merchantMatch === 'alias') base = 0.3;
  else if (shape === 'combined') base = 0.6;
  else if (shape === 'exact') base = dayGap <= 30 && merchantMatch === 'exact' ? 1 : dayGap <= 90 ? 0.85 : 0.7;
  // Spec silent beyond 90 days for a partial; tapered on the same shape as `exact`
  // rather than invented afresh, and it stays inside the 180-day window either way.
  else base = dayGap <= 90 ? 0.5 : 0.35;
  return Number((sameAccount ? base : base - DIFFERENT_ACCOUNT_PENALTY).toFixed(4));
}

export interface RefundCandidateRun {
  candidates: ReviewCandidate[];
  /** Credits the ladder actually evaluated — the `R` in §5.3's cost model. */
  creditsEvaluated: number;
  /** Σ subsets formed across every walk in this run. Asserted against the bound (M20). */
  subsetsVisited: number;
  durationMs: number;
}

/**
 * Propose, never apply.
 *
 * Runs on ingest completion, on explicit refresh or on demand — NEVER per render and
 * never in an unguarded effect (§9). The result is `unreviewed` candidates carrying
 * proposed links; not one link is written here, at any score.
 */
export function generateRefundCandidates(
  transactions: readonly Transaction[],
  accounts: PaymentAccount[],
  links: readonly TransactionLink[] = [],
  options: { generatedAt?: string; income?: IncomeContext } = {}
): RefundCandidateRun {
  const span = startSpan('Refund.GenerateCandidates', { component: 'RecoveryRefunds', route: '/flow' });
  const startedAt = Date.now();
  const generatedAt = options.generatedAt ?? new Date().toISOString();

  // POSTED ONLY — and deliberately NOT following FIN-PENDING-001, unlike the Flow graph
  // this feeds. The audit first filed this as a "honour the policy" site; closer reading
  // says no, for a reason the policy cannot override: a candidate becomes a LINK DOCUMENT
  // keyed by transaction id, and a hold's doc (`pending_pl_*`) is DELETED the moment the
  // charge posts under its own id. Every link to a hold would dangle. Counting a hold in
  // a total is reversible; writing a link to a row that is about to vanish is not.
  //
  // It may still be SHOWN with a Pending label. It generates no candidate, writes no
  // link and reduces no cost, and when the posted row arrives that row is matched
  // instead (M12/M14).
  const posted = transactions.filter(isPosted);

  // One O(n) indexing pass per run, not a scan per credit (§9). The date sort is what
  // lets the window be found by binary search instead of a full-bucket walk.
  const byMerchant = new Map<string, Transaction[]>();
  for (const t of posted) {
    const i = interpretTransaction(t, accounts, options.income);
    if (i.direction !== 'outflow' || i.expense !== 'counted') continue; // purchases only
    const key = merchantKey(t);
    if (!key) continue;
    const bucket = byMerchant.get(key);
    if (bucket) bucket.push(t);
    else byMerchant.set(key, [t]);
  }
  for (const bucket of byMerchant.values()) bucket.sort((a, b) => day(a.date).localeCompare(day(b.date)) || a.id.localeCompare(b.id));

  // matchTransfers() is O(outs x ins); computing the paired set ONCE is what keeps rung
  // 1 out of the per-credit path.
  const pairedIds = cardPaymentPairedIds([...posted], accounts);
  const confirmedSources = new Set(
    links.filter((l) => l.status === 'confirmed').map((l) => l.sourceTransactionId)
  );

  const candidates: ReviewCandidate[] = [];
  let creditsEvaluated = 0;
  let subsetsVisited = 0;
  let exactCount = 0;
  let partialCount = 0;
  let combinedCount = 0;

  for (const credit of posted) {
    const interp = interpretTransaction(credit, accounts, options.income);
    if (interp.direction !== 'inflow') continue;
    if (confirmedSources.has(credit.id)) continue; // already allocated — §4.1.4

    const { kind } = classifyCardCredit(credit, { accounts, links, pairedTransactionIds: pairedIds, income: options.income });
    const account = accounts.find((a) => a.id === credit.accountId);
    const debt = account?.type === 'credit_card' || account?.type === 'personal_loan';
    // Rung-1 settlements and rung-5 rewards are refunds of nothing and must not match.
    // The bank-side path is isRefund() on a non-debt account, which buildFlowGraph()
    // already routes to the `refunds` node.
    const eligible = REFUNDABLE_KINDS.includes(kind) || (!debt && isRefund(credit));
    if (!eligible) continue;

    creditsEvaluated++;
    const targetCents = toCents(credit.amount);
    if (targetCents <= 0) continue;

    // --- §4.2: the window ---------------------------------------------------
    const bucket = byMerchant.get(merchantKey(credit)) ?? [];
    const from = addDays(day(credit.date), -REFUND_WINDOW_DAYS);
    const to = addDays(day(credit.date), POSTING_INVERSION_DAYS);
    const window: Transaction[] = [];
    for (let i = lowerBound(bucket, from); i < bucket.length; i++) {
      if (day(bucket[i].date) > to) break;
      if (bucket[i].id === credit.id) continue;
      // Same card, always. A merchant refunds the account it charged, so a purchase
      // on another card is not evidence — it is a coincidence of merchant and amount.
      // A cross-account credit is not lost: it falls through to `unknown_card_credit`
      // and stays visible in the review queue, unmatched rather than mis-matched.
      // ponytail: this makes a legitimate refund-to-a-replacement-card unmatchable.
      // Upgrade path is an explicit owner-confirmed account-succession link, not a
      // looser default — the default must not guess across cards.
      if (bucket[i].accountId !== credit.accountId) continue;
      // A purchase already fully covered by confirmed links is not available (§5.5).
      if (purchaseEconomics(bucket[i], links).netEconomicCostCents <= 0) continue;
      window.push(bucket[i]);
    }
    if (!window.length) continue;

    // --- §4.2: score, then the hard cap of 12 -------------------------------
    const scored = window
      .map((p) => {
        const sameAccount = p.accountId === credit.accountId;
        const dayGap = Math.abs(daysBetween(day(p.date), day(credit.date)));
        const pCents = toCents(p.amount);
        const shape = pCents === targetCents ? 'exact' : targetCents < pCents ? 'partial' : 'combined';
        return { p, sameAccount, dayGap, pCents, shape, score: scoreOf(shape, 'exact', dayGap, sameAccount) };
      })
      .sort((a, b) => b.score - a.score || a.dayGap - b.dayGap || a.p.id.localeCompare(b.p.id))
      .slice(0, MAX_CANDIDATE_PURCHASES);

    const evidenceFor = (rows: Transaction[], sameAccount: boolean, dayGaps: number[], reasonCodes: string[]): CandidateEvidence =>
      sanitizeEvidence({
        amountsCents: rows.map((r) => toCents(r.amount)),
        dayGaps,
        sameAccount,
        accountTypes: [...new Set(rows.map((r) => accounts.find((a) => a.id === r.accountId)?.type).filter(Boolean))],
        merchantMatch: 'exact',
        referenceOverlap: referenceOverlap(credit, rows),
        pendingInvolved: false,
        reasonCodes,
      });

    // This credit's proposals, collected before the ambiguity rule is applied across
    // ALL of them (§4.4 is not limited to the exact-amount shape).
    const forThisCredit: ReviewCandidate[] = [];

    const emitCandidate = (
      candidateType: CandidateType,
      algorithmVersion: string,
      rows: Transaction[],
      proposedLinks: ProposedLink[],
      score: number,
      evidence: CandidateEvidence
    ) => {
      const transactionIds = [credit.id, ...rows.map((r) => r.id)];
      forThisCredit.push({
        id: buildIdentityKey(candidateType, transactionIds),
        candidateId: buildCandidateId(candidateType, algorithmVersion, transactionIds),
        candidateType,
        algorithmVersion,
        transactionIds: [...transactionIds].sort(),
        status: 'unreviewed', // NOTHING auto-confirms, at any score, ever
        proposedLinks,
        evidence,
        score,
        generatedAt,
      });
    };

    // --- §4.3 shape 1: exact ------------------------------------------------
    const exact = scored.filter((s) => s.shape === 'exact');
    for (const s of exact) {
      exactCount++;
      emitCandidate(
        'refund_match', REFUND_MATCH_VERSION, [s.p],
        [{ linkType: 'refund_of', sourceTransactionId: credit.id, targetTransactionId: s.p.id, allocatedAmountCents: targetCents }],
        s.score,
        evidenceFor([s.p], s.sameAccount, [s.dayGap], reasonCodes('exact_amount', s.sameAccount))
      );
    }

    // --- §4.3 shape 2: partial ----------------------------------------------
    if (!exact.length) {
      for (const s of scored.filter((x) => x.shape === 'partial')) {
        partialCount++;
        emitCandidate(
          'partial_refund_match', REFUND_MATCH_VERSION, [s.p],
          [{ linkType: 'partial_refund_of', sourceTransactionId: credit.id, targetTransactionId: s.p.id, allocatedAmountCents: targetCents }],
          s.score,
          evidenceFor([s.p], s.sameAccount, [s.dayGap], reasonCodes('partial_amount', s.sameAccount))
        );
      }
    }

    // --- §4.3 shape 3: combined (§5) ----------------------------------------
    let combined: Transaction[][] = [];
    if (!exact.length) {
      const walk = findCombinations(targetCents, scored.map((s) => ({ id: s.p.id, amountCents: s.pCents })));
      subsetsVisited += walk.subsetsVisited;
      const byId = new Map(scored.map((s) => [s.p.id, s.p]));
      combined = walk.combinations
        .map((c) => c.map((x) => byId.get(x.id)!))
        .filter((rows) => refusals(rows, credit))
        .sort(rankCombinations(credit))
        .slice(0, MAX_COMBINATIONS);

      for (const rows of combined) {
        combinedCount++;
        const sameAccount = rows.every((r) => r.accountId === credit.accountId);
        const dayGaps = rows.map((r) => Math.abs(daysBetween(day(r.date), day(credit.date))));
        emitCandidate(
          'combined_refund_match', COMBINED_REFUND_VERSION, rows,
          rows.map((r) => ({
            linkType: 'refund_of' as const, sourceTransactionId: credit.id,
            targetTransactionId: r.id, allocatedAmountCents: toCents(r.amount),
          })),
          scoreOf('combined', 'exact', Math.max(...dayGaps), sameAccount),
          evidenceFor(rows, sameAccount, dayGaps, reasonCodes('combined_amount', sameAccount))
        );
      }
    }

    // --- §4.3: a credit that fits nothing is queued, not force-allocated ----
    if (!exact.length && !combined.length && !scored.some((s) => s.shape === 'partial')) {
      const rows = scored.slice(0, MAX_CANDIDATE_PURCHASES).map((s) => s.p);
      if (rows.length) {
        const sameAccount = rows.every((r) => r.accountId === credit.accountId);
        emitCandidate(
          'unknown_card_credit', REFUND_MATCH_VERSION, rows, [],
          0.1,
          evidenceFor(rows, sameAccount, rows.map((r) => Math.abs(daysBetween(day(r.date), day(credit.date)))), ['unexplained_credit'])
        );
      }
    }

    // §4.4's ambiguity rule, applied across EVERY shape proposed for this credit —
    // two candidates within 0.05 are ALTERNATIVES, so all of them are marked and none
    // is presented as the answer. (They are already `unreviewed`; nothing auto-confirms
    // at any score, so this only changes how the queue explains itself.)
    if (forThisCredit.length > 1) {
      const top = Math.max(...forThisCredit.map((c) => c.score));
      const tied = forThisCredit.filter((c) => top - c.score <= AMBIGUITY_BAND);
      if (tied.length > 1) for (const c of tied) c.evidence.reasonCodes.push('ambiguous_match');
    }
    candidates.push(...forThisCredit);
  }

  const durationMs = Date.now() - startedAt;
  // ONE event for the whole run, not one per candidate (OBS-001's performance rule).
  // Counts and enums only — never a description, a merchant string or an amount.
  emit({
    eventName: 'Refund.CandidateGenerated',
    eventCategory: 'activity',
    severity: 'debug',
    traceId: span.traceId,
    component: 'RecoveryRefunds',
    route: '/flow',
    recordCount: candidates.length,
    durationMs,
    resultStatus: candidates.length ? 'ok' : 'empty',
    metadata: {
      algorithmVersion: REFUND_MATCH_VERSION,
      combinedAlgorithmVersion: COMBINED_REFUND_VERSION,
      exactCount, partialCount, combinedCount,
      creditsEvaluated, subsetsVisited,
    },
  });
  span.end({ status: 'ok', recordCount: candidates.length });

  return { candidates: rankCandidates(candidates), creditsEvaluated, subsetsVisited, durationMs };
}

const reasonCodes = (shape: string, sameAccount: boolean): string[] => [
  shape,
  sameAccount ? 'same_account' : 'different_account',
];

/** §5.5 — what a combination must refuse. */
function refusals(rows: readonly Transaction[], credit: Transaction): boolean {
  if (rows.length < 2) return false;
  const earliest = rows.reduce((a, b) => (day(a.date) <= day(b.date) ? a : b));
  if (Math.abs(daysBetween(day(earliest.date), day(credit.date))) > REFUND_WINDOW_DAYS) return false;
  // Every purchase in a combination must sit on the account being credited. The old
  // rule allowed a combination to span two accounts, which let one card's refund be
  // explained by another card's purchases.
  if (rows.some((r) => r.accountId !== credit.accountId)) return false;
  return true;
}

/** §5.4, in order: fewest purchases, same account, closest dates, overlap, ids. */
const rankCombinations = (credit: Transaction) => (a: Transaction[], b: Transaction[]): number => {
  const span = (rows: Transaction[]) => Math.max(...rows.map((r) => Math.abs(daysBetween(day(r.date), day(credit.date)))));
  const same = (rows: Transaction[]) => (rows.every((r) => r.accountId === credit.accountId) ? 0 : 1);
  const overlap = (rows: Transaction[]) => ({ strong: 0, weak: 1, none: 2 })[referenceOverlap(credit, rows)];
  return (
    a.length - b.length ||
    same(a) - same(b) ||
    span(a) - span(b) ||
    overlap(a) - overlap(b) ||
    a.map((r) => r.id).sort().join().localeCompare(b.map((r) => r.id).sort().join())
  );
};

// --- small date helpers, on the yyyy-MM-dd strings the ledger already uses ---

const addDays = (iso: string, days: number): string =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** First index whose date is >= `from`. O(log b) instead of walking the bucket. */
function lowerBound(bucket: readonly Transaction[], from: string): number {
  let lo = 0;
  let hi = bucket.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (day(bucket[mid].date) < from) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ---------------------------------------------------------------------------
// Decision telemetry — for FIN-RECOVERY-UI-001, which owns every review surface
// ---------------------------------------------------------------------------

export type RefundDecisionEvent =
  | { event: 'Refund.MatchConfirmed'; candidateType: CandidateType; allocationCount: number; sameAccount: boolean; dayGap: number }
  | { event: 'Refund.AllocationAdjusted'; allocationCount: number; direction: 'increase' | 'decrease' }
  | { event: 'Refund.MatchRejected'; candidateType: CandidateType; rejectionReasonCode: string };

/**
 * The owner's decisions happen in surfaces FIN-REFUND-001 does not own
 * (relations-store.ts, chat-actions.ts, the review UI), so the three decision events
 * live here as one emitter those callers invoke. Safe properties only — no second
 * telemetry system, and no console.log of a financial payload anywhere in this module.
 */
export function emitRefundDecision(e: RefundDecisionEvent): void {
  const { event, ...metadata } = e;
  emit({
    eventName: event,
    eventCategory: 'activity',
    severity: 'info',
    traceId: '',
    component: 'RecoveryRefunds',
    route: '/flow',
    resultStatus: 'ok',
    metadata,
  });
}
