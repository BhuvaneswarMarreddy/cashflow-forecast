/**
 * Duplicate charges and duplicate subscriptions — FIN-DUPLICATE-001.
 *
 * THREE DIFFERENT THINGS ARE CALLED "DUPLICATE", AND CONFLATING THEM IS HOW A DETECTOR
 * DELETES REAL MONEY:
 *
 *  1. TECHNICAL — one real event, two ingestion sightings. Owned by src/lib/fingerprint.ts
 *     (mirrored byte-for-byte by functions-sync/simplefin.py::signed_cents_of, and neither
 *     may be changed independently). It is resolved at ingest, BEFORE this module ever
 *     sees two rows, and it must NEVER surface as a user-facing alert. This module changes
 *     nothing there and stays strictly ABOVE it: two rows carrying the same stored
 *     `fingerprint` are skipped outright.
 *  2. ECONOMIC — two real posted charges for one economic event. `immediate_duplicate_charge`.
 *  3. DUPLICATE SUBSCRIPTION — two live recurring series for one service, on two accounts.
 *     `duplicate_subscription` / `subscription_overlap`.
 *
 * NOTHING HERE EVER DELETES A TRANSACTION. There is no delete path in this file, none in
 * the parser, and firestore.rules denies delete on both new collections. A confirmed
 * duplicate is an ANNOTATION ON REAL MONEY: both rows stay counted in every total until
 * the owner separately deletes one through the ordinary transaction UI, which this task
 * does not touch. Every decision in §8 is a statement about the ALERT, not about the money.
 *
 * PURE module — no Firestore, no React, no I/O. It produces candidates; FIN-RECOVERY-UI-001
 * renders them and persists the owner's decision through FIN-RELATION-001's store.
 *
 * WHAT IS REUSED AND WHAT IS SUPERSEDED (§2):
 *   Reused verbatim from src/lib/flows.ts — `normalizeMerchant`, `median`, `daysBetween`,
 *   `toCents`, `day`, the `BANDS` cadence table, the `RecurringItem` field vocabulary, and
 *   the four `detectRecurring` rules (flows.ts:391-402). Those four exist because "each
 *   killed a verified false result on the real data"; they are not re-derived, not loosened
 *   and not re-tuned here.
 *   Superseded — `detectRecurring()`'s GROUPING KEY, and nothing else. It groups by merchant
 *   ALONE and reports the modal account (flows.ts:380-387, :404-412), so two live
 *   subscriptions to one service on two cards collapse into one `RecurringItem` and the
 *   second is invisible BY CONSTRUCTION. `detectRecurringByAccount()` below keys on
 *   (serviceFamilyId, accountId, currency) instead. `detectRecurring()` and
 *   `SubscriptionsPanel` are NOT modified and keep working exactly as they do.
 */

import { AccountType, PaymentAccount, Transaction } from '@/types';
import { IncomeContext, interpretTransaction } from './classify';
import { BANDS, RecurringItem, day, daysBetween, median, toCents } from './flows';
import {
  CandidateEvidence,
  CandidateStatus,
  CandidateType,
  ProposedLink,
  ReviewCandidate,
  buildCandidateId,
  buildIdentityKey,
  rankCandidates,
  sortedTransactionIds,
} from './candidates';
import { orderSymmetricPair } from './relations';
import {
  AliasResolution,
  ServiceFamily,
  buildAliasIndex,
  proposeFamilyMerge,
  resolveServiceIdentity,
  significantTokens,
} from './service-identity';
import { emit } from './obs/events';
import { startSpan } from './obs/trace';

// ---------------------------------------------------------------------------
// Algorithm versions and thresholds — every number the spec fixes, named once
// ---------------------------------------------------------------------------

export const DUPLICATE_CHARGE_VERSION = 'duplicate-charge-v1';
export const DUPLICATE_SUBSCRIPTION_VERSION = 'duplicate-subscription-v1';

/** §3.2 — a date gap wider than this is two charges, not one charged twice. */
export const MAX_DUPLICATE_DAY_GAP = 3;

/** §3.2 — the legitimate-repeat guard: N same-amount charges in the trailing window. */
export const REPEAT_WINDOW_DAYS = 90;
export const REPEAT_PATTERN_MIN = 4;

/** §4.2 — E1 and E2. */
export const MIN_CHARGES_PER_ACCOUNT = 2;
export const MIN_OVERLAPPING_PERIODS = 2;

/**
 * §4.3 — the amount band: ±15% or ±$3.00, whichever is WIDER. `$3.00` covers sales-tax
 * variation on a small subscription, `15%` covers a larger one. Deliberately looser than
 * the dispersion rule below, because it answers a different question: dispersion decides
 * whether a SERIES exists, the band decides whether two SERIES are the same product.
 */
export const AMOUNT_BAND_PCT = 0.15;
export const AMOUNT_BAND_FLOOR_CENTS = 300;

/** §4.3 — price drift that keeps historical continuity. */
export const MAX_PRICE_STEP = 0.25;
export const MAX_PRICE_DRIFT = 0.4;

/**
 * The four reused `detectRecurring` rules, as named constants rather than the inline
 * literals at src/lib/flows.ts:391-402. Same values, byte for byte. They are re-declared
 * (not imported) only because flows.ts does not export them and the single sanctioned
 * write into that file is the `export` keyword on `BANDS`. Changing either copy without
 * the other is a defect, and "the reused detectRecurring rules are pinned to flows.ts" in
 * src/__tests__/duplicate-subscriptions.test.ts is what fails when one of them drifts.
 */
export const MIN_UNIQUE_DAYS = 3;
export const MIN_SERIES_CENTS = 500;
export const MAX_DISPERSION = 0.25;
export const MIN_IN_BAND = 0.6;
/** flows.ts:411 — "active" is 1.5x the cadence's OWN upper bound, never a flat 45 days. */
export const ACTIVE_CADENCE_MULTIPLE = 1.5;

/**
 * §6.2 — the mandatory label, and the only one. It is never phrased as money the owner
 * will get back, never a projection into the forecast, never a budget adjustment: a
 * number beside a question, not a number in the ledger.
 */
export const POTENTIAL_ANNUAL_DUPLICATE_COST_LABEL = 'potential annual duplicate cost';

const COMPONENT = 'RecoveryDuplicates';
const ROUTE = '/flow';
const DEFAULT_CURRENCY = 'USD';
const EPOCH = '1970-01-01';

type Cadence = RecurringItem['cadence'];
type Band = (typeof BANDS)[number];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One subscription series on ONE account — the shape `detectRecurring()` cannot express.
 * Field names follow `RecurringItem` so the two are read the same way.
 */
export interface AccountSeries {
  serviceFamilyId: string;
  /** Display/identity only; never emitted in a diagnostic event. */
  normalizedMerchant: string;
  accountId: string;
  currency: string;
  /** null when the observed gaps fall in no cadence band at all. */
  cadence: Cadence | null;
  medianCents: number;
  monthlyCents: number;
  /** Unique charge DAYS, counted exactly as flows.ts:391 counts them. */
  occurrences: number;
  firstSeen: string;
  lastSeen: string;
  active: boolean;
  nextDue: string;
  /** In-band gap ratio (0..1): how regular the cadence actually is. */
  confidence: number;
  /** True when this series satisfies the FULL reused rule set (§4.2 E3). */
  anchor: boolean;
  dates: string[];
  /** Ascending by date, then id. `[0]` is the earliest charge — the identity anchor. */
  transactionIds: string[];
  reasonCodes: string[];
}

/**
 * The owner said "I cancelled it on ⟨date⟩" (`mark_subscription_cancelled`, §7.3).
 *
 * Supplied by the caller: FIN-RELATION-001's store records the DECISION but has no field
 * for the effective date, so FIN-RECOVERY-UI-001 persists it and passes it back in. This
 * module holds no state of its own.
 */
export interface SubscriptionCancellation {
  serviceFamilyId: string;
  /** Omit to arm the whole family; set it to arm one account's series only. */
  accountId?: string;
  effectiveDate: string; // yyyy-MM-dd
}

/**
 * The avoidable-cost figure. Deliberately NOT a field on the stored candidate: it is
 * derived, recomputed on demand, and never persisted beside a decision where it could go
 * stale and start making a claim the data no longer supports.
 */
export interface DuplicateCostEstimate {
  /** The candidate's identityKey, so the UI can join without a second lookup. */
  identityKey: string;
  duplicateMonthlyCents: number;
  potentialAnnualDuplicateCostCents: number;
  label: typeof POTENTIAL_ANNUAL_DUPLICATE_COST_LABEL;
  cheaperAccountId: string;
}

export interface DuplicateOptions {
  todayISO: string;
  /** The owner's confirmed service families. Absent = every merchant is its own family. */
  families?: readonly ServiceFamily[];
  cancellations?: readonly SubscriptionCancellation[];
  /**
   * A row's currency. `Transaction` carries none, so this is the extension point: a
   * differing currency SPLITS a group and is never converted and never assumed.
   */
  currencyOf?: (t: Transaction) => string;
  /** ISO-8601 stamped onto generated candidates. Injectable so runs are reproducible. */
  generatedAt?: string;
  income?: IncomeContext;
  /** Opt-in instrumentation: how many pair comparisons the windowed sweep actually made. */
  stats?: { comparisons: number };
}

export interface DuplicateRunResult {
  /** Ranked: score desc, then generatedAt, then id — never Firestore's return order. */
  candidates: ReviewCandidate[];
  estimates: DuplicateCostEstimate[];
}

/** One eligible row, resolved once so nothing is recomputed inside a loop. */
interface Row {
  t: Transaction;
  id: string;
  cents: number;
  dayISO: string;
  dayNum: number;
  accountId: string;
  /** Absent when the row names an account the caller did not pass in. */
  accountType?: AccountType;
  normalizedMerchant: string;
  serviceFamilyId: string;
  currency: string;
}

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

const dayNumber = (dateISO: string): number => daysBetween(EPOCH, day(dateISO));

const byDateThenId = (a: Row, b: Row): number =>
  a.dayISO.localeCompare(b.dayISO) || a.id.localeCompare(b.id);

const bandOfGap = (medianGap: number): Band | undefined =>
  BANDS.find(([, lo, hi]) => medianGap >= lo && medianGap <= hi);

const bandOfCadence = (cadence: Cadence): Band | undefined => BANDS.find(([c]) => c === cadence);

/** §4.3 — symmetric, so the answer never depends on which series is asked about first. */
export const amountBandToleranceCents = (cents: number): number =>
  Math.max(AMOUNT_BAND_FLOOR_CENTS, Math.round(Math.abs(cents) * AMOUNT_BAND_PCT));

export const sameAmountBand = (a: number, b: number): boolean =>
  Math.abs(a - b) <= Math.max(amountBandToleranceCents(a), amountBandToleranceCents(b));

/**
 * The rows this module is allowed to reason about: POSTED SPENDING, on a real account,
 * with a merchant string to identify. `interpretTransaction()` is the single authority on
 * what counts as spending at all — a hold, a transfer, a card settlement and a refund all
 * fall out here rather than each detector re-deciding.
 */
function eligibleRows(
  transactions: readonly Transaction[],
  accounts: readonly PaymentAccount[],
  options: DuplicateOptions
): Row[] {
  const aliasIndex = buildAliasIndex(options.families ?? []);
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const currencyOf = options.currencyOf ?? (() => DEFAULT_CURRENCY);
  const rows: Row[] = [];

  for (const t of transactions) {
    if (!t.accountId) continue;
    if (interpretTransaction(t, accounts as PaymentAccount[], options.income).expense !== 'counted') continue;
    const identity = resolveServiceIdentity(t, aliasIndex);
    if (!identity.normalizedMerchant) continue;
    const dayISO = day(t.date);
    rows.push({
      t,
      id: t.id,
      cents: toCents(t.amount),
      dayISO,
      dayNum: dayNumber(dayISO),
      accountId: t.accountId,
      accountType: accountById.get(t.accountId)?.type,
      normalizedMerchant: identity.normalizedMerchant,
      serviceFamilyId: identity.serviceFamilyId,
      currency: currencyOf(t),
    });
  }
  return rows;
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const bucket = out.get(key(item));
    if (bucket) bucket.push(item);
    else out.set(key(item), [item]);
  }
  return out;
}

const uniqueAccountTypes = (rows: Row[]): AccountType[] => [
  ...new Set(rows.map((r) => r.accountType).filter((t): t is AccountType => Boolean(t))),
];

// ---------------------------------------------------------------------------
// Price drift (§4.3) — continuity, and where it legitimately breaks
// ---------------------------------------------------------------------------

export interface PriceSegment {
  start: number; // inclusive index into the date-ordered charge list
  end: number; // exclusive
  /** Why this segment was split from the previous one. Absent on the first segment. */
  reasonCode?: string;
}

/**
 * Split one merchant-and-account run of charges wherever the PRICE says it stopped being
 * the same product.
 *
 * A change smaller than the amount band is not a price change at all — that is tax and
 * rounding noise, and treating it as a new product would split every real subscription.
 * Above the band: a rise of ≤25% in one step and ≤40% cumulatively is one series (test
 * S11), while a single step over 25%, a cumulative rise over 40%, or an increase after a
 * decrease splits it and SAYS SO (test S12) rather than silently merging two products.
 *
 * A lone decrease does not split: a price cut is still the same service, and the spec's
 * split trigger is a decrease FOLLOWED BY an increase.
 */
export function segmentPriceDrift(amountsCents: readonly number[]): PriceSegment[] {
  if (amountsCents.length === 0) return [];

  const segments: PriceSegment[] = [];
  let start = 0;
  let reasonCode: string | undefined;
  let level = amountsCents[0];
  let base = amountsCents[0];
  let decreased = false;

  for (let i = 1; i < amountsCents.length; i++) {
    const amount = amountsCents[i];
    if (sameAmountBand(amount, level)) continue; // within-band wobble: not a level change

    let split: string | undefined;
    if (amount > level) {
      if (amount > level * (1 + MAX_PRICE_STEP)) split = 'price_step_exceeded';
      else if (amount > base * (1 + MAX_PRICE_DRIFT)) split = 'price_drift_exceeded';
      else if (decreased) split = 'price_non_monotonic';
    } else {
      decreased = true;
    }

    if (split) {
      segments.push({ start, end: i, ...(reasonCode ? { reasonCode } : {}) });
      start = i;
      reasonCode = split;
      base = amount;
      decreased = false;
    }
    level = amount;
  }

  segments.push({ start, end: amountsCents.length, ...(reasonCode ? { reasonCode } : {}) });
  return segments;
}

// ---------------------------------------------------------------------------
// detectRecurringByAccount — the superseded grouping key, and nothing else
// ---------------------------------------------------------------------------

/**
 * Every subscription series, keyed by (serviceFamilyId, accountId, currency).
 *
 * The four reused rules decide `anchor`. A series that clears the relaxed
 * MIN_CHARGES_PER_ACCOUNT bar but not the full rule set is still RETURNED — §4.2's E3 is
 * what makes the relaxed bar safe, by requiring the OTHER side of a pair to be a properly
 * detected anchor. The relaxed bar never stands alone.
 *
 * O(n) to bucket, O(n log n) total to sort (each row is in exactly one bucket).
 */
export function detectRecurringByAccount(
  transactions: readonly Transaction[],
  accounts: readonly PaymentAccount[],
  options: DuplicateOptions
): AccountSeries[] {
  return seriesFromRows(eligibleRows(transactions, accounts, options), options.todayISO);
}

function seriesFromRows(rows: Row[], todayISO: string): AccountSeries[] {
  const out: AccountSeries[] = [];
  for (const bucket of groupBy(rows, (r) => `${r.serviceFamilyId}|${r.accountId}|${r.currency}`).values()) {
    bucket.sort(byDateThenId);
    for (const segment of segmentPriceDrift(bucket.map((r) => r.cents))) {
      const series = buildSeries(bucket.slice(segment.start, segment.end), segment.reasonCode, todayISO);
      if (series) out.push(series);
    }
  }
  return out.sort(
    (a, b) =>
      a.serviceFamilyId.localeCompare(b.serviceFamilyId) ||
      a.accountId.localeCompare(b.accountId) ||
      a.firstSeen.localeCompare(b.firstSeen) ||
      a.medianCents - b.medianCents
  );
}

function buildSeries(rows: Row[], splitReason: string | undefined, todayISO: string): AccountSeries | null {
  const dates = [...new Set(rows.map((r) => r.dayISO))].sort();
  if (dates.length < MIN_CHARGES_PER_ACCOUNT) return null;

  const amounts = rows.map((r) => r.cents);
  const medianCents = median(amounts);
  const gaps = dates.slice(1).map((d, i) => daysBetween(dates[i], d));
  const medianGap = median(gaps);
  const band = bandOfGap(medianGap);
  const inBand = band ? gaps.filter((g) => g >= band[1] && g <= band[2]).length / gaps.length : 0;

  // The four reused rules, in flows.ts's own order. Not loosened, not re-tuned.
  const anchor =
    dates.length >= MIN_UNIQUE_DAYS &&
    medianCents >= MIN_SERIES_CENTS &&
    median(amounts.map((a) => Math.abs(a - medianCents))) <= medianCents * MAX_DISPERSION &&
    Boolean(band) &&
    inBand >= MIN_IN_BAND;

  const lastSeen = dates[dates.length - 1];
  const first = rows[0];

  return {
    serviceFamilyId: first.serviceFamilyId,
    normalizedMerchant: first.normalizedMerchant,
    accountId: first.accountId,
    currency: first.currency,
    cadence: band ? band[0] : null,
    medianCents,
    monthlyCents: band ? Math.round(medianCents * band[3]) : 0,
    occurrences: dates.length,
    firstSeen: dates[0],
    lastSeen,
    // A series whose gaps match no band has no cycle length to be measured against, so it
    // is not claimed to be live. Conservative on purpose: E4 then refuses the pair.
    active: band ? daysBetween(lastSeen, day(todayISO)) <= band[2] * ACTIVE_CADENCE_MULTIPLE : false,
    nextDue: new Date(Date.parse(`${lastSeen}T00:00:00Z`) + medianGap * 86_400_000).toISOString().slice(0, 10),
    confidence: inBand,
    anchor,
    dates,
    transactionIds: rows.map((r) => r.id),
    reasonCodes: [anchor ? 'anchor_series' : 'relaxed_series', ...(splitReason ? [splitReason] : [])],
  };
}

// ---------------------------------------------------------------------------
// Immediate duplicate charges (§3)
// ---------------------------------------------------------------------------

/** Index of same-amount charge days, so the legitimate-repeat guard is a binary search. */
function repeatIndex(rows: readonly Row[]): Map<string, number[]> {
  const index = groupBy(rows, (r) => `${r.accountId}|${r.normalizedMerchant}|${r.cents}`);
  const out = new Map<string, number[]>();
  for (const [key, bucket] of index) out.set(key, bucket.map((r) => r.dayNum).sort((a, b) => a - b));
  return out;
}

const lowerBound = (sorted: readonly number[], value: number): number => {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

const countInWindow = (sorted: readonly number[], from: number, to: number): number =>
  lowerBound(sorted, to + 1) - lowerBound(sorted, from);

/**
 * Two POSTED outflows that are almost certainly one economic event charged twice.
 *
 * Exact integer-cent equality, no tolerance: a $12.00 and a $12.01 charge are two charges.
 * Same account only — a cross-account "duplicate" of one charge is not a thing, that is a
 * duplicate SUBSCRIPTION (§4). Equal stored fingerprints are skipped outright: the ingest
 * layer already decided those are one row and this detector stays out of it (§1.1).
 *
 * A sorted-by-date sweep with a moving ±3-day window, so it is O(n log n + Σ window),
 * never O(n²) — pass `options.stats` to measure the comparisons it actually made.
 */
export function detectImmediateDuplicates(
  transactions: readonly Transaction[],
  accounts: readonly PaymentAccount[],
  options: DuplicateOptions
): ReviewCandidate[] {
  const rows = eligibleRows(transactions, accounts, options);
  const repeats = repeatIndex(rows);
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const out: ReviewCandidate[] = [];

  for (const bucket of groupBy(rows, (r) => r.accountId).values()) {
    bucket.sort(byDateThenId);
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length && bucket[j].dayNum - bucket[i].dayNum <= MAX_DUPLICATE_DAY_GAP; j++) {
        if (options.stats) options.stats.comparisons++;
        const earlier = bucket[i];
        const later = bucket[j];

        if (earlier.cents !== later.cents) continue;
        // §1.1 — the technical layer's answer wins, and it is not second-guessed.
        if (earlier.t.fingerprint && earlier.t.fingerprint === later.t.fingerprint) continue;

        const merchantMatch: CandidateEvidence['merchantMatch'] | null =
          earlier.normalizedMerchant === later.normalizedMerchant
            ? 'exact'
            : earlier.serviceFamilyId === later.serviceFamilyId
              ? 'family'
              : null;
        if (!merchantMatch) continue;

        out.push(buildChargeCandidate(earlier, later, merchantMatch, repeats, generatedAt));
      }
    }
  }
  return out;
}

function buildChargeCandidate(
  earlier: Row,
  later: Row,
  merchantMatch: CandidateEvidence['merchantMatch'],
  repeats: Map<string, number[]>,
  generatedAt: string
): ReviewCandidate {
  const dayGap = later.dayNum - earlier.dayNum;

  // The legitimate-repeated-purchase guard (§3.2, test U3). A daily same-amount purchase
  // from one shop is COUNTER-EVIDENCE, scored as such rather than hardcoded as a merchant
  // exception — the frequency itself is the signal.
  //
  // The window is the 90 days ENDING at the later charge, slid forward when the ledger
  // does not yet hold 90 days of history for this merchant — otherwise the first weeks of
  // any import score 0.90 purely because nothing had been imported yet, which is an
  // artefact of the import date rather than a fact about the money.
  const sameAmountDays = repeats.get(`${later.accountId}|${later.normalizedMerchant}|${later.cents}`) ?? [];
  const windowStart = Math.max(sameAmountDays[0] ?? later.dayNum, later.dayNum - REPEAT_WINDOW_DAYS);
  const repeatPattern =
    countInWindow(sameAmountDays, windowStart, windowStart + REPEAT_WINDOW_DAYS) >= REPEAT_PATTERN_MIN;

  const score = repeatPattern ? 0.3 : merchantMatch === 'exact' ? (dayGap <= 1 ? 0.9 : 0.75) : 0.6;

  const transactionIds = sortedTransactionIds([earlier.id, later.id]);
  const { sourceTransactionId, targetTransactionId } = orderSymmetricPair(
    { id: earlier.id, date: earlier.dayISO },
    { id: later.id, date: later.dayISO }
  );

  return {
    id: buildIdentityKey('immediate_duplicate_charge', transactionIds),
    candidateId: buildCandidateId('immediate_duplicate_charge', DUPLICATE_CHARGE_VERSION, transactionIds),
    candidateType: 'immediate_duplicate_charge',
    algorithmVersion: DUPLICATE_CHARGE_VERSION,
    transactionIds,
    status: 'unreviewed',
    // The LATER charge acts on the earlier one, for the amount that would be recovered if
    // this is a genuine double charge. Confirming it changes NO total (§3.3): the app
    // makes no claim the money is coming back until a refund actually posts.
    proposedLinks: [
      {
        linkType: 'duplicate_candidate',
        sourceTransactionId,
        targetTransactionId,
        allocatedAmountCents: later.cents,
      },
    ],
    evidence: {
      amountsCents: [earlier.cents, later.cents],
      dayGaps: [dayGap],
      sameAccount: true,
      accountTypes: uniqueAccountTypes([earlier, later]),
      merchantMatch,
      referenceOverlap: 'none',
      pendingInvolved: false,
      reasonCodes: [
        'exact_amount',
        'same_account',
        dayGap <= 1 ? 'within_one_day' : 'within_three_days',
        merchantMatch === 'exact' ? 'same_merchant' : 'same_service_family',
        ...(repeatPattern ? ['repeat_purchase_pattern'] : []),
      ],
    },
    score,
    generatedAt,
  };
}

// ---------------------------------------------------------------------------
// Duplicate subscriptions across accounts (§4)
// ---------------------------------------------------------------------------

/** Calendar periods of the pair's cadence. Integer counting, no fuzzy overlap. */
function periodKey(dateISO: string, cadence: Cadence): string {
  const d = day(dateISO);
  switch (cadence) {
    case 'weekly':
      return `W${Math.floor(dayNumber(d) / 7)}`;
    case 'biweekly':
      return `F${Math.floor(dayNumber(d) / 14)}`;
    case 'monthly':
      return d.slice(0, 7);
    case 'quarterly':
      return `${d.slice(0, 4)}-Q${Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1}`;
    default:
      return d.slice(0, 4);
  }
}

function overlappingPeriodCount(a: readonly string[], b: readonly string[], cadence: Cadence): number {
  const left = new Set(a.map((d) => periodKey(d, cadence)));
  let count = 0;
  for (const key of new Set(b.map((d) => periodKey(d, cadence)))) if (left.has(key)) count++;
  return count;
}

/**
 * When two series disagree on cadence, periods are counted in the COARSER one — fewer,
 * larger periods, so E2 is harder to satisfy rather than easier. Conservative by choice.
 */
function pairCadence(a: AccountSeries, b: AccountSeries): Cadence | null {
  if (!a.cadence || !b.cadence) return a.cadence ?? b.cadence;
  const [ba, bb] = [bandOfCadence(a.cadence), bandOfCadence(b.cadence)];
  if (!ba || !bb) return a.cadence;
  return ba[2] >= bb[2] ? a.cadence : b.cadence;
}

interface SeriesPair {
  a: AccountSeries;
  b: AccountSeries;
  resolution: AliasResolution;
}

/**
 * Every cross-account pair worth evaluating, each carrying HOW the two sides came to be
 * considered the same service.
 *
 * Same family → rule 1 (`exact`, identical normalized strings) or rule 2 (`alias`, an
 * alias the owner confirmed). Different families sharing an identity-bearing token → rule
 * 3, which PROPOSES (`proposed`) and never applies: those candidates are emitted as
 * `needs_more_information` with reason `alias_unconfirmed`.
 *
 * O(F·A²) over families and accounts, plus O(Σ|token bucket|²) for the proposals — both
 * quadratic in SERIES, never in ledger rows.
 */
function seriesPairs(series: readonly AccountSeries[]): SeriesPair[] {
  const pairs: SeriesPair[] = [];
  const seen = new Set<string>();
  const pairKey = (a: AccountSeries, b: AccountSeries) =>
    [a.serviceFamilyId, a.accountId, a.firstSeen, b.serviceFamilyId, b.accountId, b.firstSeen].join('|');

  const add = (x: AccountSeries, y: AccountSeries, resolution: AliasResolution) => {
    const [a, b] =
      x.accountId < y.accountId || (x.accountId === y.accountId && x.firstSeen <= y.firstSeen) ? [x, y] : [y, x];
    const key = pairKey(a, b);
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push({ a, b, resolution });
  };

  for (const family of groupBy(series, (s) => s.serviceFamilyId).values()) {
    for (let i = 0; i < family.length; i++) {
      for (let j = i + 1; j < family.length; j++) {
        add(family[i], family[j], family[i].normalizedMerchant === family[j].normalizedMerchant ? 'exact' : 'alias');
      }
    }
  }

  // Rule 3 — a token bucket, so only series that could possibly relate are compared.
  const byToken = new Map<string, AccountSeries[]>();
  for (const s of series) {
    for (const token of significantTokens(s.normalizedMerchant)) {
      const bucket = byToken.get(token);
      if (bucket) bucket.push(s);
      else byToken.set(token, [s]);
    }
  }
  for (const bucket of byToken.values()) {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        if (bucket[i].serviceFamilyId === bucket[j].serviceFamilyId) continue;
        if (!proposeFamilyMerge(bucket[i].normalizedMerchant, bucket[j].normalizedMerchant).propose) continue;
        add(bucket[i], bucket[j], 'proposed');
      }
    }
  }
  return pairs;
}

/** The five evidence thresholds of §4.2, in the order that fails cheapest first. */
function passesEvidenceBar(a: AccountSeries, b: AccountSeries): Cadence | null {
  if (a.accountId === b.accountId) return null; // E5
  if (a.currency !== b.currency) return null; // §4.3 — a differing currency SPLITS
  if (a.occurrences < MIN_CHARGES_PER_ACCOUNT || b.occurrences < MIN_CHARGES_PER_ACCOUNT) return null; // E1
  if (!a.anchor && !b.anchor) return null; // E3
  if (!a.active || !b.active) return null; // E4
  const cadence = pairCadence(a, b);
  if (!cadence) return null;
  if (overlappingPeriodCount(a.dates, b.dates, cadence) < MIN_OVERLAPPING_PERIODS) return null; // E2
  return cadence;
}

function buildSubscriptionCandidate(
  pair: SeriesPair,
  cadence: Cadence,
  centsById: Map<string, number>,
  generatedAt: string
): { candidate: ReviewCandidate; estimate: DuplicateCostEstimate } {
  const { a, b, resolution } = pair;
  const proposed = resolution === 'proposed';
  const sameProduct = a.cadence === b.cadence && sameAmountBand(a.medianCents, b.medianCents);
  const candidateType: CandidateType = sameProduct ? 'duplicate_subscription' : 'subscription_overlap';
  const status: CandidateStatus = proposed ? 'needs_more_information' : 'unreviewed';
  const score = proposed ? 0.4 : sameProduct ? (resolution === 'exact' ? 0.85 : 0.75) : 0.6;

  const transactionIds = sortedTransactionIds([a.transactionIds[0], b.transactionIds[0]]);
  const { sourceTransactionId, targetTransactionId } = orderSymmetricPair(
    { id: a.transactionIds[0], date: a.firstSeen },
    { id: b.transactionIds[0], date: b.firstSeen }
  );

  // §6.1 — the CHEAPER side. If the owner cancels one, the conservative figure is the
  // smaller of the two; claiming the larger would overstate it, and the sum is not a
  // thing that could ever be saved.
  const cheaper = a.monthlyCents <= b.monthlyCents ? a : b;

  // The allocation is bounded by the row it points at, so a confirmation can never be
  // rejected for over-allocating a real transaction (relations.ts V5).
  const allocated = Math.min(cheaper.medianCents, centsById.get(targetTransactionId) ?? 0);
  const proposedLinks: ProposedLink[] =
    allocated > 0
      ? [{ linkType: 'subscription_overlap', sourceTransactionId, targetTransactionId, allocatedAmountCents: allocated }]
      : [];

  const id = buildIdentityKey(candidateType, transactionIds);

  return {
    candidate: {
      id,
      candidateId: buildCandidateId(candidateType, DUPLICATE_SUBSCRIPTION_VERSION, transactionIds),
      candidateType,
      algorithmVersion: DUPLICATE_SUBSCRIPTION_VERSION,
      transactionIds,
      status,
      proposedLinks,
      evidence: {
        amountsCents: [a.medianCents, b.medianCents],
        dayGaps: [],
        sameAccount: false,
        accountTypes: [],
        merchantMatch: resolution === 'exact' ? 'exact' : 'alias',
        referenceOverlap: 'none',
        cadence,
        overlappingPeriods: overlappingPeriodCount(a.dates, b.dates, cadence),
        pendingInvolved: false,
        reasonCodes: [
          'different_account',
          a.anchor && b.anchor ? 'both_anchor_series' : 'anchor_series',
          sameProduct ? 'same_amount_band' : 'cadence_or_amount_differs',
          ...(proposed ? ['alias_unconfirmed'] : []),
        ],
      },
      score,
      generatedAt,
    },
    estimate: {
      identityKey: id,
      duplicateMonthlyCents: cheaper.monthlyCents,
      potentialAnnualDuplicateCostCents: cheaper.monthlyCents * 12,
      label: POTENTIAL_ANNUAL_DUPLICATE_COST_LABEL,
      cheaperAccountId: cheaper.accountId,
    },
  };
}

/**
 * A charge in a family the owner told us they cancelled, dated after the effective date.
 *
 * Emitted on the FIRST such charge, at the top of the queue. If no charge posts after the
 * effective date, no candidate is emitted and NOTHING IS SAID (test S15) — silence is the
 * correct output for a cancellation that worked.
 */
function detectContinuedCharges(
  rows: readonly Row[],
  options: DuplicateOptions,
  generatedAt: string
): ReviewCandidate[] {
  const out: ReviewCandidate[] = [];

  for (const cancellation of options.cancellations ?? []) {
    const inFamily = rows
      .filter(
        (r) =>
          r.serviceFamilyId === cancellation.serviceFamilyId &&
          (!cancellation.accountId || r.accountId === cancellation.accountId)
      )
      .sort(byDateThenId);

    const after = inFamily.find((r) => r.dayISO > cancellation.effectiveDate);
    if (!after) continue;
    // The alert names the charge that should not have happened AND the last one that
    // should have, so the candidate points at two real rows the owner can compare.
    const before = [...inFamily].reverse().find((r) => r.dayISO <= cancellation.effectiveDate);
    if (!before) continue;

    const transactionIds = sortedTransactionIds([before.id, after.id]);
    out.push({
      id: buildIdentityKey('continued_charge_after_cancellation', transactionIds),
      candidateId: buildCandidateId('continued_charge_after_cancellation', DUPLICATE_SUBSCRIPTION_VERSION, transactionIds),
      candidateType: 'continued_charge_after_cancellation',
      algorithmVersion: DUPLICATE_SUBSCRIPTION_VERSION,
      transactionIds,
      status: 'unreviewed',
      // No allocation: nothing here reverses anything. It is a question, not a claim.
      proposedLinks: [],
      evidence: {
        amountsCents: [before.cents, after.cents],
        dayGaps: [after.dayNum - before.dayNum],
        sameAccount: before.accountId === after.accountId,
        accountTypes: uniqueAccountTypes([before, after]),
        merchantMatch: before.normalizedMerchant === after.normalizedMerchant ? 'exact' : 'family',
        referenceOverlap: 'none',
        pendingInvolved: false,
        reasonCodes: ['charge_after_cancellation', 'owner_confirmed_cancellation'],
      },
      score: 0.95,
      generatedAt,
    });
  }
  return out;
}

/**
 * The cross-account engine: every duplicate-subscription, subscription-overlap and
 * continued-charge candidate, with the avoidable-cost figure beside each pair.
 */
export function detectDuplicateSubscriptions(
  transactions: readonly Transaction[],
  accounts: readonly PaymentAccount[],
  options: DuplicateOptions
): { candidates: ReviewCandidate[]; estimates: DuplicateCostEstimate[] } {
  const rows = eligibleRows(transactions, accounts, options);
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const centsById = new Map(rows.map((r) => [r.id, r.cents]));
  const series = seriesFromRows(rows, options.todayISO);

  const candidates: ReviewCandidate[] = [];
  const estimates: DuplicateCostEstimate[] = [];

  for (const pair of seriesPairs(series)) {
    const cadence = passesEvidenceBar(pair.a, pair.b);
    if (!cadence) continue;
    const built = buildSubscriptionCandidate(pair, cadence, centsById, generatedAt);
    candidates.push(built.candidate);
    estimates.push(built.estimate);
  }

  return { candidates: [...candidates, ...detectContinuedCharges(rows, options, generatedAt)], estimates };
}

// ---------------------------------------------------------------------------
// The run — one span, one event per candidate type (§9)
// ---------------------------------------------------------------------------

const safeEvent = (eventName: string, traceId: string, metadata: Record<string, unknown>, recordCount: number, durationMs: number) => {
  emit({
    eventName,
    eventCategory: 'activity',
    severity: 'info',
    traceId,
    component: COMPONENT,
    route: ROUTE,
    recordCount,
    durationMs,
    resultStatus: recordCount ? 'ok' : 'empty',
    // Reason codes, enum values, counts and small integers ONLY. Never a merchant string,
    // a service-family label, an alias, an account name or an amount as a free value —
    // and never the avoidable-cost figure.
    metadata: Object.fromEntries(Object.entries(metadata).filter(([, v]) => v !== undefined)),
  });
};

const aliasResolutionOf = (c: ReviewCandidate): AliasResolution =>
  c.evidence.reasonCodes.includes('alias_unconfirmed') ? 'proposed' : c.evidence.merchantMatch === 'alias' ? 'alias' : 'exact';

/**
 * Generate every duplicate candidate for one ledger, ranked.
 *
 * RUN THIS ON REFRESH, ON DEMAND, OR MEMOIZED — never per React render. It is a pure
 * function of (transactions, accounts, options), so a single `useMemo` keyed on those is
 * the whole story, exactly as SubscriptionsPanel already does for `detectRecurring`.
 *
 * A version bump re-evaluates ONLY unreviewed candidates: pass the result through
 * `mergeCandidateRun` (src/lib/candidates.ts), whose doc id carries no version, so a
 * decision the owner already made can never be silently reinterpreted.
 */
export function generateDuplicateCandidates(
  transactions: readonly Transaction[],
  accounts: readonly PaymentAccount[],
  options: DuplicateOptions
): DuplicateRunResult {
  const span = startSpan('Duplicate.GenerateCandidates', {
    component: COMPONENT,
    route: ROUTE,
    calculationName: 'duplicate-detection',
    calculationVersion: `${DUPLICATE_CHARGE_VERSION}+${DUPLICATE_SUBSCRIPTION_VERSION}`,
  });

  try {
    const chargeStart = Date.now();
    const charges = detectImmediateDuplicates(transactions, accounts, options);
    const chargeMs = Date.now() - chargeStart;

    const subscriptionStart = Date.now();
    const { candidates: subscriptions, estimates } = detectDuplicateSubscriptions(transactions, accounts, options);
    const subscriptionMs = Date.now() - subscriptionStart;

    if (charges.length) {
      const top = rankCandidates(charges)[0];
      safeEvent(
        'DuplicateCharge.CandidateGenerated',
        span.traceId,
        { algorithmVersion: DUPLICATE_CHARGE_VERSION, dayGap: top.evidence.dayGaps[0], score: top.score },
        charges.length,
        chargeMs
      );
    }
    if (subscriptions.length) {
      const top = rankCandidates(subscriptions)[0];
      safeEvent(
        'DuplicateSubscription.CandidateGenerated',
        span.traceId,
        {
          algorithmVersion: DUPLICATE_SUBSCRIPTION_VERSION,
          cadence: top.evidence.cadence,
          overlappingPeriods: top.evidence.overlappingPeriods,
          accountCount: accounts.length,
          aliasResolution: aliasResolutionOf(top),
        },
        subscriptions.length,
        subscriptionMs
      );
    }

    const candidates = rankCandidates([...charges, ...subscriptions]);
    span.end({
      recordCount: candidates.length,
      metadata: { chargeCount: charges.length, subscriptionCount: subscriptions.length },
    });
    return { candidates, estimates };
  } catch (error) {
    span.end({ status: 'error', error });
    throw error;
  }
}

/**
 * One event for the owner's decision, called BESIDE FIN-RELATION-001's
 * `recordCandidateDecision` — this module writes nothing itself.
 *
 * `reasonCode` distinguishes `intentional` / `different_owner` / `business`. None of them
 * is a tax claim, a deduction claim or a reduction: the expense stays fully counted.
 */
export function emitDuplicateDecision(
  candidateType: CandidateType,
  status: CandidateStatus,
  reasonCode?: string
): void {
  const eventName =
    status === 'confirmed'
      ? 'DuplicateCandidate.Confirmed'
      : status === 'intentional'
        ? 'DuplicateCandidate.MarkedIntentional'
        : status === 'dismissed'
          ? 'DuplicateCandidate.Dismissed'
          : null;
  if (!eventName) return;

  emit({
    eventName,
    eventCategory: 'activity',
    severity: 'info',
    traceId: '',
    component: COMPONENT,
    route: ROUTE,
    resultStatus: 'ok',
    metadata: {
      candidateType,
      ...(status === 'confirmed' ? { decision: status } : {}),
      ...(reasonCode && status !== 'confirmed' ? { reasonCode } : {}),
    },
  });
}
