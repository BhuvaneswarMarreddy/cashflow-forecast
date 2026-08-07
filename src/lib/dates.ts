/**
 * #30(b) — build "day N of month M" without JS Date's silent rollover.
 * new Date(2026, 8, 31) is Oct 1, so a due-day-31 card showed next month's
 * date. Month overflow (12 → next January) is preserved; only the DAY clamps.
 */
export function clampedMonthlyDate(year: number, month: number, day: number): Date {
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(day, daysInMonth));
}
