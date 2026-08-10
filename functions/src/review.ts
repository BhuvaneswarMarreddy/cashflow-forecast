/**
 * The inflow review queue — "is this money income?"
 *
 * Every credit the app cannot explain sits in `unknown_inflow`: real money that
 * is deliberately NOT counted as income, because only an approved source or the
 * owner can make it income. Resemblance never can. That is the rule the whole
 * ledger rests on, and it is why the queue exists rather than a guess.
 *
 * `selectInflowReviewQueue` (src/lib/classify.ts) is the selector, unchanged and
 * already tested. Nothing here decides what belongs in the queue; this file
 * reads the ledger, asks that function, and writes back the owner's answer.
 *
 * A phone is the right place for this. The decisions are small and there are
 * hundreds of them — the sort of thing done in a spare two minutes, which is
 * exactly why they pile up when the only workspace is a laptop.
 */

import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';

import { selectInflowReviewQueue, type IncomeContext } from '@/lib/classify';
import { withDerivedBalances } from '@/lib/forecast';
import { isFinancialMeaning, type FinancialMeaning, type InflowReview } from '@/types';

import { readLedger } from './snapshot';

/** One screenful at a time. The queue is hundreds long and the phone is not. */
const PAGE = 40;

export const reviewQueue = onCall({ cors: true, memory: '512MiB' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to review.');

  const ledger = await readLedger(request.auth.uid);
  const policy: IncomeContext = {
    sources: ledger.incomeSources,
    reviews: ledger.reviews,
    includePending: ledger.includePending,
  };
  const accounts = withDerivedBalances(ledger.accounts, ledger.transactions, policy);
  const items = selectInflowReviewQueue(ledger.transactions, accounts, policy);

  const byId = new Map(ledger.transactions.map((t) => [t.id, t]));
  const accountName = (id?: string) => {
    const account = accounts.find((a) => a.id === id);
    if (!account) return null;
    // The owner's own name plus the MASKED tail. A full number never reaches a
    // client: PaymentAccount stores four digits and nothing longer.
    return account.lastFourDigits ? `${account.name} ••${account.lastFourDigits}` : account.name;
  };

  return {
    generatedAt: new Date().toISOString(),
    /** The whole queue's size, so the screen can say "12 of 431" honestly. */
    total: items.length,
    /** Every unexplained credit, in cents. The reason the queue is worth clearing. */
    totalCents: items.reduce((sum, i) => sum + i.amountCents, 0),
    // The approved sources, so "this is my salary" is a tap rather than typing.
    sources: ledger.incomeSources
      .filter((s) => s.isActive)
      .map((s) => ({ id: s.id, name: s.name })),
    items: items.slice(0, PAGE).map((item) => {
      const transaction = byId.get(item.transactionId);
      return {
        transactionId: item.transactionId,
        date: item.date.slice(0, 10),
        amountCents: item.amountCents,
        title: transaction?.title ?? '',
        merchant: transaction?.merchant ?? null,
        accountName: accountName(item.accountId),
        pending: transaction?.pending ?? false,
        /** Why it is being asked, in the engine's own words. */
        reason: item.reason,
        reasonCodes: item.reasons,
        /** Non-empty when two or more approved sources matched — an ambiguity, not a guess. */
        candidateSourceIds: item.candidateSourceIds,
      };
    }),
  };
});

/**
 * The owner's answer.
 *
 * Written to `users/{uid}/reviews/{transactionId}` — the doc id IS the
 * transaction id, so there is at most one review per row and this is CURRENT
 * STATE, last-write-wins. The history lives in the audit log; making this
 * event-sourced would mean folding it before any figure could be shown, and it
 * is read on every interpret() call.
 *
 * Nothing about the transaction itself is touched. Provider truth — the
 * description, the amount, the posted date — is never rewritten by a review.
 */
export const resolveReview = onCall({ cors: true }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to review.');

  const { transactionId, decision, meaning, incomeSourceId, explanation } = (request.data ??
    {}) as {
    transactionId?: string;
    decision?: 'confirm' | 'dismiss';
    meaning?: string;
    incomeSourceId?: string;
    explanation?: string;
  };

  if (!transactionId) throw new HttpsError('invalid-argument', 'Which transaction?');
  if (decision !== 'confirm' && decision !== 'dismiss') {
    throw new HttpsError('invalid-argument', 'Confirm or dismiss.');
  }
  // A closed membership check at the trust boundary: `meaning` is persisted and
  // read by every surface, so an unknown string must never reach Firestore.
  if (decision === 'confirm' && !isFinancialMeaning(meaning)) {
    throw new HttpsError('invalid-argument', 'That is not a meaning Cashflow knows.');
  }

  const db = getFirestore();
  const user = db.collection('users').doc(request.auth.uid);

  // The fingerprint travels onto the review so a re-imported row under a new
  // document id can re-attach to the decision instead of asking again.
  const transaction = await user.collection('transactions').doc(transactionId).get();
  if (!transaction.exists) throw new HttpsError('not-found', 'No such transaction.');
  const fingerprint = transaction.data()?.fingerprint as string | undefined;

  const now = new Date().toISOString();
  const review: InflowReview = {
    transactionId,
    state: decision === 'confirm' ? 'confirmed' : 'dismissed',
    ...(decision === 'confirm' ? { meaning: meaning as FinancialMeaning, confirmedAt: now } : {}),
    ...(incomeSourceId ? { incomeSourceId } : {}),
    ...(fingerprint ? { fingerprint } : {}),
    ...(explanation ? { explanation: explanation.slice(0, 500) } : {}),
    updatedAt: now,
    source: 'user',
  };

  await user.collection('reviews').doc(transactionId).set(review, { merge: true });

  // An immutable trail beside the mutable state: firestore.rules denies UPDATE
  // on the audit collection, so a decision can be superseded but never quietly
  // rewritten.
  await user.collection('audit').add({
    action: 'inflow.review',
    at: Timestamp.now(),
    actor: 'user',
    after: { transactionId, state: review.state, meaning: review.meaning ?? null },
  });

  return { transactionId, state: review.state };
});
