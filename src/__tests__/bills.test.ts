/**
 * Bills register math + seed integrity (BILLS-001).
 *
 * The register is a manually curated source of truth, so the only computed
 * numbers are the frequency-normalized monthly costs and the migration
 * roll-ups. Display rounds per bill; aggregates sum RAW values then round
 * once, so 29 rounded rows can never drift the header total.
 */
import {
  Bill,
  BillFrequency,
  monthlyCostRaw,
  monthlyCost,
  totalMonthlyCost,
  migrationSummary,
  billsOnRetiredMethods,
  billUpcomingEvents,
  isCharging,
  installmentEndFrom,
  PAYMENT_METHODS,
} from '@/lib/bills';
import starter from '@/data/bills-starter.json';

const base: Omit<Bill, 'amount' | 'frequency'> = {
  id: 'x',
  vendor: 'Test Vendor',
  paymentMethodId: 'bofa-debit',
  migrationStatus: 'no-change-needed',
  lifecycleStatus: 'active',
  createdAt: '2026-08-06T00:00:00.000Z',
  updatedAt: '2026-08-06T00:00:00.000Z',
};

const mk = (amount: number, frequency: BillFrequency, extra: Partial<Bill> = {}): Bill => ({
  ...base,
  amount,
  frequency,
  ...extra,
});

describe('monthlyCost normalization', () => {
  test('weekly $10 → $43.33/mo', () => {
    expect(monthlyCost(mk(10, 'weekly'))).toBe(43.33);
  });

  test('biweekly $10 → $21.67/mo', () => {
    expect(monthlyCost(mk(10, 'biweekly'))).toBe(21.67);
  });

  test('monthly passes through unchanged', () => {
    expect(monthlyCost(mk(16.23, 'monthly'))).toBe(16.23);
  });

  test('quarterly $129 → $43.00/mo', () => {
    expect(monthlyCost(mk(129, 'quarterly'))).toBe(43);
  });

  test('semiannual $120 → $20.00/mo', () => {
    expect(monthlyCost(mk(120, 'semiannual'))).toBe(20);
  });

  test('annual $120 → $10.00/mo', () => {
    expect(monthlyCost(mk(120, 'annual'))).toBe(10);
  });
});

describe('totalMonthlyCost', () => {
  test('sums raw values then rounds once — no per-bill rounding drift', () => {
    // Three weekly $10 bills: raw each = 43.333…, rounded each = 43.33.
    // Naive sum of rounded = 129.99; correct = round(130.0) = 130.00.
    const bills = [mk(10, 'weekly'), mk(10, 'weekly'), mk(10, 'weekly')];
    expect(totalMonthlyCost(bills)).toBe(130);
    expect(monthlyCost(bills[0]) * 3).toBeCloseTo(129.99, 2);
  });

  test('cancelled bills charge nothing; cancel-planned still charges until actually cancelled', () => {
    const bills = [
      mk(100, 'monthly'),
      mk(50, 'monthly', { lifecycleStatus: 'cancelled' }),
      mk(25, 'monthly', { lifecycleStatus: 'cancel-planned' }),
    ];
    // cancel-planned still charges money until actually cancelled.
    expect(totalMonthlyCost(bills)).toBe(125);
  });

  test('empty list totals zero', () => {
    expect(totalMonthlyCost([])).toBe(0);
  });
});

describe('migrationSummary', () => {
  test('splits monthly cost by migration status and counts work remaining', () => {
    const bills = [
      mk(100, 'monthly', { migrationStatus: 'switched' }),
      mk(60, 'monthly', { migrationStatus: 'to-switch', paymentMethodId: 'discover' }),
      mk(40, 'monthly', { migrationStatus: 'exception', paymentMethodId: 'apple-card' }),
      mk(20, 'monthly', { migrationStatus: 'to-review' }),
      // cancelled rows never count toward money or completion totals
      mk(999, 'monthly', { migrationStatus: 'to-review', lifecycleStatus: 'cancelled' }),
    ];
    const s = migrationSummary(bills);
    // Money roll-ups: ACTIVE lifecycles only — the cancelled $999 row charges nothing.
    expect(s.switchedMonthly).toBe(100);
    expect(s.onCardsMonthly).toBe(60); // to-switch: money still flowing to a card
    expect(s.exceptionMonthly).toBe(40);
    // Work queue: every to-switch/to-review row regardless of lifecycle —
    // a "verify this really is cancelled" row is still work for the owner.
    expect(s.remaining).toBe(3);
    expect(s.completed).toBe(1); // switched
    expect(s.exceptions).toBe(1);
    expect(s.total).toBe(5);
  });
});

describe('billsOnRetiredMethods', () => {
  test('flags active bills whose payment method is being retired', () => {
    const bills = [
      mk(60, 'monthly', { migrationStatus: 'to-switch', paymentMethodId: 'discover' }),
      mk(10, 'monthly', { migrationStatus: 'switched', paymentMethodId: 'bofa-debit' }),
      mk(45, 'monthly', { migrationStatus: 'exception', paymentMethodId: 'apple-card' }),
      mk(99, 'monthly', { migrationStatus: 'to-switch', paymentMethodId: 'discover', lifecycleStatus: 'cancelled' }),
    ];
    const flagged = billsOnRetiredMethods(bills);
    // exception rows are deliberate; cancelled rows are dead — only the live
    // to-switch/to-review rows on retiring methods need attention.
    expect(flagged.map(b => b.amount)).toEqual([60]);
  });
});

describe('payment method registry', () => {
  test('every registry entry has label, type and active flag', () => {
    for (const [id, m] of Object.entries(PAYMENT_METHODS)) {
      expect(id).toMatch(/^[a-z0-9-]+$/);
      expect(m.label.length).toBeGreaterThan(0);
      expect(['debit', 'bank-ach', 'credit-card', 'zelle', 'manual']).toContain(m.type);
      expect(typeof m.active).toBe('boolean');
    }
  });
});

describe('starter seed integrity', () => {
  test('seed parses, has 28 rows, and every row is a valid Bill shape', () => {
    expect(Array.isArray(starter)).toBe(true);
    expect(starter).toHaveLength(28);
    for (const row of starter as Array<Record<string, unknown>>) {
      expect(typeof row.vendor).toBe('string');
      expect((row.vendor as string).length).toBeGreaterThan(0);
      expect(typeof row.amount).toBe('number');
      expect(row.amount as number).toBeGreaterThan(0);
      expect(['weekly', 'biweekly', 'monthly', 'quarterly', 'semiannual', 'annual']).toContain(row.frequency);
      expect(Object.keys(PAYMENT_METHODS)).toContain(row.paymentMethodId);
      expect(['to-review', 'to-switch', 'switched', 'exception', 'no-change-needed']).toContain(row.migrationStatus);
      expect(['active', 'cancel-planned', 'cancelled']).toContain(row.lifecycleStatus);
      expect(row.source).toBe('starter-audit');
      expect(row.seedVersion).toBe(1);
      if (row.autopayDay !== undefined) {
        expect(row.autopayDay as number).toBeGreaterThanOrEqual(1);
        expect(row.autopayDay as number).toBeLessThanOrEqual(31);
      }
      if (row.anchorDate !== undefined) {
        expect(row.anchorDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });

  test('seed contains the known anchors: Verizon on bank, Apple installments locked', () => {
    const rows = starter as Array<Record<string, unknown>>;
    const verizon = rows.find(r => (r.vendor as string).startsWith('Verizon'));
    expect(verizon?.paymentMethodId).toBe('bofa-checking-ach');
    expect(verizon?.migrationStatus).toBe('no-change-needed');
    const installments = rows.filter(r => (r.vendor as string).startsWith('Apple Card installment'));
    expect(installments).toHaveLength(4);
    for (const i of installments) expect(i.migrationStatus).toBe('exception');
  });
});

// ---------------------------------------------------------------------------
// v1.1 — merchant drill-down (spendBreakdown)
// ---------------------------------------------------------------------------

import { BillMatcher, matcherApplies, spendBreakdown } from '@/lib/bills';
import type { Transaction } from '@/types';

const tx = (over: Partial<Transaction>): Transaction => ({
  id: 't', title: 'SYNTHETIC', amount: 10, type: 'expense', category: 'other',
  paymentMethod: 'other', date: '2026-07-15', ...over,
} as Transaction);

describe('matcherApplies', () => {
  const groceries: BillMatcher = { categories: ['Groceries'], excludeMerchants: ['Instacart'] };

  test('matches by sourceCategory and respects merchant exclusions', () => {
    expect(matcherApplies(groceries, tx({ sourceCategory: 'Groceries', merchant: 'H-E-B' }))).toBe(true);
    expect(matcherApplies(groceries, tx({ sourceCategory: 'Groceries', merchant: 'Instacart' }))).toBe(false);
    expect(matcherApplies(groceries, tx({ sourceCategory: 'Gas', merchant: 'H-E-B' }))).toBe(false);
  });

  test('matches by merchant and drops one-offs above excludeOver', () => {
    const amazon: BillMatcher = { merchants: ['Amazon'], excludeOver: 1000 };
    expect(matcherApplies(amazon, tx({ merchant: 'Amazon', amount: 86.59 }))).toBe(true);
    expect(matcherApplies(amazon, tx({ merchant: 'Amazon', amount: 2271.09 }))).toBe(false);
    expect(matcherApplies(amazon, tx({ merchant: 'Walmart', amount: 5 }))).toBe(false);
  });

  test('ignores transfers and pending rows', () => {
    const any: BillMatcher = { categories: ['Groceries'] };
    expect(matcherApplies(any, tx({ sourceCategory: 'Groceries', type: 'transfer' }))).toBe(false);
    expect(matcherApplies(any, tx({ sourceCategory: 'Groceries', pending: true }))).toBe(false);
  });
});

describe('spendBreakdown', () => {
  const TODAY = new Date('2026-08-07T12:00:00');
  const matcher: BillMatcher = { categories: ['Groceries'], excludeMerchants: ['Instacart'] };

  const rows: Transaction[] = [
    tx({ id: 'a', sourceCategory: 'Groceries', merchant: 'H-E-B', amount: 100, date: '2026-05-10' }),
    tx({ id: 'b', sourceCategory: 'Groceries', merchant: 'H-E-B', amount: 50, date: '2026-06-10' }),
    tx({ id: 'c', sourceCategory: 'Groceries', merchant: 'Kroger', amount: 60, date: '2026-07-10' }),
    // refund nets against the merchant
    tx({ id: 'd', sourceCategory: 'Groceries', merchant: 'Kroger', amount: 10, type: 'income', date: '2026-07-12' }),
    // store-card payment credit must NOT count as a refund
    tx({ id: 'e', sourceCategory: 'Groceries', merchant: 'Kroger', title: 'No Details Available', amount: 500, type: 'income', date: '2026-07-13' }),
    // outside the 3-full-month window (April) and current-month partial (August)
    tx({ id: 'f', sourceCategory: 'Groceries', merchant: 'H-E-B', amount: 999, date: '2026-04-30' }),
    tx({ id: 'g', sourceCategory: 'Groceries', merchant: 'H-E-B', amount: 25, date: '2026-08-05' }),
    // excluded merchant never appears
    tx({ id: 'h', sourceCategory: 'Groceries', merchant: 'Instacart', amount: 400, date: '2026-07-01' }),
  ];

  test('windows to the last 3 full months, nets refunds, reports current month separately', () => {
    const b = spendBreakdown(matcher, rows, TODAY);
    expect(b.months.map(m => m.month)).toEqual(['2026-05', '2026-06', '2026-07']);
    expect(b.months.map(m => m.total)).toEqual([100, 50, 50]); // Jul: 60 − 10 refund
    expect(b.actualMonthly).toBeCloseTo(200 / 3, 2);
    expect(b.currentMonth).toEqual({ month: '2026-08', total: 25 });
  });

  test('ranks merchants by net monthly spend, descending', () => {
    const b = spendBreakdown(matcher, rows, TODAY);
    expect(b.merchants[0].merchant).toBe('H-E-B');
    expect(b.merchants[0].monthly).toBeCloseTo(150 / 3, 2);
    expect(b.merchants[1].merchant).toBe('Kroger');
    expect(b.merchants[1].monthly).toBeCloseTo(50 / 3, 2);
  });

  test('falls back to title when merchant is absent', () => {
    const b = spendBreakdown({ categories: ['Gas'] }, [
      tx({ sourceCategory: 'Gas', merchant: undefined, title: 'SHELL OIL 5744', amount: 30, date: '2026-07-02' }),
    ], TODAY);
    expect(b.merchants[0].merchant).toBe('SHELL OIL 5744');
  });
});

// ---------------------------------------------------------------------------
// BILLS-003 — non-negotiable lock
// ---------------------------------------------------------------------------

import { nonNegotiableMonthly } from '@/lib/bills';

describe('nonNegotiableMonthly', () => {
  test('sums locked active bills raw-then-round; cancelled locks charge nothing', () => {
    const bills = [
      mk(124.99, 'monthly', { nonNegotiable: true }),
      mk(10, 'weekly', { nonNegotiable: true }),          // 43.333…
      mk(98.99, 'annual', { nonNegotiable: true }),       // 8.249…
      mk(50, 'monthly'),                                   // unlocked — ignored
      mk(999, 'monthly', { nonNegotiable: true, lifecycleStatus: 'cancelled' }),
    ];
    expect(nonNegotiableMonthly(bills)).toBe(176.57); // 124.99 + 43.3333 + 8.2492 → round once
  });

  test('zero when nothing is locked', () => {
    expect(nonNegotiableMonthly([mk(100, 'monthly')])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// record-bill epic (#10/#14) — endDate stops charging
// ---------------------------------------------------------------------------

describe('isCharging honours endDate (totalMonthlyCost / nonNegotiableMonthly)', () => {
  test('an endDate before today stops both totals', () => {
    const bill = mk(45.79, 'monthly', { endDate: '2020-01-01', nonNegotiable: true });
    expect(totalMonthlyCost([bill], '2026-08-22')).toBe(0);
    expect(nonNegotiableMonthly([bill], '2026-08-22')).toBe(0);
  });

  test('boundary: endDate === today still charges; the day after it does not', () => {
    const bill = mk(45.79, 'monthly', { endDate: '2026-08-22' });
    expect(totalMonthlyCost([bill], '2026-08-22')).toBe(45.79);
    expect(totalMonthlyCost([bill], '2026-08-23')).toBe(0);
  });

  test('no endDate never stops charging', () => {
    expect(totalMonthlyCost([mk(10, 'monthly')], '2026-08-22')).toBe(10);
  });

  test('cancelled still beats an unexpired endDate', () => {
    const bill = mk(10, 'monthly', { endDate: '2099-01-01', lifecycleStatus: 'cancelled' });
    expect(totalMonthlyCost([bill], '2026-08-22')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// record-bill epic (#10/#14) — billUpcomingEvents projection
// ---------------------------------------------------------------------------

describe('billUpcomingEvents', () => {
  test('monthly with a dueDay projects the next occurrence inside the horizon', () => {
    const bill = mk(45.79, 'monthly', { autopayDay: 15 });
    // today is PAST this month's 15th — next occurrence is next month's.
    const events = billUpcomingEvents([bill], '2026-08-20', 45);
    expect(events).toEqual([{ billId: 'x', vendor: 'Test Vendor', dueDate: '2026-09-15', amount: 45.79 }]);
  });

  test('a due date exactly on "today" counts; the horizon end is inclusive', () => {
    const bill = mk(20, 'monthly', { autopayDay: 1 });
    const events = billUpcomingEvents([bill], '2026-08-01', 10);
    // Aug 1 (== today) is IN; the next occurrence (Sep 1) is past the 10-day horizon.
    expect(events.map(e => e.dueDate)).toEqual(['2026-08-01']);
  });

  test('horizon clip: a due date past the horizon end is excluded entirely', () => {
    const bill = mk(20, 'monthly', { autopayDay: 15 });
    const events = billUpcomingEvents([bill], '2026-08-01', 10); // horizon ends Aug 11
    expect(events).toEqual([]);
  });

  test('installmentsRemaining caps the number of projected occurrences', () => {
    const bill = mk(45.79, 'monthly', { autopayDay: 1, installmentsRemaining: 2 });
    // A long horizon would otherwise project 6+ monthly occurrences.
    const events = billUpcomingEvents([bill], '2026-08-01', 200);
    expect(events.map(e => e.dueDate)).toEqual(['2026-08-01', '2026-09-01']);
  });

  test('endDate clips projected occurrences mid-horizon, not just the charging gate', () => {
    const bill = mk(20, 'monthly', { autopayDay: 1, endDate: '2026-09-01' });
    const events = billUpcomingEvents([bill], '2026-08-01', 200);
    // Oct 1 would otherwise appear; endDate stops it after Sep 1.
    expect(events.map(e => e.dueDate)).toEqual(['2026-08-01', '2026-09-01']);
  });

  test('weekly steps from anchorDate', () => {
    const bill = mk(15, 'weekly', { anchorDate: '2026-08-05' });
    const events = billUpcomingEvents([bill], '2026-08-20', 14); // horizon ends Sep 3
    expect(events.map(e => e.dueDate)).toEqual(['2026-08-26', '2026-09-02']);
  });

  test('biweekly steps from anchorDate at a 14-day cadence', () => {
    const bill = mk(15, 'biweekly', { anchorDate: '2026-08-05' });
    const events = billUpcomingEvents([bill], '2026-08-20', 21); // horizon ends Sep 10
    expect(events.map(e => e.dueDate)).toEqual(['2026-09-02']);
  });

  test('quarterly needs BOTH autopayDay and anchorDate to pin the month cycle', () => {
    const bill = mk(129, 'quarterly', { autopayDay: 10, anchorDate: '2026-01-10' });
    const events = billUpcomingEvents([bill], '2026-09-01', 45); // horizon ends Oct 16
    expect(events).toEqual([{ billId: 'x', vendor: 'Test Vendor', dueDate: '2026-10-10', amount: 129 }]);
  });

  test('a monthly bill with no autopayDay "varies" and projects nothing', () => {
    const bill = mk(20, 'monthly');
    expect(billUpcomingEvents([bill], '2026-08-01', 45)).toEqual([]);
  });

  test('a weekly bill with no anchorDate projects nothing', () => {
    const bill = mk(15, 'weekly');
    expect(billUpcomingEvents([bill], '2026-08-01', 45)).toEqual([]);
  });

  test('a quarterly bill with autopayDay but no anchorDate projects nothing (cycle unknown)', () => {
    const bill = mk(129, 'quarterly', { autopayDay: 10 });
    expect(billUpcomingEvents([bill], '2026-08-01', 45)).toEqual([]);
  });

  test('a cancelled or ended bill is excluded even if its due date is inside the horizon', () => {
    const cancelled = mk(20, 'monthly', { id: 'c', autopayDay: 5, lifecycleStatus: 'cancelled' });
    const ended = mk(20, 'monthly', { id: 'e', autopayDay: 5, endDate: '2026-07-01' });
    expect(billUpcomingEvents([cancelled, ended], '2026-08-01', 45)).toEqual([]);
  });

  test('multiple bills come back sorted by dueDate', () => {
    // A short 10-day horizon from Aug 20 (ends Aug 30) keeps each bill to ONE
    // occurrence — both due-days sit inside Aug, their September repeats do not.
    const late = mk(20, 'monthly', { id: 'late', vendor: 'Late Vendor', autopayDay: 28 });
    const early = mk(10, 'monthly', { id: 'early', vendor: 'Early Vendor', autopayDay: 25 });
    const events = billUpcomingEvents([late, early], '2026-08-20', 10);
    expect(events.map(e => e.dueDate)).toEqual(['2026-08-25', '2026-08-28']);
    expect(events.map(e => e.vendor)).toEqual(['Early Vendor', 'Late Vendor']);
  });

  // Defect 2 (bills.ts:337): `new Date(year, month, 31)` rolls over in any month with
  // fewer than 31 days — JS Date normalizes the overflow into the FOLLOWING month rather
  // than clamping. Verified before the fix: autopayDay 31, monthly, Jan 1 + 90 days
  // produced ['2026-01-31', '2026-03-03', '2026-03-31'] — a phantom "Mar 3" from Feb's
  // rollover, alongside March's own real 31st.
  test('autopayDay 31 clamps into February — no phantom rollover into March', () => {
    const bill = mk(50, 'monthly', { autopayDay: 31 });
    const events = billUpcomingEvents([bill], '2026-01-01', 90); // horizon ends Apr 1
    expect(events.map(e => e.dueDate)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
  });

  test('autopayDay 31 clamps into a 30-day month (Sep), not just February', () => {
    const bill = mk(50, 'monthly', { autopayDay: 31 });
    const events = billUpcomingEvents([bill], '2026-09-01', 35); // horizon ends Oct 6
    // Buggy code rolls Sep 31 -> Oct 1 (a phantom, since Sep only has 30 days); Oct's
    // own real 31st is excluded by the horizon either way.
    expect(events.map(e => e.dueDate)).toEqual(['2026-09-30']);
  });
});

/**
 * Installment plans have to expire on their own.
 *
 * `installmentsRemaining` is a count captured at record time and nothing
 * decrements it. `isCharging` used to consult only `endDate` — and
 * `record_bill`'s prompt deliberately instructs the model to send at most ONE
 * of the two, so the screenshot path ("$45.79/mo, $595.31 remaining" → 13
 * payments) produces a count and NO end date. That bill charged forever,
 * inflating the Home "Locked" tile and Upcoming every month until someone
 * remembered to re-record it by hand.
 */
describe('installment plans expire without a re-record', () => {
  const thirteenMonthly = (createdAt: string): Bill =>
    mk(45.79, 'monthly', { installmentsRemaining: 13, createdAt, updatedAt: createdAt });

  test('still charges while the plan is running', () => {
    const bill = thirteenMonthly('2026-08-06T00:00:00.000Z');
    expect(isCharging(bill, '2027-01-06')).toBe(true);
    expect(totalMonthlyCost([bill], '2027-01-06')).toBe(45.79);
  });

  test('stops charging once the last payment has passed', () => {
    // 13 monthly payments from 2026-08-06 ends 2027-09-06.
    const bill = thirteenMonthly('2026-08-06T00:00:00.000Z');
    expect(isCharging(bill, '2027-09-07')).toBe(false);
    expect(totalMonthlyCost([bill], '2027-09-07')).toBe(0);
    expect(nonNegotiableMonthly([{ ...bill, nonNegotiable: true }], '2027-09-07')).toBe(0);
  });

  test('projects no further due dates after the plan ends', () => {
    const bill = thirteenMonthly('2026-08-06T00:00:00.000Z');
    expect(billUpcomingEvents([bill], '2027-09-07', 45)).toHaveLength(0);
  });

  test('a count of zero means finished, not unbounded', () => {
    const bill = mk(45.79, 'monthly', { installmentsRemaining: 0 });
    expect(isCharging(bill, '2026-08-07')).toBe(false);
  });

  test('a bill with no installment count is unaffected', () => {
    expect(isCharging(mk(20, 'monthly'), '2030-01-01')).toBe(true);
  });
});

/**
 * Review of the first cut of this fix caught a defect worse than the bug:
 * anchoring on `createdAt` retired a bill EARLY and silently whenever the owner
 * corrected its count, because `updateBill` strips `createdAt` and `update_bill`
 * is the documented way to correct one.
 */
describe('installment anchor survives a correction', () => {
  test('correcting the count re-anchors instead of retiring the bill early', () => {
    const corrected = mk(45.79, 'monthly', {
      installmentsRemaining: 8,
      createdAt: '2026-01-10T00:00:00.000Z',
      updatedAt: '2026-08-10T00:00:00.000Z', // the day the count was corrected
    });
    // 8 payments from the correction runs to 2027-04-10, not 2026-09-10.
    expect(isCharging(corrected, '2026-12-01')).toBe(true);
    expect(isCharging(corrected, '2027-04-09')).toBe(true);
    expect(isCharging(corrected, '2027-04-11')).toBe(false);
  });

  test('a malformed stamp disables expiry rather than throwing', () => {
    // `format()` on an Invalid Date throws RangeError, which would take the
    // whole homeSnapshot callable — and the phone's Home screen — down.
    const broken = mk(20, 'monthly', {
      installmentsRemaining: 3,
      createdAt: '',
      updatedAt: '',
    });
    expect(() => isCharging(broken, '2026-08-07')).not.toThrow();
    expect(isCharging(broken, '2026-08-07')).toBe(true);
  });

  test('a non-numeric count cannot retire a bill instantly', () => {
    const nulled = mk(20, 'monthly', {
      installmentsRemaining: null as unknown as number,
    });
    expect(isCharging(nulled, '2026-08-07')).toBe(true);
  });
});

/**
 * The ratchet (issue #165). Deriving the end at read time from `updatedAt`
 * meant every unrelated edit re-anchored the plan — and since the count never
 * decrements, each edit re-added the FULL original term. `update_bill`'s own
 * worked example in prompts.ts is a rename, so this was the normal path.
 *
 * The end is now stamped once, at write time, into `endDate`.
 */
describe('installmentEndFrom — the write-time stamp', () => {
  test('13 monthly payments from the anchor date', () => {
    expect(installmentEndFrom('2026-08-06T00:00:00.000Z', 'monthly', 13)).toBe('2027-09-06');
  });

  test('weekly and biweekly step in days, not months', () => {
    expect(installmentEndFrom('2026-08-06T00:00:00.000Z', 'weekly', 4)).toBe('2026-09-03');
    expect(installmentEndFrom('2026-08-06T00:00:00.000Z', 'biweekly', 4)).toBe('2026-10-01');
  });

  test('quarterly, semiannual and annual use their real month steps', () => {
    expect(installmentEndFrom('2026-08-06T00:00:00.000Z', 'quarterly', 2)).toBe('2027-02-06');
    expect(installmentEndFrom('2026-08-06T00:00:00.000Z', 'semiannual', 2)).toBe('2027-08-06');
    expect(installmentEndFrom('2026-08-06T00:00:00.000Z', 'annual', 2)).toBe('2028-08-06');
  });

  test('a stored endDate makes the bill immune to the ratchet', () => {
    // The whole point: with endDate present, isCharging never consults the
    // updatedAt-based fallback, so later edits cannot move the plan's end.
    const stamped = mk(45.79, 'monthly', {
      installmentsRemaining: 13,
      endDate: '2027-09-06',
      createdAt: '2026-08-06T00:00:00.000Z',
      updatedAt: '2027-06-01T00:00:00.000Z', // a rename, long after recording
    });
    expect(isCharging(stamped, '2027-09-05')).toBe(true);
    expect(isCharging(stamped, '2027-09-07')).toBe(false);
  });

  test('refuses a malformed anchor rather than throwing', () => {
    expect(installmentEndFrom('', 'monthly', 3)).toBeUndefined();
    expect(installmentEndFrom('not-a-date', 'monthly', 3)).toBeUndefined();
  });
});

/**
 * The month-end anchors, duplicated VERBATIM in cashflow-mobile's
 * accountsWrite.test.ts. If either port drifts, one of the two suites fails.
 *
 * The first version of these tests pinned only 2026-08-06 — the one anchor that
 * cannot expose a clamp difference — and the PR claimed on that basis that the
 * two clients could not drift. They already had: the mobile port used a bare
 * `setMonth`, which overflows, against date-fns `addMonths`, which clamps.
 */
describe('installmentEndFrom — month-end anchors clamp', () => {
  test('clamps to the shorter target month rather than overflowing', () => {
    expect(installmentEndFrom('2026-01-31T12:00:00.000Z', 'monthly', 1)).toBe('2026-02-28');
    expect(installmentEndFrom('2026-03-31T12:00:00.000Z', 'monthly', 1)).toBe('2026-04-30');
    expect(installmentEndFrom('2026-08-31T12:00:00.000Z', 'monthly', 13)).toBe('2027-09-30');
  });

  test('leaves a leap February on the 29th', () => {
    expect(installmentEndFrom('2028-01-31T12:00:00.000Z', 'monthly', 1)).toBe('2028-02-29');
  });

  test('still agrees on the ordinary anchor', () => {
    expect(installmentEndFrom('2026-08-06T12:00:00.000Z', 'monthly', 13)).toBe('2027-09-06');
  });
});

/**
 * `withInstallmentEnd` resolves against the STORED bill, not the patch alone.
 *
 * `update_bill`'s prompt says "include only the fields actually changing", so
 * single-key patches are the normal path. Reading only the patch made the
 * write-time stamp inert on exactly the two corrections it exists for —
 * correcting the count, and correcting the cadence — leaving a stale endDate
 * that retired the bill EARLY and silently.
 *
 * The function is not exported (it is a firestore.ts internal), so this pins
 * the arithmetic it delegates to and the rule it must follow.
 */
describe('re-stamping an installment plan on correction', () => {
  const NOW = '2027-01-15T12:00:00.000Z';

  test('a corrected COUNT re-dates the plan from now', () => {
    // 20 payments from the correction, not 13 from the original recording.
    expect(installmentEndFrom(NOW, 'monthly', 20)).toBe('2028-09-15');
  });

  test('a corrected CADENCE re-dates the plan from now', () => {
    // The count survives from the stored doc; only the step changes.
    expect(installmentEndFrom(NOW, 'annual', 13)).toBe('2040-01-15');
  });

  test('the stale stamp it replaces would have retired the bill years early', () => {
    // What the original recording stamped, for contrast: both corrections above
    // land far past it, so leaving it in place ends the bill too soon.
    const original = installmentEndFrom('2026-08-06T12:00:00.000Z', 'monthly', 13);
    expect(original).toBe('2027-09-06');
    expect(original! < installmentEndFrom(NOW, 'monthly', 20)!).toBe(true);
    expect(original! < installmentEndFrom(NOW, 'annual', 13)!).toBe(true);
  });
});
