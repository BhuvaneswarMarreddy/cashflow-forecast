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
import { IncomeContext, InflowReviewItem, selectInflowReviewQueue } from './classify';
import { unpairedLegLane } from './flow-lanes';
import { BANDS, daysBetween, day, isSelfPerson, median, normalizeMerchant, personFrom, toCents } from './flows';
import { MappingRule, NewMappingRule, RuleMatch, describeRule, rowDirection, rulePreview } from './mapping-rules';
import { formatMoneyCents } from './money';
import { emit } from './obs/events';
import { newTraceId } from './obs/trace';

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

/** The four evidence kinds. Each is a fact the ledger already contains. */
export type SuggestionEvidence =
  | 'existing_rule'
  | 'prior_confirmation'
  | 'approved_income_source'
  | 'same_day_opposite_leg';

export interface MappingSuggestion {
  evidence: SuggestionEvidence;
  /** What the rows would mean. Written to the review record, not to the row. */
  meaning?: FinancialMeaning;
  /** What a rule would set, when the evidence is itself a rule. */
  set?: MappingRule['set'];
  /** The approved source, when that is the evidence. */
  incomeSourceId?: string;
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
 * The first evidence that holds, in confidence order. `null` is a legitimate and common
 * answer: when the ledger says nothing, this module says nothing. It never fills the gap
 * with a plausible-sounding default, because a plausible default is exactly how a
 * one-off deposit became salary in the first place.
 */
function suggestFor(
  rows: Transaction[],
  signalValue: string,
  ctx: UnmappedContext,
  siblings: Transaction[]
): MappingSuggestion | null {
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

  // 4. The counterpart is sitting in another account you own, on the same day, for the
  //    same amount. Nothing is PAIRED here — `transfers.ts` is untouched. This only
  //    tells the owner what the ledger already shows and lets them decide.
  const sameDay = rows.filter((t) =>
    ctx.transactions.some(
      (o) =>
        o.id !== t.id &&
        o.accountId &&
        t.accountId &&
        o.accountId !== t.accountId &&
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
        `${plural(sameDay.length, 'row')} of these has the same amount going the other way in ` +
        'another account of yours on the same day',
    };
  }

  return null;
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
      accountIds: [...new Set(rows.map((t) => t.accountId).filter(Boolean) as string[])].sort(),
      sourceCategories: [...new Set(rows.map((t) => (t.sourceCategory ?? '').trim()).filter(Boolean))].sort(),
      cadence: cadenceOf(dates),
      suggestion: suggestFor(rows, b.value, ctx, siblings as Transaction[]),
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
  { value: 'earned_income', label: 'Income I earned' },
  { value: 'other_non_income_credit', label: 'Something else — but not income' },
];
