/**
 * FIN-SPEND-001 (#133) — the owner's override of the monthly-spend assumption
 * that drives runway.
 *
 * `buildSnapshot` is the pure core `homeSnapshot` calls after `readLedger` —
 * same split as `applyDecisionCore` (decisions.ts): a plain `Ledger` object in,
 * no Firestore, no emulator needed to prove the override actually reaches both
 * `homeSummary` and the payload field mobile reads to label the figure.
 */
import { buildSnapshot } from '../snapshot';
import type { Ledger } from '../snapshot';
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

/** One real expense, dated exactly one full month before "now" — the same
 *  month-key math `monthlyAverages` uses — so the derived spend figure is
 *  deterministic no matter what day the suite actually runs on. */
const lastMonthDate = (() => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15)).toISOString();
})();

const rent: Transaction = {
  id: 'rent',
  title: 'Rent',
  amount: 250,
  type: 'expense',
  category: 'rent',
  paymentMethod: 'bank-transfer',
  date: lastMonthDate,
  accountId: 'chk',
};

const baseLedger: Ledger = {
  accounts: [checking],
  transactions: [],
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

describe('FIN-SPEND-001: assumedMonthlySpend overrides the derived average', () => {
  it('absent (null): the derived 6-month average flows through unchanged', () => {
    const ledger: Ledger = { ...baseLedger, transactions: [rent] };
    const { snapshot } = buildSnapshot(ledger);

    expect(snapshot.avgMonthlySpendCents).toBe(25_000); // $250 — the one real row
    expect(snapshot.assumedMonthlySpend).toBeNull();
    expect(snapshot.runway.hasBurn).toBe(true);
  });

  it('set: the owner’s number wins over the derived average, everywhere it feeds', () => {
    const ledger: Ledger = { ...baseLedger, transactions: [rent], assumedMonthlySpend: 999 };
    const { snapshot } = buildSnapshot(ledger);

    // NOT the derived $250 — the override, in both the figure that drove
    // runway and the figure the client displays as "$N a month".
    expect(snapshot.avgMonthlySpendCents).toBe(99_900);
    expect(snapshot.assumedMonthlySpend).toBe(999);
  });

  it('no spending measured and no override: hasBurn stays false, never a fabricated runway', () => {
    const { snapshot } = buildSnapshot(baseLedger);
    expect(snapshot.avgMonthlySpendCents).toBe(0);
    expect(snapshot.assumedMonthlySpend).toBeNull();
    expect(snapshot.runway.hasBurn).toBe(false);
  });

  it('an override makes hasBurn true even with zero real spending history', () => {
    const { snapshot } = buildSnapshot({ ...baseLedger, assumedMonthlySpend: 1200 });
    expect(snapshot.avgMonthlySpendCents).toBe(120_000);
    expect(snapshot.runway.hasBurn).toBe(true);
  });
});
