/**
 * Review candidates — a deterministic, UNAPPLIED proposal produced by application code,
 * carrying a stable identity so a decision the owner has already made is never asked
 * again.
 *
 * A candidate is a question about an ALERT, never a statement about money. Nothing here
 * has a field that could change an amount: marking a duplicate `intentional` silences
 * the question and leaves both transactions fully-counted expenses.
 *
 * PURE module — no Firestore, no React. FIN-REFUND-001 and FIN-DUPLICATE-001 are the
 * generators that emit these; FIN-RELATION-001 owns the shape, the identity and the
 * suppression rule.
 */

import { AccountType } from '@/types';
import { RecurringItem } from './flows';
import { ID_SEPARATOR, LinkType } from './relations';

export const CANDIDATE_TYPES = [
  'refund_match',
  'combined_refund_match',
  'partial_refund_match',
  'unknown_card_credit',
  'immediate_duplicate_charge',
  'duplicate_subscription',
  'subscription_overlap',
  'continued_charge_after_cancellation',
] as const;

export type CandidateType = (typeof CANDIDATE_TYPES)[number];

export const CANDIDATE_STATUSES = [
  'unreviewed', // generated, never looked at
  'suggested', // the UI or an AI turn surfaced a specific proposal
  'confirmed', // the owner accepted it; links were written
  'dismissed', // the owner refused it; never regenerate
  'intentional', // real, deliberate, and not a problem (two accounts on purpose)
  'needs_more_information', // the owner cannot decide yet; stays in the queue, ranked last
] as const;

export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

/**
 * A decision the owner has made. Terminal candidates are never rewritten, never
 * re-scored and never re-ranked — that is the one rule that makes the queue trustworthy.
 */
export const TERMINAL_CANDIDATE_STATUSES: readonly CandidateStatus[] = ['confirmed', 'dismissed', 'intentional'];

export const isTerminalCandidateStatus = (s: CandidateStatus): boolean => TERMINAL_CANDIDATE_STATUSES.includes(s);

/** 12 candidate purchases + 1 credit. Asserted, not assumed — see buildIdentityKey. */
export const MAX_CANDIDATE_TRANSACTIONS = 13;
export const MAX_PROPOSED_LINKS = 12;

export interface ProposedLink {
  linkType: LinkType;
  sourceTransactionId: string;
  targetTransactionId: string;
  allocatedAmountCents: number; // integer, > 0
}

/**
 * Structured, safe, no raw text. No merchant strings, titles, descriptions, account
 * names or lastFourDigits — the UI renders merchant text by looking the transaction up
 * locally. That is what makes this collection safe to count in a diagnostics bundle and
 * what stops it becoming a shadow copy of the ledger.
 */
export interface CandidateEvidence {
  amountsCents: number[];
  dayGaps: number[];
  sameAccount: boolean;
  accountTypes: AccountType[];
  merchantMatch: 'exact' | 'family' | 'alias' | 'none';
  referenceOverlap: 'strong' | 'weak' | 'none';
  cadence?: RecurringItem['cadence'];
  overlappingPeriods?: number;
  pendingInvolved: boolean;
  reasonCodes: string[]; // stable ids, e.g. 'exact_amount', 'different_account'
}

export const EVIDENCE_KEYS = [
  'amountsCents',
  'dayGaps',
  'sameAccount',
  'accountTypes',
  'merchantMatch',
  'referenceOverlap',
  'cadence',
  'overlappingPeriods',
  'pendingInvolved',
  'reasonCodes',
] as const;

export interface ReviewCandidate {
  id: string; // = identityKey, the Firestore doc id
  candidateId: string; // type + version + ids — the audit form
  candidateType: CandidateType;
  algorithmVersion: string;
  transactionIds: string[]; // SORTED ascending, 2..13 entries
  status: CandidateStatus;
  proposedLinks: ProposedLink[]; // never written to the link collection until confirmed
  evidence: CandidateEvidence;
  score: number; // 0..1, an explainable ladder — never a model output
  generatedAt: string; // ISO-8601
  reviewedAt?: string;
  reviewedBy?: 'user';
  linkIds?: string[]; // written on confirmation, for undo and audit
}

// ---------------------------------------------------------------------------
// Identity — two parts, because one string cannot satisfy both requirements
// ---------------------------------------------------------------------------

/** Sorted ascending, deduplicated, bounded, and free of the separator. Throws otherwise. */
export function sortedTransactionIds(ids: readonly string[]): string[] {
  const unique = [...new Set(ids)].sort();
  if (unique.length < 2) throw new Error('candidate identity: at least 2 transaction ids are required');
  if (unique.length > MAX_CANDIDATE_TRANSACTIONS) {
    throw new Error(`candidate identity: at most ${MAX_CANDIDATE_TRANSACTIONS} transaction ids, got ${unique.length}`);
  }
  for (const id of unique) {
    if (!id) throw new Error('candidate identity: an empty transaction id');
    if (id.includes(ID_SEPARATOR)) {
      throw new Error(`candidate identity: transaction id ${JSON.stringify(id)} contains the "${ID_SEPARATOR}" separator`);
    }
  }
  return unique;
}

/**
 * THE DOCUMENT ID. It omits the algorithm version on purpose.
 *
 * The original brief asked for an id derived from "candidate type + sorted transaction
 * ids + algorithm version, so a dismissed candidate cannot resurface". Taken literally
 * those clauses contradict each other: with the version in the doc id, bumping
 * refund-match-v1 -> v2 mints a NEW id, the dismissal stays on the old one, and every
 * dismissed candidate resurfaces on the next release — the exact failure the requirement
 * exists to prevent.
 *
 * So the decision attaches to THE RELATIONSHIP BETWEEN THESE ROWS, which is what the
 * owner actually decided about, and the version lives in `candidateId` for audit.
 */
export function buildIdentityKey(candidateType: CandidateType, transactionIds: readonly string[]): string {
  return [candidateType, ...sortedTransactionIds(transactionIds)].join(ID_SEPARATOR);
}

/** The audit form: which generator version produced this instance. A field, not the id. */
export function buildCandidateId(
  candidateType: CandidateType,
  algorithmVersion: string,
  transactionIds: readonly string[]
): string {
  if (!algorithmVersion || algorithmVersion.includes(ID_SEPARATOR)) {
    throw new Error(`candidate identity: bad algorithmVersion ${JSON.stringify(algorithmVersion)}`);
  }
  return [candidateType, algorithmVersion, ...sortedTransactionIds(transactionIds)].join(ID_SEPARATOR);
}

// ---------------------------------------------------------------------------
// Suppression and version bumps
// ---------------------------------------------------------------------------

export interface CandidateRunResult {
  /** Documents to write: new candidates, plus re-evaluated `unreviewed` ones. */
  writes: ReviewCandidate[];
  /** Stored candidates left exactly as they are, algorithmVersion included. */
  unchanged: ReviewCandidate[];
  /** identityKeys dropped because the owner's decision is terminal. */
  suppressed: string[];
}

/**
 * Reconcile one generator run against what is already stored.
 *
 * - terminal (confirmed | dismissed | intentional) -> suppressed forever, including
 *   across an algorithm version bump, because the doc id carries no version;
 * - stored and `unreviewed` -> re-evaluated: the new version and score are written;
 * - stored and anything else (suggested | needs_more_information) -> untouched. They
 *   stay in the queue but a version bump never rewrites them, so the stored
 *   `algorithmVersion` keeps recording the instance the owner actually saw;
 * - never seen -> written as new.
 *
 * A version bump is therefore incapable of reinterpreting a decision.
 */
export function mergeCandidateRun(
  generated: readonly ReviewCandidate[],
  stored: readonly ReviewCandidate[]
): CandidateRunResult {
  const byKey = new Map(stored.map((c) => [c.id, c]));
  const result: CandidateRunResult = { writes: [], unchanged: [], suppressed: [] };

  for (const candidate of generated) {
    const existing = byKey.get(candidate.id);
    if (!existing) {
      result.writes.push(candidate);
      continue;
    }
    if (isTerminalCandidateStatus(existing.status)) {
      result.suppressed.push(existing.id);
      result.unchanged.push(existing);
      continue;
    }
    if (existing.status === 'unreviewed') {
      result.writes.push({ ...candidate, status: 'unreviewed' });
      continue;
    }
    result.unchanged.push(existing);
  }
  return result;
}

/**
 * Score descending, then generatedAt ascending, then id ascending — so list order never
 * depends on Firestore's return order and two runs always agree.
 */
export function rankCandidates(candidates: readonly ReviewCandidate[]): ReviewCandidate[] {
  return [...candidates].sort(
    (a, b) => b.score - a.score || a.generatedAt.localeCompare(b.generatedAt) || a.id.localeCompare(b.id)
  );
}

/**
 * Drop anything that is not a declared evidence key. The TYPE already forbids free text;
 * this is the runtime half, because a generator that spreads its working object into
 * `evidence` would otherwise ship merchant strings into a collection that is safe to
 * count precisely because it has none.
 */
export function sanitizeEvidence(evidence: unknown): CandidateEvidence {
  const raw = (evidence ?? {}) as Record<string, unknown>;
  const clean: Record<string, unknown> = {};
  for (const key of EVIDENCE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(raw, key) && raw[key] !== undefined) clean[key] = raw[key];
  }
  return clean as unknown as CandidateEvidence;
}
