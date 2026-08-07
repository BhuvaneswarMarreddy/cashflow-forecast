/**
 * #30(b) — a card's due DAY (1–31) must clamp to the real month length.
 * new Date(2026, 8, 31) silently rolls to Oct 1; a due-day-31 card then
 * shows a wrong month's due date on the dashboard.
 */
import { clampedMonthlyDate } from '@/lib/dates';

describe('clampedMonthlyDate', () => {
  test('day within month passes through', () => {
    const d = clampedMonthlyDate(2026, 7, 27); // Aug 27
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 7, 27]);
  });

  test('day 31 clamps in a 30-day month instead of rolling over', () => {
    const d = clampedMonthlyDate(2026, 8, 31); // Sep → 30
    expect([d.getMonth(), d.getDate()]).toEqual([8, 30]);
  });

  test('day 31 clamps to Feb 28 in a non-leap year', () => {
    const d = clampedMonthlyDate(2026, 1, 31);
    expect([d.getMonth(), d.getDate()]).toEqual([1, 28]);
  });

  test('month overflow still works: month 12 = January next year', () => {
    const d = clampedMonthlyDate(2026, 12, 31); // "next month" after Dec
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2027, 0, 31]);
  });
});
