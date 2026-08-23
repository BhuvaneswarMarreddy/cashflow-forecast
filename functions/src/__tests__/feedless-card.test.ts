/**
 * FEEDLESS-CARD-001 (#14) — end-to-end through `buildSnapshot`, the mobile
 * client's actual read path (cashflow-mobile#14).
 *
 * Same split as bill-upcoming.test.ts / spend-assumption.test.ts: a plain
 * `Ledger` in, no Firestore, no emulator, proving the owner's $800 Amazon
 * card payment reaches `avgMonthlySpendCents` and `creditCardBalanceCents`
 * exactly once — and that a user with no feedless accounts sees the SAME
 * numbers this ledger would have produced before #14.
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

const amazonCard: PaymentAccount = {
  id: 'amzn',
  name: 'Amazon Store Card',
  type: 'credit_card',
  provider: 'other',
  lastFourDigits: '4521',
  feedless: true,
  color: '#ff9900',
  isActive: true,
  openingBalance: 1200,
  openingDate: '2026-01-01',
};

const normalCard: PaymentAccount = {
  id: 'rewards',
  name: 'Rewards Card',
  type: 'credit_card',
  provider: 'amex',
  color: '#333333',
  isActive: true,
  openingBalance: 0,
  openingDate: '2026-01-01',
};

/** One month before "now" — the same month-key math `monthlyAverages` uses
 *  (see spend-assumption.test.ts) — so the derived spend figure is
 *  deterministic no matter what day the suite actually runs on. */
const lastMonthDate = (() => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15)).toISOString();
})();

const amazonPayment: Transaction = {
  id: 'pay1',
  title: 'AMAZON STORE CARD PAYMENT ...4521',
  amount: 800,
  type: 'expense',
  category: 'other',
  paymentMethod: 'bank-transfer',
  date: lastMonthDate,
  accountId: 'chk',
};

const baseLedger: Ledger = {
  accounts: [checking, amazonCard],
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

describe('FEEDLESS-CARD-001: the $800 Amazon payment reaches the mobile snapshot', () => {
  it('counts as spend and lowers the card balance, with zero itemized rows', () => {
    const { snapshot, accounts } = buildSnapshot({ ...baseLedger, transactions: [amazonPayment] });

    expect(snapshot.avgMonthlySpendCents).toBe(80_000); // exact cents — the $800 itself
    const card = accounts.find((a) => a.id === 'amzn')!;
    expect(card.balanceCents).toBe(120_000 - 80_000); // anchor 1200 - the payment
  });

  it('the double-count guard: once the card has itemized rows, later payments stop counting', () => {
    // Fixed, well-in-the-past dates — never "today": deriveAccountBalance's window
    // check is LOCAL-timezone (date-fns `format`), and a UTC "today" fixture can
    // land on the wrong side of it depending on where this suite runs.
    const itemizedDate = '2026-02-15';
    const itemizedRow: Transaction = {
      id: 'own1', title: 'Household goods', amount: 45, type: 'expense', category: 'shopping',
      paymentMethod: 'other', date: itemizedDate, accountId: 'amzn',
    };
    const earlyPayment: Transaction = { ...amazonPayment, id: 'pay1', date: '2026-02-01' }; // before the feed
    const laterPayment: Transaction = { ...amazonPayment, id: 'pay2', date: '2026-03-01' }; // after — guarded

    const { accounts } = buildSnapshot({
      ...baseLedger, transactions: [earlyPayment, itemizedRow, laterPayment],
    });

    // earlyPayment (before the feed) still counts; laterPayment (after the itemized
    // row) is guarded out — only the itemized row's own $45 counts from there on,
    // not the $800 payment that would double it.
    const card = accounts.find((a) => a.id === 'amzn')!;
    expect(card.balanceCents).toBe(120_000 - 80_000 + 4_500); // anchor - earlyPayment + purchase
  });
});

describe('FEEDLESS-CARD-001: regression — no feedless accounts, nothing changes', () => {
  const normalPayment: Transaction = {
    id: 'p1', title: 'AMEX EPAYMENT ACH PMT', amount: 250, type: 'expense', category: 'other',
    paymentMethod: 'bank-transfer', date: lastMonthDate, accountId: 'chk',
  };
  const purchase: Transaction = {
    id: 'p2', title: 'Groceries', amount: 60, type: 'expense', category: 'food',
    paymentMethod: 'other', date: lastMonthDate, accountId: 'rewards',
  };

  it('the card payment is still a transfer, not spend, and the card balance derives from ITS OWN rows only', () => {
    const ledger: Ledger = {
      ...baseLedger, accounts: [checking, normalCard], transactions: [normalPayment, purchase],
    };
    const { snapshot, accounts } = buildSnapshot(ledger);

    expect(snapshot.avgMonthlySpendCents).toBe(6_000); // exact cents — the $250 payment stays excluded (transfer)
    const card = accounts.find((a) => a.id === 'rewards')!;
    // $60 owed: the $250 bank-side payment never touches this account's OWN rows,
    // and — unlike a feedless card — a normal card gets no cross-account credit for it.
    expect(card.balanceCents).toBe(6_000);
  });
});
