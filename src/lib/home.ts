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

export interface HomeSummary {
  /** Months current cash lasts at the average burn, 1-decimal, capped at the target. */
  runwayMonths: number;
  /** The calendar date the runway reaches. */
  runwayDate: Date;
  /** Runway measured against the 5-month reserve target, 0..1. */
  reserveProgress: number;
  cardsOwed: number;
  lockedMonthly: number;
}

export function homeSummary(i: HomeSummaryInput): HomeSummary {
  const raw =
    i.currentCash <= 0
      ? 0
      : i.avgMonthlyExpense <= 0
        ? RESERVE_TARGET_MONTHS // no burn measured: cash lasts beyond any target
        : i.currentCash / i.avgMonthlyExpense;
  const runwayMonths = Math.round(Math.min(raw, RESERVE_TARGET_MONTHS) * 10) / 10;
  const runwayDate = new Date(i.today);
  runwayDate.setDate(runwayDate.getDate() + Math.round(runwayMonths * 30.44));
  return {
    runwayMonths,
    runwayDate,
    reserveProgress: Math.min(runwayMonths / RESERVE_TARGET_MONTHS, 1),
    cardsOwed: i.cardsOwed,
    lockedMonthly: i.lockedMonthly,
  };
}
