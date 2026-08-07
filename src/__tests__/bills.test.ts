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
