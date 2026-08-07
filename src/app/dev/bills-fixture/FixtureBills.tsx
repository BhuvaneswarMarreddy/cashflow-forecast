'use client';

import React from 'react';
import BillsTab from '@/components/BillsTab';
import type { Bill } from '@/lib/bills';
import starterRows from '@/data/bills-starter.json';

const T0 = '2026-08-06T00:00:00.000Z';

// The starter audit, given synthetic ids/timestamps — exactly what the real
// seed produces, so the fixture shows the true post-import state.
const FIXTURE_BILLS: Bill[] = (starterRows as Array<Omit<Bill, 'id' | 'createdAt' | 'updatedAt'>>).map(
  (row, i) => ({ ...row, id: `fixture-${i}`, createdAt: T0, updatedAt: T0 })
);

export default function FixtureBills() {
  return (
    <div className="min-h-screen relative">
      <div className="bg-pattern" />
      <main className="pt-10 pb-12 px-4 sm:px-6 lg:px-8 max-w-4xl mx-auto relative z-10">
        <h1 className="text-2xl font-bold text-[var(--foreground)] mb-6">
          Bills — fixture preview
        </h1>
        <BillsTab userId="fixture-user" initialBills={FIXTURE_BILLS} />
      </main>
    </div>
  );
}
