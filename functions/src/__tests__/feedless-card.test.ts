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
import { interpretTransaction, POSTED_ONLY } from '@/lib/classify';
import { withDerivedBalances } from '@/lib/forecast';
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

/** `n` full calendar months before "now", on the given day — same reasoning as
 *  lastMonthDate, generalised so the double-count guard test below can place
 *  rows in two different months without ever naming a literal year. */
const monthsAgo = (n: number, day: number): string => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, day)).toISOString();
};

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
    // #14 round 2: the guard is a PER-PAYMENT predicate — a payment stops counting
    // once the card has a POSTED row of its own dated ON/BEFORE it (a real row
    // already covers that period). Relative dates (not literal year strings), same
    // reasoning as lastMonthDate above — deterministic whenever this suite runs.
    const twoMonthsAgo = monthsAgo(2, 1);   // earlyPayment: before the card's own row
    const itemizedDate = monthsAgo(1, 15);  // the card's own (only) row
    const oneMonthAgoLater = monthsAgo(1, 20); // laterPayment: after the card's own row

    const itemizedRow: Transaction = {
      id: 'own1', title: 'Household goods', amount: 45, type: 'expense', category: 'shopping',
      paymentMethod: 'other', date: itemizedDate, accountId: 'amzn',
    };
    const earlyPayment: Transaction = { ...amazonPayment, id: 'pay1', date: twoMonthsAgo }; // guarded out
    const laterPayment: Transaction = { ...amazonPayment, id: 'pay2', date: oneMonthAgoLater }; // still counts

    const transactions = [earlyPayment, itemizedRow, laterPayment];
    const { snapshot, accounts } = buildSnapshot({ ...baseLedger, transactions });

    // earlyPayment is guarded out; laterPayment still counts — the itemized row's
    // own $45 plus laterPayment's $800, not both payments plus the row.
    const card = accounts.find((a) => a.id === 'amzn')!;
    expect(card.balanceCents).toBe(120_000 - 80_000 + 4_500); // anchor - laterPayment + purchase

    // IMPORTANT-7: balanceCents alone cannot tell an INERT guard from a working
    // one when both payments are the same $800 — this whole suite passed with the
    // classify guard inert, because the number comes out identical either way.
    // avgMonthlySpendCents is a SUM across payments, not a difference: an inert
    // guard counts BOTH ($845 + $800 = $1,645, spread over the same 2 months, so
    // $823/mo), a working guard counts exactly one payment ($845 over 2 months =
    // $423/mo, rounded — monthlyAverages() rounds to the nearest dollar before this
    // converts to cents).
    expect(snapshot.avgMonthlySpendCents).toBe(42_300);

    // The `forecast` treatment (classify.ts) must agree with `expense`: a guarded
    // payment must not silently keep projecting into the forecast baseline.
    const derived = withDerivedBalances([checking, amazonCard], transactions, POSTED_ONLY);
    const derivedAmzn = derived.find((a) => a.id === 'amzn')!;
    expect(interpretTransaction(earlyPayment, [checking, derivedAmzn]).forecast).toBe('excluded');
    expect(interpretTransaction(laterPayment, [checking, derivedAmzn]).forecast).toBe('counted');
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
