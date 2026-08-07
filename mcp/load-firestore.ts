/**
 * Live Firestore -> Ledger. The read path, and only the read path.
 *
 * READ-ONLY BY CONSTRUCTION, in the order that actually matters:
 *
 *  1. IAM. The Admin SDK BYPASSES firestore.rules entirely, so nothing in this repo
 *     can stop a key that has write permission. The guarantee is the service account
 *     itself: roles/datastore.viewer and nothing more (see mcp/README.md).
 *  2. This file names no write API — no document reference is ever created, only
 *     collection reads, so there is nothing here to call a mutation on.
 *  3. Four literal collection paths, hard-coded. No function takes a collection name,
 *     so there is no code path to any other document in the user's tree — notably the
 *     sync-metadata document that stores a credential-bearing provider URL.
 *
 * Documents cross the boundary through an explicit field whitelist: the mappers build
 * a fresh object out of named fields, so an unknown field is dropped by construction
 * rather than filtered out afterwards. They are pure and exported for exactly that
 * reason — server.check.ts exercises them on fake documents, since this server has no
 * live project to test against.
 */
import {
  EXPENSE_CATEGORIES, ExpenseCategory, IncomeSource, InflowReview, InflowReviewState,
  PAYMENT_METHODS, PaymentAccount, PaymentMethod, Transaction, isFinancialMeaning,
} from '@/types';
import { Ledger } from './load';

/** A Firestore QueryDocumentSnapshot narrowed to what a mapper is allowed to touch. */
export interface DocLike {
  id: string;
  data(): unknown;
}

const fields = (doc: DocLike): Record<string, unknown> => (doc.data() ?? {}) as Record<string, unknown>;

/**
 * Firestore Timestamp -> ISO string, the same conversion getTransactions() does.
 * Duck-typed on toDate() rather than `instanceof Timestamp`: a row hand-entered in the
 * app stores its date as a plain ISO string and must survive unchanged, and the check
 * has to work on a fake document too. A date that is neither reads as '' — every
 * consumer slices a day out of it, and '' sorts out of the way instead of throwing.
 */
const isoDate = (v: unknown): string => {
  const ts = v as { toDate?: () => Date } | null | undefined;
  if (typeof ts?.toDate === 'function') return ts.toDate().toISOString();
  return typeof v === 'string' ? v : '';
};

/** Never NaN: one malformed amount would otherwise poison every total downstream. */
const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
const optNum = (v: unknown): number | undefined => (v === undefined || v === null ? undefined : num(v));
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const optStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const strList = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;

/** Closed sets are validated, not cast: a value outside the set becomes the fallback. */
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  (allowed as readonly string[]).includes(v as string) ? (v as T) : fallback;

const CATEGORIES: ExpenseCategory[] = EXPENSE_CATEGORIES.map((c) => c.value);
const METHODS: PaymentMethod[] = PAYMENT_METHODS.map((m) => m.value);
const REVIEW_STATES: InflowReviewState[] = ['unreviewed', 'suggested', 'confirmed', 'dismissed', 'needs_attention'];

// ---------------------------------------------------------------------------
// The whitelists. Every field the MCP tools read, and nothing else — an ingest
// fingerprint, an owner's free-text review explanation and every provider id stay in
// Firestore because no line below names them.
// ---------------------------------------------------------------------------

export function mapTransaction(doc: DocLike): Transaction {
  const d = fields(doc);
  return {
    id: doc.id,
    // provenance: which ingest paths wrote this row (audit reads it)
    sources: Array.isArray(d.sources) ? (d.sources as string[]) : undefined,
    title: str(d.title),
    amount: num(d.amount),
    type: oneOf(d.type, ['expense', 'income', 'transfer'] as const, 'expense'),
    category: oneOf(d.category, CATEGORIES, 'other'),
    paymentMethod: oneOf(d.paymentMethod, METHODS, 'other'),
    accountId: optStr(d.accountId),
    date: isoDate(d.date),
    description: optStr(d.description),
    merchant: optStr(d.merchant),
    sourceCategory: optStr(d.sourceCategory),
    transferDirection: d.transferDirection === 'in' || d.transferDirection === 'out' ? d.transferDirection : undefined,
    pending: d.pending === true,
  };
}

export function mapAccount(doc: DocLike): PaymentAccount {
  const d = fields(doc);
  return {
    id: doc.id,
    name: str(d.name),
    type: oneOf(d.type, ['credit_card', 'debit_card', 'bank_account', 'cash', 'personal_loan'] as const, 'bank_account'),
    provider: oneOf(d.provider, METHODS, 'other'),
    color: str(d.color) || '#000',
    // Absent reads as active, matching the app: only an explicit false deactivates.
    isActive: d.isActive !== false,
    openingBalance: num(d.openingBalance),
    openingDate: isoDate(d.openingDate) || '2000-01-01',
    lastFourDigits: optStr(d.lastFourDigits),
  };
}

export function mapIncomeSource(doc: DocLike): IncomeSource {
  const d = fields(doc);
  return {
    id: doc.id,
    name: str(d.name),
    amount: num(d.amount),
    frequency: oneOf(d.frequency, ['weekly', 'biweekly', 'monthly', 'yearly'] as const, 'monthly'),
    isActive: d.isActive !== false,
    // `userApproved` absent = approved (the owner typed it in), so only an explicit
    // false may be carried across — undefined and false are different answers here.
    userApproved: d.userApproved === false ? false : undefined,
    matchAliases: strList(d.matchAliases),
    depositAccountIds: strList(d.depositAccountIds),
    amountToleranceCents: optNum(d.amountToleranceCents),
  };
}

/** The doc id IS the transaction id, exactly as getInflowReviews() reads it. */
export function mapReview(doc: DocLike): InflowReview {
  const d = fields(doc);
  return {
    transactionId: doc.id,
    state: oneOf(d.state, REVIEW_STATES, 'unreviewed'),
    meaning: isFinancialMeaning(d.meaning) ? d.meaning : undefined,
    incomeSourceId: optStr(d.incomeSourceId),
    reasons: strList(d.reasons),
    confirmedAt: optStr(d.confirmedAt),
    updatedAt: str(d.updatedAt),
    source: d.source === 'system' ? 'system' : 'user',
  };
}

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

export async function loadFromFirestore(): Promise<Ledger> {
  const keyPath = process.env.CASHFLOW_FIRESTORE_KEY;
  const uid = process.env.CASHFLOW_FIRESTORE_UID;
  // Unreachable through load.ts, which owns the two owner-facing messages for these
  // and never dispatches here without both. A guard, not a duplicate.
  if (!keyPath || !uid) throw new Error('CASHFLOW_FIRESTORE_KEY and CASHFLOW_FIRESTORE_UID must both be set.');

  // Lazy import so the default CSV path never pays firebase-admin's startup cost. The
  // app and db handles live in this scope only — nothing else in the process can reach
  // an authenticated client through this module.
  const { initializeApp, cert, getApps } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const app = getApps()[0] ?? initializeApp({ credential: cert(keyPath) });
  const db = getFirestore(app);

  // The whole surface: four literal paths, no parameter, no other collection.
  const [accounts, transactions, income, reviews] = await Promise.all([
    db.collection(`users/${uid}/accounts`).get(),
    db.collection(`users/${uid}/transactions`).get(),
    db.collection(`users/${uid}/income`).get(),
    db.collection(`users/${uid}/reviews`).get(),
  ]);

  return {
    transactions: transactions.docs.map(mapTransaction),
    accounts: accounts.docs.map(mapAccount),
    // Both halves of IncomeContext: without `reviews`, list_unmapped would re-ask every
    // question the owner has already answered in the app.
    income: {
      sources: income.docs.map(mapIncomeSource),
      reviews: Object.fromEntries(reviews.docs.map((d) => [d.id, mapReview(d)])),
    },
    source: 'firestore',
    loadedAt: new Date().toISOString(),
  };
}
