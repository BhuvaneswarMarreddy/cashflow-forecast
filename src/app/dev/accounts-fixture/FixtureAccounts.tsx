'use client';

/** Renders the REAL Accounts screen against fixtures. See _fixture/FixtureShell. */
import React from 'react';
import AccountsPage from '@/app/accounts/page';
import FixtureShell from '../_fixture/FixtureShell';

export default function FixtureAccounts() {
  return (
    <FixtureShell name="accounts">
      <AccountsPage />
    </FixtureShell>
  );
}
