/**
 * MAP-001 — group the unmapped, so the owner answers PATTERNS instead of rows.
 *
 * The measured problem: 205 unclassified inflows and 103 unpaired transfer legs. Both
 * numbers are correct — money is not income until an approved source or the owner says
 * so, and ~85% of those legs genuinely have no counterpart in the imported data. The
 * defect is the ASK: 308 individual questions is a surface the owner learns to ignore.
 *
 * Measured on the owner's real export, read-only: the 229 unknown inflows this repo's
 * own selector produces collapse to 50 groups, of which 16 cover 80% of the rows; the
 * 103 stub-lane legs collapse to 29 groups, of which 11 cover 80%.
 *
 * PURE module: no React, no Firestore, no I/O, no network. Every group, every suggestion
 * and every preview is derived on read from the ledger, the owner's rules and the owner's
 * own past answers. NOTHING here writes; the write functions return DOCUMENTS for a
 * caller to persist after a button press, which is the only path to a stored fact.
 *
 * NO VENDOR LIST. There is no merchant catalogue, no category seed and no bundled
 * registry in this file, and `mapping-suggestions.test.ts` asserts their absence exactly
 * the way `service-identity.ts` is asserted. A suggestion is evidence the owner's own
 * data already carries, or there is no suggestion.
 *
 * Amounts are INTEGER CENTS end to end.
 */

import { FinancialMeaning, IncomeSource, InflowReview, PaymentAccount, Transaction } from '@/types';
import { ReviewCandidate } from './candidates';
import { IncomeContext, InflowReviewItem, selectInflowReviewQueue } from './classify';
import { unpairedLegLane } from './flow-lanes';
import { BANDS, daysBetween, day, isSelfPerson, median, normalizeMerchant, personFrom, toCents } from './flows';
import {
  PayerSeries, detectLoanProceeds, detectPayerSeries, isDepositAccount, missingPeriods,
  refundEvidenceFor, seriesEndDate, sharedTokens,
} from './mapping-evidence';
import { MappingRule, NewMappingRule, RuleMatch, describeRule, rowDirection, rulePreview } from './mapping-rules';
import { formatMoneyCents } from './money';
import { emit } from './obs/events';
import { newTraceId } from './obs/trace';
import { generateRefundCandidates } from './refunds';

// ---------------------------------------------------------------------------
// What an unmapped row is, and what identifies its group
// ---------------------------------------------------------------------------

export type UnmappedKind = 'unknown_inflow' | 'unpaired_leg';

/**
 * The reason id written onto a review record when a whole group is answered
 * "I can't classify this". Its presence on ANY row of a group suppresses the group
 * forever, rows imported later included — see `buildMappingGroups`.
 */
export const GROUP_UNKNOWN_REASON = 'group_marked_unknown';

/**
 * FIN-REVIEW-002 §7.1's closed list, minus the scopes this task has no data for
 * (`merchant_and_amount_range`, `same_shared_expense_group`, `selected_historical_and_future`).
 * Anything not in here is not offered and cannot be built.
 */
export const GROUP_SCOPES = [
  'only_this_group',
  'same_normalized_merchant',
  'merchant_and_account',
  'merchant_and_direction',
  'same_counterparty',
  'future_only',
] as const;

export type GroupScope = (typeof GROUP_SCOPES)[number];

export const SCOPE_LABEL: Record<GroupScope, string> = {
  only_this_group: 'These rows only — no rule',
  same_normalized_merchant: 'Every row from this merchant',
  merchant_and_account: 'This merchant, on this account',
  merchant_and_direction: 'This merchant, money in this direction only',
  same_counterparty: 'Every row involving this person',
  future_only: 'Rows imported from today onwards',
};

/** The evidence kinds. Each is a fact the ledger already contains. */
export type SuggestionEvidence =
  | 'existing_rule'
  | 'prior_confirmation'
  | 'approved_income_source'
  // --- MAP-002 -------------------------------------------------------------
  | 'refund_candidate'
  | 'payroll_shape'
  | 'loan_proceeds'
  | 'same_day_opposite_leg';

export interface MappingSuggestion {
  evidence: SuggestionEvidence;
  /** What the rows would mean. Written to the review record, not to the row. */
  meaning?: FinancialMeaning;
  /** What a rule would set, when the evidence is itself a rule. */
  set?: MappingRule['set'];
  /** The approved source, when that is the evidence. */
  incomeSourceId?: string;
  /**
   * MAP-002 — a PRE-FILLED income source the owner may choose to create, derived
   * entirely from the series that produced this suggestion. It is a proposal in memory
   * and nothing more: no id, and no write happens until a button is pressed.
   */
  incomeSourceOffer?: Omit<IncomeSource, 'id'>;
  /** How many ledger facts back this. Never a model output. */
  supportCount: number;
  /** 0..1, an explainable ladder. */
  confidence: number;
  /** ONE sentence a human can go and check. */
  why: string;
}

export interface MappingGroup {
  /** Stable identity, and deliberately free of any algorithm version — the same reason
   *  `buildIdentityKey` omits one: a version bump must not resurrect an answer. */
  key: string;
  kind: UnmappedKind;
  signal: 'merchant' | 'counterparty';
  signalValue: string;
  label: string;
  direction: 'inflow' | 'outflow';
  transactionIds: string[];
  rowCount: number;
  totalCents: number;
  minCents: number;
  maxCents: number;
  firstDate: string;
  lastDate: string;
  accountIds: string[];
  sourceCategories: string[];
  /** Present when the group's own dates fall in one of `flows.ts`'s existing bands. */
  cadence?: (typeof BANDS)[number][0];
  suggestion: MappingSuggestion | null;
  /**
   * MAP-002 — things the ledger says ABOUT this group that are not an answer to it.
   * "Five expected payments from this payer are absent" is not a candidate to confirm;
   * it tells the owner their import may be incomplete. Informational, never actionable.
   */
  findings: string[];
  /** rows × dollars — the ranking key, so the biggest question is asked first. */
  impactScore: number;
}

export interface UnmappedContext {
  transactions: readonly Transaction[];
  accounts?: readonly PaymentAccount[];
  /** Already-selected unknown inflows. Derived from the ledger when absent. */
  inflowItems?: readonly InflowReviewItem[];
  /** Rows the Flow graph put in a "other leg not found" lane. Absent = none. */
  unpairedLegIds?: readonly string[];
  rules?: readonly MappingRule[];
  income?: IncomeContext;
  /**
   * MAP-002 — FIN-REFUND-001's OWN output. Pass the run the page already computed; this
   * module does no refund matching of its own and never will. Absent and with accounts
   * present, the generator is called here so a caller that has not wired it still gets
   * the evidence — at the cost of one extra run, which is why /flow passes its own.
   */
  refundCandidates?: readonly ReviewCandidate[];
  todayISO?: string;
}

/** The four stub lanes, ASKED of the module that owns them rather than copied. */
export const UNPAIRED_LEG_LANE_IDS: string[] = [
  unpairedLegLane({ sourceCategory: '' } as Transaction, 'in').id,
  unpairedLegLane({ sourceCategory: '' } as Transaction, 'out').id,
  unpairedLegLane({ sourceCategory: 'Credit Card Payment' } as Transaction, 'in').id,
  unpairedLegLane({ sourceCategory: 'Credit Card Payment' } as Transaction, 'out').id,
];

// ---------------------------------------------------------------------------
// The grouping signal
// ---------------------------------------------------------------------------

/**
 * WHO this row is with. A named external person beats the merchant string, because the
 * merchant string on a person-to-person row is the TRANSPORT and the transport is not a
 * meaning — FIN-REVIEW-002 §7.3's worked rejection, and the reason `buildFlowGraph`
 * keeps those legs away from the transfer pairer. Measured cost of the split on the real
 * export: 7 rows, 43 merchant groups -> 50. Measured cost of NOT splitting: money sent
 * to family and money from a friend answered as one thing.
 */
function signalOf(t: Transaction): { signal: 'merchant' | 'counterparty'; value: string } {
  const person = personFrom(t.description) ?? personFrom(t.title);
  if (person && !isSelfPerson(person)) return { signal: 'counterparty', value: person };
  return { signal: 'merchant', value: normalizeMerchant(t.merchant || t.title) };
}

const directionOf = (t: Transaction): 'inflow' | 'outflow' => (rowDirection(t) === 'outflow' ? 'outflow' : 'inflow');

const groupKey = (kind: UnmappedKind, signal: string, value: string, direction: string) =>
  `${kind}~${signal}:${value}~${direction}`;

/**
 * The group's own cadence, off the SAME `BANDS` table and the SAME 0.6 in-band rule
 * `detectRecurring()` uses. It is not reused directly because that function only looks
 * at EXPENSES, and every unknown-inflow group is on the other side of the ledger.
 */
function cadenceOf(dates: string[]): MappingGroup['cadence'] {
  const unique = [...new Set(dates)].sort();
  if (unique.length < 3) return undefined;
  const gaps = unique.slice(1).map((d, i) => daysBetween(unique[i], d));
  const band = BANDS.find(([, lo, hi]) => median(gaps) >= lo && median(gaps) <= hi);
  if (!band) return undefined;
  const inBand = gaps.filter((g) => g >= band[1] && g <= band[2]).length / gaps.length;
  return inBand >= 0.6 ? band[0] : undefined;
}

// ---------------------------------------------------------------------------
// Suggestions — four evidence kinds, all from the owner's own data
// ---------------------------------------------------------------------------

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Everything about a group that more than one rung of the ladder needs, computed ONCE.
 * `series` in particular is read by three rungs — the payroll offer, the missing-period
 * finding, and the guard that stops a payer's deposits being called a transfer.
 */
interface GroupFacts {
  signalValue: string;
  direction: 'inflow' | 'outflow';
  accountIds: string[];
  /** Repeated payments from this one payer, on a cadence, in a consistent band. */
  series: PayerSeries | null;
  /** The last day ANY row in the ledger falls on — what "has this stopped?" is asked of. */
  ledgerLastDate: string;
  /** Later money going back to the same party. Loan repayments look exactly like this. */
  laterOutflowsToSamePayer: Transaction[];
}

/** `IncomeSource.frequency` cannot express every band, and an offer it cannot express
 *  is not made. The suggestion still stands — only the pre-filled source is withheld. */
const OFFERABLE_FREQUENCY: Partial<Record<PayerSeries['cadence'], IncomeSource['frequency']>> = {
  weekly: 'weekly', biweekly: 'biweekly', monthly: 'monthly', yearly: 'yearly',
};

/**
 * The first evidence that holds, in confidence order. `null` is a legitimate and common
 * answer: when the ledger says nothing, this module says nothing. It never fills the gap
 * with a plausible-sounding default, because a plausible default is exactly how a
 * one-off deposit became salary in the first place.
 */
function suggestFor(
  rows: Transaction[],
  facts: GroupFacts,
  ctx: UnmappedContext,
  siblings: Transaction[],
  refundCandidates: readonly ReviewCandidate[]
): MappingSuggestion | null {
  const signalValue = facts.signalValue;
  // 1. The owner already wrote a rule that catches these rows.
  const hit = (ctx.rules ?? []).find(
    (r) => r.enabled && rulePreview(r, rows as Transaction[]).matches > 0
  );
  if (hit) {
    return {
      evidence: 'existing_rule',
      set: hit.set,
      supportCount: rows.length,
      confidence: 0.9,
      why: `You already have a rule that covers these rows: ${describeRule(hit)}`,
    };
  }

  // 2. The owner has answered this exact pattern before. Their answer, their count.
  const reviews = ctx.income?.reviews ?? {};
  const answered = siblings
    .map((t) => reviews[t.id])
    .filter((r): r is InflowReview => !!r && r.state === 'confirmed' && !!r.meaning);
  if (answered.length) {
    const tally = new Map<FinancialMeaning, number>();
    for (const r of answered) tally.set(r.meaning!, (tally.get(r.meaning!) ?? 0) + 1);
    const [meaning, count] = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    return {
      evidence: 'prior_confirmation',
      meaning,
      supportCount: count,
      confidence: count >= 3 ? 0.9 : 0.7,
      why: `You have already answered "${signalValue}" the same way ${plural(count, 'time')}`,
    };
  }

  // 3. An APPROVED income source the amounts and cadence agree with. Amount can only
  //    ever narrow, never create — FIN-INCOME-001's rule, restated here.
  const cadence = cadenceOf(rows.map((t) => day(t.date)));
  const amounts = rows.map((t) => toCents(t.amount));
  const med = median(amounts);
  const source = (ctx.income?.sources ?? []).find((s: IncomeSource) => {
    if (s.isActive === false || s.userApproved === false) return false;
    const expected = Math.round(s.amount * 100);
    const tolerance = s.amountToleranceCents ?? Math.max(100, Math.round(expected * 0.05));
    return Math.abs(med - expected) <= tolerance && (!cadence || s.frequency === cadence);
  });
  if (source) {
    return {
      evidence: 'approved_income_source',
      meaning: 'earned_income',
      incomeSourceId: source.id,
      supportCount: rows.length,
      confidence: cadence ? 0.9 : 0.7,
      why:
        `${plural(rows.length, 'row')} of ${formatMoneyCents(med)}${cadence ? `, ${cadence}` : ''}, ` +
        `matching the income source you approved called "${source.name}"`,
    };
  }

  // 4. FIN-REFUND-001 has ALREADY proposed a purchase for these credits.
  //    A group whose rows the refund matcher has matched must say so instead of "you
  //    decide" — the work is done, it is sitting one screen away, and asking the owner to
  //    rediscover it is the defect this whole task exists to fix. No matching happens
  //    here; `refundEvidenceFor()` reads that generator's output and cites its score.
  const refunds = refundEvidenceFor(rows, refundCandidates);
  if (refunds) {
    return {
      evidence: 'refund_candidate',
      meaning: 'refund',
      supportCount: refunds.rowIds.length,
      // The generator's own ladder, capped below owner-confirmed evidence.
      confidence: Math.min(0.9, refunds.bestScore),
      why:
        `Your refund review already proposes a matching purchase for ${plural(refunds.rowIds.length, 'row')} ` +
        `here — ${refunds.exact} exact, ${refunds.partial} partial and ${refunds.combined} combined`,
    };
  }

  // 5. The PAYROLL SHAPE: one payer, a detectable cadence, a consistent amount band, a
  //    deposit account, more than one month. Every one of those is a fact on the rows.
  //
  //    This suggests `earned_income` and OFFERS the income source — pre-filled with the
  //    payer's name, the aliases shared by the rows' own text, the median amount, the
  //    detected frequency and, when the series has stopped, the end date derived from
  //    its last payment. That end date is the valuable part: the owner remembered "about
  //    April"; the ledger knows the day.
  const series = facts.series;
  const accountsOf = (id: string) => (ctx.accounts ?? []).find((a) => a.id === id);
  const intoDepositAccount =
    facts.accountIds.length > 0 && facts.accountIds.every((id) => isDepositAccount(accountsOf(id)));
  if (series && facts.direction === 'inflow' && signalValue && series.months >= 2 && intoDepositAccount) {
    const endDate = seriesEndDate(series, facts.ledgerLastDate);
    const frequency = OFFERABLE_FREQUENCY[series.cadence];
    return {
      evidence: 'payroll_shape',
      meaning: 'earned_income',
      supportCount: series.occurrences,
      // Explainable ladder, four independent signals over a base of 0.5. A shape is
      // inference, so it starts below every rung above it and tops out at 0.85 — it can
      // never reach the 0.9 the owner's own confirmed answer carries.
      // ponytail: no size floor — a small regular deposit scores the same as a salary.
      // Upgrade path if that proves noisy is a floor derived from the ledger's own inflow
      // distribution, not a hard-coded dollar figure.
      confidence:
        0.5 +
        (series.occurrences >= 6 ? 0.1 : 0) +
        (series.months >= 6 ? 0.1 : 0) +
        (series.bandTight ? 0.1 : 0) +
        (series.inBand >= 0.8 ? 0.05 : 0),
      ...(frequency
        ? {
            incomeSourceOffer: {
              name: signalValue,
              amount: series.medianCents / 100,
              frequency,
              isActive: !endDate,
              ...(endDate ? { endDate } : {}),
              matchAliases: sharedTokens(rows),
              depositAccountIds: facts.accountIds,
              amountToleranceCents: series.toleranceCents,
              // Pressing the button IS the approval; nothing here writes without one.
              userApproved: true,
              historicalMatchCount: series.occurrences,
            },
          }
        : {}),
      why:
        `${plural(series.occurrences, 'payment')} from "${signalValue}" between ${series.firstDate} and ` +
        `${series.lastDate}, ${series.cadence}, ` +
        `${series.bandTight ? 'typically' : 'varying around'} ${formatMoneyCents(series.medianCents)} each, ` +
        `into an account you deposit into${endDate ? `, and none since ${endDate}` : ''}`,
    };
  }

  // 6. BORROWED money. A large one-off credit from a party the owner either holds a loan
  //    account with, or repaid afterwards on a cadence for far less each time.
  const loan = detectLoanProceeds(rows, signalValue, facts.laterOutflowsToSamePayer, ctx.accounts ?? []);
  if (loan) {
    const parts = [
      loan.loanAccountName ? `it came from "${signalValue}", which is also the name of a loan account you hold` : '',
      loan.repaymentCount
        ? `${plural(loan.repaymentCount, 'payment')} went back to "${signalValue}" afterwards, ` +
          `${loan.repaymentCadence}, each far smaller than this credit`
        : '',
    ].filter(Boolean);
    return {
      evidence: 'loan_proceeds',
      meaning: 'loan_proceeds',
      supportCount: (loan.repaymentCount ?? 0) + (loan.loanAccountName ? 1 : 0),
      confidence: loan.confidence,
      why: `This looks like money you borrowed — ${parts.join(', and ')}`,
    };
  }

  // 7. The counterpart is sitting in another account you own, on the same day, for the
  //    same amount. Nothing is PAIRED here — `transfers.ts` is untouched.
  //
  //    THE BUG THIS RUNG SHIPPED WITH: measured on the real export, 21 salary deposits
  //    over 12 months were offered as an internal transfer at 0.9 confidence, because
  //    salary lands and is moved on the same day to meet an obligation. The signature is
  //    identical; the meaning is the opposite. Two guards, both derived from the ledger:
  //
  //      (a) BOTH accounts must be ones the owner HOLDS. Before this, the rung never
  //          consulted the account list at all — any row with any other accountId
  //          qualified as "another account of yours". An inflow whose counterpart sits
  //          somewhere the owner does not hold is not a leg of anything.
  //      (b) A payer who pays on a cadence is an EXTERNAL PAYER. Their money arriving and
  //          then being spent is two facts, not one movement, so no amount of same-day
  //          symmetry makes it a transfer. This guard stands on its own rather than
  //          relying on rung 5 running first, because rung 5 declines for a payer who
  //          pays into a card or on a band an income source cannot express — and the
  //          answer there is still "not a transfer", not "probably a transfer".
  if (facts.series) return null;
  const owned = new Set((ctx.accounts ?? []).map((a) => a.id));
  const sameDay = rows.filter((t) =>
    owned.has(t.accountId ?? '') &&
    ctx.transactions.some(
      (o) =>
        o.id !== t.id &&
        o.accountId &&
        t.accountId &&
        o.accountId !== t.accountId &&
        owned.has(o.accountId) &&
        day(o.date) === day(t.date) &&
        toCents(o.amount) === toCents(t.amount) &&
        directionOf(o) !== directionOf(t)
    )
  );
  if (sameDay.length) {
    return {
      evidence: 'same_day_opposite_leg',
      meaning: 'internal_transfer',
      supportCount: sameDay.length,
      confidence: sameDay.length === rows.length ? 0.9 : 0.6,
      why:
        `${plural(sameDay.length, 'row')} of these has the same amount going the other way on the same day, ` +
        'in another account you hold',
    };
  }

  return null;
}

/**
 * What the ledger says ABOUT a group without answering it.
 *
 * Today there is one: a payer series with holes in it. The owner's Flow chart carries a
 * "not in your data yet" plug, and absent paychecks are a plausible part of it — so the
 * app says which periods are missing rather than leaving the owner to notice. This is
 * NOT a candidate: there is nothing to confirm, and the honest conclusion is usually
 * "your import is incomplete", not "you were not paid".
 */
function findingsFor(rows: Transaction[], facts: GroupFacts): string[] {
  if (!facts.series || facts.direction !== 'inflow' || !facts.signalValue) return [];
  const gaps = missingPeriods(rows, facts.series);
  if (!gaps.missing) return [];
  return [
    `${plural(gaps.missing, 'expected payment')} from this payer ${gaps.missing === 1 ? 'is' : 'are'} absent ` +
      `between ${facts.series.firstDate} and ${facts.series.lastDate} — the ${facts.series.cadence} cadence ` +
      `implies ${gaps.expected} payment dates and these rows cover ${facts.series.occurrences}, so your import ` +
      `may be incomplete (${gaps.months.join(', ')})`,
  ];
}

// ---------------------------------------------------------------------------
// Building the groups
// ---------------------------------------------------------------------------

/**
 * Every unmapped row, gathered into the smallest number of questions the data supports,
 * ranked biggest-first.
 *
 * A group is SUPPRESSED entirely when any row carrying its key has a review record with
 * `GROUP_UNKNOWN_REASON`. That is what makes "leave it unknown" terminal for rows that
 * have not been imported yet: the answer attaches to the PATTERN, and the pattern is
 * recomputed from the ledger on every run. No second store, no second document type —
 * `users/{uid}/reviews/{transactionId}` is the one decision record, exactly as it was.
 */
export function buildMappingGroups(ctx: UnmappedContext): MappingGroup[] {
  const byId = new Map(ctx.transactions.map((t) => [t.id, t]));
  const reviews = ctx.income?.reviews ?? {};

  const inflowItems =
    ctx.inflowItems ??
    selectInflowReviewQueue(
      ctx.transactions as Transaction[],
      ctx.accounts as PaymentAccount[] | undefined,
      ctx.income
    );

  const unmapped: Array<{ t: Transaction; kind: UnmappedKind }> = [];
  const seen = new Set<string>();
  for (const item of inflowItems) {
    const t = byId.get(item.transactionId);
    if (t && !seen.has(t.id)) { seen.add(t.id); unmapped.push({ t, kind: 'unknown_inflow' }); }
  }
  for (const id of ctx.unpairedLegIds ?? []) {
    const t = byId.get(id);
    // A leg the owner has already answered is out, on the same review record the
    // inflow selector uses. One vocabulary, one store.
    const state = reviews[id]?.state;
    if (!t || seen.has(id) || state === 'confirmed' || state === 'dismissed') continue;
    seen.add(id);
    unmapped.push({ t, kind: 'unpaired_leg' });
  }

  // Which keys the owner has already declared unanswerable, from the review records.
  const silenced = new Set<string>();
  for (const t of ctx.transactions) {
    if (!reviews[t.id]?.reasons?.includes(GROUP_UNKNOWN_REASON)) continue;
    const { signal, value } = signalOf(t);
    for (const kind of ['unknown_inflow', 'unpaired_leg'] as UnmappedKind[]) {
      silenced.add(groupKey(kind, signal, value, directionOf(t)));
    }
  }

  const buckets = new Map<string, { kind: UnmappedKind; signal: 'merchant' | 'counterparty'; value: string; direction: 'inflow' | 'outflow'; rows: Transaction[] }>();
  for (const { t, kind } of unmapped) {
    const { signal, value } = signalOf(t);
    const direction = directionOf(t);
    const key = groupKey(kind, signal, value, direction);
    if (silenced.has(key)) continue;
    const bucket = buckets.get(key);
    if (bucket) bucket.rows.push(t);
    else buckets.set(key, { kind, signal, value, direction, rows: [t] });
  }

  // FIN-REFUND-001's OWN result, taken from the caller when it already has one — /flow
  // computes this run for the recovery queue two memos above the one that calls us.
  const refundCandidates =
    ctx.refundCandidates ??
    (ctx.accounts?.length
      ? generateRefundCandidates(ctx.transactions, ctx.accounts as PaymentAccount[], [], { income: ctx.income })
          .candidates
      : []);

  // "Has this stopped?" is asked of the LEDGER's last day, never the wall clock: an
  // export that ends in May must not make every series look dead.
  const ledgerLastDate = ctx.transactions.reduce((latest, t) => {
    const d = day(t.date);
    return d > latest ? d : latest;
  }, '');

  const groups: MappingGroup[] = [];
  for (const [key, b] of buckets) {
    const rows = [...b.rows].sort((x, y) => day(x.date).localeCompare(day(y.date)) || x.id.localeCompare(y.id));
    const cents = rows.map((t) => toCents(t.amount));
    const dates = rows.map((t) => day(t.date)).sort();
    // Evidence is drawn from rows OUTSIDE the group that share its key: what the owner
    // already decided about this pattern, not what the open rows say about themselves.
    const siblings = ctx.transactions.filter((t) => {
      if (rows.some((r) => r.id === t.id)) return false;
      const s = signalOf(t);
      return s.signal === b.signal && s.value === b.value;
    });
    const totalCents = cents.reduce((s, c) => s + c, 0);
    const facts: GroupFacts = {
      signalValue: b.value,
      direction: b.direction,
      accountIds: [...new Set(rows.map((t) => t.accountId).filter(Boolean) as string[])].sort(),
      series: detectPayerSeries(rows),
      ledgerLastDate,
      laterOutflowsToSamePayer: (siblings as Transaction[]).filter(
        (t) => directionOf(t) === 'outflow' && day(t.date) > dates[dates.length - 1]
      ),
    };
    groups.push({
      key,
      kind: b.kind,
      signal: b.signal,
      signalValue: b.value,
      label: b.signal === 'counterparty' ? b.value : b.value || 'No merchant name in your export',
      direction: b.direction,
      transactionIds: rows.map((t) => t.id),
      rowCount: rows.length,
      totalCents,
      minCents: Math.min(...cents),
      maxCents: Math.max(...cents),
      firstDate: dates[0],
      lastDate: dates[dates.length - 1],
      accountIds: facts.accountIds,
      sourceCategories: [...new Set(rows.map((t) => (t.sourceCategory ?? '').trim()).filter(Boolean))].sort(),
      cadence: cadenceOf(dates),
      suggestion: suggestFor(rows, facts, ctx, siblings as Transaction[], refundCandidates),
      findings: findingsFor(rows, facts),
      impactScore: rows.length * Math.abs(totalCents),
    });
  }

  groups.sort((a, b) => b.impactScore - a.impactScore || b.rowCount - a.rowCount || a.key.localeCompare(b.key));

  // Counts only. No merchant, no counterparty name, no amount, no transaction id.
  emit({
    eventName: 'Mapping.GroupsBuilt',
    traceId: newTraceId(),
    route: '/flow',
    component: 'mapping-suggestions.buildMappingGroups',
    calculationName: 'buildMappingGroups',
    recordCount: groups.length,
    resultStatus: groups.length ? 'ok' : 'empty',
    severity: 'debug',
    metadata: {
      rowCount: unmapped.length,
      silencedKeyCount: silenced.size,
      decisionsFor80Percent: decisionsToCover(groups, 0.8),
      byKind: groups.reduce<Record<string, number>>((a, g) => ({ ...a, [g.kind]: (a[g.kind] ?? 0) + 1 }), {}),
      withSuggestion: groups.filter((g) => g.suggestion).length,
      // MAP-002 — which evidence carried the day, as counts. An evidence KIND is a
      // vocabulary word of this module, not anything about the owner's money.
      byEvidence: groups.reduce<Record<string, number>>(
        (a, g) => (g.suggestion ? { ...a, [g.suggestion.evidence]: (a[g.suggestion.evidence] ?? 0) + 1 } : a),
        {}
      ),
      withFinding: groups.filter((g) => g.findings.length).length,
      withIncomeSourceOffer: groups.filter((g) => g.suggestion?.incomeSourceOffer).length,
    },
  });

  return groups;
}

/**
 * How many of these groups the owner has to answer to clear `fraction` of the rows.
 * The whole point of the task, as a number the UI can print.
 */
export function decisionsToCover(groups: readonly MappingGroup[], fraction: number): number {
  const total = groups.reduce((s, g) => s + g.rowCount, 0);
  let acc = 0;
  for (const [i, g] of groups.entries()) {
    acc += g.rowCount;
    if (acc >= total * fraction) return i + 1;
  }
  return groups.length;
}

// ---------------------------------------------------------------------------
// Scope and rule generation
// ---------------------------------------------------------------------------

/** Only the scopes this group can actually express, so the UI cannot offer a lie. */
export function groupScopes(group: MappingGroup): GroupScope[] {
  const scopes: GroupScope[] = ['only_this_group'];
  if (group.signal === 'merchant' && group.signalValue) {
    scopes.push('same_normalized_merchant');
    if (group.accountIds.length === 1) scopes.push('merchant_and_account');
    scopes.push('merchant_and_direction');
  }
  if (group.signal === 'counterparty') scopes.push('same_counterparty');
  scopes.push('future_only');
  return scopes;
}

/**
 * The rule a scope means, or `null` for "no rule".
 *
 * `contains` rather than `equals` on the merchant, because `normalizeMerchant()` strips
 * `#…`/`*…` suffixes and trailing digit runs: `equals` on the normalized value would miss
 * the very rows the group was built from. The breadth that buys is not hidden — the
 * preview is computed FROM this rule, so the count it shows is the count it will change.
 */
export function buildGroupRule(
  group: MappingGroup,
  scope: GroupScope,
  set: MappingRule['set'],
  todayISO?: string
): NewMappingRule | null {
  if (scope === 'only_this_group') return null;
  if (!groupScopes(group).includes(scope)) return null;

  const base: RuleMatch =
    group.signal === 'counterparty'
      ? { field: 'description', op: 'contains', value: group.signalValue }
      : { field: 'merchant', op: 'contains', value: group.signalValue };

  const match: RuleMatch = { ...base };
  if (scope === 'merchant_and_account') match.accountId = group.accountIds[0];
  if (scope === 'merchant_and_direction') match.direction = group.direction;
  if (scope === 'same_counterparty') match.direction = group.direction;
  if (scope === 'future_only') match.onOrAfter = day(todayISO ?? new Date().toISOString());

  return { match, set, enabled: true };
}

// ---------------------------------------------------------------------------
// The preview — FIN-REVIEW-002 §7.2, nothing applies before this is read
// ---------------------------------------------------------------------------

export interface GroupPreview {
  /** `describeRule()` in the owner's words. */
  whatChanges: string;
  /** Straight from `rulePreview()` — the rows this exact rule would alter, today. */
  affectedCount: number;
  dateRange: string;
  includesFutureRows: boolean;
  futureEffect: string;
  budgetEffect: string;
  forecastEffect: string;
  flowEffect: string;
  scopeSentence: string;
  /** §7.3 — a broad rule cannot be applied in one click. */
  needsExtraConfirmation: boolean;
}

/** §7.3's threshold: 25 rows, or 10% of the ledger, whichever is smaller. */
export const BROAD_RULE_THRESHOLD = 25;

/**
 * What the owner is agreeing to, computed from the RULE rather than from the group, so
 * "matches 37 transactions" and "changes 37 transactions" cannot drift apart.
 */
export function groupPreview(
  group: MappingGroup,
  rule: NewMappingRule,
  ctx: Pick<UnmappedContext, 'transactions' | 'accounts'>
): GroupPreview {
  const asRule: MappingRule = {
    id: rule.id ?? 'preview', createdAt: rule.createdAt ?? '',
    enabled: rule.enabled, match: rule.match, set: rule.set,
  };
  // One predicate for the count AND the dates — `rulePreview()`, the same helper §7.2
  // names — so "matches N" and "these N rows" can never disagree.
  const all = (ctx.transactions as Transaction[]).filter((t) => rulePreview(asRule, [t]).matches > 0);
  const matches = all.length;
  const dates = all.map((t) => day(t.date)).sort();
  const threshold = Math.min(BROAD_RULE_THRESHOLD, Math.ceil(ctx.transactions.length * 0.1));

  const setsCategory = !!(rule.set.category || rule.set.sourceCategory);
  const changesType = !!rule.set.type;

  return {
    whatChanges: describeRule(asRule),
    affectedCount: matches,
    dateRange: dates.length
      ? dates[0] === dates[dates.length - 1] ? dates[0] : `${dates[0]} to ${dates[dates.length - 1]}`
      : 'no existing rows',
    // A rule has no end date. Every scope here keeps applying as rows arrive; the only
    // question is whether history moves too, and `future_only` is the scope that says no.
    includesFutureRows: true,
    futureEffect: rule.match.onOrAfter
      ? `Rows imported from ${rule.match.onOrAfter} onwards. Your history is left exactly as it is.`
      : 'Rows imported from now on are treated the same way, automatically.',
    budgetEffect: setsCategory
      ? `${plural(matches, 'row')} move category, so the months between ${
          dates[0] ?? 'nothing'
        } and ${dates[dates.length - 1] ?? 'nothing'} re-total.`
      : 'No category changes, so no budget total moves.',
    // Umbrella §10 restated: this feature projects nothing. Answering a group can only
    // ever remove a guess, never add income.
    forecastEffect: changesType
      ? 'Rows marked as a transfer leave the forecast baseline entirely — they are money you already had.'
      : 'Your forecast gains no income from this. Naming money does not create any.',
    flowEffect: changesType
      ? 'These rows move out of their current Flow lane and into your transfers.'
      : setsCategory
        ? 'These rows move to the lane of their new category in Flow. The totals do not change.'
        : 'The Flow diagram keeps the same boxes, ribbons and totals.',
    scopeSentence: `${SCOPE_LABEL[scopeOfRule(rule, group)]} — ${plural(matches, 'existing row')}${
      matches ? '' : ' (nothing in your history matches yet)'
    }.`,
    needsExtraConfirmation: matches > threshold,
  };
}

/** Which scope a built rule came from — for the sentence above. Derived, not stored. */
function scopeOfRule(rule: NewMappingRule, group: MappingGroup): GroupScope {
  if (rule.match.onOrAfter) return 'future_only';
  if (rule.match.accountId) return 'merchant_and_account';
  if (group.signal === 'counterparty') return 'same_counterparty';
  if (rule.match.direction) return 'merchant_and_direction';
  return 'same_normalized_merchant';
}

// ---------------------------------------------------------------------------
// The owner's answer — DOCUMENTS to persist, never a write from here
// ---------------------------------------------------------------------------

/**
 * "This is outside my data" / "I don't want to classify this", as review records.
 *
 * `dismissed` is already terminal everywhere: `selectInflowReviewQueue` drops the row and
 * `queueStateOfReview` returns `null`. The added `GROUP_UNKNOWN_REASON` is what makes it
 * terminal for the PATTERN as well, so a row imported next month does not re-open a
 * question the owner has closed.
 */
export function markGroupUnknown(group: MappingGroup, at: string): InflowReview[] {
  return group.transactionIds.map((transactionId) => ({
    transactionId,
    state: 'dismissed' as const,
    reasons: [GROUP_UNKNOWN_REASON],
    source: 'user' as const,
    updatedAt: at,
  }));
}

/** The owner's positive answer for a whole group, one review record per row. */
export function confirmGroupMeaning(
  group: MappingGroup,
  meaning: FinancialMeaning,
  at: string,
  incomeSourceId?: string
): InflowReview[] {
  return group.transactionIds.map((transactionId) => ({
    transactionId,
    state: 'confirmed' as const,
    meaning,
    ...(incomeSourceId ? { incomeSourceId } : {}),
    source: 'user' as const,
    confirmedAt: at,
    updatedAt: at,
  }));
}

/**
 * What a rule can carry for a given answer, or `null` when the engine cannot express it.
 *
 * The engine sets `category | sourceCategory | type | merchant` and nothing else, so a
 * meaning like "someone paying me back" has no rule form — the review record carries it
 * per row and the scope is honestly "these rows only". "Money between my own accounts"
 * DOES have one: `type: 'transfer'` is the one `set.type` value that survives, because
 * `classifyTransaction()` never re-derives a stored transfer.
 *
 * Returning `null` instead of inventing a category is the whole discipline of this file.
 */
export function ruleSetForMeaning(meaning: FinancialMeaning): MappingRule['set'] | null {
  return meaning === 'internal_transfer' || meaning === 'card_payment' ? { type: 'transfer' } : null;
}

/** The owner's answer to a group. Produced by a button press and by nothing else. */
export interface GroupDecision {
  action: 'confirm' | 'unknown';
  meaning?: FinancialMeaning;
  incomeSourceId?: string;
  scope: GroupScope;
  /** Present only when a rule was asked for AND the engine can express the answer. */
  rule?: NewMappingRule;
  /**
   * MAP-002 — the derived income source, present ONLY when the owner explicitly ticked
   * the offer. Absent otherwise, including when the suggestion carried one and the owner
   * left it alone. Deriving a source and creating one are two different events.
   */
  incomeSourceOffer?: Omit<IncomeSource, 'id'>;
}

/** The meanings a group can be answered with, in the order a person would consider them. */
export const GROUP_MEANINGS: readonly { value: FinancialMeaning; label: string }[] = [
  { value: 'internal_transfer', label: 'Money moving between my own accounts' },
  { value: 'card_payment', label: 'A payment to one of my cards' },
  { value: 'refund', label: 'Money back from something I bought' },
  { value: 'shared_expense_reimbursement', label: 'Someone paying me back their share' },
  { value: 'receivable_repayment', label: 'Someone repaying money I lent' },
  { value: 'gift_or_personal_transfer', label: 'A gift or a personal transfer' },
  { value: 'sale_proceeds', label: 'Money from selling something' },
  { value: 'loan_proceeds', label: 'Money I borrowed — a loan paid out to me' },
  { value: 'earned_income', label: 'Income I earned' },
  { value: 'other_non_income_credit', label: 'Something else — but not income' },
];
