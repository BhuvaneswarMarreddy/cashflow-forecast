/**
 * Transaction links — the auditable, integer-cent statement that row A does something
 * to row B: this credit refunds that purchase, this bank debit settles that card
 * statement, this charge duplicates that one.
 *
 * Everything here is integer CENTS, like src/lib/flows.ts. `4120`, never `41.2` —
 * `41.20 * 100` is `4119.999999999999` and that is how a ledger drifts.
 *
 * This module is PURE: no Firestore, no React, no I/O. Persistence lives in
 * src/lib/relations-store.ts, which calls the same validator. A link points AT rows;
 * it never restates them, so no merchant, description, amount-in-dollars or provider
 * payload appears on a link. Raw transactions are never modified by anything here.
 *
 * FIN-RELATION-001 owns this file. FIN-REFUND-001, FIN-DUPLICATE-001 and
 * FIN-REVIEW-002 consume it and define no second link model.
 */

import { Transaction } from '@/types';
import { toCents } from './flows';
import { emit } from './obs/events';

// ---------------------------------------------------------------------------
// The closed sets
// ---------------------------------------------------------------------------

export const LINK_TYPES = [
  'refund_of', // credit reverses a specific purchase, in full
  'partial_refund_of', // credit reverses part of a specific purchase
  'reversal_of', // merchant/processor voided its own charge
  'chargeback_for', // disputed charge; outcome not final
  'card_payment_pair', // bank debit settles a card statement credit
  'reimbursement_for', // inbound share against a shared/reimbursable expense
  'repayment_of', // inbound against money previously lent
  'duplicate_candidate', // two real posted charges for one economic event
  'subscription_overlap', // two live subscriptions to one service family
] as const;

/**
 * `internal_transfer_leg` is deliberately NOT a link type.
 *
 * matchTransfers() (src/lib/transfers.ts:56) pairs both legs live from the current
 * transaction set and self-updates on every re-import; pairedLegId() already answers
 * "what is the other leg of this row". Storing that as a link would create a second,
 * staler source of truth for a fact the deterministic code recomputes for free — and a
 * stale money fact is worse than no stored fact. FIN-REVIEW-002 §9.3 relies on the live
 * pairer too, so nothing needs the stored form.
 */
export type LinkType = (typeof LINK_TYPES)[number];

export const LINK_STATUSES = [
  'suggested', // system proposed it; affects no displayed number
  'confirmed', // the owner accepted it; the only status that changes money
  'rejected', // the owner refused it; suppresses regeneration
  'superseded', // replaced by a later link over the same pair
  'provisional', // real but not final — dispute credits only
] as const;

export type LinkStatus = (typeof LINK_STATUSES)[number];

/** Link types whose SOURCE is a credit being allocated out (V4's scope). */
export const REFUND_SOURCE_TYPES: readonly LinkType[] = [
  'refund_of',
  'partial_refund_of',
  'reversal_of',
  'chargeback_for',
];

/**
 * The ten card-credit kinds, declared here rather than in FIN-REFUND-001's
 * src/lib/card-credit.ts because FIN-RELATION-001 merges FIRST and owns the parser that
 * has to validate them (§7.4/P11). FIN-REFUND-001 imports this list and derives
 * `CardCreditKind` from it — it must not declare a second copy.
 */
export const CARD_CREDIT_KINDS = [
  'card_payment',
  'merchant_refund',
  'partial_refund',
  'statement_credit',
  'cashback_reward',
  'promotional_credit',
  'charge_reversal',
  'chargeback_credit',
  'manual_adjustment',
  'unknown_card_credit',
] as const;

export type CardCreditKind = (typeof CARD_CREDIT_KINDS)[number];

/** Explicit, named conflict states. Nothing is EVER silently clamped. */
export type ConflictState = 'over_allocated_credit' | 'over_refunded';

export interface TransactionLink {
  id: string; // deterministic, = the Firestore doc id
  linkType: LinkType;
  sourceTransactionId: string; // the row that ACTS (the credit, the debit, the later charge)
  targetTransactionId: string; // the row acted UPON (the purchase, the statement, the earlier charge)
  allocatedAmountCents: number; // INTEGER CENTS, strictly > 0
  status: LinkStatus;
  algorithmVersion: string;
  candidateId?: string; // the ReviewCandidate this came from, for audit
  confirmedAt?: string; // ISO-8601, present iff status is confirmed | provisional
  confirmedBy?: 'user' | 'system'; // 'system' ONLY for card_payment_pair
  supersededByLinkId?: string;
  note?: string; // the owner's own words
  createdAt: string; // ISO-8601
  updatedAt: string; // ISO-8601
}

export const NOTE_MAX = 280;

// ---------------------------------------------------------------------------
// Ids — composed, never hashed
// ---------------------------------------------------------------------------

export const ID_SEPARATOR = '~';

/**
 * `linkType~source~target`. Composed, never hashed: a hash buys nothing here and costs
 * collision risk on money. Re-proposing the same relation writes the same document, so
 * idempotency is free and there is no dedupe pass — there is nothing to dedupe.
 *
 * Throws rather than emitting an ambiguous id, and never falls back to a hash. `~`
 * satisfies Firestore's doc-id constraints (no `/`, not `.`/`..`, not `__.*__`) and
 * appears in no id this app produces (`sf_<id>`, `pending_<id>`, 20-char auto-ids).
 */
export function buildLinkId(linkType: LinkType, sourceTransactionId: string, targetTransactionId: string): string {
  for (const id of [sourceTransactionId, targetTransactionId]) {
    if (!id) throw new Error('link id: a transaction id is required');
    if (id.includes(ID_SEPARATOR)) {
      throw new Error(`link id: transaction id ${JSON.stringify(id)} contains the "${ID_SEPARATOR}" separator`);
    }
  }
  return [linkType, sourceTransactionId, targetTransactionId].join(ID_SEPARATOR);
}

/**
 * `duplicate_candidate` and `subscription_overlap` are symmetric relations forced into
 * an ordered pair so the id above is unique: the LATER-dated row is the source, and a
 * same-date tie breaks on the lexicographically greater id. Order-independent by
 * construction, so both discovery orders give the same answer.
 */
export function orderSymmetricPair(
  a: { id: string; date: string },
  b: { id: string; date: string }
): { sourceTransactionId: string; targetTransactionId: string } {
  const later = a.date === b.date ? (a.id > b.id ? a : b) : a.date > b.date ? a : b;
  const earlier = later === a ? b : a;
  return { sourceTransactionId: later.id, targetTransactionId: earlier.id };
}

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------

const TRANSITIONS: Record<LinkStatus, readonly LinkStatus[]> = {
  suggested: ['confirmed', 'rejected', 'provisional'],
  provisional: ['confirmed', 'rejected'],
  confirmed: ['superseded', 'rejected'],
  rejected: ['suggested'], // ONLY by explicit owner re-open
  superseded: [], // terminal
};

export const canTransition = (from: LinkStatus, to: LinkStatus): boolean =>
  (TRANSITIONS[from] ?? []).includes(to);

// ---------------------------------------------------------------------------
// Allocation totals — CONFIRMED links only
// ---------------------------------------------------------------------------

/**
 * A `suggested` link contributes to no total. That is the mechanical form of "nothing
 * applies before confirmation": the arithmetic literally cannot see an unconfirmed
 * proposal. `provisional` does not count either — a dispute credit reduces nothing
 * until it resolves.
 */
export function confirmedAllocatedFromSource(
  links: readonly TransactionLink[],
  sourceTransactionId: string,
  types: readonly LinkType[] = REFUND_SOURCE_TYPES
): number {
  return links.reduce(
    (sum, l) =>
      l.status === 'confirmed' && l.sourceTransactionId === sourceTransactionId && types.includes(l.linkType)
        ? sum + l.allocatedAmountCents
        : sum,
    0
  );
}

export function confirmedAllocatedAgainstTarget(
  links: readonly TransactionLink[],
  targetTransactionId: string
): number {
  return links.reduce(
    (sum, l) => (l.status === 'confirmed' && l.targetTransactionId === targetTransactionId ? sum + l.allocatedAmountCents : sum),
    0
  );
}

/**
 * `Map<transactionId, links>` keyed on BOTH endpoints, built in one O(L) pass, so
 * "is this row refunded?" is O(1) instead of a scan per render (§10).
 */
export function linkIndex(links: readonly TransactionLink[]): Map<string, TransactionLink[]> {
  const index = new Map<string, TransactionLink[]>();
  const push = (key: string, link: TransactionLink) => {
    const bucket = index.get(key);
    if (bucket) bucket.push(link);
    else index.set(key, [link]);
  };
  for (const link of links) {
    push(link.sourceTransactionId, link);
    push(link.targetTransactionId, link);
  }
  return index;
}

// ---------------------------------------------------------------------------
// Validation — V1..V11
// ---------------------------------------------------------------------------

/** A transaction reduced to what allocation arithmetic needs. Nothing else travels. */
export interface TxRef {
  id: string;
  amountCents: number;
  currency?: string;
}

export const toTxRef = (t: Transaction): TxRef => ({ id: t.id, amountCents: toCents(t.amount) });

export interface LinkDraft {
  id?: string; // set when re-validating an existing link, so it is excluded from the sums
  linkType: LinkType;
  sourceTransactionId: string;
  targetTransactionId: string;
  allocatedAmountCents: number;
  status: LinkStatus;
  algorithmVersion: string;
  candidateId?: string;
  confirmedAt?: string;
  confirmedBy?: 'user' | 'system';
  supersededByLinkId?: string;
  note?: string;
}

export interface LinkValidationContext {
  transactions: readonly TxRef[] | Map<string, TxRef>;
  /** Links already stored, for the V4/V5 cross-document sums. */
  links?: readonly TransactionLink[];
  /** Explicit, named conflict states the caller is knowingly accepting. */
  allow?: readonly ConflictState[];
}

/**
 * V11 is additive to the spec's V1–V10: the note-length cap. It is a shape rule, not a
 * money rule, and is numbered rather than folded into V7 so a rejection reason stays
 * legible in telemetry.
 */
export type RuleId = 'V1' | 'V2' | 'V3' | 'V4' | 'V5' | 'V7' | 'V8' | 'V10' | 'V11';

export type ValidationResult = { ok: true } | { ok: false; ruleId: RuleId };

const asMap = (t: LinkValidationContext['transactions']): Map<string, TxRef> =>
  t instanceof Map ? t : new Map(t.map((r) => [r.id, r]));

function reject(ruleId: RuleId): ValidationResult {
  // The reason CODE, never the payload. See docs/observability/ADDING-A-TRACEABLE-FLOW.md.
  emit({
    eventName: 'Relation.ValidationRejected',
    eventCategory: 'activity',
    severity: 'warn',
    traceId: '',
    component: 'RecoveryRelations',
    resultStatus: 'error',
    metadata: { ruleId },
  });
  return { ok: false, ruleId };
}

/**
 * Every rule, and what happens when it fails. Nothing is ever silently clamped: an
 * over-allocation is rejected with a stated reason, or stored under an explicit named
 * conflict state that surfaces for review.
 */
export function validateLink(draft: LinkDraft, ctx: LinkValidationContext): ValidationResult {
  const transactions = asMap(ctx.transactions);
  const links = ctx.links ?? [];
  const allow = ctx.allow ?? [];

  // V1 — integer cents, strictly positive. Floats, 0, negatives, NaN, Infinity all out.
  if (!Number.isInteger(draft.allocatedAmountCents) || draft.allocatedAmountCents <= 0) return reject('V1');

  // V2 — no self-link. The cheapest correctness rule there is.
  if (draft.sourceTransactionId === draft.targetTransactionId) return reject('V2');

  // V3 — both endpoints resolve in the caller's current ledger.
  const source = transactions.get(draft.sourceTransactionId);
  const target = transactions.get(draft.targetTransactionId);
  if (!source || !target) return reject('V3');

  // V10 — single currency. A cross-currency link is unvalidatable, never silently summed.
  if ((source.currency ?? null) !== (target.currency ?? null)) return reject('V10');

  // V7 — closed sets, plus the two structural rules that ride with status.
  if (!LINK_TYPES.includes(draft.linkType)) return reject('V7');
  if (!LINK_STATUSES.includes(draft.status)) return reject('V7');
  // §3.5: exactly one system-confirmable link type. There is no confidence threshold at
  // which the system confirms a refund, a duplicate or a chargeback.
  if (draft.confirmedBy === 'system' && draft.linkType !== 'card_payment_pair') return reject('V7');
  if (draft.status === 'superseded' && !links.some((l) => l.id === draft.supersededByLinkId)) return reject('V7');

  // V8 — confirmedAt present iff confirmed | provisional.
  const wantsConfirmedAt = draft.status === 'confirmed' || draft.status === 'provisional';
  if (wantsConfirmedAt !== Boolean(draft.confirmedAt)) return reject('V8');

  // V11 — the owner's own words, bounded.
  if (draft.note !== undefined && draft.note.length > NOTE_MAX) return reject('V11');

  // V4/V5 apply to what this draft would ADD to a confirmed total, so they only bite
  // when the draft is itself confirmed. V6 (under-allocation) is allowed and needs no
  // rule: nothing pads a partial refund to full.
  if (draft.status === 'confirmed') {
    const others = links.filter((l) => l.id !== (draft.id ?? buildLinkId(draft.linkType, draft.sourceTransactionId, draft.targetTransactionId)));

    // V5 — purchase side: Σ confirmed against this target ≤ the target's cents.
    if (
      !allow.includes('over_refunded') &&
      confirmedAllocatedAgainstTarget(others, draft.targetTransactionId) + draft.allocatedAmountCents > target.amountCents
    ) {
      return reject('V5');
    }

    // V4 — credit side: Σ confirmed out of this credit ≤ the credit's cents.
    if (
      REFUND_SOURCE_TYPES.includes(draft.linkType) &&
      !allow.includes('over_allocated_credit') &&
      confirmedAllocatedFromSource(others, draft.sourceTransactionId) + draft.allocatedAmountCents > source.amountCents
    ) {
      return reject('V4');
    }
  }

  return { ok: true };
}

/**
 * Validate, then compose the stored document. The id is derived, so calling this twice
 * with the same relation is an upsert against one document, not a second row.
 *
 * V9 lives in the absence of code: nothing here or in the store deletes a link, and
 * firestore.rules denies delete outright. A rejected link IS the suppression record —
 * deleting it makes the same suggestion come back.
 */
export function buildLink(
  input: LinkDraft & { createdAt?: string; updatedAt?: string },
  ctx: LinkValidationContext
): { ok: true; link: TransactionLink } | { ok: false; ruleId: RuleId } {
  const check = validateLink(input, ctx);
  if (!check.ok) return check;

  const now = new Date().toISOString();
  const link: TransactionLink = {
    id: buildLinkId(input.linkType, input.sourceTransactionId, input.targetTransactionId),
    linkType: input.linkType,
    sourceTransactionId: input.sourceTransactionId,
    targetTransactionId: input.targetTransactionId,
    allocatedAmountCents: input.allocatedAmountCents,
    status: input.status,
    algorithmVersion: input.algorithmVersion,
    ...(input.candidateId ? { candidateId: input.candidateId } : {}),
    ...(input.confirmedAt ? { confirmedAt: input.confirmedAt } : {}),
    ...(input.confirmedBy ? { confirmedBy: input.confirmedBy } : {}),
    ...(input.supersededByLinkId ? { supersededByLinkId: input.supersededByLinkId } : {}),
    ...(input.note ? { note: input.note } : {}),
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  };
  return { ok: true, link };
}
