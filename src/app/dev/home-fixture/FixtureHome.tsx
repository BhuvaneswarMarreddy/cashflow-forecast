'use client';

/**
 * Renders the REAL Home screen against sanitized fixtures.
 *
 * Same isolation boundary as FixtureAccounts: the contexts sit ABOVE the Firebase
 * SDK, so no provider mounts and no Firestore read can be issued from this route.
 * Bills arrive through DashboardPage's `initialBills` prop for the same reason —
 * that is the one place Home reads Firestore directly.
 *
 * This exists so the redesign can be audited from a screenshot without anyone
 * having to log in and send one. Authentication is untouched; this route simply
 * does not use it, and 404s outside development/test.
 */

import React from 'react';
import DashboardPage from '@/app/dashboard/page';
import { AuthContext, AuthContextType } from '@/context/AuthContext';
import { UserProfileContext, UserProfileContextType } from '@/context/UserProfileContext';
import { TransactionContext, TransactionContextType } from '@/context/TransactionContext';
import { FIXTURE_PROFILE, FIXTURE_TRANSACTIONS, FIXTURE_USER } from '@/lib/obs/fixtures';
import type { Bill } from '@/lib/bills';
import type { Transaction } from '@/types';

function withNoops<T extends object>(base: Partial<T>): T {
  return new Proxy(base, {
    get(target, key) {
      if (typeof key === 'symbol' || key in target) {
        return (target as Record<string | symbol, unknown>)[key as string];
      }
      return async () => undefined;
    },
  }) as T;
}

const auth = withNoops<AuthContextType>({
  user: FIXTURE_USER,
  isAuthenticated: true,
  isLoading: false,
});

const profile = withNoops<UserProfileContextType>({
  profile: FIXTURE_PROFILE,
  isLoading: false,
  isOnboarded: true,
  error: null,
});

/**
 * The shared FIXTURE_TRANSACTIONS are anchored to a fixed past date, so the
 * six-month burn window is empty and Home only ever shows its "not measured yet"
 * branch. Home's whole point is the runway, so this route needs recent movement
 * to exercise it — including one raw bank string, which is what the real ledger
 * is mostly made of.
 */
function recentLedger(): Transaction[] {
  const day = (ago: number) => {
    const d = new Date();
    d.setDate(d.getDate() - ago);
    return d.toISOString().slice(0, 10);
  };
  const rows: Array<[string, number, number, Transaction['type'], Transaction['category']]> = [
    ['PURCHASE 08/06 2C8MUM4AIHQ0CZN +XXXXX249889 WY', 1.0, 1, 'expense', 'other'],
    ['Cinemark Theatres', 47.85, 1, 'expense', 'entertainment'],
    ['Royal Biryani', 41.61, 2, 'expense', 'food'],
    ['On Inc', 184.03, 2, 'expense', 'shopping'],
    ['KEEP THE CHANGE CREDIT FROM ACCT2126', 0.39, 3, 'income', 'other'],
    ['H-E-B', 212.4, 5, 'expense', 'food'],
    ['Verizon Wireless', 525.0, 9, 'expense', 'utilities'],
    ['Payroll deposit', 4300.0, 12, 'income', 'other'],
    ['Rent', 1850.0, 20, 'expense', 'rent'],
    ['H-E-B', 188.2, 34, 'expense', 'food'],
    ['Payroll deposit', 4300.0, 42, 'income', 'other'],
    ['Rent', 1850.0, 50, 'expense', 'rent'],
  ];
  return rows.map(([title, amount, ago, type, category], i) => ({
    ...FIXTURE_TRANSACTIONS[0],
    id: `fx-recent-${i}`,
    title,
    amount,
    date: day(ago),
    type,
    category,
    accountId: 'fx-checking',
    paymentMethod: 'bank-transfer' as const,
    isProjected: false,
  }));
}

const transactions = withNoops<TransactionContextType>({
  transactions: recentLedger(),
  isLoading: false,
  error: null,
  rules: [],
});

/** Two locked bills, enough to exercise the hero's reserved chip. */
const bills: Bill[] = [
  {
    id: 'fx-1',
    vendor: 'Claude Max',
    amount: 200,
    frequency: 'monthly',
    autopayDay: 12,
    paymentMethodId: 'bofa-debit',
    migrationStatus: 'switched',
    lifecycleStatus: 'active',
    nonNegotiable: true,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  },
  {
    id: 'fx-2',
    vendor: 'Lawn care',
    amount: 63.55,
    frequency: 'monthly',
    autopayDay: 3,
    paymentMethodId: 'bofa-debit',
    migrationStatus: 'to-switch',
    lifecycleStatus: 'active',
    nonNegotiable: true,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  },
];

export default function FixtureHome() {
  return (
    <div data-testid="home-fixture-root">
      <AuthContext.Provider value={auth}>
        <UserProfileContext.Provider value={profile}>
          <TransactionContext.Provider value={transactions}>
            <DashboardPage initialBills={bills} />
          </TransactionContext.Provider>
        </UserProfileContext.Provider>
      </AuthContext.Provider>
    </div>
  );
}
