/**
 * #14 round 2 — the Accounts form's feedless checkbox.
 *
 * IMPORTANT-5: unticking "No transaction feed" and saving must actually clear the
 * field. `updateAccount()` (firestore.ts) strips `undefined` keys — Firestore
 * rejects `undefined` — so writing `feedless: undefined` left the stored
 * `feedless: true` untouched: the UI looked like it worked until reload, silently
 * re-arming the spending rule.
 *
 * CRITICAL-3: a feedless card with no starting balance has nothing to anchor its
 * derived balance to (it would go negative the moment a payment is recorded) —
 * the form must refuse to save until one is entered.
 *
 * Mount pattern copied from accounts-unanchored-actions.test.tsx, the only
 * precedent in this repo for mounting Accounts with mocked contexts.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { PaymentAccount } from '@/types';
import { POSTED_ONLY } from '@/lib/classify';

jest.mock('@/components/Navbar', () => ({ __esModule: true, default: () => <nav /> }));

const mockUpdatePaymentAccount = jest.fn().mockResolvedValue(undefined);
const mockAddPaymentAccount = jest.fn().mockResolvedValue(undefined);

const FEEDLESS_ANCHORED: PaymentAccount = {
  id: 'card-amazon', name: 'Amazon Store Card', type: 'credit_card', provider: 'discover',
  feedless: true, openingBalance: 500, openingDate: '2026-01-01', color: '#e07a3f', isActive: true,
};

const PROFILE = {
  id: 'u1', email: 'owner@example.test', name: 'Owner', createdAt: '2026-01-01T00:00:00.000Z',
  isOnboarded: true, monthlyBudget: 0, currency: 'USD',
  paymentAccounts: [FEEDLESS_ANCHORED], incomeSources: [], settings: {},
};

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ isAuthenticated: true, isLoading: false, user: { id: 'u1' } }),
}));
jest.mock('@/context/TransactionContext', () => ({
  useTransactions: () => ({ transactions: [], isLoading: false, error: null, refreshTransactions: jest.fn() }),
}));
jest.mock('@/context/UserProfileContext', () => ({
  useUserProfile: () => ({
    profile: PROFILE,
    isLoading: false,
    addPaymentAccount: mockAddPaymentAccount,
    updatePaymentAccount: mockUpdatePaymentAccount,
    reconcileAccount: jest.fn(),
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

beforeEach(() => {
  mockUpdatePaymentAccount.mockClear();
  mockAddPaymentAccount.mockClear();
});

describe('IMPORTANT-5: unticking the feedless checkbox actually clears it', () => {
  it('saves an explicit `feedless: false`, not undefined (which Firestore would strip)', async () => {
    render(<AccountsPage />);
    fireEvent.click(screen.getByRole('button', { name: `Edit ${FEEDLESS_ANCHORED.name}` }));

    const checkbox = screen.getByRole('checkbox', { name: /No transaction feed/ });
    expect(checkbox).toBeChecked();
    fireEvent.click(checkbox); // uncheck

    fireEvent.click(screen.getByRole('button', { name: 'Update Account' }));

    await waitFor(() => expect(mockUpdatePaymentAccount).toHaveBeenCalled());
    const [, updates] = mockUpdatePaymentAccount.mock.calls[0];
    // The bug: `undefined` here is silently stripped and the stored `true` survives.
    expect(updates.feedless).toBe(false);
    expect('feedless' in updates).toBe(true);
  });
});

describe('CRITICAL-3: a feedless card cannot be saved without a starting balance', () => {
  it('the Save button is disabled while feedless is checked and balance is blank, and enables once one is entered', () => {
    render(<AccountsPage />);
    // Exactly one "Add Account" button exists before the modal opens — after, the
    // trigger (still mounted behind the overlay) and the submit button share the
    // same text, so every query below scopes to the modal itself.
    fireEvent.click(screen.getByRole('button', { name: 'Add Account' }));
    const modal = within(document.querySelector('.modal-content') as HTMLElement);

    fireEvent.change(modal.getByPlaceholderText('e.g., Chase Sapphire'), { target: { value: 'New Store Card' } });
    // Default form type is already 'credit_card'.
    fireEvent.click(modal.getByRole('checkbox', { name: /No transaction feed/ }));

    const saveButton = modal.getByRole('button', { name: 'Add Account' });
    expect(saveButton).toBeDisabled();

    fireEvent.change(modal.getByPlaceholderText('0.00'), { target: { value: '250' } });
    expect(saveButton).not.toBeDisabled();
  });
});
