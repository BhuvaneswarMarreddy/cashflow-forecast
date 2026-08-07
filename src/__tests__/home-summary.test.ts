/**
 * UI-102 — the Home hero's numbers, computed once, tested here.
 * Runway = how long current cash lasts at the real monthly burn;
 * reserve progress = runway measured against the owner's 5-month target.
 * No display range, no account selection, nothing changes these but money.
 */
import { homeSummary } from '@/lib/home';

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

  test('zero burn does not divide by zero — runway caps at the 5-month target', () => {
    const s = homeSummary({ ...base, avgMonthlyExpense: 0 });
    expect(s.runwayMonths).toBe(5);
    expect(s.reserveProgress).toBe(1);
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
