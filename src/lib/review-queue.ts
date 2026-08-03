/**
 * ONE review queue — the view model behind `/flow?tab=review`.
 *
 * FIN-RECOVERY-UI-001 owns this file and the shell it feeds. FIN-REVIEW-002's
 * unknown-inflow items are a second ITEM SOURCE in the same queue, never a second queue
 * (FIN-REVIEW-002.md:36-39). Money type is a property of the item.
 *
 * PURE module: no React, no Firestore, no I/O. Everything here is derived on read from
 * the ledger, the links and the candidates — nothing is stored on a transaction, and no
 * number is parsed out of a model reply. Amounts are INTEGER CENTS end to end; dollars
 * exist only inside `formatMoneyCents()`.
 *
 * The plain-language builders live here rather than in the components so the same
 * sentence is testable without a DOM, and so Dashboard/Analytics/Export can adopt the
 * badge helper later without a second derivation (§5.1).
 */

import { ExpenseCategory, EXPENSE_CATEGORIES, InflowReviewState, PaymentAccount, Transaction } from '@/types';
import { CandidateStatus, CandidateType, ReviewCandidate, isTerminalCandidateStatus } from './candidates';
import { InflowReviewItem, interpretTransaction } from './classify';
import { DuplicateCostEstimate } from './duplicates';
import { day, normalizeMerchant, toCents } from './flows';
import { formatMoneyCents } from './money';
import { PurchaseEconomics, RefundEconomics, purchaseEconomics, refundEconomics } from './refunds';
import { LinkStatus, REFUND_SOURCE_TYPES, TransactionLink } from './relations';
import { getAllCategorySpending } from './budgets';
import { MappingGroup, groupMeanings } from './mapping-suggestions';

// ---------------------------------------------------------------------------
// §2.3 — ONE state vocabulary, aligned once, with no translation layer
// ---------------------------------------------------------------------------

export type QueueState = 'needs_attention' | 'unreviewed' | 'suggested' | 'needs_more_information';

/** Ranked FIRST to LAST — §4.5's primary sort key. Index is the rank. */
export const QUEUE_STATES: readonly QueueState[] = [
  'needs_attention',
  'unreviewed',
  'suggested',
  'needs_more_information',
];

/** A candidate the owner has decided about leaves the queue. `null` means "not in queue". */
export function queueStateOfCandidate(status: CandidateStatus): QueueState | null {
  if (isTerminalCandidateStatus(status)) return null;
  return status as QueueState;
}

/**
 * FIN-REVIEW-002's per-transaction states, as a value. `InflowReviewState` is a type-only
 * union in `src/types`, which is FIN-INCOME-001's file; declaring the array here rather
 * than editing that file keeps ownership disjoint. Test Q3 pins the two together.
 */
export const INFLOW_REVIEW_STATES: readonly InflowReviewState[] = [
  'unreviewed', 'suggested', 'confirmed', 'dismissed', 'needs_attention',
];

/** FIN-REVIEW-002's per-transaction review state, onto the same vocabulary. */
export function queueStateOfReview(state: InflowReviewState): QueueState | null {
  if (state === 'confirmed' || state === 'dismissed') return null;
  return state as QueueState;
}

/**
 * The reverse direction (test Q3). `needs_attention` has no stored candidate status — it
 * is DERIVED (a link partner missing, FIN-RELATION-001 §3.7) — and
 * `needs_more_information` has no FIN-REVIEW-002 equivalent. Both gaps are `null` rather
 * than invented, because inventing either would be a second state machine.
 */
export function statusesOfQueueState(state: QueueState): {
  candidateStatus: CandidateStatus | null;
  reviewState: InflowReviewState | null;
} {
  return {
    candidateStatus: state === 'needs_attention' ? null : (state as CandidateStatus),
    reviewState: state === 'needs_more_information' ? null : (state as InflowReviewState),
  };
}

// ---------------------------------------------------------------------------
// Sections — the six recovery groups plus the FIN-REVIEW-002 source
// ---------------------------------------------------------------------------

export type SectionId =
  | 'refund_matches'
  | 'returned_purchases'
  | 'unknown_card_credits'
  | 'duplicate_charges'
  | 'duplicate_subscriptions'
  | 'continued_charges'
  | 'unknown_deposits'
  | 'unmapped_groups';

export interface ReviewSection {
  id: SectionId;
  label: string;
  /** Chip wording on the Flow entry strip (§3), which is terser than the heading. */
  chipLabel: string;
  candidateTypes: readonly CandidateType[];
  /** What these items ARE, in one sentence nobody had to learn the app to understand. */
  what: string;
  /** What answering one actually DOES — read before the decision, not discovered after. */
  after: string;
}

/**
 * Ordered by how much money an answer here is worth, NOT by how many items there are.
 *
 * The owner opened this panel and could not work out what to do, because the counts run
 * the other way: 400-odd refund matches worth cents each used to sit above the handful of
 * patterns holding six figures. `SECTION_RANK` below makes this list the queue's primary
 * sort key, so the first thing on screen is the most valuable thing to answer.
 */
export const REVIEW_SECTIONS: readonly ReviewSection[] = [
  // MAP-001. A group answers many rows at once, which is why it earns its own section
  // rather than being 205 more rows in one of the ones below — and why it leads.
  {
    id: 'unmapped_groups',
    label: 'Patterns To Map',
    chipLabel: 'Patterns to map',
    candidateTypes: [],
    what: 'Money the app can see but cannot name, grouped so that one answer covers every row that looks the same. Nearly all of your unexplained money is here.',
    after: 'Those rows stop being unknown everywhere at once — Flow, budgets and your totals all use the name you give them. Nothing is deleted, and naming money never invents income.',
  },
  {
    id: 'unknown_deposits',
    label: 'Unknown Deposits',
    chipLabel: 'Unknown deposits',
    candidateTypes: [],
    what: 'Money that arrived and does not match any income source you approved. Until you say what it is, the app refuses to count it as income.',
    after: 'Your answer is recorded on that deposit. It only starts counting as income if you say it is income you earned.',
  },
  {
    id: 'unknown_card_credits',
    label: 'Unknown Card Credits',
    chipLabel: 'Unknown card credits',
    candidateTypes: ['unknown_card_credit'],
    what: 'A credit landed on a card and nothing in your data explains it yet — it could be a refund, a reward, a payment you made, or a reversed charge.',
    after: 'The credit gets filed as what you say it is. A card credit is never counted as income, whichever answer you pick.',
  },
  {
    id: 'continued_charges',
    label: 'Continued Charges After Cancellation',
    chipLabel: 'Charges after cancelling',
    candidateTypes: ['continued_charge_after_cancellation'],
    what: 'A merchant charged you after the date you told us you cancelled.',
    after: 'Your answer is recorded and the app stops asking. No money comes back on its own — this is a prompt to go and claim it.',
  },
  {
    id: 'duplicate_subscriptions',
    label: 'Possible Duplicate Subscriptions',
    chipLabel: 'Duplicate subscriptions',
    candidateTypes: ['duplicate_subscription', 'subscription_overlap'],
    what: 'The same service looks like it is billing two of your accounts.',
    after: 'No total moves — both charges stay counted in your spending. What you get is a straight answer about what you could cancel.',
  },
  {
    id: 'duplicate_charges',
    label: 'Possible Duplicate Charges',
    chipLabel: 'Possible duplicate charges',
    candidateTypes: ['immediate_duplicate_charge'],
    what: 'A merchant charged the same amount twice within a day or two.',
    after: 'No total moves — both charges stay counted. Your answer records whether the second one was real, and the app stops asking.',
  },
  {
    id: 'refund_matches',
    label: 'Refund Matches',
    chipLabel: 'Refunds to match',
    candidateTypes: ['refund_match', 'combined_refund_match'],
    what: 'A credit that exactly matches something you bought. The app is confident and only needs you to agree the two belong together.',
    after: 'That purchase’s category total drops by the refund. Both rows stay in your history at their full amounts.',
  },
  {
    id: 'returned_purchases',
    label: 'Returned Purchases',
    chipLabel: 'Returned purchases',
    candidateTypes: ['partial_refund_match'],
    what: 'A credit that covers only PART of a purchase — a partial return, or a price adjustment.',
    after: 'The purchase starts showing its net cost: what you paid minus what came back. Nothing is deleted.',
  },
];

/** §4.5's new primary sort key — the index of a section in the list above. */
const SECTION_RANK = new Map(REVIEW_SECTIONS.map((s, i) => [s.id, i] as const));

const SECTION_OF_TYPE = new Map<CandidateType, SectionId>(
  REVIEW_SECTIONS.flatMap((s) => s.candidateTypes.map((t) => [t, s.id] as [CandidateType, SectionId]))
);

export const sectionOfCandidateType = (t: CandidateType): SectionId => SECTION_OF_TYPE.get(t) ?? 'refund_matches';

// ---------------------------------------------------------------------------
// The item
// ---------------------------------------------------------------------------

export interface ReviewQueueItem {
  key: string; // review record id (= transaction id) OR candidate identityKey OR group key
  source: 'transaction' | 'candidate' | 'group';
  sectionId: SectionId;
  transactionIds: string[]; // 1 for a transaction item, 2..13 for a candidate
  headline: string; // plain language, built locally from the ledger
  reasonCodes: string[];
  state: QueueState;
  rank: number; // QUEUE_STATES index — the §4.5 primary key, exposed for tests
  score: number;
  generatedAt: string;
  /** Present iff `source === 'candidate'`. The card renders from this. */
  candidate?: ReviewCandidate;
  /** Present iff `source === 'group'`. */
  group?: MappingGroup;
}

export interface QueueContext {
  transactions: readonly Transaction[];
  accounts: readonly PaymentAccount[];
  links: readonly TransactionLink[];
  candidates: readonly ReviewCandidate[];
  /** FIN-REVIEW-002's item source. Composes as one section; absent is fine. */
  inflowItems?: readonly InflowReviewItem[];
  estimates?: readonly DuplicateCostEstimate[];
  /**
   * MAP-001's item source. When present, a grouped row is asked ONCE as its group
   * instead of once per row — that is the entire point. Absent is fine and leaves the
   * queue exactly as it was.
   */
  groups?: readonly MappingGroup[];
}

const byId = (transactions: readonly Transaction[]) => new Map(transactions.map((t) => [t.id, t]));

const accountLabel = (accounts: readonly PaymentAccount[], accountId?: string): string => {
  const a = accounts.find((x) => x.id === accountId);
  if (!a) return 'an account';
  // The owner's own name for it, plus the MASKED tail. A full number never reaches here:
  // PaymentAccount stores four digits and nothing longer.
  return a.lastFourDigits ? `${a.name} ••${a.lastFourDigits}` : a.name;
};

export const maskedAccount = accountLabel;

/** The MERCHANT FAMILY — for a sentence about a merchant, not about one row. */
const merchantOf = (t: Transaction | undefined): string => (t ? t.merchant || t.title : 'this merchant');

/**
 * ONE ROW, named the way the owner would name it. Two Amazon purchases are both
 * "DEMO AMAZON"; only the title tells the lens from the filter, and an allocation card
 * that lists the same word twice is useless.
 */
export const rowLabel = (t: Transaction | undefined): string => (t ? t.title || t.merchant || t.id : 'that purchase');

const shortDate = (iso: string): string => {
  const d = new Date(`${day(iso)}T00:00:00Z`);
  return `${d.getUTCDate()} ${d.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })}`;
};

const money = formatMoneyCents;

// ---------------------------------------------------------------------------
// Plain language — §4 and the "Why?" line. Never a bare score (test C11).
// ---------------------------------------------------------------------------

/**
 * Reason CODES are stable ids; this is the only place they become English. A code with
 * no entry falls back to its own words with the underscores removed, so a new generator
 * code degrades to readable text instead of rendering `exact_amount` at the owner.
 */
export const REASON_TEXT: Record<string, string> = {
  exact_amount: 'the credit is exactly the amount of that purchase',
  partial_amount: 'the credit is part of that purchase',
  combined_amount: 'the amounts add up to this credit exactly',
  unexplained_credit: 'nothing in the data explains this credit yet',
  ambiguous_match: 'more than one purchase could be the answer',
  same_account: 'both are on the same card',
  different_account: 'they are on different accounts',
  same_day: 'both charges landed on the same day',
  next_day: 'the second charge landed the next day',
  repeat_pattern: 'this merchant charges you this amount regularly',
  overlapping_periods: 'both accounts were billed in the same months',
  alias_unconfirmed: 'the two merchant names have not been confirmed as one service',
  charge_after_cancellation: 'a charge posted after the date you said you cancelled',
  owner_confirmed_cancellation: 'you told us this was cancelled',
};

export const reasonText = (code: string): string => REASON_TEXT[code] ?? code.replace(/_/g, ' ');

/** "the amounts add up to this credit exactly, and both are on the same card." */
export function reasonSentence(reasonCodes: readonly string[]): string {
  const parts = reasonCodes.map(reasonText).filter(Boolean);
  if (!parts.length) return 'We have no evidence beyond the amounts.';
  const sentence = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

/** §4.2.1 — "Credit · $1,200.00 · 31 Jul · Demo Rewards Card ••9021". */
export const creditLine = (credit: Transaction, accounts: readonly PaymentAccount[]): string =>
  `Credit · ${money(toCents(credit.amount))} · ${shortDate(credit.date)} · ${accountLabel(accounts, credit.accountId)}`;

/** §4.2.3 — the remainder, ALWAYS, in words. */
export function remainderSentence(economics: RefundEconomics): string {
  if (economics.unallocatedRefundCents === 0) return 'nothing left over';
  if (economics.unallocatedRefundCents > 0) {
    return `${money(economics.unallocatedRefundCents)} of this credit is unaccounted for`;
  }
  return `${money(-economics.unallocatedRefundCents)} more than this credit has been allocated — needs review`;
}

/** The purchase side of the same sentence. */
export function unrefundedSentence(economics: PurchaseEconomics): string {
  if (economics.netEconomicCostCents <= 0) return 'nothing left over';
  return `${money(economics.netEconomicCostCents)} of this purchase is still unrefunded`;
}

/** §4.2.6 — a partial refund states the net, in one sentence. */
export const netCostSentence = (grossCents: number, refundedCents: number): string =>
  `You paid ${money(grossCents)}, got ${money(refundedCents)} back. Net cost ${money(grossCents - refundedCents)}.`;

/**
 * The headline the queue row shows. Built from the LOCAL ledger, never from a candidate
 * document — candidates deliberately carry no merchant string (FIN-RELATION-001 §4.4).
 */
export function headlineOf(candidate: ReviewCandidate, ctx: QueueContext): string {
  const index = byId(ctx.transactions);
  const rows = candidate.transactionIds.map((id) => index.get(id)).filter(Boolean) as Transaction[];
  const credit = rows.find((r) => interpretTransaction(r, ctx.accounts as PaymentAccount[]).direction === 'inflow');
  const merchant = merchantOf(credit ?? rows[0]);
  const amount = credit ? money(toCents(credit.amount)) : money(candidate.evidence.amountsCents[0] ?? 0);

  switch (candidate.candidateType) {
    case 'refund_match':
      return `${amount} back from ${merchant} — one purchase matches exactly`;
    case 'combined_refund_match':
      return `${amount} back from ${merchant} — ${candidate.proposedLinks.length} purchases add up to it`;
    case 'partial_refund_match':
      return `${amount} back from ${merchant} — part of one purchase`;
    case 'unknown_card_credit':
      return `${amount} arrived on your card from ${merchant} — we cannot explain it yet`;
    case 'immediate_duplicate_charge':
      return `${merchantOf(rows[0])} charged ${money(candidate.evidence.amountsCents[0] ?? 0)} twice`;
    case 'duplicate_subscription':
      return `${merchantOf(rows[0])} is billing two of your accounts`;
    case 'subscription_overlap':
      return `${merchantOf(rows[0])} looks like two overlapping subscriptions`;
    case 'continued_charge_after_cancellation':
      return `${merchantOf(rows[0])} charged you after you cancelled`;
  }
}

/**
 * A group's headline says how many rows one answer covers, because that number IS the
 * reason the owner should spend attention here rather than on the row below it.
 */
export const groupHeadline = (group: MappingGroup): string =>
  `${group.label} — ${group.rowCount} ${group.rowCount === 1 ? 'row' : 'rows'}, ${money(
    group.totalCents
  )}, one answer`;

const inflowHeadline = (item: InflowReviewItem, ctx: QueueContext): string => {
  const t = byId(ctx.transactions).get(item.transactionId);
  return `${money(item.amountCents)} arrived from ${merchantOf(t)} — we do not know what it is`;
};

// ---------------------------------------------------------------------------
// "Explain this" — the same question the owner would have had to type
// ---------------------------------------------------------------------------

/**
 * The choices the card for this item actually offers, word for word.
 *
 * The chat is grounded on the ledger, not on the UI, so it cannot name a button it has
 * never seen. Sending the real labels is the difference between "here are your options"
 * and a plausible invention.
 *
 * ponytail: the duplicate and refund lists are copied from those two cards' buttons and
 * can drift. Lift them into a shared list if a third surface ever needs them.
 */
export function optionLabels(item: ReviewQueueItem): string[] {
  if (item.source === 'group' && item.group) return groupMeanings(item.group.direction).map((m) => m.label);

  const type = item.candidate?.candidateType;
  if (item.source === 'transaction' || type === 'unknown_card_credit') return Object.values(CARD_CREDIT_MEANING);

  if (type === 'immediate_duplicate_charge' || type === 'duplicate_subscription'
    || type === 'subscription_overlap' || type === 'continued_charge_after_cancellation') {
    return ['Yes, a duplicate', 'Both intentional', 'Different owners', 'Business vs personal', 'Already cancelled', 'Dismiss'];
  }
  return ['Confirm links', 'Adjust allocation', 'Mark as reward', 'Mark as card payment', 'Mark as chargeback', 'Keep unclassified'];
}

/**
 * Everything the owner is looking at, phrased as a question — the rows, how often they
 * arrive, why the app flagged them, the exact options, and what the app says each answer
 * will do. Without the options and the after-effects the model would answer about the
 * money and stay silent on the decision, which is the half the owner was stuck on.
 */
export function askAboutItem(item: ReviewQueueItem, ctx: QueueContext): string {
  const index = byId(ctx.transactions);
  const rows = item.transactionIds.map((id) => index.get(id)).filter(Boolean) as Transaction[];
  const section = REVIEW_SECTIONS.find((s) => s.id === item.sectionId);
  const g = item.group;
  const shown = rows.slice(0, 8);

  const parts: (string | null)[] = [
    `My money review queue is asking me about this, under "${section?.label ?? 'review'}":`,
    item.headline,
    '',
    section ? `The app describes this kind of item as: ${section.what}` : null,
    g
      ? `This pattern is ${g.rowCount} ${g.rowCount === 1 ? 'row' : 'rows'} totalling ${money(g.totalCents)}, `
        + `${g.firstDate} to ${g.lastDate}${g.cadence ? `, arriving ${g.cadence}` : ''}, `
        + `${g.direction === 'inflow' ? 'money coming in' : 'money going out'}.`
      : null,
    g?.suggestion?.why ? `The app's own evidence: ${g.suggestion.why}.` : null,
    item.reasonCodes.length && !g ? `Why it was flagged: ${reasonSentence(item.reasonCodes)}` : null,
    shown.length ? '' : null,
    shown.length
      ? `The transactions${rows.length > shown.length ? ` (first ${shown.length} of ${rows.length})` : ''}:`
      : null,
    ...shown.map(
      (t) =>
        `- ${day(t.date)} · ${rowLabel(t)} · ${money(toCents(t.amount))}`
        + `${t.sourceCategory ? ` · my export files it as ${t.sourceCategory}` : ''}`
    ),
    '',
    `The options the app gives me are: ${optionLabels(item).map((o) => `"${o}"`).join(', ')}.`,
    section ? `The app says that after I answer: ${section.after}` : null,
    '',
    'Explain in plain English what this money most likely is, which option you would pick and why, '
      + 'and what will actually look different on my Dashboard and Flow once I answer. '
      + 'If you need something from me to be sure, ask me one question at a time.',
  ];

  return parts.filter((l) => l !== null).join('\n');
}

// ---------------------------------------------------------------------------
// Building the queue — §4.5's deterministic order
// ---------------------------------------------------------------------------

/**
 * SECTION first (see `REVIEW_SECTIONS` — money-weighted, not count-weighted), then
 * `needs_attention` → `unreviewed` → `suggested` → `needs_more_information`, then score
 * descending, then `generatedAt` ascending, then key ascending. Fully deterministic, so
 * the list cannot reshuffle between renders (test Q4).
 *
 * Section leads because state cannot see value: a $0.45 Amazon refund and a $120,562
 * pattern are both `unreviewed`, and sorting on state alone buried every decision worth
 * making under four hundred that were not.
 */
export function buildReviewQueue(ctx: QueueContext): ReviewQueueItem[] {
  const items: ReviewQueueItem[] = [];

  for (const candidate of ctx.candidates) {
    const state = queueStateOfCandidate(candidate.status);
    if (!state) continue; // terminal — a decision is never asked twice (test Q5)
    items.push({
      key: candidate.id,
      source: 'candidate',
      sectionId: sectionOfCandidateType(candidate.candidateType),
      transactionIds: candidate.transactionIds,
      headline: headlineOf(candidate, ctx),
      reasonCodes: candidate.evidence.reasonCodes ?? [],
      state,
      rank: QUEUE_STATES.indexOf(state),
      score: candidate.score,
      generatedAt: candidate.generatedAt,
      candidate,
    });
  }

  // MAP-001: a row that belongs to a group is asked as its GROUP, not on its own. This
  // is where 205 individual questions become the handful of patterns behind them.
  const grouped = new Set((ctx.groups ?? []).flatMap((g) => g.transactionIds));

  for (const group of ctx.groups ?? []) {
    items.push({
      key: group.key,
      source: 'group',
      sectionId: 'unmapped_groups',
      transactionIds: group.transactionIds,
      headline: groupHeadline(group),
      reasonCodes: group.suggestion ? [group.suggestion.evidence] : [],
      state: group.suggestion ? 'suggested' : 'unreviewed',
      rank: QUEUE_STATES.indexOf(group.suggestion ? 'suggested' : 'unreviewed'),
      // Impact ranks the groups against each other; normalised so it cannot outrank a
      // candidate's 0..1 score by sheer magnitude.
      score: Math.min(1, group.rowCount / 100),
      generatedAt: group.firstDate,
      group,
    });
  }

  for (const inflow of ctx.inflowItems ?? []) {
    if (grouped.has(inflow.transactionId)) continue;
    const state = queueStateOfReview(inflow.state);
    if (!state) continue;
    items.push({
      key: inflow.transactionId,
      source: 'transaction',
      sectionId: 'unknown_deposits',
      transactionIds: [inflow.transactionId],
      headline: inflowHeadline(inflow, ctx),
      reasonCodes: inflow.reasons,
      state,
      rank: QUEUE_STATES.indexOf(state),
      score: 0,
      generatedAt: inflow.date,
    });
  }

  return items.sort(
    (a, b) =>
      (SECTION_RANK.get(a.sectionId) ?? 0) - (SECTION_RANK.get(b.sectionId) ?? 0) ||
      a.rank - b.rank ||
      b.score - a.score ||
      a.generatedAt.localeCompare(b.generatedAt) ||
      a.key.localeCompare(b.key)
  );
}

export interface QueueCounts {
  total: number;
  bySection: Record<SectionId, number>;
}

export function queueCounts(items: readonly ReviewQueueItem[]): QueueCounts {
  const bySection = Object.fromEntries(REVIEW_SECTIONS.map((s) => [s.id, 0])) as Record<SectionId, number>;
  for (const item of items) bySection[item.sectionId] += 1;
  return { total: items.length, bySection };
}

/** §2.4 — announced, not merely painted. */
export const queueBadgeLabel = (count: number): string =>
  `Flow, ${count} item${count === 1 ? '' : 's'} to review`;

// ---------------------------------------------------------------------------
// §5 — transaction badges, DERIVED, never stored on the row
// ---------------------------------------------------------------------------

export type BadgeTone = 'neutral' | 'good' | 'warn';

export interface RelationBadge {
  /** Text plus icon, never colour alone (FIN-REVIEW-002.md:921). */
  text: string;
  icon: string;
  tone: BadgeTone;
}

export interface BadgeContext {
  links: readonly TransactionLink[];
  transactions: readonly Transaction[];
  accounts?: readonly PaymentAccount[];
  candidates?: readonly ReviewCandidate[];
}

/**
 * Every badge a row has earned. A badge is NEVER a claim the app cannot back:
 * "Returned" appears only when confirmed links sum exactly to the purchase, and a
 * provisional credit always carries the word "provisional" (FIN-REFUND-001 §6.1).
 */
export function relationBadges(t: Transaction, ctx: BadgeContext): RelationBadge[] {
  const badges: RelationBadge[] = [];
  const index = byId(ctx.transactions);
  const economics = purchaseEconomics(t, ctx.links);

  if (economics.confirmedRefundedCents > 0) {
    if (economics.status === 'fully_refunded') badges.push({ text: 'Returned', icon: '↩', tone: 'good' });
    else if (economics.status === 'partially_refunded') {
      badges.push({
        text: `Partly refunded · ${money(economics.netEconomicCostCents)} net`,
        icon: '↩',
        tone: 'good',
      });
    } else if (economics.status === 'over_refunded') {
      badges.push({ text: 'Over-refunded — needs review', icon: '⚠', tone: 'warn' });
    }
  }
  if (economics.provisionalRefundedCents > 0) {
    // Never on a netted figure: the amount above is gross − CONFIRMED only.
    badges.push({ text: 'Provisional dispute credit', icon: '⏳', tone: 'warn' });
  }

  // The credit side: what this row was allocated to.
  const allocatedTo = ctx.links.filter(
    (l) => l.sourceTransactionId === t.id && l.status === 'confirmed' && REFUND_SOURCE_TYPES.includes(l.linkType)
  );
  for (const l of allocatedTo) {
    const target = index.get(l.targetTransactionId);
    badges.push({
      text: `Refund of ${rowLabel(target)}${target ? `, ${shortDate(target.date)}` : ''}`,
      icon: '↩',
      tone: 'neutral',
    });
  }
  if (allocatedTo.length) {
    const credit = refundEconomics(t, ctx.links);
    if (credit.unallocatedRefundCents !== 0) {
      badges.push({ text: `Unallocated ${money(credit.unallocatedRefundCents)}`, icon: '•', tone: 'warn' });
    }
  }

  const duplicate = (ctx.candidates ?? []).some(
    (c) =>
      c.candidateType === 'immediate_duplicate_charge' &&
      !isTerminalCandidateStatus(c.status) &&
      c.transactionIds.includes(t.id)
  );
  if (duplicate) badges.push({ text: 'Possible duplicate', icon: '⧉', tone: 'warn' });

  if (interpretTransaction(t, ctx.accounts as PaymentAccount[] | undefined).pending === 'pending') {
    badges.push({ text: 'Pending', icon: '◷', tone: 'neutral' });
  }
  return badges;
}

/**
 * What a card credit MEANS, in the owner's words. Never a generic "income" label — that
 * is the product rule this whole programme exists to enforce.
 */
export const CARD_CREDIT_MEANING: Record<string, string> = {
  card_payment: 'Payment to this card — not income',
  merchant_refund: 'Refund of a purchase — not income',
  partial_refund: 'Partial refund — not income',
  statement_credit: 'Statement credit — not income',
  cashback_reward: 'Card reward — not income',
  promotional_credit: 'Promotional credit — not income',
  charge_reversal: 'Charge reversed — not income',
  chargeback_credit: 'Provisional dispute credit — not income',
  manual_adjustment: 'Manual adjustment — not income',
  unknown_card_credit: 'Unexplained card credit — not income until you say what it is',
};

// ---------------------------------------------------------------------------
// The owner's answer — the ONLY thing that ever reaches the store
// ---------------------------------------------------------------------------

export interface QueueAllocation {
  targetTransactionId: string;
  allocatedAmountCents: number;
}

/**
 * A decision is produced by a click and by nothing else. There is no confidence at which
 * one of these is constructed automatically, and no code path from a model reply to here
 * that does not pass through a button press.
 */
export interface RecoveryDecision {
  status: CandidateStatus;
  /** `intentional` / `different_owner` / `business` / `already_cancelled` / `accidental`. */
  reasonCode?: string;
  allocations?: QueueAllocation[];
  /** For a card credit the owner explains rather than allocates. */
  cardCreditKind?: string;
  /** A chargeback needs the purchase it disputes. */
  chargebackTargetId?: string;
  /** "I cancelled it on…" — persisted so `continued_charge_after_cancellation` can arm. */
  effectiveDate?: string;
}

// ---------------------------------------------------------------------------
// §7.1 — the confirmation gate's preview. Nothing applies before this is read.
// ---------------------------------------------------------------------------

export interface ConfirmationPreview {
  /** One line per allocation, with its target, in plain language. */
  whatChanges: string[];
  affectedCount: number;
  dateRange: string;
  moneyEffect: string;
  budgetEffect: string;
  forecastEffect: string;
  flowEffect: string;
  whatDoesNotChange: string;
  scope: string;
}

const CATEGORY_LABEL = new Map(EXPENSE_CATEGORIES.map((c) => [c.value, c.label]));

const monthName = (iso: string) =>
  new Date(`${day(iso)}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });

/**
 * What the owner is agreeing to, before Confirm is enabled: what changes, how many rows
 * are touched, over what dates, and the effect on budget, forecast and Flow — plus what
 * explicitly does NOT change. A duplicate confirmation changes no total at all.
 */
export function confirmationPreview(
  candidate: ReviewCandidate,
  allocations: readonly { targetTransactionId: string; allocatedAmountCents: number }[],
  ctx: QueueContext
): ConfirmationPreview {
  const index = byId(ctx.transactions);
  const rows = candidate.transactionIds.map((id) => index.get(id)).filter(Boolean) as Transaction[];
  const dates = rows.map((r) => day(r.date)).sort();
  const dateRange = dates.length
    ? dates[0] === dates[dates.length - 1]
      ? dates[0]
      : `${dates[0]} to ${dates[dates.length - 1]}`
    : 'no dated rows';

  const isDuplicate = candidate.proposedLinks.every((l) => l.linkType === 'duplicate_candidate' || l.linkType === 'subscription_overlap')
    && candidate.candidateType !== 'refund_match';

  const whatChanges = allocations.length
    ? allocations.map((a) => {
        const target = index.get(a.targetTransactionId);
        return `${money(a.allocatedAmountCents)} of this credit goes to ${rowLabel(target)}${target ? ` on ${day(target.date)}` : ''}`;
      })
    : ['Nothing is allocated. This records your answer and nothing else.'];

  const totalCents = allocations.reduce((s, a) => s + a.allocatedAmountCents, 0);

  // Budget effect, computed through the SAME helper the Budgets surface uses, with and
  // without the links this confirmation would write.
  const proposedLinks: TransactionLink[] = allocations.map((a) => ({
    id: `preview~${a.targetTransactionId}`,
    linkType: 'refund_of',
    sourceTransactionId: candidate.transactionIds[0],
    targetTransactionId: a.targetTransactionId,
    allocatedAmountCents: a.allocatedAmountCents,
    status: 'confirmed' as LinkStatus,
    algorithmVersion: candidate.algorithmVersion,
    confirmedAt: candidate.generatedAt,
    createdAt: candidate.generatedAt,
    updatedAt: candidate.generatedAt,
  }));

  let budgetEffect = 'No budget changes.';
  const purchase = allocations.length ? index.get(allocations[0].targetTransactionId) : undefined;
  if (purchase && totalCents > 0) {
    const month = new Date(`${day(purchase.date)}T00:00:00Z`);
    const accounts = ctx.accounts as PaymentAccount[];
    const before = getAllCategorySpending(ctx.transactions as Transaction[], month, accounts, ctx.links);
    const after = getAllCategorySpending(ctx.transactions as Transaction[], month, accounts, [...ctx.links, ...proposedLinks]);
    const category = purchase.category as ExpenseCategory;
    budgetEffect = `Your ${CATEGORY_LABEL.get(category) ?? category} total for ${monthName(purchase.date)} falls from ${money(
      Math.round(before[category] * 100)
    )} to ${money(Math.round(after[category] * 100))}.`;
  }

  return {
    whatChanges,
    affectedCount: candidate.transactionIds.length,
    dateRange,
    moneyEffect: isDuplicate || !allocations.length
      ? 'This changes no total. Both charges stay counted in your spending.'
      : `This marks ${money(totalCents)} of purchases as returned.`,
    budgetEffect,
    // Umbrella §10: a refund is never a recurring inflow, and a detected duplicate is
    // never a future saving. This programme adds no projection at all.
    forecastEffect: allocations.length
      ? 'Your forecast gains no income. A refund lowers what that category is expected to cost, nothing else.'
      : 'Your forecast does not change.',
    // §6 / FIN-REFUND-001 §7.1: no node, no edge, no conservation change.
    flowEffect: 'The flow diagram keeps the same boxes, the same ribbons and the same totals.',
    whatDoesNotChange: 'Both transactions stay in your history at their full amounts. Nothing is deleted.',
    scope: 'This candidate only. Confirming here creates no merchant rule and changes no other transaction.',
  };
}

// ---------------------------------------------------------------------------
// §4.3 — BOTH series, per account, never one collapsed row
// ---------------------------------------------------------------------------

export interface SeriesView {
  accountId?: string;
  accountLabel: string;
  amountCents: number; // median of that account's charges for this service
  firstSeen: string;
  lastSeen: string;
  chargeCount: number;
}

const median = (values: number[]): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
};

/**
 * A duplicate-subscription candidate stores only the two ANCHOR rows (the earliest charge
 * of each account's series), because a candidate document carries no merchant text. The
 * series either side of it is rebuilt from the local ledger here — one pass, on the same
 * `normalizeMerchant()` the detector grouped by.
 */
export function subscriptionSeries(candidate: ReviewCandidate, ctx: QueueContext): SeriesView[] {
  const index = byId(ctx.transactions);
  const anchors = candidate.transactionIds.map((id) => index.get(id)).filter(Boolean) as Transaction[];

  return anchors.map((anchor) => {
    const key = normalizeMerchant(anchor.merchant || anchor.title);
    const rows = ctx.transactions.filter(
      (t) => t.accountId === anchor.accountId && normalizeMerchant(t.merchant || t.title) === key
    );
    const dates = rows.map((r) => day(r.date)).sort();
    return {
      accountId: anchor.accountId,
      accountLabel: accountLabel(ctx.accounts, anchor.accountId),
      amountCents: median(rows.map((r) => toCents(r.amount))),
      firstSeen: dates[0] ?? day(anchor.date),
      lastSeen: dates[dates.length - 1] ?? day(anchor.date),
      chargeCount: rows.length,
    };
  });
}

/**
 * The shared decision-button class. 44px minimum touch target is the house standard
 * here and is NOT negotiable per card, so it lives in one string.
 */
export const ACTION_BTN =
  'min-h-[44px] min-w-[44px] px-3 py-2 rounded-lg text-sm border border-[var(--border-color)] ' +
  'text-[var(--foreground)] hover:bg-[var(--background-tertiary)] ' +
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)] ' +
  'disabled:opacity-40 disabled:cursor-not-allowed';

/**
 * §7.2 — re-allocating a credit SUPERSEDES the allocation it replaces. Nothing is ever
 * deleted: `firestore.rules` denies delete on links, and a superseded row is the audit
 * trail that says what the answer used to be.
 *
 * A link id is derived from `linkType~source~target`, so changing the AMOUNT on the same
 * pair is an upsert against one document and needs no supersede. Only a changed TARGET
 * mints a second document, and that is the case this handles.
 */
export function supersededLinks(
  links: readonly TransactionLink[],
  creditTransactionId: string,
  keptTargetIds: ReadonlySet<string>,
  replacementLinkId: string,
  at: string
): TransactionLink[] {
  return links
    .filter(
      (l) =>
        l.status === 'confirmed' &&
        l.sourceTransactionId === creditTransactionId &&
        !keptTargetIds.has(l.targetTransactionId)
    )
    .map((l) => ({ ...l, status: 'superseded' as LinkStatus, supersededByLinkId: replacementLinkId, updatedAt: at }));
}

/** §6 — gross and net side by side, ALWAYS. A net-only figure is unauditable. */
export const grossAndNet = (grossCents: number, netCents: number): string =>
  `${money(grossCents)} gross · ${money(netCents)} after refunds`;

/** Panel header totals, reported separately and NEVER summed together (§6). */
export function recoveryTotals(ctx: QueueContext): { returnedCents: number; matchedCount: number; potentialAnnualDuplicateCostCents: number } {
  const confirmed = ctx.links.filter((l) => l.status === 'confirmed' && REFUND_SOURCE_TYPES.includes(l.linkType));
  const openKeys = new Set(ctx.candidates.filter((c) => !isTerminalCandidateStatus(c.status)).map((c) => c.id));
  return {
    returnedCents: confirmed.reduce((s, l) => s + l.allocatedAmountCents, 0),
    matchedCount: new Set(confirmed.map((l) => l.sourceTransactionId)).size,
    potentialAnnualDuplicateCostCents: (ctx.estimates ?? [])
      .filter((e) => openKeys.has(e.identityKey))
      .reduce((s, e) => s + e.potentialAnnualDuplicateCostCents, 0),
  };
}
