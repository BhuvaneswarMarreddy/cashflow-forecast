'use client';

/**
 * Renders the REAL Accounts page against sanitized fixtures.
 *
 * The isolation boundary is the React context layer, which sits ABOVE the Firebase
 * SDK: AuthContext / UserProfileContext / TransactionContext are supplied directly,
 * so `UserProfileProvider` never mounts, `syncFromFirestore` never runs, and no
 * Firestore read can be issued at all. That is stronger than mocking the SDK — there
 * is no code path from this page to the live project.
 *
 * Authentication is NOT weakened: the real login flow is untouched. This route simply
 * does not use it, and does not exist outside development/test.
 */

import React from 'react';
import AccountsPage from '@/app/accounts/page';
import { AuthContext, AuthContextType } from '@/context/AuthContext';
import { UserProfileContext, UserProfileContextType } from '@/context/UserProfileContext';
import { TransactionContext, TransactionContextType } from '@/context/TransactionContext';
import { FIXTURE_PROFILE, FIXTURE_TRANSACTIONS, FIXTURE_USER } from '@/lib/obs/fixtures';

/**
 * Fill in the fields we care about; every other method on the context becomes a
 * no-op that resolves. Keeps the fixture honest (it cannot mutate anything) without
 * hand-writing forty stubs that would rot the moment an interface gains a method.
 */
function withNoops<T extends object>(base: Partial<T>): T {
  return new Proxy(base, {
    get(target, key) {
      if (typeof key === 'symbol' || key in target) return (target as Record<string | symbol, unknown>)[key as string];
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

const transactions = withNoops<TransactionContextType>({
  transactions: FIXTURE_TRANSACTIONS,
  isLoading: false,
  error: null,
  rules: [],
});

export default function FixtureAccounts() {
  return (
    <div data-testid="accounts-fixture-root">
      <AuthContext.Provider value={auth}>
        <UserProfileContext.Provider value={profile}>
          <TransactionContext.Provider value={transactions}>
            <AccountsPage />
          </TransactionContext.Provider>
        </UserProfileContext.Provider>
      </AuthContext.Provider>
    </div>
  );
}
