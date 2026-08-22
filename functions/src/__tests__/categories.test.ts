/**
 * cashflow-mobile#24 — the snapshot payload exposes the owner's resolved category
 * set (defaults + custom), so mobile can stop hardcoding its own mirror. Same
 * split as FIN-SPEND-001's spend-assumption.test.ts: `buildSnapshot` is the pure
 * core `homeSnapshot` calls after `readLedger`, so this is a plain `Ledger` object
 * in, no Firestore, no emulator.
 *
 * The double-count-guard style: adding a category to the ledger must never move
 * any OTHER figure in the payload — this is a pure addition, not a derived one.
 */
import { buildSnapshot } from '../snapshot';
import type { Ledger } from '../snapshot';
import { EXPENSE_CATEGORIES } from '@/types';
import type { PaymentAccount, Transaction } from '@/types';

const checking: PaymentAccount = {
  id: 'chk',
  name: 'Checking',
  type: 'bank_account',
  provider: 'bank-transfer',
  color: '#000000',
  isActive: true,
  openingBalance: 5000,
  openingDate: '2026-01-01',
};

const rent: Transaction = {
  id: 'rent',
  title: 'Rent',
  amount: 250,
  type: 'expense',
  category: 'rent',
  paymentMethod: 'bank-transfer',
  date: '2026-01-15',
  accountId: 'chk',
};

const baseLedger: Ledger = {
  accounts: [checking],
  transactions: [rent],
  incomeSources: [],
  reviews: {},
  bills: [],
  goals: [],
  safetyThreshold: 500,
  includePending: false,
  lastBankSyncAt: null,
  rules: [],
  assumedMonthlySpend: null,
};

describe('buildSnapshot — categories payload (cashflow-mobile#24)', () => {
  it('a ledger with no categories field still returns the 13 defaults', () => {
    const { categories } = buildSnapshot(baseLedger);
    expect(categories).toHaveLength(EXPENSE_CATEGORIES.length);
    expect(categories.map((c) => c.value)).toEqual(EXPENSE_CATEGORIES.map((c) => c.value));
    expect(categories.every((c) => c.archived === false)).toBe(true);
  });

  it('a resolved custom category rides through verbatim, value/label/icon/archived', () => {
    const ledger: Ledger = {
      ...baseLedger,
      categories: [
        ...EXPENSE_CATEGORIES.map((c) => ({ ...c, archived: false })),
        { value: 'vacations', label: 'Vacations', icon: '🏖️', archived: false },
      ],
    };
    const { categories } = buildSnapshot(ledger);
    expect(categories).toContainEqual({ value: 'vacations', label: 'Vacations', icon: '🏖️', archived: false });
  });

  it('an archived category is still present in the payload, marked archived', () => {
    const ledger: Ledger = {
      ...baseLedger,
      categories: [
        ...EXPENSE_CATEGORIES.map((c) => ({ ...c, archived: false })),
        { value: 'vacations', label: 'Vacations', icon: '🏖️', archived: true },
      ],
    };
    const { categories } = buildSnapshot(ledger);
    expect(categories.find((c) => c.value === 'vacations')).toEqual(
      { value: 'vacations', label: 'Vacations', icon: '🏖️', archived: true },
    );
  });

  it('double-count guard: adding a custom category changes NOTHING else in the payload', () => {
    const without = buildSnapshot(baseLedger);
    const withCustom = buildSnapshot({
      ...baseLedger,
      categories: [
        ...EXPENSE_CATEGORIES.map((c) => ({ ...c, archived: false })),
        { value: 'vacations', label: 'Vacations', icon: '🏖️', archived: false },
      ],
    });

    // `generatedAt` is wall-clock and the two builds are milliseconds apart —
    // comparing it compares the clock, not the figures. Everything else must
    // be identical.
    const { categories: _c1, generatedAt: _g1, ...snapshotWithout } = without;
    const { categories: _c2, generatedAt: _g2, ...snapshotWithCustom } = withCustom;
    expect(snapshotWithCustom).toEqual(snapshotWithout);
  });
});
