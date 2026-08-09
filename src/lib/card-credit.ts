/**
 * What is this credit on my credit card?
 *
 * Today the app answers with two regexes (`isRefund()`, `isReward()`), and the
 * `ponytail:` note at src/lib/classify.ts:135-137 names the gap: a refund filed under
 * the original spend category with no "refund" word reads as income. This module is the
 * ladder that answers properly.
 *
 * THE OWNER'S RULE, MECHANISED: a credit-card credit is NEVER automatically earned
 * income. That is not enforced by a branch anyone could forget — it is a property of
 * CARD_CREDIT_TO_INFLOW_MEANING, a TOTAL function over the ten kinds whose range
 * excludes `earned_income`. Test D1 proves it by enumeration.
 *
 * PURE module: no Firestore, no React, no I/O. It reads the merged classifier and never
 * writes to it. `CardCreditKind` and its ten values are IMPORTED from src/lib/relations.ts
 * (FIN-RELATION-001 merged first and owns the parser that validates them) — there is no
 * second copy of that list, and there is no second inflow taxonomy: `FinancialMeaning`
 * comes from FIN-INCOME-001 through the module that owns it.
 *
 * FIN-REFUND-001 owns this file.
 */

import { PaymentAccount, Transaction } from '@/types';
import {
  FinancialMeaning,
  IncomeContext,
  LedgerMeaning,
  interpretTransaction,
  isReward,
} from './classify';
import { CARD_CREDIT_KINDS, CardCreditKind, TransactionLink } from './relations';
import { matchTransfers } from './transfers';
import { emit } from './obs/events';

export type { CardCreditKind };
export { CARD_CREDIT_KINDS };

// ---------------------------------------------------------------------------
// §3.3 — the projection onto FIN-INCOME-001's taxonomy
// ---------------------------------------------------------------------------

/**
 * The whole point of this file, in one object.
 *
 * `earned_income` is not in the range. A card credit therefore cannot become earned
 * income by any path through this module, and adding an eleventh kind without deciding
 * its meaning is a TYPE ERROR rather than a silent default. FIN-REFUND-001 declares no
 * taxonomy value of its own — the type and its values are FIN-INCOME-001's.
 */
export const CARD_CREDIT_TO_INFLOW_MEANING: Record<CardCreditKind, FinancialMeaning> = {
  card_payment: 'internal_transfer',
  merchant_refund: 'refund',
  partial_refund: 'refund',
  charge_reversal: 'refund',
  chargeback_credit: 'refund', // provisional until the dispute resolves — see refunds.ts §6.3
  statement_credit: 'other_non_income_credit',
  cashback_reward: 'other_non_income_credit',
  promotional_credit: 'other_non_income_credit',
  manual_adjustment: 'other_non_income_credit',
  unknown_card_credit: 'unknown_inflow',
};

/** The one question this module never answers for itself. */
export const inflowMeaningOfCardCredit = (kind: CardCreditKind): FinancialMeaning =>
  CARD_CREDIT_TO_INFLOW_MEANING[kind];

/**
 * §3.3's consistency table, as the TEXT-DERIVED rungs can produce it.
 *
 * Deviation from the spec's table, stated plainly: `unknown_card_credit` and
 * `manual_adjustment` are added to `refund`. §3.2 requires rungs 2–4 to see a CONFIRMED
 * link, so a credit whose text merely says "refund" and which carries no confirmed link
 * MUST fall through to rung 6 or 7 — the spec's own "honest default". A table that
 * excluded them would contradict the ladder two sections earlier.
 *
 * Rungs 1–4 are LINK-derived facts and outrank text by construction: a confirmed
 * `chargeback_for` on a row whose title happens to say "rewards" is a chargeback, and
 * that is correct. Read this table as the tail of the ladder, not as a gate on it.
 */
export const PERMITTED_KINDS_BY_LEDGER_MEANING: Record<LedgerMeaning, readonly CardCreditKind[]> = {
  spending: [],
  internal_transfer: [],
  // #79. Same as internal_transfer: a transfer leg is not a card credit of any kind,
  // whether the other party is you or someone else.
  external_transfer: [],
  card_payment: ['card_payment'],
  reward: ['statement_credit', 'cashback_reward', 'promotional_credit'],
  refund: ['merchant_refund', 'partial_refund', 'charge_reversal', 'chargeback_credit', 'manual_adjustment', 'unknown_card_credit'],
  income_candidate: CARD_CREDIT_KINDS,
};

// ---------------------------------------------------------------------------
// §3.4 — sub-splitting rung 5 without touching isReward()
// ---------------------------------------------------------------------------

type Named = Pick<Transaction, 'title'> & Partial<Pick<Transaction, 'merchant' | 'sourceCategory'>>;

/** Same haystack as isReward(), so the split can never widen or narrow the gate. */
const haystack = (t: Named) => `${t.title} ${t.merchant || ''} ${t.sourceCategory || ''}`.toLowerCase();

/**
 * Runs ONLY when isReward() is already true, and returns null otherwise — so this is a
 * partition of what the app already calls a reward, never a re-definition of it.
 */
export function rewardKind(t: Named): CardCreditKind | null {
  if (!isReward(t)) return null;
  const text = haystack(t);
  if (text.includes('statement credit')) return 'statement_credit';
  if (/promo|promotional|welcome|intro/.test(text)) return 'promotional_credit';
  return 'cashback_reward';
}

// ---------------------------------------------------------------------------
// Manual provenance (rung 6)
// ---------------------------------------------------------------------------

/**
 * Same vocabulary src/lib/obs/provenance.ts:96 already uses, so "what is a provider
 * path" has one answer in the codebase.
 */
const NON_PROVIDER_SOURCES = ['manual', 'csv'];

/**
 * Deviation, stated: an ABSENT `sources` array is unknown provenance, not proof of
 * manual entry. The spec's literal wording ("the row's sources contain no provider
 * path") would make rung 6 swallow every row predating the dual-source ingest and leave
 * rung 7 — the spec's own "honest default" — unreachable. Rung 6 therefore requires
 * positive evidence: a non-empty `sources` naming no provider, or an owner-edited amount.
 */
function isManualAdjustment(t: Transaction): boolean {
  if (t.userEdited?.amount === true) return true;
  return Array.isArray(t.sources) && t.sources.length > 0
    && !t.sources.some((s) => !NON_PROVIDER_SOURCES.includes(s));
}

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

export interface CardCreditContext {
  accounts?: PaymentAccount[];
  /** Stored links. Rungs 2–4 read CONFIRMED (and, for a chargeback, PROVISIONAL) only. */
  links?: readonly TransactionLink[];
  /**
   * The current transaction set, for matchTransfers() evidence at rung 1. Prefer
   * `pairedTransactionIds` in a loop: matchTransfers() is O(outs x ins) and calling it
   * per credit is the n^2 §9 forbids.
   */
  transactions?: Transaction[];
  /** Precomputed once by the caller — see cardPaymentPairedIds(). */
  pairedTransactionIds?: ReadonlySet<string>;
  income?: IncomeContext;
}

export interface CardCreditClassification {
  kind: CardCreditKind;
  /** 1..7 — which rung held. Makes the ordering assertable (D13) and loggable. */
  rung: number;
  confidence: number;
  /** Evidence in words, for the review queue. Never logged. */
  reason: string;
}

/** Both legs of every matched settlement, computed ONCE for a whole run. */
export function cardPaymentPairedIds(transactions: Transaction[], accounts: PaymentAccount[]): Set<string> {
  const ids = new Set<string>();
  for (const p of matchTransfers(transactions, accounts).pairs) {
    ids.add(p.out.id);
    ids.add(p.inbound.id);
  }
  return ids;
}

const sourcedLinks = (links: readonly TransactionLink[] | undefined, id: string) =>
  (links ?? []).filter((l) => l.sourceTransactionId === id);

/**
 * Rule order is load-bearing — first rung that holds wins. Do not permute without a
 * failing test (D13 asserts it rung by rung).
 *
 *   1 card-payment pair · 2 confirmed merchant refund · 3 confirmed reversal
 *   4 chargeback (confirmed OR provisional) · 5 reward split · 6 manual · 7 unknown
 *
 * Rungs 2–4 require a CONFIRMED link precisely so an unconfirmed SUGGESTION cannot
 * change a row's classification. That is the mechanical form of "nothing applies before
 * confirmation": the ladder cannot see a `suggested` link.
 */
export function classifyCardCredit(t: Transaction, ctx: CardCreditContext = {}): CardCreditClassification {
  const result = ladder(t, ctx);

  // Counts and enums only. Never the description, the merchant or the amount.
  emit({
    eventName: 'CardCredit.Classified',
    eventCategory: 'activity',
    severity: 'debug',
    traceId: '',
    component: 'RecoveryRefunds',
    route: '/flow',
    resultStatus: 'ok',
    metadata: { cardCreditKind: result.kind, rung: result.rung, confidence: result.confidence },
  });

  return result;
}

function ladder(t: Transaction, ctx: CardCreditContext): CardCreditClassification {
  const links = ctx.links ?? [];
  const fromHere = sourcedLinks(links, t.id);

  // --- rung 1: a card-payment pair is a settlement, never a refund -----------
  // Precedence is the point: a $300 credit titled "AUTOPAY PAYMENT - THANK YOU" that
  // happens to equal a $300 purchase from last week is debt settlement. Rung 1 fires
  // before rung 2 ever looks.
  const settlement = interpretTransaction(t, ctx.accounts, ctx.income).transfer === 'card_settlement';
  const paired = ctx.pairedTransactionIds
    ? ctx.pairedTransactionIds.has(t.id)
    : ctx.transactions && ctx.accounts
      ? cardPaymentPairedIds(ctx.transactions, ctx.accounts).has(t.id)
      : false;
  const pairLink = links.some(
    (l) => l.linkType === 'card_payment_pair' && l.status === 'confirmed'
      && (l.sourceTransactionId === t.id || l.targetTransactionId === t.id)
  );
  if (settlement || paired || pairLink) {
    return {
      kind: 'card_payment', rung: 1, confidence: pairLink ? 1 : 0.9,
      reason: pairLink
        ? 'a confirmed card-payment pair links this row to its funding leg'
        : settlement
          ? 'reads as a settlement of one of your cards, so the purchases are the expenses'
          : 'paired with a funding leg on another of your accounts',
    };
  }

  // --- rungs 2-4: a CONFIRMED link is a fact, and outranks any text ----------
  const confirmedOf = (type: TransactionLink['linkType']) =>
    fromHere.some((l) => l.linkType === type && l.status === 'confirmed');

  if (confirmedOf('refund_of')) {
    return { kind: 'merchant_refund', rung: 2, confidence: 1, reason: 'a confirmed refund link reverses a specific purchase in full' };
  }
  if (confirmedOf('partial_refund_of')) {
    return { kind: 'partial_refund', rung: 2, confidence: 1, reason: 'a confirmed link reverses part of a specific purchase' };
  }
  if (confirmedOf('reversal_of')) {
    return { kind: 'charge_reversal', rung: 3, confidence: 1, reason: 'a confirmed reversal — the merchant or processor voided its own charge' };
  }
  if (fromHere.some((l) => l.linkType === 'chargeback_for' && (l.status === 'confirmed' || l.status === 'provisional'))) {
    const provisional = fromHere.some((l) => l.linkType === 'chargeback_for' && l.status === 'provisional');
    return {
      kind: 'chargeback_credit', rung: 4, confidence: provisional ? 0.8 : 1,
      reason: provisional
        ? 'a dispute credit whose outcome is not final — provisional, and it reduces no spending yet'
        : 'a resolved dispute credit',
    };
  }

  // --- rung 5: the reward split, gated by the untouched isReward() -----------
  const reward = rewardKind(t);
  if (reward) {
    return { kind: reward, rung: 5, confidence: 0.6, reason: 'card credit whose text reads as rewards, a promotion or a statement credit' };
  }

  // --- rung 6: the owner entered or corrected it ------------------------------
  if (isManualAdjustment(t)) {
    return { kind: 'manual_adjustment', rung: 6, confidence: 0.7, reason: 'entered or amended by hand — no provider wrote this amount' };
  }

  // --- rung 7: the honest default --------------------------------------------
  return {
    kind: 'unknown_card_credit', rung: 7, confidence: 0.3,
    reason: 'nothing explains this credit yet — real money, counted as no kind of income',
  };
}
