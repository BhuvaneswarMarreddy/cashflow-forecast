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
