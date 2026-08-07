/**
 * UI-102 — the Home hero's numbers, one computation for one screen.
 *
 * Runway is cash over real monthly burn; the audit found the old screens
 * recomputed figures like this per-panel and disagreed (runway changed with
 * the chart's display range). This function takes MONEY inputs only.
 * 5 months is the owner's stated emergency-reserve target (2 checking +
 * 3 savings — see the 2026-08-06 financial plan).
 */
export const RESERVE_TARGET_MONTHS = 5;

export interface HomeSummaryInput {
  currentCash: number;
  avgMonthlyExpense: number;
  cardsOwed: number;
  lockedMonthly: number;
  today: Date;
}

/** Mean length of a month. Days are the readable unit for a short runway. */
const DAYS_PER_MONTH = 30.44;

export interface HomeSummary {
  /**
   * Months current cash lasts at the average burn, 1-decimal. NOT capped — the
   * cap belongs to reserveProgress alone. Capping this reported a five-month
   * date to someone holding a year of cash.
   */
  runwayMonths: number;
  /** The same runway in whole days — how a sub-two-month runway is actually read. */
  runwayDays: number;
  /** The calendar date the runway reaches. Meaningless when hasBurn is false. */
  runwayDate: Date;
  /**
   * False when no spending has been measured yet. The caller must not render a
   * runway at all in that case: there is no burn to divide by, so any figure
   * shown would be invented.
   */
  hasBurn: boolean;
  /** Runway measured against the 5-month reserve target, 0..1. */
  reserveProgress: number;
  /** The next whole month of runway worth chasing; 0 once the target is met. */
  nextMonthTarget: number;
  /** Cash still needed to reach nextMonthTarget; 0 once the target is met. */
  amountToNextMonth: number;
  cardsOwed: number;
  lockedMonthly: number;
}

/**
 * How the runway is spoken. Under three months nobody thinks in decimals of a
 * month — "0.3 months" was the old hero and it reads as a score, not a deadline.
 */
export function runwayLabel(s: Pick<HomeSummary, 'runwayDays' | 'runwayMonths' | 'hasBurn'>): string {
  if (!s.hasBurn) return 'Not measured yet';
  if (s.runwayDays < 90) return `${s.runwayDays} day${s.runwayDays === 1 ? '' : 's'}`;
  return `${s.runwayMonths} months`;
}

export function homeSummary(i: HomeSummaryInput): HomeSummary {
  const hasBurn = i.avgMonthlyExpense > 0;
  const raw = !hasBurn || i.currentCash <= 0 ? 0 : i.currentCash / i.avgMonthlyExpense;
  const runwayMonths = Math.round(raw * 10) / 10;
  const runwayDays = Math.round(raw * DAYS_PER_MONTH);

  const runwayDate = new Date(i.today);
  runwayDate.setDate(runwayDate.getDate() + runwayDays);

  // The motivating figure. "6% of a five-month target" is a score; "$1,400 buys
  // your first month" is something to do this week. Chasing the NEXT whole month
  // keeps the goal close enough to be believable.
  const reached = Math.floor(runwayMonths);
  const nextMonthTarget = !hasBurn || reached >= RESERVE_TARGET_MONTHS ? 0 : reached + 1;
  const amountToNextMonth = nextMonthTarget
    ? Math.max(0, Math.round((nextMonthTarget * i.avgMonthlyExpense - i.currentCash) * 100) / 100)
    : 0;

  return {
    runwayMonths,
    runwayDays,
    runwayDate,
    hasBurn,
    reserveProgress: Math.min(runwayMonths / RESERVE_TARGET_MONTHS, 1),
    nextMonthTarget,
    amountToNextMonth,
    cardsOwed: i.cardsOwed,
    lockedMonthly: i.lockedMonthly,
  };
}
