'use client';

import React from 'react';
import BillsTab from '@/components/BillsTab';
import type { Bill } from '@/lib/bills';
import type { Transaction } from '@/types';
import starterRows from '@/data/bills-starter.json';

const T0 = '2026-08-06T00:00:00.000Z';

// The starter audit, given synthetic ids/timestamps — exactly what the real
// seed produces, so the fixture shows the true post-import state.
const seeded: Bill[] = (starterRows as Array<Omit<Bill, 'id' | 'createdAt' | 'updatedAt'>>).map(
  (row, i) => ({ ...row, id: `fixture-${i}`, createdAt: T0, updatedAt: T0 })
);

// Target rows with matchers, mirroring the live register's "(average)" rows.
const targets: Bill[] = [
  {
    id: 'fx-groceries', vendor: 'Groceries — stores (average)', amount: 300, frequency: 'monthly',
    category: 'Variable average', paymentMethodId: 'bofa-debit',
    migrationStatus: 'no-change-needed', lifecycleStatus: 'active',
    matcher: { categories: ['Groceries'], excludeMerchants: ['Instacart'] },
    remarks: 'Tap the row to see the merchants behind this number.',
    createdAt: T0, updatedAt: T0,
  },
  {
    id: 'fx-amazon', vendor: 'Amazon orders (average)', amount: 100, frequency: 'monthly',
    category: 'Variable average', paymentMethodId: 'bofa-debit',
    migrationStatus: 'no-change-needed', lifecycleStatus: 'active',
    matcher: { merchants: ['Amazon'], excludeOver: 1000 },
    remarks: 'Necessities only from here on; big one-offs are excluded from the actual.',
    createdAt: T0, updatedAt: T0,
  },
];

const FIXTURE_BILLS: Bill[] = [...targets, ...seeded];

// Obviously synthetic spending, shaped like the real data: three full months
// of grocery-store and Amazon activity plus a current-month partial.
const tx = (id: string, over: Partial<Transaction>): Transaction => ({
  id, title: 'SYNTHETIC', amount: 0, type: 'expense', category: 'other',
  paymentMethod: 'other', date: '2026-07-01', ...over,
} as Transaction);

const FIXTURE_TRANSACTIONS: Transaction[] = [
  // Groceries — May / Jun / Jul + Aug partial
  tx('g1', { sourceCategory: 'Groceries', merchant: 'H-E-B', amount: 134, date: '2026-05-08' }),
  tx('g2', { sourceCategory: 'Groceries', merchant: 'Triveni Supermarket', amount: 112, date: '2026-05-17' }),
  tx('g3', { sourceCategory: 'Groceries', merchant: 'Kroger', amount: 85, date: '2026-05-24' }),
  tx('g4', { sourceCategory: 'Groceries', merchant: 'H-E-B', amount: 96, date: '2026-06-06' }),
  tx('g5', { sourceCategory: 'Groceries', merchant: 'Triveni Supermarket', amount: 128, date: '2026-06-14' }),
  tx('g6', { sourceCategory: 'Groceries', merchant: 'Blessington Farms', amount: 54, date: '2026-06-21' }),
  tx('g7', { sourceCategory: 'Groceries', merchant: 'H-E-B', amount: 141, date: '2026-07-05' }),
  tx('g8', { sourceCategory: 'Groceries', merchant: 'Triveni Supermarket', amount: 166, date: '2026-07-12' }),
  tx('g9', { sourceCategory: 'Groceries', merchant: 'Kroger', amount: 92, date: '2026-07-19' }),
  tx('g10', { sourceCategory: 'Groceries', merchant: 'H-E-B', amount: 97, date: '2026-07-26' }),
  tx('g11', { sourceCategory: 'Groceries', merchant: 'H-E-B', amount: 45, date: '2026-08-04' }),
  // Instacart exists but is excluded from the stores row
  tx('g12', { sourceCategory: 'Groceries', merchant: 'Instacart', amount: 120, date: '2026-07-09' }),
  // Amazon — orders, a refund, and a >$1000 one-off that must not count
  tx('a1', { merchant: 'Amazon', amount: 86, date: '2026-05-11' }),
  tx('a2', { merchant: 'Amazon', amount: 54, date: '2026-06-08' }),
  tx('a3', { merchant: 'Amazon', amount: 133, date: '2026-07-15' }),
  tx('a4', { merchant: 'Amazon', amount: 68, date: '2026-07-16' }),
  tx('a5', { merchant: 'Amazon', amount: 33, type: 'income', date: '2026-07-18' }), // refund
  tx('a6', { merchant: 'Amazon', amount: 2271, date: '2026-07-15' }), // one-off, excluded
];

export default function FixtureBills() {
  return (
    <div className="min-h-screen relative">
      <div className="bg-pattern" />
      <main className="pt-10 pb-12 px-4 sm:px-6 lg:px-8 max-w-4xl mx-auto relative z-10">
        <h1 className="text-2xl font-bold text-[var(--foreground)] mb-6">
          Bills — fixture preview
        </h1>
        <BillsTab
          userId="fixture-user"
          initialBills={FIXTURE_BILLS}
          initialTransactions={FIXTURE_TRANSACTIONS}
        />
      </main>
    </div>
  );
}
