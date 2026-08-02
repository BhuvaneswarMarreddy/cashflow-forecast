/**
 * Sanitized fixture data for observability validation. INVENTED NUMBERS ONLY.
 *
 * This exists because production is also the development environment: there is one
 * Firebase project and a local `next dev` talks to live Firestore. An automated
 * browser test therefore may not load real data, so the fixture route feeds the real
 * Accounts page from here instead — no auth, no Firebase SDK call, no live balance.
 *
 * Dates are fixed in the past so derived balances are deterministic: every row is
 * dated after `openingDate` and before today, so it lands inside the derivation
 * window regardless of when the test runs.
 */

import { PaymentAccount, Transaction, UserProfile } from '@/types';

const OPENING = '2020-01-01';

export const FIXTURE_ACCOUNTS: PaymentAccount[] = [
  { id: 'fx-checking', name: 'Fixture Checking', type: 'bank_account', provider: 'chase', color: '#3b82f6', isActive: true, openingBalance: 2500, openingDate: OPENING, sortIndex: 0 },
  { id: 'fx-savings', name: 'Fixture Savings', type: 'bank_account', provider: 'chase', color: '#22c55e', isActive: true, openingBalance: 5000, openingDate: OPENING, sortIndex: 1 },
  { id: 'fx-cash', name: 'Fixture Cash', type: 'cash', provider: 'cash', color: '#a3a3a3', isActive: true, openingBalance: 100, openingDate: OPENING, sortIndex: 2 },
  { id: 'fx-card', name: 'Fixture Card', type: 'credit_card', provider: 'amex', color: '#ef4444', isActive: true, openingBalance: 400, openingDate: OPENING, creditLimit: 3000, apr: 22.9, lastFourDigits: '4242', sortIndex: 3 },
  { id: 'fx-card-nolimit', name: 'Fixture Card (no limit set)', type: 'credit_card', provider: 'discover', color: '#f59e0b', isActive: true, openingBalance: 150, openingDate: OPENING, sortIndex: 4 },
  { id: 'fx-loan', name: 'Fixture Loan', type: 'personal_loan', provider: 'other', color: '#f59e0b', isActive: true, openingBalance: 12000, openingDate: OPENING, monthlyPayment: 250, dueDate: 15, sortIndex: 5 },
];

export const FIXTURE_TRANSACTIONS: Transaction[] = [
  { id: 'fx-t1', title: 'Fixture Groceries', amount: 120, type: 'expense', category: 'food', paymentMethod: 'chase', accountId: 'fx-checking', date: '2020-02-01T00:00:00.000Z', sources: ['manual'] },
  { id: 'fx-t2', title: 'Fixture Salary', amount: 3000, type: 'income', category: 'other', paymentMethod: 'chase', accountId: 'fx-checking', date: '2020-02-02T00:00:00.000Z', sources: ['simplefin'] },
  { id: 'fx-t3', title: 'Fixture Card Purchase', amount: 75, type: 'expense', category: 'shopping', paymentMethod: 'amex', accountId: 'fx-card', date: '2020-02-03T00:00:00.000Z', sources: ['simplefin'] },
  { id: 'fx-t4', title: 'Fixture Transfer Out', amount: 500, type: 'transfer', transferDirection: 'out', category: 'other', paymentMethod: 'chase', accountId: 'fx-checking', date: '2020-02-04T00:00:00.000Z', sources: ['manual'] },
  { id: 'fx-t5', title: 'Fixture Transfer In', amount: 500, type: 'transfer', transferDirection: 'in', category: 'other', paymentMethod: 'chase', accountId: 'fx-savings', date: '2020-02-04T00:00:00.000Z', sources: ['manual'] },
];

export const FIXTURE_USER = { id: 'fx-user', email: 'fixture@example.test', name: 'Fixture User', createdAt: '2020-01-01T00:00:00.000Z' };

export const FIXTURE_PROFILE: UserProfile = {
  ...FIXTURE_USER,
  isOnboarded: true,
  monthlyBudget: 2000,
  currency: 'USD',
  paymentAccounts: FIXTURE_ACCOUNTS,
  incomeSources: [{ id: 'fx-inc', name: 'Fixture Salary', amount: 3000, frequency: 'monthly', payDate: 1, isActive: true }],
  settings: { timezone: 'UTC', notifications: false },
};

/** A raw sync document shaped like the real one, INCLUDING the fields that must never escape. */
export const FIXTURE_RAW_SYNC_DOC = {
  accessUrl: 'https://fixtureuser:fixturetoken@bridge.simplefin.test/simplefin',
  session: 'fixture-session-token-value',
  lastRun: '2026-08-01T23:45:00.000Z',
  lastSuccess: '2026-08-01T23:45:00.000Z',
  lastSyncDate: '2026-08-01',
  fetched: 42,
  added: 7,
  skippedPending: 2,
  reanchored: ['fx-checking', 'fx-card'],
  unmatchedAccounts: ['Unknown Bank 1'],
  error: '',
};
