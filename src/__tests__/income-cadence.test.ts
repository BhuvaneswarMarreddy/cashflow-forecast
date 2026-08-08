/**
 * #75 — the declared pay frequency was never checked against the deposits.
 *
 * `monthlyIncomeOf` turns a declaration into money: biweekly means × 26 / 12.
 * Nothing compared that to what actually landed, so declaring "biweekly" while
 * being paid monthly inflated income 2.17× — silently, permanently, and in the
 * largest figure on the screen. It then cascaded into "Growing / your wealth is
 * increasing" and "Savings potential $7,316.67/month".
 *
 * A five-persona review flagged it as the most dangerous number in the app.
 * Eleanor, 71: "Telling a pensioner she has $7,316 spare every month is the
 * sort of number people act on."
 *
 * The rule these tests pin: infer the cadence from the dated deposits, and when
 * it disagrees with the declaration, report the conflict instead of a figure.
 * Same contract as the runway hero's `hasBurn` — never print what the data
 * cannot back.
 */
import { observedCadence, reconcileIncome, monthlyFromCadence } from '@/lib/income-cadence';

/** n deposits, `gap` days apart, most recent first. */
const series = (n: number, gap: number, from = '2026-08-01'): string[] => {
  const start = new Date(`${from}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() - i * gap);
    return d.toISOString().slice(0, 10);
  });
};

describe('observedCadence', () => {
  it('reads a fortnightly rhythm as biweekly', () => {
    expect(observedCadence(series(6, 14)).cadence).toBe('biweekly');
  });

  it('reads a monthly rhythm as monthly', () => {
    expect(observedCadence(series(5, 30)).cadence).toBe('monthly');
  });

  it('reads a weekly rhythm as weekly', () => {
    expect(observedCadence(series(8, 7)).cadence).toBe('weekly');
  });

  it('tolerates weekend drift — payday slides but the rhythm holds', () => {
    // Real payrolls land Fri/Mon, so gaps wobble around the nominal 14.
    expect(observedCadence(['2026-08-01', '2026-07-17', '2026-07-03', '2026-06-19']).cadence)
      .toBe('biweekly');
  });

  it('refuses to guess from too few deposits', () => {
    // Two deposits is one gap. One gap is a coincidence, not a rhythm.
    expect(observedCadence(series(2, 30)).cadence).toBe('unknown');
    expect(observedCadence([]).cadence).toBe('unknown');
  });

  it('calls genuinely erratic pay irregular rather than forcing a bucket', () => {
    expect(observedCadence(['2026-08-01', '2026-07-20', '2026-05-02', '2026-04-28']).cadence)
      .toBe('irregular');
  });

  it('is order-independent — callers should not have to sort', () => {
    const shuffled = ['2026-07-03', '2026-08-01', '2026-06-19', '2026-07-17'];
    expect(observedCadence(shuffled).cadence).toBe('biweekly');
  });
});

describe('monthlyFromCadence', () => {
  it('uses 26 paychecks a year for biweekly, not 24', () => {
    expect(monthlyFromCadence(4300, 'biweekly')).toBeCloseTo((4300 * 26) / 12, 2);
  });

  it('passes monthly through untouched', () => {
    expect(monthlyFromCadence(4300, 'monthly')).toBe(4300);
  });
});

describe('reconcileIncome', () => {
  const source = { amount: 4300, frequency: 'biweekly' as const };

  it('reports a conflict, and NO figure, when the deposits disagree', () => {
    // The exact defect: declared biweekly, paid monthly.
    const r = reconcileIncome(source, series(4, 30));
    expect(r.conflict).toBe(true);
    expect(r.declared).toBe('biweekly');
    expect(r.observed).toBe('monthly');
    expect(r.monthly).toBeNull(); // the caller must not have a number to print
    expect(r.observedMonthly).toBe(4300); // what it WOULD be if the deposits are right
  });

  it('agrees silently when the declaration matches reality', () => {
    const r = reconcileIncome(source, series(6, 14));
    expect(r.conflict).toBe(false);
    expect(r.monthly).toBeCloseTo((4300 * 26) / 12, 2);
  });

  it('trusts the declaration when there is not enough history to argue with it', () => {
    // A new user has one or two deposits. Blocking their income on that would
    // be its own kind of wrong.
    const r = reconcileIncome(source, series(2, 30));
    expect(r.conflict).toBe(false);
    expect(r.observed).toBe('unknown');
    expect(r.monthly).toBeCloseTo((4300 * 26) / 12, 2);
  });

  it('does not treat irregular pay as a conflict', () => {
    // Irregular means "we cannot tell", not "you are wrong".
    const r = reconcileIncome(source, ['2026-08-01', '2026-07-20', '2026-05-02', '2026-04-28']);
    expect(r.observed).toBe('irregular');
    expect(r.conflict).toBe(false);
    expect(r.monthly).not.toBeNull();
  });

  it('a monthly declaration paid fortnightly is also caught — it under-reports', () => {
    // The mirror case. This one hides income rather than inventing it, but a
    // wrong number is a wrong number.
    const r = reconcileIncome({ amount: 2000, frequency: 'monthly' }, series(6, 14));
    expect(r.conflict).toBe(true);
    expect(r.observed).toBe('biweekly');
    expect(r.observedMonthly).toBeCloseTo((2000 * 26) / 12, 2);
  });
});
