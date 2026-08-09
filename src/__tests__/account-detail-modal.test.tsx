import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import AccountDetailModal from '@/components/AccountDetailModal';
import { PaymentAccount, Transaction } from '@/types';

// jsdom has no <dialog> methods — Sheet calls showModal()/close() on mount (see
// sheet.test.tsx for the same polyfill).
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});

const acct = (o: Partial<PaymentAccount> & { id: string }): PaymentAccount => ({
  name: 'Amazon Store Card', type: 'credit_card', provider: 'amazon', openingBalance: 0,
  color: '#000', isActive: true, ...o,
} as PaymentAccount);

const tx = (o: Partial<Transaction> & { id: string; accountId: string; date: string; amount: number }): Transaction => ({
  title: o.id, type: 'expense', category: 'other', paymentMethod: 'credit-card', ...o,
} as Transaction);

// #83 Finding 2: this modal is one graph-button click from the Accounts row, which
// already gives anchored/unanchored their own caption — the modal used to show
// "as of {date}" for anchored and NOTHING for unanchored, right beside the same
// large balance a caption below calls "your real balance owed". These pin the same
// three-way treatment Accounts uses, so the two surfaces cannot disagree again.
describe('AccountDetailModal — balance disclosure (#83 Fix 2)', () => {
  it('an anchored account states its anchor date', () => {
    render(
      <AccountDetailModal
        account={acct({ id: 'a', openingDate: '2026-01-01' })}
        transactions={[]}
        onClose={() => {}}
      />
    );
    expect(screen.getByText(/as of 2026-01-01/)).toBeInTheDocument();
  });

  it('an unanchored account with rows discloses net-since — never silent beside a real balance', () => {
    render(
      <AccountDetailModal
        account={acct({ id: 'a', openingDate: undefined })}
        transactions={[tx({ id: 't1', accountId: 'a', date: '2026-03-14', amount: 40 })]}
        onClose={() => {}}
      />
    );
    expect(screen.getByText(/net since 2026-03-14 · no starting balance set/)).toBeInTheDocument();
  });

  it('an unanchored account with no rows still discloses, not just an unlabeled number', () => {
    render(
      <AccountDetailModal
        account={acct({ id: 'a', openingDate: undefined })}
        transactions={[]}
        onClose={() => {}}
      />
    );
    expect(screen.getByText(/no starting balance set/)).toBeInTheDocument();
  });
});
