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
import { reconcile, driftStatus } from '@/lib/accounts';

jest.mock('@/components/Navbar', () => ({ __esModule: true, default: () => <nav /> }));

const mockUpdatePaymentAccount = jest.fn().mockResolvedValue(undefined);
// A stand-in for the REAL UserProfileContext.reconcileAccount that runs the actual
// reconcile()/driftStatus() from src/lib/accounts.ts — not a canned resolved value —
// and, like the real implementation, calls updatePaymentAccount ONLY when reconcile()
// returns a `reanchor`. A canned value can't exercise accounts.ts's driftCents===0
// branch (#83 round 4a Defect 1: an unanchored account must still re-anchor at zero
// drift, since the confirm itself is the owner's first assertion); this does, so a
// regression on that branch turns the FIX B test below red instead of staying green
// no matter what accounts.ts does.
const mockReconcileAccount = jest.fn(async (id: string, entered: number, derived: number) => {
  const account = PROFILE.paymentAccounts.find((x) => x.id === id)!;
  const today = new Date().toISOString().slice(0, 10);
  const { driftCents, reanchor, observation } = reconcile(
    account, entered, derived, today, { includePending: false, source: 'user' }
  );
  if (reanchor) await mockUpdatePaymentAccount(id, reanchor);
  return { driftCents, status: driftStatus(observation, today) };
});

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
  it('typing a balance on an UNANCHORED account anchors it to that number (#83 round 4a Defect 2)', async () => {
    render(<AccountsPage />);
    fireEvent.click(screen.getByRole('button', { name: `Edit ${UNANCHORED.name}` }));

    // The balance field must prefill EMPTY, never currentOf() — that derived figure
    // is net movement, not a bank balance, and prefilling it let ANY save (even one
    // that only touched APR or colour) silently assert that number as a real anchor.
    // (The "Current Balance" <label> isn't programmatically associated with its
    // <input> — no htmlFor/id pair — so this locates it by its unique placeholder.)
    const balanceInput = screen.getByPlaceholderText('0.00') as HTMLInputElement;
    expect(balanceInput.value).toBe('');

    // 700, not 500: the $500 expense on this credit card makes DERIVED_CARD_BALANCE
    // exactly 500 too, and typing the SAME number the account would already derive
    // gives a delta of 0 — indistinguishable from not typing anything. Picking a
    // value that actually differs is what proves TYPING (not merely re-affirming
    // the derived figure) is what anchors it.
    fireEvent.change(balanceInput, { target: { value: '700' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update Account' }));

    await waitFor(() => expect(mockUpdatePaymentAccount).toHaveBeenCalled());
    const [id, updates] = mockUpdatePaymentAccount.mock.calls[0];
    expect(id).toBe(UNANCHORED.id);
    // Typing a real number is the owner's first assertion — it must anchor.
    expect(updates.openingDate).toBe(todayISO());
    expect(updates.openingBalance).toBe(700);
  });

  it('editing only a non-balance field on an UNANCHORED account (balance left blank) leaves it unanchored', async () => {
    render(<AccountsPage />);
    fireEvent.click(screen.getByRole('button', { name: `Edit ${UNANCHORED.name}` }));

    // Balance field is left exactly as prefilled — blank. Only APR changes.
    fireEvent.change(screen.getByPlaceholderText('24.99'), { target: { value: '24.99' } });
    fireEvent.click(screen.getByRole('button', { name: 'Update Account' }));

    await waitFor(() => expect(mockUpdatePaymentAccount).toHaveBeenCalled());
    const [id, updates] = mockUpdatePaymentAccount.mock.calls[0];
    expect(id).toBe(UNANCHORED.id);
    expect(updates.apr).toBe(24.99);
    // No balance was typed — openingAnchor('') asserts nothing, so the account must
    // still have no anchor after save. Manufacturing one here (a plausible NUMBER
    // instead of $0) was exactly #83 round 4a Defect 2.
    expect(updates.openingBalance).toBe(0);
    expect(updates.openingDate).toBeUndefined();
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
    // #83 round 4a Defect 1: entered === derived here (driftCents 0) — the owner's
    // most likely path, confirming the number the sheet already showed them. On an
    // UNANCHORED account that confirmation IS the first assertion, so it must still
    // write, THROUGH reconcileAccount (mockReconcileAccount above mirrors the real
    // implementation's own internal updatePaymentAccount call) — never a second,
    // direct write path from this page.
    await waitFor(() => expect(mockUpdatePaymentAccount).toHaveBeenCalledWith(
      UNANCHORED.id, { openingBalance: DERIVED_CARD_BALANCE, openingDate: todayISO() }
    ));
  });
});
