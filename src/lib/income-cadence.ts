/**
 * #75 — checking a declared pay frequency against the deposits that actually
 * landed.
 *
 * `monthlyIncomeOf` converts a declaration into money (biweekly → × 26 / 12) and
 * nothing ever compared it to reality. Declaring biweekly while being paid
 * monthly inflated income 2.17×, in the largest figure on the screen, and
 * cascaded into "Growing / your wealth is increasing" and a savings-potential
 * number people would act on.
 *
 * The contract here is the same one the runway hero already follows: when the
 * data cannot back the number, the caller gets no number — it gets a conflict to
 * put in front of the user.
 */

import { matchApprovedSources } from '@/lib/classify';
import type { IncomeSource, Transaction } from '@/types';

export type Cadence = 'weekly' | 'biweekly' | 'monthly' | 'yearly';
/** What the deposits look like, including the two honest non-answers. */
export type ObservedCadence = Cadence | 'irregular' | 'unknown';

/**
 * Nominal gap in days, with tolerance for real payroll: paydays slide across
 * weekends and month lengths vary, so these are bands rather than points.
 */
const BANDS: Array<{ cadence: Cadence; min: number; max: number }> = [
  { cadence: 'weekly', min: 5, max: 9 },
  { cadence: 'biweekly', min: 11, max: 18 },
  { cadence: 'monthly', min: 26, max: 35 },
  { cadence: 'yearly', min: 350, max: 380 },
];

/** Two deposits is one gap, and one gap is a coincidence rather than a rhythm. */
const MIN_DEPOSITS = 3;

export interface CadenceReading {
  cadence: ObservedCadence;
  /** Median days between deposits; 0 when there was nothing to measure. */
  medianGapDays: number;
  deposits: number;
}

/**
 * Infers the rhythm from dated deposits. Uses the MEDIAN gap, not the mean: one
 * missed or back-paid cheque skews a mean enough to change the bucket, and a
 * back-pay is exactly the situation where a wrong answer is most costly.
 */
export function observedCadence(depositDates: readonly string[]): CadenceReading {
  const days = [...depositDates]
    .map((d) => Date.parse(`${d.slice(0, 10)}T00:00:00Z`))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);

  if (days.length < MIN_DEPOSITS) {
    return { cadence: 'unknown', medianGapDays: 0, deposits: days.length };
  }

  const gaps: number[] = [];
  for (let i = 1; i < days.length; i++) {
    gaps.push((days[i] - days[i - 1]) / 86_400_000);
  }
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  const medianGapDays =
    gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;

  const band = BANDS.find((b) => medianGapDays >= b.min && medianGapDays <= b.max);
  if (!band) return { cadence: 'irregular', medianGapDays, deposits: days.length };

  /**
   * A median inside a band is not enough on its own. Gaps of 4, 12 and 79 days
   * have a median of 12, which lands squarely in the biweekly band while being
   * obviously not a rhythm. So the gaps have to AGREE: a majority must fall in
   * the same band before we are willing to call it a cadence.
   */
  const inBand = gaps.filter((g) => g >= band.min && g <= band.max).length;
  const agrees = inBand / gaps.length >= 0.6;

  return {
    cadence: agrees ? band.cadence : 'irregular',
    medianGapDays,
    deposits: days.length,
  };
}

/** One month of income at a given cadence. Biweekly is 26 a year, not 24. */
export function monthlyFromCadence(amount: number, cadence: Cadence): number {
  switch (cadence) {
    case 'yearly': return amount / 12;
    case 'biweekly': return (amount * 26) / 12;
    case 'weekly': return (amount * 52) / 12;
    case 'monthly': return amount;
  }
}

export interface IncomeReconciliation {
  /**
   * The monthly figure, or NULL when the declaration and the deposits disagree.
   * Null is the point: a caller cannot accidentally render a number it was not
   * given.
   */
  monthly: number | null;
  declared: Cadence;
  observed: ObservedCadence;
  conflict: boolean;
  /** What it would be if the deposits are the truth — for the resolution prompt. */
  observedMonthly: number | null;
  medianGapDays: number;
  deposits: number;
}

/**
 * Cross-checks one income source against its own deposits.
 *
 * Only a CONFIDENT disagreement is a conflict. 'unknown' (a new user with one or
 * two deposits) and 'irregular' (genuinely erratic pay) both mean "we cannot
 * tell" — blocking someone's income figure on that would be its own kind of
 * wrong, so the declaration stands.
 */
export function reconcileIncome(
  source: { amount: number; frequency: Cadence },
  depositDates: readonly string[]
): IncomeReconciliation {
  const reading = observedCadence(depositDates);
  const declaredMonthly = monthlyFromCadence(source.amount, source.frequency);

  const measurable = reading.cadence !== 'unknown' && reading.cadence !== 'irregular';
  const conflict = measurable && reading.cadence !== source.frequency;

  return {
    monthly: conflict ? null : declaredMonthly,
    declared: source.frequency,
    observed: reading.cadence,
    conflict,
    observedMonthly: measurable
      ? monthlyFromCadence(source.amount, reading.cadence as Cadence)
      : null,
    medianGapDays: reading.medianGapDays,
    deposits: reading.deposits,
  };
}

export interface SourceReconciliation extends IncomeReconciliation {
  sourceId: string;
  sourceName: string;
}

/**
 * Cross-checks every active source against the deposits that matched it, using
 * the SAME matcher the income classifier uses (`matchApprovedSources`) — a
 * second, looser rule here would just be a new way for two screens to disagree.
 */
export function reconcileAllIncome(
  sources: readonly IncomeSource[] | undefined,
  transactions: readonly Transaction[]
): SourceReconciliation[] {
  return (sources ?? [])
    .filter((s) => s.isActive)
    .map((s) => {
      const deposits = transactions
        .filter((t) => matchApprovedSources(t, [s]).length > 0)
        .map((t) => t.date);
      return {
        sourceId: s.id,
        sourceName: s.name,
        ...reconcileIncome({ amount: s.amount, frequency: s.frequency as Cadence }, deposits),
      };
    });
}

/**
 * The monthly total, or null when ANY source is in conflict.
 *
 * Deliberately all-or-nothing. Summing the sources that happen to agree and
 * quietly dropping the one that does not would produce a confident total that is
 * wrong by exactly the amount in dispute — which is the failure this whole
 * module exists to stop.
 */
export function totalMonthlyIncome(reconciliations: readonly SourceReconciliation[]): number | null {
  if (reconciliations.some((r) => r.conflict)) return null;
  return reconciliations.reduce((sum, r) => sum + (r.monthly ?? 0), 0);
}
