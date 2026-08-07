/**
 * UI-102 — the Home hero's numbers, computed once, tested here.
 * Runway = how long current cash lasts at the real monthly burn;
 * reserve progress = runway measured against the owner's 5-month target.
 * No display range, no account selection, nothing changes these but money.
 */
import { homeSummary, runwayLabel } from '@/lib/home';

const base = {
  currentCash: 6000,
  avgMonthlyExpense: 2000,
  cardsOwed: 5121.22,
  lockedMonthly: 263.55,
  today: new Date('2026-08-07T12:00:00'),
};

describe('homeSummary', () => {
  test('runway: cash over burn, and the date it runs out', () => {
    const s = homeSummary(base);
    expect(s.runwayMonths).toBe(3);
    expect(s.runwayDate.getFullYear()).toBe(2026);
    expect(s.runwayDate.getMonth()).toBe(10); // Nov (Aug + 3)
  });

  test('reserve progress is runway against the 5-month target, capped at 1', () => {
    expect(homeSummary(base).reserveProgress).toBe(0.6);
    expect(homeSummary({ ...base, currentCash: 20000 }).reserveProgress).toBe(1);
  });

  test('zero burn does not divide by zero — and does not invent a runway', () => {
    const s = homeSummary({ ...base, avgMonthlyExpense: 0 });
    // No spending measured means no runway can be computed. Reporting "5 months"
    // (or any date) would be a number the data cannot back.
    expect(s.hasBurn).toBe(false);
    expect(s.runwayMonths).toBe(0);
    expect(s.amountToNextMonth).toBe(0);
  });

  test('negative cash means no runway, zero progress', () => {
    const s = homeSummary({ ...base, currentCash: -500 });
    expect(s.runwayMonths).toBe(0);
    expect(s.reserveProgress).toBe(0);
  });

  test('passes through the debt and locked figures untouched', () => {
    const s = homeSummary(base);
    expect(s.cardsOwed).toBe(5121.22);
    expect(s.lockedMonthly).toBe(263.55);
  });

  test('fractional runway rounds to one decimal for display honesty', () => {
    const s = homeSummary({ ...base, currentCash: 5000 });
    expect(s.runwayMonths).toBe(2.5);
  });
});

/**
 * UI-112 — the hero used to lead with a runway DATE and a figure like
 * "0.3 months", which is both unreadable and, above the 5-month target, untrue:
 * runwayMonths was capped at 5, so someone with a year of cash was shown a date
 * five months out. Days are how a short runway is actually thought about, and
 * the cap belongs to the progress bar alone.
 */
describe('homeSummary — readable and honest runway', () => {
  test('runway is also expressed in whole days', () => {
    expect(homeSummary(base).runwayDays).toBe(91); // 3 months × 30.44
    expect(homeSummary({ ...base, currentCash: 600 }).runwayDays).toBe(9);
  });

  test('runway above the reserve target is reported in full, not clipped to it', () => {
    const s = homeSummary({ ...base, currentCash: 20000 }); // 10 months of burn
    expect(s.runwayMonths).toBe(10);
    expect(s.reserveProgress).toBe(1); // the CAP lives here, and only here
    expect(s.runwayDate.getMonth()).toBe(5); // Jun 2027, not Jan
    expect(s.runwayDate.getFullYear()).toBe(2027);
  });

  test('names the next whole month of runway and what it costs to get there', () => {
    // The motivating number: not "you are 6% of the way", but "$1,400 buys you
    // your first month".
    const broke = homeSummary({ ...base, currentCash: 600 }); // 0.3 months
    expect(broke.nextMonthTarget).toBe(1);
    expect(broke.amountToNextMonth).toBe(1400); // 1 × 2000 − 600

    const mid = homeSummary({ ...base, currentCash: 5000 }); // 2.5 months
    expect(mid.nextMonthTarget).toBe(3);
    expect(mid.amountToNextMonth).toBe(1000); // 3 × 2000 − 5000
  });

  test('a runway sitting exactly on a whole month still chases the next one', () => {
    const s = homeSummary(base); // exactly 3.0 months
    expect(s.nextMonthTarget).toBe(4);
    expect(s.amountToNextMonth).toBe(2000);
  });

  test('once the reserve target is reached there is nothing left to chase', () => {
    const s = homeSummary({ ...base, currentCash: 20000 });
    expect(s.nextMonthTarget).toBe(0);
    expect(s.amountToNextMonth).toBe(0);
  });

  test('a short runway is spoken in days, a long one in months', () => {
    expect(runwayLabel(homeSummary({ ...base, currentCash: 600 }))).toBe('9 days');
    expect(runwayLabel(homeSummary(base))).toBe('3 months'); // 91 days
    expect(runwayLabel(homeSummary({ ...base, currentCash: 0 }))).toBe('0 days');
  });

  test('with no measured spending the hero says so instead of showing a number', () => {
    expect(runwayLabel(homeSummary({ ...base, avgMonthlyExpense: 0 }))).toBe('Not measured yet');
  });

  test('an overdrawn balance must be climbed out of before month one counts', () => {
    const s = homeSummary({ ...base, currentCash: -500 });
    expect(s.runwayDays).toBe(0);
    expect(s.nextMonthTarget).toBe(1);
    expect(s.amountToNextMonth).toBe(2500); // 1 × 2000 − (−500), not 2000
  });
});
