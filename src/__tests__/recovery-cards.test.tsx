/**
 * FIN-RECOVERY-UI-001 §13.2 — the cards (C1–C11).
 *
 * Sanitized fixtures only: invented merchants, invented amounts, a clearly-marked demo
 * account. Nothing here touches Firestore, an emulator, a network or a real ledger.
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import CardCreditCard from '@/components/CardCreditCard';
import DuplicateCandidateCard from '@/components/DuplicateCandidateCard';
import RefundCandidateCard from '@/components/RefundCandidateCard';
import { RelationBadgeRow } from '@/components/TransactionRelationBadge';
import { CARD_CREDIT_KINDS } from '@/lib/card-credit';
import { ReviewCandidate } from '@/lib/candidates';
import { DuplicateCostEstimate, POTENTIAL_ANNUAL_DUPLICATE_COST_LABEL } from '@/lib/duplicates';
import { TransactionLink } from '@/lib/relations';
import { CARD_CREDIT_MEANING, QueueContext, relationBadges } from '@/lib/review-queue';
import { PaymentAccount, Transaction } from '@/types';

const accounts: PaymentAccount[] = [
  { id: 'demo-card-9021', name: 'Demo Rewards Card', type: 'credit_card', provider: 'amex', lastFourDigits: '9021', creditLimit: 500000, openingBalance: 0, openingDate: '2000-01-01', color: '#222', isActive: true },
  { id: 'demo-card-4410', name: 'Demo Travel Card', type: 'credit_card', provider: 'visa', lastFourDigits: '4410', creditLimit: 500000, openingBalance: 0, openingDate: '2000-01-01', color: '#333', isActive: true },
];

const tx = (o: Partial<Transaction> & { id: string; title: string; amount: number }): Transaction => ({
  type: 'expense', category: 'shopping', paymentMethod: 'other', date: '2026-07-12', accountId: 'demo-card-9021', ...o,
});

const PURCHASE_A = tx({ id: 'demo-purchase-a', title: 'Demo Amazon Lens', merchant: 'DEMO AMAZON', amount: 1100 });
const PURCHASE_B = tx({ id: 'demo-purchase-b', title: 'Demo Amazon Filter', merchant: 'DEMO AMAZON', amount: 100, date: '2026-07-14' });
const REFUND_AB = tx({ id: 'demo-refund-ab', title: 'Demo Amazon Refund', merchant: 'DEMO AMAZON', amount: 1200, type: 'income', date: '2026-07-31' });
const PURCHASE_C = tx({ id: 'demo-purchase-c', title: 'Demo Brightleaf Chair', merchant: 'DEMO BRIGHTLEAF', amount: 1100, date: '2026-06-02' });
const REFUND_C = tx({ id: 'demo-refund-c', title: 'Demo Brightleaf Refund', merchant: 'DEMO BRIGHTLEAF', amount: 900, type: 'income', date: '2026-06-20' });
const PURCHASE_E = tx({ id: 'demo-purchase-e', title: 'Demo Novacast Subscr', merchant: 'DEMO NOVACAST', amount: 200, date: '2026-04-10' });
const DISPUTE = tx({ id: 'demo-dispute', title: 'Demo Dispute Credit', merchant: 'DEMO NOVACAST', amount: 200, type: 'income', date: '2026-04-20' });
const UNKNOWN = tx({ id: 'demo-unknown', title: 'AB-4471 CREDIT', amount: 88, type: 'income', date: '2026-07-22' });
const DUP_1 = tx({ id: 'demo-dup-1', title: 'Demo Hardware Store', merchant: 'DEMO HARDWARE', amount: 64.2, date: '2026-07-05' });
const DUP_2 = tx({ id: 'demo-dup-2', title: 'Demo Hardware Store', merchant: 'DEMO HARDWARE', amount: 64.2, date: '2026-07-06' });
const SUB_9021 = tx({ id: 'demo-sub-9021', title: 'Demo Streaming', merchant: 'DEMO STREAMING', amount: 20, category: 'subscriptions', date: '2026-04-08' });
const SUB_4410 = tx({ id: 'demo-sub-4410', title: 'Demo Streaming', merchant: 'DEMO STREAMING', amount: 20, category: 'subscriptions', accountId: 'demo-card-4410', date: '2026-04-19' });

const TRANSACTIONS = [PURCHASE_A, PURCHASE_B, REFUND_AB, PURCHASE_C, REFUND_C, PURCHASE_E, DISPUTE, UNKNOWN, DUP_1, DUP_2, SUB_9021, SUB_4410];

const ctx = (links: TransactionLink[] = [], candidates: ReviewCandidate[] = []): QueueContext => ({
  transactions: TRANSACTIONS, accounts, links, candidates,
});

const candidate = (o: Partial<ReviewCandidate> & Pick<ReviewCandidate, 'id' | 'candidateType' | 'transactionIds'>): ReviewCandidate => ({
  candidateId: `${o.candidateType}~v1`,
  algorithmVersion: 'refund-match-v1',
  status: 'unreviewed',
  proposedLinks: [],
  evidence: { amountsCents: [], dayGaps: [19], sameAccount: true, accountTypes: ['credit_card'], merchantMatch: 'exact', referenceOverlap: 'none', pendingInvolved: false, reasonCodes: ['exact_amount', 'same_account'] },
  score: 0.85,
  generatedAt: '2026-08-01T00:00:00.000Z',
  ...o,
});

const COMBINED = candidate({
  id: 'combined_refund_match~demo-purchase-a~demo-purchase-b~demo-refund-ab',
  candidateType: 'combined_refund_match',
  transactionIds: ['demo-purchase-a', 'demo-purchase-b', 'demo-refund-ab'],
  proposedLinks: [
    { linkType: 'refund_of', sourceTransactionId: 'demo-refund-ab', targetTransactionId: 'demo-purchase-a', allocatedAmountCents: 110000 },
    { linkType: 'refund_of', sourceTransactionId: 'demo-refund-ab', targetTransactionId: 'demo-purchase-b', allocatedAmountCents: 10000 },
  ],
  evidence: { amountsCents: [110000, 10000], dayGaps: [19, 17], sameAccount: true, accountTypes: ['credit_card'], merchantMatch: 'exact', referenceOverlap: 'none', pendingInvolved: false, reasonCodes: ['combined_amount', 'same_account'] },
});

const PARTIAL = candidate({
  id: 'partial_refund_match~demo-purchase-c~demo-refund-c',
  candidateType: 'partial_refund_match',
  transactionIds: ['demo-purchase-c', 'demo-refund-c'],
  proposedLinks: [{ linkType: 'partial_refund_of', sourceTransactionId: 'demo-refund-c', targetTransactionId: 'demo-purchase-c', allocatedAmountCents: 90000 }],
  evidence: { amountsCents: [110000], dayGaps: [18], sameAccount: true, accountTypes: ['credit_card'], merchantMatch: 'exact', referenceOverlap: 'none', pendingInvolved: false, reasonCodes: ['partial_amount', 'same_account'] },
});

/** Two candidates for ONE credit, within the ambiguity band. */
const AMBIGUOUS_A = candidate({
  id: 'refund_match~demo-purchase-a~demo-refund-ab',
  candidateType: 'refund_match',
  transactionIds: ['demo-purchase-a', 'demo-refund-ab'],
  proposedLinks: [{ linkType: 'refund_of', sourceTransactionId: 'demo-refund-ab', targetTransactionId: 'demo-purchase-a', allocatedAmountCents: 110000 }],
  evidence: { amountsCents: [110000], dayGaps: [19], sameAccount: true, accountTypes: ['credit_card'], merchantMatch: 'exact', referenceOverlap: 'none', pendingInvolved: false, reasonCodes: ['exact_amount', 'same_account', 'ambiguous_match'] },
});
const AMBIGUOUS_B = candidate({
  id: 'refund_match~demo-purchase-c~demo-refund-ab',
  candidateType: 'refund_match',
  transactionIds: ['demo-purchase-c', 'demo-refund-ab'],
  proposedLinks: [{ linkType: 'refund_of', sourceTransactionId: 'demo-refund-ab', targetTransactionId: 'demo-purchase-c', allocatedAmountCents: 110000 }],
  evidence: { ...AMBIGUOUS_A.evidence, reasonCodes: ['exact_amount', 'same_account', 'ambiguous_match'] },
});

const DUP_CHARGE = candidate({
  id: 'immediate_duplicate_charge~demo-dup-1~demo-dup-2',
  candidateType: 'immediate_duplicate_charge',
  transactionIds: ['demo-dup-1', 'demo-dup-2'],
  evidence: { amountsCents: [6420, 6420], dayGaps: [1], sameAccount: true, accountTypes: ['credit_card'], merchantMatch: 'exact', referenceOverlap: 'none', pendingInvolved: false, reasonCodes: ['next_day'] },
});

const DUP_SUB = candidate({
  id: 'duplicate_subscription~demo-sub-4410~demo-sub-9021',
  candidateType: 'duplicate_subscription',
  transactionIds: ['demo-sub-4410', 'demo-sub-9021'],
  evidence: { amountsCents: [2000, 2000], dayGaps: [], sameAccount: false, accountTypes: ['credit_card'], merchantMatch: 'exact', referenceOverlap: 'none', cadence: 'monthly', overlappingPeriods: 4, pendingInvolved: false, reasonCodes: ['different_account', 'overlapping_periods'] },
});

const ESTIMATE: DuplicateCostEstimate = {
  identityKey: DUP_SUB.id,
  duplicateMonthlyCents: 2000,
  potentialAnnualDuplicateCostCents: 24000,
  label: POTENTIAL_ANNUAL_DUPLICATE_COST_LABEL,
  cheaperAccountId: 'demo-card-4410',
};

const noop = () => {};

describe('FIN-RECOVERY-UI-001 · cards (C1-C11)', () => {
  it('C1 — the refund card shows the credit, every purchase, every allocation and the remainder in words', () => {
    render(<RefundCandidateCard candidate={COMBINED} ctx={ctx()} onDecide={noop} />);
    expect(screen.getByText(/Credit · \$1,200\.00 · 31 Jul · Demo Rewards Card ••9021/)).toBeInTheDocument();
    expect(screen.getByText('Demo Amazon Lens')).toBeInTheDocument();
    expect(screen.getByText('Demo Amazon Filter')).toBeInTheDocument();
    expect(screen.getByText('allocated $1,100.00 of $1,100.00')).toBeInTheDocument();
    expect(screen.getByText('allocated $100.00 of $100.00')).toBeInTheDocument();
    expect(screen.getByText(/nothing left over/)).toBeInTheDocument();
  });

  it('C2 — a combined refund shows TWO allocations totalling the credit exactly', () => {
    render(<RefundCandidateCard candidate={COMBINED} ctx={ctx()} onDecide={noop} />);
    expect(screen.getByText(/Allocated \$1,200\.00 of \$1,200\.00 · nothing left over/)).toBeInTheDocument();
    expect(screen.getAllByText(/^allocated /)).toHaveLength(2);
  });

  it('C3 — a partial refund states the net cost in one sentence', () => {
    render(<RefundCandidateCard candidate={PARTIAL} ctx={ctx()} onDecide={noop} />);
    expect(screen.getByText('You paid $1,100.00, got $900.00 back. Net cost $200.00.')).toBeInTheDocument();
  });

  it('C4 — an ambiguous candidate renders alternatives with NO pre-selection and Confirm disabled', () => {
    render(<RefundCandidateCard candidate={AMBIGUOUS_A} alternatives={[AMBIGUOUS_B]} ctx={ctx()} onDecide={noop} />);
    expect(screen.getByText('2 purchases could match this credit')).toBeInTheDocument();
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(radios).toHaveLength(2);
    expect(radios.every((r) => !r.checked)).toBe(true);
    expect(screen.getByRole('button', { name: 'Confirm links' })).toBeDisabled();

    fireEvent.click(radios[0]);
    expect(screen.getByRole('button', { name: 'Confirm links' })).toBeEnabled();
  });

  it('C5 — the duplicate card shows BOTH series per account, never one collapsed row', () => {
    render(<DuplicateCandidateCard candidate={DUP_SUB} estimate={ESTIMATE} ctx={ctx()} onDecide={noop} />);
    expect(screen.getByText('Demo Rewards Card ••9021')).toBeInTheDocument();
    expect(screen.getByText('Demo Travel Card ••4410')).toBeInTheDocument();
    expect(screen.getAllByText('$20.00/monthly')).toHaveLength(2);
    expect(screen.getByText('Both charged in 4 of the same periods.')).toBeInTheDocument();
  });

  it('C6 — the avoidable cost is labelled, adjacent to its disclaimer, and never called a saving', () => {
    const { container } = render(<DuplicateCandidateCard candidate={DUP_SUB} estimate={ESTIMATE} ctx={ctx()} onDecide={noop} />);
    expect(screen.getByText(/potential annual duplicate cost: \$240\.00/i)).toBeInTheDocument();
    expect(screen.getByText(/not money coming back/)).toBeInTheDocument();
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/savings/i);
    expect(text).not.toMatch(/you will save/i);
    expect(text).not.toMatch(/guaranteed/i);
  });

  it('C7 — all five duplicate decisions are visible, none behind an overflow menu', () => {
    render(<DuplicateCandidateCard candidate={DUP_SUB} estimate={ESTIMATE} ctx={ctx()} onDecide={noop} />);
    for (const label of ['Accidental duplicate', 'Both intentional', 'Different owners', 'Business vs personal', 'Already cancelled']) {
      expect(screen.getByRole('button', { name: label })).toBeVisible();
    }
  });

  it('C8 — the immediate-duplicate card states that confirming changes no total', () => {
    render(<DuplicateCandidateCard candidate={DUP_CHARGE} ctx={ctx()} onDecide={noop} />);
    expect(screen.getByText(/Confirming this does not change any total/)).toBeInTheDocument();
    expect(screen.getByText('1 day apart.')).toBeInTheDocument();
  });

  it('C9 — the card-credit choices come from the exported kind list, with the income rule stated', () => {
    render(<CardCreditCard transaction={UNKNOWN} ctx={ctx()} onDecide={noop} />);
    expect(
      screen.getByText('This is money that arrived on a credit card. It is not income until you say what it is.')
    ).toBeInTheDocument();
    // Exactly one choice per exported kind — a hand-written list would drift.
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(radios).toHaveLength(CARD_CREDIT_KINDS.length);
    expect(radios.map((r) => r.value).sort()).toEqual([...CARD_CREDIT_KINDS].sort());
    // Every choice names what the money MEANS; none of them is a generic "income" label.
    for (const kind of CARD_CREDIT_KINDS) {
      expect(screen.getByText(CARD_CREDIT_MEANING[kind])).toBeInTheDocument();
    }
    expect(screen.queryByRole('radio', { name: /^income$/i })).toBeNull();
  });

  it('C10 — a provisional dispute credit says "provisional" and never rides on a netted figure', () => {
    const links: TransactionLink[] = [{
      id: 'chargeback_for~demo-dispute~demo-purchase-e', linkType: 'chargeback_for',
      sourceTransactionId: 'demo-dispute', targetTransactionId: 'demo-purchase-e',
      allocatedAmountCents: 20000, status: 'provisional', algorithmVersion: 'v1',
      confirmedAt: '2026-08-01T00:00:00.000Z', createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
    }];
    const badges = relationBadges(PURCHASE_E, { links, transactions: TRANSACTIONS, accounts });
    const { container } = render(<RelationBadgeRow badges={badges} />);
    expect(screen.getByText('Provisional dispute credit')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/net/i);
    expect(container.textContent).not.toMatch(/Returned/);
  });

  it('C11 — reason text is plain language, and no bare score is rendered anywhere', () => {
    const { container } = render(<RefundCandidateCard candidate={COMBINED} ctx={ctx()} onDecide={noop} />);
    fireEvent.click(screen.getByText('Why?'));
    expect(screen.getByText(/The amounts add up to this credit exactly, and both are on the same card\./)).toBeInTheDocument();
    // A bare 0.xx score never reaches the owner; the confidence word does.
    expect(container.textContent).not.toMatch(/\b0\.\d+\b/);
    expect(container.textContent).toMatch(/confidence high/);
  });
});
