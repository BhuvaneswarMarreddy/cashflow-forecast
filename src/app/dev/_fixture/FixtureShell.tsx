'use client';

/**
 * The isolation boundary every /dev fixture route shares.
 *
 * Contexts are supplied directly, and they sit ABOVE the Firebase SDK — so no
 * provider mounts, no `syncFromFirestore` runs, and there is no code path from a
 * fixture page to the live project. That is stronger than mocking the SDK.
 *
 * These routes exist so the redesign can be measured (scripts/ui-audit.mjs)
 * without anyone logging in to send a screenshot. Authentication is untouched;
 * fixtures simply do not use it, and every route 404s outside development —
 * pinned by dev-routes-gated.test.ts.
 */

import React from 'react';
import { AuthContext, AuthContextType } from '@/context/AuthContext';
import { UserProfileContext, UserProfileContextType } from '@/context/UserProfileContext';
import { TransactionContext, TransactionContextType } from '@/context/TransactionContext';
import { FIXTURE_PROFILE, FIXTURE_TRANSACTIONS, FIXTURE_USER } from '@/lib/obs/fixtures';
import type { Transaction } from '@/types';

/**
 * Fills in the fields a screen reads; every other method becomes a no-op that
 * resolves. Keeps the fixture unable to mutate anything without hand-writing
 * forty stubs that would rot the moment an interface gains a method.
 */
export function withNoops<T extends object>(base: Partial<T>): T {
  return new Proxy(base, {
    get(target, key) {
      if (typeof key === 'symbol' || key in target) {
        return (target as Record<string | symbol, unknown>)[key as string];
      }
      return async () => undefined;
    },
  }) as T;
}

/**
 * The shared FIXTURE_TRANSACTIONS are anchored to a fixed past date, so any
 * screen that measures a trailing window sees an empty one and renders only its
 * "nothing here yet" branch — which is not the state worth auditing. This is the
 * same ledger relative to today, including one raw bank string, because that is
 * what the real ledger is mostly made of.
 */
export function recentLedger(): Transaction[] {
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
    ['Amazon', 96.12, 61, 'expense', 'shopping'],
    ['Payroll deposit', 4300.0, 72, 'income', 'other'],
    ['Rent', 1850.0, 80, 'expense', 'rent'],
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

const auth = withNoops<AuthContextType>({
  user: FIXTURE_USER,
  isAuthenticated: true,
  isLoading: false,
});

/**
 * The observability fixtures are named "Fixture Checking", "Fixture Salary" and
 * dated 2020-01-01, which is correct for their job — asserting provenance in
 * tests. It is wrong for this one.
 *
 * A five-persona UX review of these routes spent a large share of its findings
 * on those names and dates: every reviewer flagged "as of 2020-01-01" as a stale
 * balance that voided the app, and one said they "would not link a bank to an
 * app currently showing a mock-up of my finances". None of that was true of the
 * product. Test data that looks broken makes a review report the harness.
 *
 * So the journey routes carry their own plausible household, ids untouched so
 * the obs tests that count and reference them keep passing.
 */
const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};

const REALISTIC_ACCOUNTS = FIXTURE_PROFILE.paymentAccounts.map((a, i) => ({
  ...a,
  name: [
    'Everyday Checking',
    'Emergency Savings',
    'Cash',
    'Rewards Card',
    'Travel Card',
    'Car Loan',
  ][i] ?? a.name,
  // Balances that were current this morning, not six years ago.
  openingDate: daysAgo(90),
}));

const INCOME_SOURCES = [
  { id: 'fx-inc', name: 'Payroll deposit', amount: 4300, frequency: 'biweekly' as const, payDate: 1, isActive: true },
];

const profile = withNoops<UserProfileContextType>({
  /**
   * The real UserProfileContext DERIVES this from the profile's income sources
   * (`UserProfileContext.tsx:519`). Without it here, withNoops() hands every
   * consumer a stub instead of `{ sources, reviews }`, nothing can match an
   * approved source, and every screen that counts income the strict way reports
   * $0.00 beside visible paychecks.
   *
   * That is not a product bug, and it was reported as one: a persona review
   * called it "the clearest 'this app cannot count' moment in the whole set".
   * A fixture that omits a derived value manufactures the exact failure it is
   * supposed to be testing for.
   */
  incomeContext: { sources: INCOME_SOURCES, reviews: {} },
  profile: {
    ...FIXTURE_PROFILE,
    paymentAccounts: REALISTIC_ACCOUNTS,
    // The name has to MATCH the deposits in recentLedger(), or income falls
    // through the approved-source check and every month reports +$0.00 beside a
    // visible paycheck — which is exactly what the review reported as a bug.
    incomeSources: INCOME_SOURCES,
  },
  isLoading: false,
  isOnboarded: true,
  error: null,
});

export default function FixtureShell({
  name,
  children,
}: {
  name: string;
  children: React.ReactNode;
}) {
  const transactions = withNoops<TransactionContextType>({
    transactions: recentLedger(),
    isLoading: false,
    error: null,
    rules: [],
  });

  return (
    <div data-testid={`${name}-fixture-root`}>
      <AuthContext.Provider value={auth}>
        <UserProfileContext.Provider value={profile}>
          <TransactionContext.Provider value={transactions}>
            {children}
          </TransactionContext.Provider>
        </UserProfileContext.Provider>
      </AuthContext.Provider>
    </div>
  );
}
