/**
 * record-bill epic (#10/#14) — the Bills register feeds mobile's Upcoming list.
 *
 * `buildSnapshot` is the pure core `homeSnapshot` calls after `readLedger` — same
 * split spend-assumption.test.ts uses: a plain `Ledger` in, no Firestore, no
 * emulator needed to prove a bill actually reaches `upcoming`/`upcomingTotalCents`
 * AND that it never reaches the spend average / runway (the double-count trap
 * this whole feature has to avoid — bills would otherwise be counted once as
 * real transaction history and again as a projected bill event).
 */
import { buildSnapshot } from '../snapshot';
import type { Ledger } from '../snapshot';
import { nonNegotiableMonthly, type Bill } from '@/lib/bills';
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

/** Anchored on TODAY, so the first projected occurrence is deterministically
 *  today's date no matter what day this suite actually runs on. */
const todayISO = new Date().toISOString().slice(0, 10);

const installmentBill: Bill = {
  id: 'b1',
  vendor: 'Apple Card installment - iPhone',
  amount: 45.79,
  frequency: 'weekly',
  anchorDate: todayISO,
  paymentMethodId: 'apple-card',
  migrationStatus: 'to-review',
  lifecycleStatus: 'active',
  nonNegotiable: true,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

/** One real expense, dated exactly one full month before "now" — the same
 *  month-key math `monthlyAverages` uses (see spend-assumption.test.ts). */
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

describe('the Bills register feeds Upcoming (display only)', () => {
  it('a charging bill appears in upcoming, and rolls into upcomingTotalCents', () => {
    const ledger: Ledger = { ...baseLedger, bills: [installmentBill] };
    const { upcoming, snapshot } = buildSnapshot(ledger);

    // A weekly cadence repeats several times inside the 45-day UPCOMING_DAYS window —
    // the point here is that the FIRST (earliest, today's) occurrence is present with
    // the right shape, not an exact count.
    const billRows = upcoming.filter((u) => u.kind === 'bill');
    expect(billRows.length).toBeGreaterThanOrEqual(1);
    expect(billRows[0]).toMatchObject({
      name: 'Apple Card installment - iPhone',
      dueDate: todayISO,
      amountCents: 4579,
      accountId: null,
      // Bills carry no autopay flag (bills.ts) — never true here.
      autopay: false,
    });
    expect(snapshot.upcomingTotalCents).toBeGreaterThanOrEqual(4579);
  });

  it('a cancelled bill contributes nothing to upcoming', () => {
    const cancelled: Bill = { ...installmentBill, lifecycleStatus: 'cancelled' };
    const { upcoming } = buildSnapshot({ ...baseLedger, bills: [cancelled] });
    expect(upcoming.filter((u) => u.kind === 'bill')).toHaveLength(0);
  });

  it('an ended bill (endDate in the past) contributes nothing to upcoming', () => {
    const ended: Bill = { ...installmentBill, endDate: '2020-01-01' };
    const { upcoming } = buildSnapshot({ ...baseLedger, bills: [ended] });
    expect(upcoming.filter((u) => u.kind === 'bill')).toHaveLength(0);
  });

  it('the merged list (loan events + bill events) stays sorted by dueDate', () => {
    const loan: PaymentAccount = {
      id: 'loan1',
      name: 'Car Loan',
      type: 'personal_loan',
      provider: 'other',
      color: '#000',
      isActive: true,
      openingBalance: 1000,
      openingDate: '2026-01-01',
      monthlyPayment: 300,
      // A due date far into the horizon, so it sorts AFTER the bill's due-today row.
      dueDate: 28,
    };
    const { upcoming } = buildSnapshot({ ...baseLedger, accounts: [checking, loan], bills: [installmentBill] });
    const dates = upcoming.map((u) => u.dueDate);
    expect(dates).toEqual([...dates].sort());
    expect(upcoming.some((u) => u.kind === 'bill')).toBe(true);
    expect(upcoming.some((u) => u.kind === 'card-payment' || u.name.includes('Car Loan'))).toBe(true);
  });

  it('DOUBLE-COUNT GUARD: a bill never changes the spend average or runway, even with real transaction history', () => {
    const withoutBill = buildSnapshot({ ...baseLedger, transactions: [rent] });
    const withBill = buildSnapshot({ ...baseLedger, transactions: [rent], bills: [installmentBill] });

    // The bill register must be invisible to everything runway reads — adding a
    // $45.79/week NON-NEGOTIABLE bill changes nothing here, even though it is
    // exactly the kind of number a naive merge would double-count.
    expect(withBill.snapshot.avgMonthlySpendCents).toBe(withoutBill.snapshot.avgMonthlySpendCents);
    expect(withBill.snapshot.runway.days).toBe(withoutBill.snapshot.runway.days);
    expect(withBill.snapshot.runway.hasBurn).toBe(withoutBill.snapshot.runway.hasBurn);
    // lockedMonthlyCents is a pure function of ledger.bills (nonNegotiableMonthly) — the
    // same guard extends to it: real transaction history (the `rent` row) must change
    // nothing here, AND the figure itself must be the bill's own monthly-normalized cost
    // pinned exactly, not merely "some positive number" — the weaker toBeGreaterThan(0)
    // assertion below (BILLS-003) would not catch a formula that computed the wrong value.
    expect(withoutBill.snapshot.lockedMonthlyCents).toBe(0);
    expect(withBill.snapshot.lockedMonthlyCents).toBe(Math.round(nonNegotiableMonthly([installmentBill]) * 100));
  });

  it('a non-negotiable bill still reaches lockedMonthlyCents (BILLS-003, unchanged wiring)', () => {
    const { snapshot } = buildSnapshot({ ...baseLedger, bills: [installmentBill] });
    // weekly $45.79 -> monthly-normalized, same math as nonNegotiableMonthly().
    expect(snapshot.lockedMonthlyCents).toBeGreaterThan(0);
  });
});

/**
 * #22 (cashflow-mobile). Mobile has no bills read path at all — homeSnapshot's `upcoming`
 * projects bill EVENTS (dates), but never the bills themselves, so a mobile chat asking
 * "is X already on my bills" or "what do I pay monthly" had nothing to answer from. This
 * digest mirrors the server ChatContext.bills field subset (functions/src/prompts.ts),
 * cents where the payload uses cents, same as every other money field in `buildSnapshot`.
 */
describe('the Bills register feeds the snapshot bills digest, for mobile chat parity (#22)', () => {
  it('a charging bill appears in the digest with the full field subset, in cents', () => {
    const { bills } = buildSnapshot({ ...baseLedger, bills: [installmentBill] });
    expect(bills).toEqual([{
      id: 'b1',
      vendor: 'Apple Card installment - iPhone',
      amountCents: 4579,
      frequency: 'weekly',
      nonNegotiable: true,
      endDate: null,
      installmentsRemaining: null,
      // paymentMethodId 'apple-card' -> PAYMENT_METHODS['apple-card'].label
      method: 'Apple Card',
    }]);
  });

  it('carries endDate/installmentsRemaining verbatim when the bill has them', () => {
    const withEnd: Bill = { ...installmentBill, endDate: '2027-01-01' };
    expect(buildSnapshot({ ...baseLedger, bills: [withEnd] }).bills[0].endDate).toBe('2027-01-01');

    const withCount: Bill = { ...installmentBill, endDate: undefined, installmentsRemaining: 13 };
    expect(buildSnapshot({ ...baseLedger, bills: [withCount] }).bills[0].installmentsRemaining).toBe(13);
  });

  it('a cancelled bill is absent from the digest, same rule as upcoming (isCharging)', () => {
    const cancelled: Bill = { ...installmentBill, lifecycleStatus: 'cancelled' };
    expect(buildSnapshot({ ...baseLedger, bills: [cancelled] }).bills).toHaveLength(0);
  });

  it('an ended bill (endDate in the past) is absent from the digest', () => {
    const ended: Bill = { ...installmentBill, endDate: '2020-01-01' };
    expect(buildSnapshot({ ...baseLedger, bills: [ended] }).bills).toHaveLength(0);
  });

  it('DOUBLE-COUNT GUARD: the bills digest is a pure addition — it changes no derived figure', () => {
    const withoutBill = buildSnapshot({ ...baseLedger, transactions: [rent] });
    const withBill = buildSnapshot({ ...baseLedger, transactions: [rent], bills: [installmentBill] });

    expect(withBill.snapshot.avgMonthlySpendCents).toBe(withoutBill.snapshot.avgMonthlySpendCents);
    expect(withBill.snapshot.runway.days).toBe(withoutBill.snapshot.runway.days);
    expect(withBill.snapshot.runway.hasBurn).toBe(withoutBill.snapshot.runway.hasBurn);
    // No bills at all -> no digest and (pre-existing behaviour) nothing locked.
    expect(withoutBill.bills).toEqual([]);
    expect(withoutBill.upcoming).toEqual([]);
  });
});
