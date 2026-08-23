import { formatMoney, formatMoneyCents, monthlyIncomeOf } from '@/lib/money';

describe('formatMoney', () => {
  it('formats USD with no decimals by default (matches existing app look)', () => {
    expect(formatMoney(1234.56)).toBe('$1,235');
    expect(formatMoney(-500)).toBe('-$500');
  });

  it('formats INR with the rupee symbol and en-IN lakh grouping', () => {
    expect(formatMoney(100000, 'INR')).toBe('₹1,00,000');
  });

  it('cents variant keeps 2 decimals', () => {
    expect(formatMoneyCents(123456)).toBe('$1,234.56');
    expect(formatMoneyCents(123456, 'INR')).toBe('₹1,234.56');
  });

  // #29 regression guard: Navbar/dashboard used formatMoney(Math.abs(x)) with
  // red-vs-green as the only carrier of sign — negative money read as positive.
  // The fix passes raw values through, so the minus MUST survive formatting.
  it('negative amounts carry a visible minus at 2 decimals (#29)', () => {
    expect(formatMoney(-412, 'USD', 2)).toBe('-$412.00');
    expect(formatMoney(-2145, 'USD', 2)).toBe('-$2,145.00');
  });
});

/**
 * `monthlyIncomeOf` renders the "Monthly Income" headline on accounts, history and
 * onboarding. It used to re-implement this arithmetic by hand rather than call
 * income-cadence.ts's `monthlyFromCadence` — two copies of the same formula are
 * exactly how a past version of this app drifted to a *24 biweekly multiplier and
 * cost a real user ~$723/month (see income-cadence.ts's docstring). It now
 * delegates; these tests pin every cadence so a future edit cannot silently
 * reintroduce a second, different formula.
 */
describe('monthlyIncomeOf', () => {
  it('passes a monthly source through unchanged', () => {
    expect(monthlyIncomeOf([{ amount: 4300, frequency: 'monthly' }])).toBe(4300);
  });

  it('uses 26 paychecks a year for biweekly, not the naive 24 (*2/mo)', () => {
    // The historical bug: (amount * 2) would give 8600. The correct answer is
    // (amount * 26) / 12 ≈ 9316.67 — a ~$716.67/month difference at this amount,
    // the same class of error the docstring's $723/month regression describes.
    expect(monthlyIncomeOf([{ amount: 4300, frequency: 'biweekly' }])).toBeCloseTo((4300 * 26) / 12, 2);
  });

  it('uses 52 paychecks a year for weekly', () => {
    expect(monthlyIncomeOf([{ amount: 1000, frequency: 'weekly' }])).toBeCloseTo((1000 * 52) / 12, 2);
  });

  it('divides a yearly source by 12', () => {
    expect(monthlyIncomeOf([{ amount: 120000, frequency: 'yearly' }])).toBe(10000);
  });

  it('sums multiple sources of mixed cadence', () => {
    const total = monthlyIncomeOf([
      { amount: 4300, frequency: 'monthly' },
      { amount: 1000, frequency: 'weekly' },
    ]);
    expect(total).toBeCloseTo(4300 + (1000 * 52) / 12, 2);
  });

  it('an empty source list is zero income', () => {
    expect(monthlyIncomeOf([])).toBe(0);
  });
});
