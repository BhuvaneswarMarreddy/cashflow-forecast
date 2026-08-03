/**
 * MAP-001 — the card, and the group as an item source in the ONE review queue.
 *
 * Sanitized fixtures only: invented merchants, invented amounts, a clearly-marked demo
 * account. Nothing here touches Firestore, an emulator, a network or a real ledger.
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import MappingGroupCard from '@/components/MappingGroupCard';
import { GroupDecision, buildMappingGroups } from '@/lib/mapping-suggestions';
import { buildReviewQueue, queueCounts } from '@/lib/review-queue';
import { PaymentAccount, Transaction } from '@/types';

const accounts: PaymentAccount[] = [
  { id: 'demo-chk-1188', name: 'Demo Checking', type: 'bank_account', provider: 'other', lastFourDigits: '1188', openingBalance: 0, openingDate: '2000-01-01', color: '#222', isActive: true },
];

const tx = (o: Partial<Transaction> & { id: string }): Transaction => ({
  title: 'DEMO SOLSTICE FUND',
  merchant: 'DEMO SOLSTICE FUND',
  description: 'DEMO SOLSTICE FUND',
  sourceCategory: 'Other Income',
  amount: 250,
  type: 'income',
  category: 'other',
  paymentMethod: 'other',
  date: '2026-01-09',
  accountId: 'demo-chk-1188',
  ...o,
} as Transaction);

const ROWS: Transaction[] = [
  tx({ id: 'demo-in-1', date: '2026-01-09' }),
  tx({ id: 'demo-in-2', date: '2026-02-09' }),
  tx({ id: 'demo-in-3', date: '2026-03-09' }),
  tx({ id: 'demo-in-4', date: '2026-04-09' }),
];

const group = () => buildMappingGroups({ transactions: ROWS, accounts })[0];

const renderCard = (onDecide: (d: GroupDecision) => void = jest.fn()) =>
  render(
    <MappingGroupCard
      group={group()}
      transactions={ROWS}
      accounts={accounts}
      todayISO="2026-08-02"
      onDecide={onDecide}
    />
  );

describe('G1 the card asks about the pattern, not the row', () => {
  it('names how many rows one answer covers, and over what dates', () => {
    renderCard();
    // The count and the span appear in the header AND in the "if you confirm" panel —
    // the owner should not have to scroll back up to check what they are agreeing to.
    expect(screen.getAllByText(/4 rows/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/2026-01-09 to 2026-04-09/).length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: 'DEMO SOLSTICE FUND' })).toBeInTheDocument();
  });

  it('shows the account and the export\'s own label, never an invented category', () => {
    renderCard();
    expect(screen.getByText(/Demo Checking ••1188/)).toBeInTheDocument();
    expect(screen.getByText(/your export calls this Other Income/)).toBeInTheDocument();
  });
});

describe('G2 nothing applies without a confirmation', () => {
  it('keeps Confirm disabled until an answer is chosen', () => {
    const onDecide = jest.fn();
    renderCard(onDecide);
    const confirm = screen.getByRole('button', { name: /Confirm for 4 rows/ });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(onDecide).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText('A gift or a personal transfer'));
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    expect(onDecide).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'confirm', meaning: 'gift_or_personal_transfer', scope: 'only_this_group' })
    );
  });

  it('states the effect on budget, forecast and Flow before anything is chosen', () => {
    renderCard();
    expect(screen.getByText(/no budget total moves/i)).toBeInTheDocument();
    expect(screen.getByText(/forecast gains no income/i)).toBeInTheDocument();
    expect(screen.getByText(/same boxes, ribbons and totals/i)).toBeInTheDocument();
    expect(screen.getByText(/stays in your history at its full amount/i)).toBeInTheDocument();
  });

  it('says plainly when the answer has no rule form instead of inventing one', () => {
    renderCard();
    fireEvent.click(screen.getByLabelText('A gift or a personal transfer'));
    expect(screen.getAllByText(/no rule is created/i).length).toBeGreaterThan(0);
  });

  it('offers a scope with a live preview when the answer DOES have a rule form', () => {
    const onDecide = jest.fn();
    renderCard(onDecide);
    fireEvent.click(screen.getByLabelText('Money moving between my own accounts'));
    fireEvent.click(screen.getByLabelText('Every row from this merchant'));
    expect(screen.getByText(/4 transactions affected/)).toBeInTheDocument();
    expect(screen.getAllByText(/2026-01-09 to 2026-04-09/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Rows imported from now on/)).toBeInTheDocument();

    // §7.3 — this rule is broad for this ledger, so one click is not enough.
    const confirm = screen.getByRole('button', { name: /Confirm for 4 rows/ });
    expect(confirm).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/This is a broad rule/));
    expect(confirm).toBeEnabled();

    fireEvent.click(confirm);
    const decision = onDecide.mock.calls[0][0] as GroupDecision;
    expect(decision.scope).toBe('same_normalized_merchant');
    expect(decision.rule!.set).toEqual({ type: 'transfer' });
    expect(decision.rule!.match.value).toBe('DEMO SOLSTICE FUND');
  });
});

describe('G3 the terminal answer is one button away', () => {
  it('returns an "unknown" decision that creates no rule', () => {
    const onDecide = jest.fn();
    renderCard(onDecide);
    fireEvent.click(screen.getByRole('button', { name: /can't classify these/i }));
    expect(onDecide).toHaveBeenCalledWith({ action: 'unknown', scope: 'only_this_group' });
  });
});

describe('G4 a group replaces its rows in the ONE queue', () => {
  const ctx = {
    transactions: ROWS,
    accounts,
    links: [],
    candidates: [],
    inflowItems: ROWS.map((t) => ({
      transactionId: t.id, date: t.date, amountCents: 25000, accountId: t.accountId,
      meaning: 'unknown_inflow' as const, state: 'unreviewed' as const, reasons: [],
      candidateSourceIds: [], reason: 'no approved source matched',
    })),
  };

  it('asks once instead of four times', () => {
    const withoutGroups = buildReviewQueue(ctx);
    expect(withoutGroups).toHaveLength(4);
    expect(queueCounts(withoutGroups).bySection.unknown_deposits).toBe(4);

    const withGroups = buildReviewQueue({ ...ctx, groups: buildMappingGroups({ transactions: ROWS, accounts }) });
    expect(withGroups).toHaveLength(1);
    expect(queueCounts(withGroups).bySection.unmapped_groups).toBe(1);
    expect(queueCounts(withGroups).bySection.unknown_deposits).toBe(0);
    expect(withGroups[0].source).toBe('group');
    expect(withGroups[0].transactionIds).toHaveLength(4);
    expect(withGroups[0].headline).toMatch(/4 rows/);
  });

  it('leaves the queue exactly as it was when no groups are supplied', () => {
    expect(buildReviewQueue(ctx)).toEqual(buildReviewQueue({ ...ctx, groups: [] }));
  });
});
