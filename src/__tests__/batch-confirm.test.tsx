/**
 * Batch-confirm for exact refund matches — one press instead of 118.
 *
 * Invented fixtures only. The scope rule is the safety property: partial matches and
 * ambiguous credits change a purchase's net or need a human choice, so they must NEVER
 * ride along with a batch press.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import RecoveryReviewPanel from '@/components/RecoveryReviewPanel';
import { ReviewCandidate } from '@/lib/candidates';
import { ReviewQueueItem, buildReviewQueue } from '@/lib/review-queue';
import { PaymentAccount, Transaction } from '@/types';

const accounts: PaymentAccount[] = [
  { id: 'chk', name: 'Demo Checking', type: 'bank_account', provider: 'other', openingBalance: 0, openingDate: '2000-01-01', color: '#111', isActive: true } as PaymentAccount,
];

const tx = (o: Partial<Transaction> & { id: string }): Transaction => ({
  title: 'DEMO ROW', merchant: 'DEMO', description: '', amount: 10, type: 'expense',
  category: 'other', paymentMethod: 'other', date: '2026-05-01', accountId: 'chk', ...o,
} as Transaction);

const LEDGER: Transaction[] = [
  tx({ id: 'p1', amount: 31.64 }), tx({ id: 'r1', amount: 31.64, type: 'income' }),
  tx({ id: 'p2', amount: 91.55 }), tx({ id: 'r2', amount: 91.55, type: 'income' }),
  tx({ id: 'p3', amount: 40.0 }), tx({ id: 'r3', amount: 12.0, type: 'income' }),
  tx({ id: 'p4', amount: 20.0 }), tx({ id: 'r4', amount: 20.0, type: 'income' }),
];

const candidate = (o: Partial<ReviewCandidate> & Pick<ReviewCandidate, 'id'>): ReviewCandidate => ({
  candidateId: `${o.id}~v1`, candidateType: 'refund_match', algorithmVersion: 'refund-match-v1',
  status: 'suggested', transactionIds: ['p1', 'r1'],
  proposedLinks: [{ sourceTransactionId: 'r1', targetTransactionId: 'p1', allocatedAmountCents: 3164, linkType: 'refund_of' }],
  evidence: { amountsCents: [3164], dayGaps: [1], sameAccount: true, accountTypes: [], merchantMatch: 'exact', referenceOverlap: 'none', pendingInvolved: false, reasonCodes: ['exact_amount'] },
  score: 0.9, generatedAt: '2026-05-02T00:00:00.000Z', ...o,
} as ReviewCandidate);

const CANDIDATES: ReviewCandidate[] = [
  candidate({ id: 'exact-1' }),
  candidate({
    id: 'exact-2', transactionIds: ['p2', 'r2'],
    proposedLinks: [{ sourceTransactionId: 'r2', targetTransactionId: 'p2', allocatedAmountCents: 9155, linkType: 'refund_of' }],
    evidence: { amountsCents: [9155], dayGaps: [2], sameAccount: true, accountTypes: [], merchantMatch: 'exact', referenceOverlap: 'none', pendingInvolved: false, reasonCodes: ['exact_amount'] },
  }),
  // A PARTIAL match — must never be batch-eligible.
  candidate({
    id: 'partial-1', candidateType: 'partial_refund_match', transactionIds: ['p3', 'r3'],
    proposedLinks: [{ sourceTransactionId: 'r3', targetTransactionId: 'p3', allocatedAmountCents: 1200, linkType: 'partial_refund_of' }],
    evidence: { amountsCents: [1200], dayGaps: [1], sameAccount: true, accountTypes: [], merchantMatch: 'exact', referenceOverlap: 'none', pendingInvolved: false, reasonCodes: ['partial_amount'] },
  }),
  // An AMBIGUOUS exact match — more than one purchase could be the answer.
  candidate({
    id: 'ambiguous-1', transactionIds: ['p4', 'r4'],
    proposedLinks: [{ sourceTransactionId: 'r4', targetTransactionId: 'p4', allocatedAmountCents: 2000, linkType: 'refund_of' }],
    evidence: { amountsCents: [2000], dayGaps: [1], sameAccount: true, accountTypes: [], merchantMatch: 'exact', referenceOverlap: 'none', pendingInvolved: false, reasonCodes: ['exact_amount', 'ambiguous_match'] },
  }),
];

const ctx = { transactions: LEDGER, accounts, links: [], candidates: CANDIDATES };

const renderPanel = (onBatchConfirm = jest.fn()) => {
  const items = buildReviewQueue(ctx);
  render(
    <RecoveryReviewPanel
      items={items} ctx={ctx} estimates={[]} selectedKey={null} sectionFilter={null}
      announcement="" undoLabel={null} onSelect={() => {}} onSectionFilter={() => {}}
      onDecide={() => {}} onUndo={() => {}} onClose={() => {}} variant="panel"
      onBatchConfirm={onBatchConfirm}
    />
  );
  return { onBatchConfirm, items };
};

describe('batch-confirm scope', () => {
  it('offers ONLY unambiguous exact matches, and states the money', () => {
    renderPanel();
    // 2 exact — not the partial, not the ambiguous. $31.64 + $91.55 = $123.19.
    expect(screen.getByText('2 refunds match a purchase exactly — $123.19 in one press.')).toBeInTheDocument();
  });

  it('the press hands over exactly the ticked items', () => {
    const { onBatchConfirm } = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm 2 refunds' }));
    const passed: ReviewQueueItem[] = onBatchConfirm.mock.calls[0][0];
    expect(passed.map((i) => i.candidate!.id).sort()).toEqual(['exact-1', 'exact-2']);
  });

  it('unticking removes an item from the press', () => {
    const { onBatchConfirm } = renderPanel();
    fireEvent.click(screen.getByText('Review the list — untick anything you are not sure about'));
    // Untick the $31.64 one by its headline checkbox.
    fireEvent.click(screen.getByRole('checkbox', { name: /\$31\.64 back from DEMO/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm 1 refund' }));
    const passed: ReviewQueueItem[] = onBatchConfirm.mock.calls[0][0];
    expect(passed.map((i) => i.candidate!.id)).toEqual(['exact-2']);
  });

  it('does not render at all for a single exact match — one item is not a batch', () => {
    const single = { ...ctx, candidates: [CANDIDATES[0]] };
    render(
      <RecoveryReviewPanel
        items={buildReviewQueue(single)} ctx={single} estimates={[]} selectedKey={null}
        sectionFilter={null} announcement="" undoLabel={null} onSelect={() => {}}
        onSectionFilter={() => {}} onDecide={() => {}} onUndo={() => {}} onClose={() => {}}
        variant="panel" onBatchConfirm={jest.fn()}
      />
    );
    expect(screen.queryByText(/in one press/)).not.toBeInTheDocument();
  });
});
