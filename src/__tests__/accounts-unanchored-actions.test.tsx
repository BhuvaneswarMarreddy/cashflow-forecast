/**
 * Round 3a (#83 follow-up): the unanchored-account disclosure had no exit, and the
 * obvious route — Edit, confirm the prefilled number, Save — was a TRAP. Both fixes
 * here live on the same Accounts page, so one mount setup (mirroring the FlowPage
 * mount in recovery-flow-view.test.tsx / recovery-confirm.test.tsx — the only
 * precedent in this repo for mounting a full page with mocked contexts) covers both:
 *
 *  FIX A — handleSaveAccount must always anchor an unanchored account on save, even
 *  when the entered balance exactly matches the prefilled derived figure (delta 0),
 *  while an anchored account's untouched balance must still NOT re-anchor (UI-106).
 *
 *  FIX B — a "Set balance" control on the unanchored caption must render only for
 *  unanchored accounts, and activating it must open ReconcileSheet for that exact
 *  account — never anchor by itself (FIN-SETTLEMENT-003).
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { PaymentAccount, Transaction } from '@/types';
import { deriveAccountBalance } from '@/lib/forecast';
import { POSTED_ONLY } from '@/lib/classify';

jest.mock('@/components/Navbar', () => ({ __esModule: true, default: () => <nav /> }));

const mockUpdatePaymentAccount = jest.fn().mockResolvedValue(undefined);
const mockReconcileAccount = jest.fn().mockResolvedValue(0);

const UNANCHORED: PaymentAccount = {
  id: 'card-amazon', name: 'Amazon Store Card', type: 'credit_card', provider: 'other',
  openingBalance: 0, openingDate: undefined, color: '#e07a3f', isActive: true,
};
const ANCHORED: PaymentAccount = {
  id: 'chk-chase', name: 'Chase Checking', type: 'bank_account', provider: 'chase',
  openingBalance: 1000, openingDate: '2026-01-01', color: '#2f6fed', isActive: true,
};

const TXNS: Transaction[] = [
  {
    id: 't-amazon-1', title: 'Amazon purchase', amount: 500, type: 'expense',
    category: 'shopping', paymentMethod: 'other', accountId: 'card-amazon', date: '2026-02-01',
  } as Transaction,
];

// The exact figure deriveAccountBalance computes for the unanchored card — matches
// what openEditAccount() prefills and what ReconcileSheet's derivedCurrent must equal.
const DERIVED_CARD_BALANCE = deriveAccountBalance(UNANCHORED, TXNS, POSTED_ONLY);

const PROFILE = {
  id: 'u1', email: 'owner@example.test', name: 'Owner', createdAt: '2026-01-01T00:00:00.000Z',
  isOnboarded: true, monthlyBudget: 0, currency: 'USD',
  paymentAccounts: [UNANCHORED, ANCHORED], incomeSources: [], settings: {},
};

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ isAuthenticated: true, isLoading: false, user: { id: 'u1' } }),
}));
jest.mock('@/context/TransactionContext', () => ({
  useTransactions: () => ({ transactions: TXNS, isLoading: false, error: null, refreshTransactions: jest.fn() }),
}));
jest.mock('@/context/UserProfileContext', () => ({
  useUserProfile: () => ({
    profile: PROFILE,
    isLoading: false,
    addPaymentAccount: jest.fn(),
    updatePaymentAccount: mockUpdatePaymentAccount,
    reconcileAccount: mockReconcileAccount,
    reorderPaymentAccounts: jest.fn(),
    deletePaymentAccount: jest.fn(),
    addIncomeSource: jest.fn(),
    updateIncomeSource: jest.fn(),
    deleteIncomeSource: jest.fn(),
    updateProfile: jest.fn(),
    incomeContext: POSTED_ONLY,
    refreshProfile: jest.fn(),
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const AccountsPage = require('@/app/accounts/page').default;

beforeAll(() => {
  // Sheet uses the native <dialog> — jsdom has the element but not its methods.
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) { this.removeAttribute('open'); };
});

beforeEach(() => {
  mockUpdatePaymentAccount.mockClear();
  mockReconcileAccount.mockClear();
});

const todayISO = () => new Date().toISOString().slice(0, 10);

describe('FIX A — the Edit-account trap', () => {
  it('confirming the prefilled balance on an UNANCHORED account anchors it (openingDate gets set)', async () => {
    render(<AccountsPage />);
    fireEvent.click(screen.getByRole('button', { name: `Edit ${UNANCHORED.name}` }));

    // The form prefilled `balance` with the derived figure — the owner changes nothing.
    // (The "Current Balance" <label> isn't programmatically associated with its
    // <input> — no htmlFor/id pair — so this locates it by its unique placeholder.)
    const balanceInput = screen.getByPlaceholderText('0.00') as HTMLInputElement;
    expect(balanceInput.value).toBe(String(DERIVED_CARD_BALANCE));

    fireEvent.click(screen.getByRole('button', { name: 'Update Account' }));

    await waitFor(() => expect(mockUpdatePaymentAccount).toHaveBeenCalled());
    const [id, updates] = mockUpdatePaymentAccount.mock.calls[0];
    expect(id).toBe(UNANCHORED.id);
    // The trap: an unchanged, agreed-with number must still anchor, not vanish
    // into an `openingDate: editingAccount.openingDate` (i.e. still undefined).
    expect(updates.openingDate).toBe(todayISO());
    expect(updates.openingBalance).toBe(DERIVED_CARD_BALANCE);
  });

  it('UI-106 survives: editing an ANCHORED account\'s name without touching the balance does NOT re-anchor', async () => {
    render(<AccountsPage />);
    fireEvent.click(screen.getByRole('button', { name: `Edit ${ANCHORED.name}` }));

    const nameInput = screen.getByPlaceholderText('e.g., Chase Sapphire') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'Chase Checking (renamed)' } });
    // Balance field is left exactly as prefilled.
    fireEvent.click(screen.getByRole('button', { name: 'Update Account' }));

    await waitFor(() => expect(mockUpdatePaymentAccount).toHaveBeenCalled());
    const [id, updates] = mockUpdatePaymentAccount.mock.calls[0];
    expect(id).toBe(ANCHORED.id);
    expect(updates.name).toBe('Chase Checking (renamed)');
    // Untouched balance on an account that already had an anchor must keep its
    // OWN anchor — a rename must never move the numbers (UI-106).
    expect(updates.openingBalance).toBe(ANCHORED.openingBalance);
    expect(updates.openingDate).toBe(ANCHORED.openingDate);
  });
});

describe('FIX B — Set balance control on the unanchored disclosure', () => {
  it('renders only on the unanchored row, never on an anchored one', () => {
    render(<AccountsPage />);
    expect(screen.getByRole('button', { name: `Set balance for ${UNANCHORED.name}` })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: `Set balance for ${ANCHORED.name}` })).not.toBeInTheDocument();
  });

  it('opens ReconcileSheet for the SAME account, does not anchor on its own, and confirming routes through reconcileAccount (FIN-SETTLEMENT-003 / INV-1)', async () => {
    render(<AccountsPage />);
    fireEvent.click(screen.getByRole('button', { name: `Set balance for ${UNANCHORED.name}` }));

    expect(await screen.findByRole('heading', { name: `Reconcile ${UNANCHORED.name}` })).toBeInTheDocument();
    // Opening the sheet is not a confirmation — nothing has been written yet.
    expect(mockReconcileAccount).not.toHaveBeenCalled();
    expect(mockUpdatePaymentAccount).not.toHaveBeenCalled();

    const balanceField = screen.getByLabelText('Balance') as HTMLInputElement;
    expect(balanceField.value).toBe(String(Math.round(DERIVED_CARD_BALANCE * 100) / 100));

    fireEvent.click(screen.getByRole('button', { name: /Confirm|Re-anchor/ }));

    await waitFor(() => expect(mockReconcileAccount).toHaveBeenCalledWith(
      UNANCHORED.id, DERIVED_CARD_BALANCE, DERIVED_CARD_BALANCE
    ));
    // The control must route through reconcileAccount (which records the
    // DriftObservation) — never a second, direct write path.
    expect(mockUpdatePaymentAccount).not.toHaveBeenCalled();
  });
});
