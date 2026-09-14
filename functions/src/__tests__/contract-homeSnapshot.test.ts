/**
 * The wire contract between this server and cashflow-mobile.
 *
 * `homeSnapshot` is what the phone renders, and a merge to main deploys it with
 * no mobile release in step. This test pins one full payload — every array
 * non-empty so every field has a real value to type-check — into
 * `contracts/homeSnapshot.json` at the repo root. cashflow-mobile type-checks its
 * `SnapshotPayload` against that file and runs its mapper over it; validate.yml
 * does the same against mobile's main before this repo can deploy.
 *
 * A change here that fails this test is a change the phone will see. Re-record
 * with `UPDATE_CONTRACTS=1 npm test --prefix functions -- contract`, commit the
 * JSON, and let the mobile-contract CI job say whether the phone still copes.
 */
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { buildSnapshot, type Ledger } from '../snapshot';
import type { Bill } from '@/lib/bills';

const CONTRACT = join(__dirname, '../../../contracts/homeSnapshot.json');

const ledger: Ledger = {
  accounts: [
    {
      id: 'chk', name: 'Checking', type: 'bank_account', provider: 'bank-transfer',
      color: '#000000', isActive: true, openingBalance: 5000, openingDate: '2026-01-01',
      lastFourDigits: '1234',
    },
    {
      id: 'card', name: 'Amex', type: 'credit_card', provider: 'amex', creditLimit: 8000,
      color: '#000000', isActive: true, openingBalance: 0, openingDate: '2026-01-01',
    },
  ],
  transactions: [
    { id: 'rent', title: 'Rent', amount: 1200, type: 'expense', category: 'rent', paymentMethod: 'bank-transfer', date: '2026-08-01', accountId: 'chk' },
    { id: 'pay', title: 'Salary', amount: 3000, type: 'income', category: 'other', paymentMethod: 'bank-transfer', date: '2026-08-15', accountId: 'chk' },
    { id: 'food', title: 'Groceries', amount: 84.12, type: 'expense', category: 'food', paymentMethod: 'amex', date: '2026-08-20', accountId: 'card' },
  ],
  incomeSources: [{ id: 'job', name: 'Salary', amount: 3000, frequency: 'monthly', payDate: 15, isActive: true }],
  reviews: {},
  bills: [{
    id: 'internet', vendor: 'Internet', amount: 65, frequency: 'monthly', autopayDay: 10,
    paymentMethodId: 'chk', migrationStatus: 'to-review', lifecycleStatus: 'active', nonNegotiable: true,
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  } satisfies Bill],
  goals: [{
    id: 'fund', name: 'Emergency fund', targetAmount: 10000, currentAmount: 2500, targetDate: '2027-06-01',
    priority: 1, color: '#000000', isActive: true,
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  }],
  safetyThreshold: 500,
  includePending: false,
  assumedMonthlySpend: null,
  timezone: 'America/Chicago',
  lastBankSyncAt: '2026-09-01T12:00:00.000Z',
  rules: [],
};

describe('homeSnapshot wire contract (cashflow-mobile)', () => {
  beforeAll(() => jest.useFakeTimers({ now: new Date('2026-09-01T17:00:00.000Z') }));
  afterAll(() => jest.useRealTimers());

  it('matches contracts/homeSnapshot.json', () => {
    // Through JSON, exactly as the callable serialises it: undefined keys vanish.
    const payload = JSON.parse(JSON.stringify(buildSnapshot(ledger)));

    // An empty array type-checks against anything, so it would prove nothing.
    for (const key of ['accounts', 'categories', 'upcoming', 'bills', 'goals', 'activity']) {
      expect([key, payload[key].length > 0]).toEqual([key, true]);
    }
    expect(payload.snapshot.nextPaycheck).not.toBeNull();

    if (process.env.UPDATE_CONTRACTS) {
      writeFileSync(CONTRACT, `${JSON.stringify(payload, null, 2)}\n`);
    }
    expect(payload).toEqual(JSON.parse(readFileSync(CONTRACT, 'utf8')));
  });
});
