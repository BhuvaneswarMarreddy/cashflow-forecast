/**
 * MAP-002 — the evidence a ledger already carries about its own unmapped money.
 *
 * MAP-001 grouped the unmapped and then said "no evidence, you decide" for 45 of the
 * owner's 50 unknown-inflow groups. Everything a human worked out by hand in an hour —
 * "that payer is an employer", "that series stopped in May", "five paychecks are
 * missing", "that credit already has a refund proposal", "that deposit is a loan" — was
 * derivable from the ledger itself. This module derives it.
 *
 * PURE: no React, no Firestore, no I/O, no network, no clock. Every function takes rows
 * and returns facts about those rows.
 *
 * NO VENDOR LIST, NO NAME LIST. Nothing here recognises an employer, a bank, a lender or
 * a tax agency by name. Every detector works on SHAPE — cadence, direction, amount band,
 * account type, and the owner's own account names — the same discipline
 * `service-identity.ts` holds to, and `mapping-suggestions.test.ts` asserts it the same
 * way. A government-refund detector was considered and DELIBERATELY LEFT OUT: nothing
 * distinguishes an annual credit from a tax agency from an annual credit from anyone
 * else without knowing the agency's name, and a name list is the one thing this codebase
 * refuses.
 *
 * The cadence rule set is NOT reinvented here. `detectPayerSeries()` is
 * `detectRecurring()`'s rule set — >= 3 unique days, >= $5, amount spread <= 25% of the
 * median, a median gap inside a `BANDS` band, >= 60% of gaps in that band — applied to
 * the other side of the ledger, and `seriesEndDate()` reuses that function's own
 * "still active" test rather than inventing a second staleness rule.
 *
 * Amounts are INTEGER CENTS throughout.
 */

import { PaymentAccount, Transaction } from '@/types';
import { ProposedLink, ReviewCandidate, isTerminalCandidateStatus } from './candidates';
import { BANDS, RecurringItem, day, daysBetween, isDebtAccount, median, normalizeMerchant, toCents } from './flows';

const addDays = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

const uniqueDays = (rows: readonly Transaction[]) => [...new Set(rows.map((t) => day(t.date)))].sort();

/** Money lands here, rather than paying down a debt. Asked of `flows.ts`, not re-listed. */
export const isDepositAccount = (a?: PaymentAccount) => !!a && !isDebtAccount(a);

// ---------------------------------------------------------------------------
// 1. Payer series — the payroll shape, and the only cadence rule set in the app
// ---------------------------------------------------------------------------

export interface PayerSeries {
  cadence: NonNullable<RecurringItem['cadence']>;
  /** The band's upper bound, carried so the staleness test stays the band's own. */
  bandHighDays: number;
  medianGapDays: number;
  medianCents: number;
  /** The widest observed distance from the median. An income source built from this
   *  series uses it so the source matches THESE deposits and not every deposit. */
  toleranceCents: number;
  occurrences: number;
  firstDate: string;
  lastDate: string;
  /** Distinct yyyy-MM the payments fall in — "spanning multiple months", measured. */
  months: number;
  /** Fraction of gaps inside the band. `detectRecurring()`'s `confidence`, same meaning. */
  inBand: number;
  /**
   * Whether the amounts hold `detectRecurring()`'s 25%-of-median spread rule.
   *
   * MEASURED, and the reason this is a SIGNAL rather than a GATE: the owner's real
   * 21-payment salary series scatters 44% around its median — small extra payments from
   * the same employer land in the same merchant group as the paychecks. A subscription's
   * amount is fixed; a person's pay is not. Gating on 25% rejected the very series this
   * detector exists to find, so the rule survives as confidence: a tight band scores
   * higher, a scattered one still gets found and says so in its own sentence.
   */
  bandTight: boolean;
}

/**
 * Repeated payments from ONE payer on a detectable cadence.
 *
 * The CADENCE rules are `detectRecurring()`'s, unchanged and not re-derived: at least 3
 * unique days, a median amount of at least $5, a median gap inside a `BANDS` band, and at
 * least 60% of gaps inside that band. There is one cadence rule set in this app.
 *
 * The caller supplies rows that already share a payer — a mapping group is exactly that —
 * so "one payer" is the caller's guarantee and the shape is this function's.
 */
export function detectPayerSeries(rows: readonly Transaction[]): PayerSeries | null {
  const dates = uniqueDays(rows);
  if (dates.length < 3) return null;                                   // rule 1
  const amounts = rows.map((t) => toCents(t.amount));
  const med = median(amounts);
  if (med < 500) return null;                                          // rule 3: >= $5
  const gaps = dates.slice(1).map((d, i) => daysBetween(dates[i], d));
  const mg = median(gaps);
  const band = BANDS.find(([, lo, hi]) => mg >= lo && mg <= hi);
  if (!band) return null;
  const [cadence, lo, hi] = band;
  const inBand = gaps.filter((g) => g >= lo && g <= hi).length / gaps.length;
  if (inBand < 0.6) return null;                                       // rule 2
  return {
    cadence,
    bandHighDays: hi,
    medianGapDays: mg,
    medianCents: med,
    toleranceCents: Math.max(100, ...amounts.map((a) => Math.abs(a - med))),
    occurrences: dates.length,
    firstDate: dates[0],
    lastDate: dates[dates.length - 1],
    months: new Set(dates.map((d) => d.slice(0, 7))).size,
    inBand,
    bandTight: median(amounts.map((a) => Math.abs(a - med))) <= med * 0.25,
  };
}

/**
 * When a series has clearly STOPPED, the date of its last payment; otherwise `undefined`.
 *
 * The staleness test is `detectRecurring()`'s own: a series is still alive if it was seen
 * within 1.5 of its own cycle length, so a quarterly series is not declared dead at the
 * 45-day mark a monthly one would be. It is measured against the LEDGER'S last day, not
 * the wall clock — an export that ends in May cannot make every series look dead.
 */
export const seriesEndDate = (series: PayerSeries, ledgerLastDate: string): string | undefined =>
  daysBetween(series.lastDate, ledgerLastDate) > series.bandHighDays * 1.5 ? series.lastDate : undefined;

// ---------------------------------------------------------------------------
// 2. Missing periods — the payments the cadence expected and the ledger does not have
// ---------------------------------------------------------------------------

export interface MissingPeriods {
  /** Payments the cadence implies between the first and the last, inclusive. */
  expected: number;
  /** Of those, the ones with no row. */
  missing: number;
  /** yyyy-MM of each absent payment, deduplicated and sorted. */
  months: string[];
}

/**
 * Absent payments, counted BETWEEN the first and last occurrence only.
 *
 * Each real gap is divided by the series' median gap and rounded: a gap of one cycle is a
 * payment that arrived, a gap of two cycles is one that did not. Counting this way rather
 * than walking a fixed grid from the first date is what stops semi-monthly pay — whose
 * gaps alternate 13 and 16 days — accumulating drift and reporting phantom absences.
 *
 * Nothing after the last occurrence is counted: a series that simply stopped is answered
 * by `seriesEndDate()`, not by claiming a year of missed pay.
 */
export function missingPeriods(rows: readonly Transaction[], series: PayerSeries): MissingPeriods {
  const dates = uniqueDays(rows);
  const months: string[] = [];
  for (let i = 1; i < dates.length; i++) {
    const slots = Math.round(daysBetween(dates[i - 1], dates[i]) / series.medianGapDays);
    for (let k = 1; k < slots; k++) months.push(addDays(dates[i - 1], k * series.medianGapDays).slice(0, 7));
  }
  return {
    expected: dates.length + months.length,
    missing: months.length,
    months: [...new Set(months)].sort(),
  };
}

// ---------------------------------------------------------------------------
// 3. Refund evidence — asked of FIN-REFUND-001's generator, never re-derived
// ---------------------------------------------------------------------------

/** The candidate types whose SOURCE is a credit being allocated against a purchase. */
const REFUND_CANDIDATE_TYPES: readonly ReviewCandidate['candidateType'][] = [
  'refund_match',
  'partial_refund_match',
  'combined_refund_match',
];

export interface RefundEvidence {
  /** Rows of this group that already carry a refund proposal. */
  rowIds: string[];
  exact: number;
  partial: number;
  combined: number;
  /** The best score the generator gave any of them. Its ladder, not a second one. */
  bestScore: number;
}

/**
 * Which of these rows `generateRefundCandidates()` has ALREADY matched to a purchase.
 *
 * This function does no matching. It reads the generator's output — the proposals live on
 * `proposedLinks`, whose `sourceTransactionId` is the credit — so there is exactly one
 * refund matcher in the app and this is not it. Candidates the owner has already decided
 * (`confirmed`/`dismissed`/`intentional`) are not evidence of an open question.
 */
export function refundEvidenceFor(
  rows: readonly Transaction[],
  candidates: readonly ReviewCandidate[]
): RefundEvidence | null {
  const ids = new Set(rows.map((t) => t.id));
  const hit = { rowIds: new Set<string>(), exact: 0, partial: 0, combined: 0, bestScore: 0 };
  for (const c of candidates) {
    if (isTerminalCandidateStatus(c.status)) continue;
    if (!REFUND_CANDIDATE_TYPES.includes(c.candidateType)) continue;
    const credits = c.proposedLinks.filter((l: ProposedLink) => ids.has(l.sourceTransactionId));
    if (!credits.length) continue;
    for (const l of credits) hit.rowIds.add(l.sourceTransactionId);
    if (c.candidateType === 'refund_match') hit.exact++;
    else if (c.candidateType === 'partial_refund_match') hit.partial++;
    else hit.combined++;
    hit.bestScore = Math.max(hit.bestScore, c.score);
  }
  return hit.rowIds.size ? { ...hit, rowIds: [...hit.rowIds].sort() } : null;
}

// ---------------------------------------------------------------------------
// 4. Loan proceeds — borrowed money, which is a liability and not a windfall
// ---------------------------------------------------------------------------

export interface LoanProceedsEvidence {
  /** The owner's OWN account name, when that is what identified it. Their data. */
  loanAccountName?: string;
  /** Later payments back to the same payer, on a cadence. */
  repaymentCount?: number;
  repaymentCadence?: RecurringItem['cadence'];
  confidence: number;
}

/** Two normalized names are the same party when one contains the other. Length-guarded
 *  so a two-letter overlap cannot make every deposit a loan. */
const namesAgree = (a: string, b: string) =>
  a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a));

/**
 * A large one-off inflow that is BORROWED money.
 *
 * Two derived routes, neither of which needs to know a single lender's name:
 *   (a) the payer is one of the owner's OWN loan accounts — the disbursement of a loan
 *       they hold, identified from their own account list;
 *   (b) money went back to that same payer afterwards, repeatedly and on a cadence, for
 *       far less each time than arrived — which is what repaying a loan looks like.
 *
 * The size guard is what keeps a refund out: a refund is never many times larger than the
 * payments that follow it, because there are no payments that follow it.
 */
export function detectLoanProceeds(
  rows: readonly Transaction[],
  signalValue: string,
  laterOutflowsToSamePayer: readonly Transaction[],
  accounts: readonly PaymentAccount[]
): LoanProceedsEvidence | null {
  if (!signalValue || rows.length > 2) return null;                    // a one-off, not a series
  const inCents = median(rows.map((t) => toCents(t.amount)));
  if (inCents < 100_000) return null;                                  // "large": >= $1,000

  const payer = normalizeMerchant(signalValue);
  const loanAccount = accounts.find(
    (a) => a.type === 'personal_loan' && namesAgree(normalizeMerchant(a.name), payer)
  );

  const repayments = detectPayerSeries(laterOutflowsToSamePayer);
  const repaid =
    repayments && inCents >= median(laterOutflowsToSamePayer.map((t) => toCents(t.amount))) * 3
      ? repayments
      : null;

  if (!loanAccount && !repaid) return null;
  return {
    ...(loanAccount ? { loanAccountName: loanAccount.name } : {}),
    ...(repaid ? { repaymentCount: repaid.occurrences, repaymentCadence: repaid.cadence } : {}),
    confidence: loanAccount && repaid ? 0.85 : loanAccount ? 0.75 : 0.7,
  };
}

// ---------------------------------------------------------------------------
// 5. Shared tokens — what an income source should match on, taken from the rows
// ---------------------------------------------------------------------------

const tokensOf = (t: Transaction) =>
  new Set(
    `${t.merchant ?? ''} ${t.title ?? ''} ${t.description ?? ''}`
      .toUpperCase()
      .split(/[^A-Z0-9]+/)
      .filter((w) => w.length >= 4 && !/^\d+$/.test(w))
  );

/**
 * The words every one of these rows contains, longest first.
 *
 * This is the alias a future deposit has to carry to be recognised as the same payer, and
 * it is read off the owner's own statement text — there is no dictionary here. Confirmation
 * numbers and dates drop out on their own: they differ row to row, so they are not shared.
 */
export function sharedTokens(rows: readonly Transaction[], limit = 3): string[] {
  let shared: Set<string> | null = null;
  for (const t of rows) {
    const here = tokensOf(t);
    shared = shared ? new Set([...shared].filter((w: string) => here.has(w))) : here;
    if (!shared.size) return [];
  }
  return [...(shared ?? new Set<string>())]
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .slice(0, limit);
}
