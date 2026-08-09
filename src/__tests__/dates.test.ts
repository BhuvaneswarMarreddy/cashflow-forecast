/**
 * #30(b) — a card's due DAY (1–31) must clamp to the real month length.
 * new Date(2026, 8, 31) silently rolls to Oct 1; a due-day-31 card then
 * shows a wrong month's due date on the dashboard.
 */
import { clampedMonthlyDate, lastScheduledSyncSlot } from '@/lib/dates';

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

/**
 * INV-1 — the producer `driftStatus` never had: the most recent Plaid sync slot
 * (07:00/13:00/19:00 America/Chicago — functions-sync/main.py:168, `0 7,13,19 * * *`)
 * at or before a given instant.
 *
 * Every case below is checked against a fixed instant, never `new Date()` — a test
 * that reads the clock at run time can't fail reliably tomorrow.
 */
describe('lastScheduledSyncSlot', () => {
  test('just after 07:00 local -> today\'s 07:00 (winter, CST = UTC-6)', () => {
    // 2026-01-15T13:05:00Z is 07:05 CST. A fixed-6h-threshold implementation would
    // also pass this one; the next two cases are the ones that catch it.
    const slot = lastScheduledSyncSlot(new Date('2026-01-15T13:05:00Z'));
    expect(slot.toISOString()).toBe('2026-01-15T13:00:00.000Z');
  });

  test('just before 07:00 local -> YESTERDAY\'s 19:00, not "no slot yet"', () => {
    // 2026-01-15T12:55:00Z is 06:55 CST. The overnight gap is 12h — a fixed 6h/12h
    // staleness window would misfire here, which is the whole reason this function
    // exists instead of one. Expected slot: 2026-01-14 19:00 CST = 2026-01-15T01:00Z.
    const slot = lastScheduledSyncSlot(new Date('2026-01-15T12:55:00Z'));
    expect(slot.toISOString()).toBe('2026-01-15T01:00:00.000Z');
  });

  test('exactly on a slot boundary counts as that slot ("at or before")', () => {
    const slot = lastScheduledSyncSlot(new Date('2026-01-15T19:00:00Z')); // 13:00:00 CST exactly
    expect(slot.toISOString()).toBe('2026-01-15T19:00:00.000Z');
  });

  test('"yesterday" crosses a YEAR boundary correctly (Jan 1 -> Dec 31 prior year)', () => {
    // 2026-01-01T12:55:00Z is 06:55 CST — before 07:00, so the answer is Dec 31
    // 2025's 19:00 CST (= 2026-01-01T01:00Z). A month-rollback that special-cases
    // "day 1 -> day 28" (true for the Feb case but wrong everywhere else) or that
    // forgets to roll the YEAR back too would both miss this by days, not hours.
    const slot = lastScheduledSyncSlot(new Date('2026-01-01T12:55:00Z'));
    expect(slot.toISOString()).toBe('2026-01-01T01:00:00.000Z');
  });

  test('DST spring-forward (2026-03-08): today\'s slot uses the NEW offset (CDT = UTC-5)', () => {
    // 2026-03-08T20:00:00Z is 15:00 CDT (clocks jumped forward at 2am local).
    // Today's most recent slot is 13:00 CDT = 18:00Z, not 19:00Z (the CST offset).
    const slot = lastScheduledSyncSlot(new Date('2026-03-08T20:00:00Z'));
    expect(slot.toISOString()).toBe('2026-03-08T18:00:00.000Z');
  });

  test('DST spring-forward: "yesterday" still uses the OLD offset (CST) it actually ran under', () => {
    // 2026-03-08T11:55:00Z is 06:55 CDT (today, post-transition) — before 07:00, so
    // the answer is YESTERDAY's 19:00, but yesterday (Mar 7) was still CST (UTC-6):
    // 2026-03-07T19:00 CST = 2026-03-08T01:00Z. Using today's offset for yesterday's
    // slot would be off by an hour.
    const slot = lastScheduledSyncSlot(new Date('2026-03-08T11:55:00Z'));
    expect(slot.toISOString()).toBe('2026-03-08T01:00:00.000Z');
  });

  test('DST fall-back (2026-11-01): today\'s slot uses the NEW offset (CST = UTC-6)', () => {
    // 2026-11-01T20:00:00Z is 14:00 CST (clocks fell back at 2am local).
    // Today's most recent slot is 13:00 CST = 19:00Z, not 18:00Z (the CDT offset).
    const slot = lastScheduledSyncSlot(new Date('2026-11-01T20:00:00Z'));
    expect(slot.toISOString()).toBe('2026-11-01T19:00:00.000Z');
  });

  test('DST fall-back: "yesterday" still uses the OLD offset (CDT) it actually ran under', () => {
    // 2026-11-01T12:55:00Z is 06:55 CST (today, post-transition) — before 07:00, so
    // the answer is YESTERDAY's 19:00, but yesterday (Oct 31) was still CDT (UTC-5):
    // 2026-10-31T19:00 CDT = 2026-11-01T00:00Z.
    const slot = lastScheduledSyncSlot(new Date('2026-11-01T12:55:00Z'));
    expect(slot.toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });
});
