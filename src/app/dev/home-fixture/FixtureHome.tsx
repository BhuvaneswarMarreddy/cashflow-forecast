'use client';

/** Renders the REAL Home screen against fixtures. See _fixture/FixtureShell. */
import React from 'react';
import DashboardPage from '@/app/dashboard/page';
import FixtureShell from '../_fixture/FixtureShell';
import type { Bill } from '@/lib/bills';

/**
 * Home is the one screen that reads Firestore directly (locked bills for the
 * hero's reserved chip), so it takes them as a prop here rather than reaching
 * past the context boundary the shell establishes.
 */
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
    <FixtureShell name="home">
      <DashboardPage initialBills={bills} />
    </FixtureShell>
  );
}
