/**
 * Client half of the AI mapping chat.
 *
 * buildChatContext() — the COMPACT ledger snapshot the callable gets. Never the full
 * ledger: it is cost, and every extra row is more text the model could be steered by.
 *
 * parseChatAction() — the trust boundary. The callable returns model output, so it is
 * treated as hostile: unknown actions, unknown keys, invented categories, empty match
 * values and anything that isn't the exact shape below are rejected outright rather
 * than coerced. A rejected payload is `null`; the UI shows the raw text instead of
 * offering to save a rule nobody asked for.
 */

import {
  ExpenseCategory,
  PaymentAccount,
  resolveCategories,
  ResolvedCategory,
  Transaction,
  TransactionType,
} from '@/types';
import { buildAssumptions } from './behavior';
import { loadOverrides } from './assumption-overrides';
import { isCharging, PAYMENT_METHODS, type Bill, type BillFrequency } from './bills';
import { buildLedgerSummary, LedgerSummary } from './chat-summary';
import { describeRule, MappingRule, NewMappingRule } from './mapping-rules';
import { MAX_PROPOSED_LINKS, ReviewCandidate } from './candidates';
import { CARD_CREDIT_KINDS, CardCreditKind, LinkDraft, TxRef, validateLink } from './relations';
import { emit } from './obs/events';

export interface ChatContext {
  // cashflow-mobile#24: the owner's OWN set (defaults + custom, archived excluded) —
  // a plain string, not ExpenseCategory, since a custom slug is never a member of
  // that closed union.
  categories: string[];
  merchants: string[];
  accounts: string[];
  recent: { title: string; merchant?: string; amount: number; category?: string }[];
  /** App-computed totals over EVERY row — see chat-summary.ts. */
  summary?: LedgerSummary;
  /**
   * #22: the owner's recorded Bills register, filtered to current (not cancelled, not
   * past its endDate — same `isCharging` rule billUpcomingEvents uses), so the chat can
   * answer "is X already on my bills" instead of "I have no information". No `upcoming`
   * counterpart on web: that is homeSnapshot's forecast-events + bill-events merge
   * (functions/src/snapshot.ts), which nothing on the web client computes today.
   */
  bills: { vendor: string; amount: number; frequency: BillFrequency; nonNegotiable?: boolean; endDate?: string; installmentsRemaining?: number; method?: string }[];
  /** #22: detected recurring merchants (behavior.ts's buildAssumptions().fixedBills),
   *  separate from the owner-curated Bills register above. */
  recurring: { merchant: string; amount: number; cadence: string }[];
}

/**
 * What the parser needs to check a recovery action against reality: the candidates the
 * application chose to show, and the rows in the caller's current ledger. Both come from
 * users/{uid}/…, which is what makes the ownership rule (P13) true by construction.
 *
 * Absent this, every recovery action is rejected — a model cannot act on rows the
 * application never handed it.
 */
export interface RecoveryContext {
  candidates: readonly ReviewCandidate[];
  transactions: readonly TxRef[] | Map<string, TxRef>;
}

export interface Allocation {
  targetTransactionId: string;
  allocatedAmountCents: number; // INTEGER CENTS, > 0
}

/**
 * The thirteen structured recovery actions. All of them land here in ONE pass:
 * src/lib/chat-actions.ts is the collision risk of the whole programme, so after
 * FIN-RELATION-001 the parser is CLOSED and FIN-REFUND-001 / FIN-DUPLICATE-001 add no
 * parser code at all.
 *
 * Every one is a PROPOSAL. Parsing renders a confirmation card and stops; there is no
 * code path from a model response to a Firestore write, no auto-apply mode, no
 * "apply all", and no setting that disables the gate.
 */
export type RecoveryAction =
  | { action: 'confirm_refund_allocation'; candidateId: string; allocations: Allocation[]; reason: string }
  | { action: 'adjust_refund_allocation'; candidateId: string; allocations: Allocation[]; reason: string }
  | { action: 'reject_refund_candidate'; candidateId: string; reason: string }
  | { action: 'classify_card_credit'; transactionId: string; cardCreditKind: CardCreditKind; reason: string }
  | { action: 'mark_reward_credit'; transactionId: string; reason: string }
  | { action: 'mark_chargeback_credit'; transactionId: string; targetTransactionId: string; allocatedAmountCents: number; reason: string }
  | { action: 'confirm_duplicate_charge'; candidateId: string; reason: string }
  | { action: 'confirm_duplicate_subscription'; candidateId: string; keepTransactionId: string; reason: string }
  | { action: 'mark_intentional_duplicate'; candidateId: string; reason: string }
  | { action: 'mark_different_owner'; candidateId: string; reason: string }
  | { action: 'mark_business_subscription'; candidateId: string; reason: string }
  | { action: 'mark_subscription_cancelled'; candidateId: string; effectiveDate: string; reason: string }
  | { action: 'dismiss_review_candidate'; candidateId: string; reason: string };

export type ChatAction =
  | { action: 'answer'; explanation: string }
  | { action: 'create_rule'; rule: NewMappingRule; explanation: string }
  /** Proposes a balance re-anchor. accountName resolves CLIENT-side against the
   *  owner's real account list; an ambiguous or unknown name renders no button. */
  | { action: 'set_account_balance'; accountName: string; balance: number; reason: string }
  /** Proposes an APPROVED INCOME SOURCE. Until one exists the engine calls no
   *  deposit income — deliberately, since guessing is what inflated the old
   *  figures. amount/frequency are DERIVED client-side from the deposits that
   *  actually match, never taken from the model. */
  | { action: 'set_income_source'; name: string; matchText: string[]; reason: string }
  /** FIN-SPEND-001 (#133). Proposes an OVERRIDE of the derived 6-month average
   *  that drives runway. amount is DOLLARS, > 0, capped at 1,000,000 — a model
   *  typo here would relabel the owner's own runway deadline, not just a rule. */
  | { action: 'set_monthly_spend'; amount: number; reason: string }
  /** #10/#14. Proposes a Bill row — a recurring/installment obligation that then
   *  shows in Upcoming and the Bills register. DISPLAY ONLY: this never reaches
   *  forecast/runway math (see billUpcomingEvents in bills.ts). accountName, if
   *  given, resolves CLIENT-side against the payment-method registry, same
   *  unresolvable-means-no-button contract as set_account_balance's accountName. */
  | {
      action: 'record_bill';
      vendor: string;
      amount: number;
      frequency: BillFrequency;
      dueDay?: number;
      /** ISO date of the NEXT payment. Fixes Defect 1: without this, a chat-recorded
       *  weekly/biweekly/quarterly/semiannual/annual bill got no Bill.anchorDate and
       *  billUpcomingEvents silently produced no Upcoming events for it. The card
       *  (DataChatSheet) turns this into anchorDate, and derives autopayDay from its
       *  day-of-month when dueDay is absent. */
      nextDueDate?: string;
      accountName?: string;
      endDate?: string;
      installmentsRemaining?: number;
      nonNegotiable?: boolean;
      reason: string;
    }
  /** cashflow-mobile#24. Proposes a NEW category. No `value` — the app derives a
   *  unique slug from the label, never the model. */
  | { action: 'add_category'; label: string; icon?: string; reason: string }
  /** cashflow-mobile#24. Renames one of the OWNER'S OWN categories (never a
   *  built-in default — `value` must be a CUSTOM entry the owner already has). */
  | { action: 'rename_category'; value: string; label: string; reason: string }
  /** cashflow-mobile#24. Removes one of the owner's own categories. reassignTo
   *  always resolves to a concrete value (defaults to 'other') so every consumer
   *  downstream of the parser can rely on it being present. */
  | { action: 'remove_category'; value: string; reassignTo: string; reason: string }
  | RecoveryAction;

/**
 * The prose an action carries, if it carries any. The two original actions explain
 * themselves; the thirteen recovery actions carry `reason` and are rendered by their own
 * confirmation card, so callers that only want a line of text ask for it here rather than
 * reaching into a union member that may not have one.
 */
export const explanationOf = (a: ChatAction | null | undefined): string | undefined =>
  a && 'explanation' in a ? a.explanation : undefined;

/**
 * The PROSE inside a payload `parseChatAction` refused — and nothing else.
 *
 * The owner typed "this Turo row is car rental for the trip", a perfectly clear
 * instruction, and got "I couldn't turn that into a change." The strict parser had done
 * its job: whatever came back was not a rule it could vouch for. The defect is what
 * happened next — returning `null` threw away the model's ANSWER along with its rejected
 * action, so a reply that could not become a button became nothing at all.
 *
 * This reads text and only text. No rule, no allocation, no candidate id, no action can
 * come out of here, so the trust boundary above is untouched: a refused rule is still
 * refused, the owner just gets to read what was said about it.
 */
export function fallbackText(raw: unknown): string | undefined {
  if (typeof raw === 'string') return str(raw, MAX.explanation) ?? undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  if (hasPollutedKey(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  for (const key of ['explanation', 'reason', 'answer', 'text', 'message']) {
    const s = str(o[key], MAX.explanation);
    if (s) return s;
  }
  return undefined;
}

const MAX = {
  merchants: 40,
  recent: 15,
  accounts: 20,
  str: 60,
  matchValue: 120,
  explanation: 500,
  candidateId: 400,
  transactionId: 128,
  // firestore.rules' isValidString(vendor, 1, 200) — the same ceiling the write itself enforces.
  vendor: 200,
  // #22 — breadth caps for the two new context sections, same idea as `merchants` above:
  // bound the LIST length so a large register/ledger cannot grow the context unboundedly.
  bills: 60,
  recurring: 40,
  // cashflow-mobile#24
  categoryLabel: 40,
  categoryValue: 32,
  categoryIcon: 4,
} as const;

// The DEFAULT category set — used as the fallback everywhere a caller does not (yet)
// have the owner's resolved one, so every existing call site keeps working unchanged.
const DEFAULT_CATEGORIES: readonly ResolvedCategory[] = resolveCategories();
const FIELDS: readonly string[] = ['merchant', 'title', 'description'];
const OPS: readonly string[] = ['contains', 'equals'];
const TYPES: readonly string[] = ['expense', 'income', 'transfer'];
// Mirrors bills.ts's BillFrequency exactly — a closed set, not income's ('yearly' vs 'annual').
const BILL_FREQUENCIES: readonly string[] = ['weekly', 'biweekly', 'monthly', 'quarterly', 'semiannual', 'annual'];

const clip = (s: string, max: number = MAX.str) => s.trim().slice(0, max);

/**
 * The compact context sent with every chat turn: the closed category set, the merchant
 * strings that actually occur, account names, and a handful of recent rows so the model
 * can see what raw bank text looks like.
 *
 * Bank feeds often carry no merchant at all, so the merchant list falls back to the row
 * title — those are the strings a `title contains "..."` rule has to match.
 */
export function buildChatContext(
  transactions: Transaction[],
  accounts: PaymentAccount[] = [],
  bills: Bill[] = [],
  // cashflow-mobile#24. The owner's resolved set — defaults when the caller has
  // none yet, so every existing 2/3-arg call site keeps behaving unchanged.
  categories: readonly ResolvedCategory[] = DEFAULT_CATEGORIES
): ChatContext {
  const counts = new Map<string, number>();
  for (const t of transactions) {
    const key = clip(t.merchant || t.title || '');
    if (key) counts.set(key, (counts.get(key) || 0) + 1);
  }

  const merchants = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX.merchants)
    .map(([name]) => name);

  const recent = [...transactions]
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .slice(0, MAX.recent)
    .map((t) => ({
      title: clip(t.title || ''),
      ...(t.merchant ? { merchant: clip(t.merchant) } : {}),
      amount: t.amount,
      ...(t.category ? { category: t.category } : {}),
    }));

  const today = new Date().toISOString().slice(0, 10);

  return {
    // cashflow-mobile#24: ASSIGNABLE only — archived never appears in ALLOWED
    // CATEGORIES, so the model can never propose filing a new row under one.
    categories: categories.filter((c) => !c.archived).map((c) => c.value),
    merchants,
    accounts: accounts.slice(0, MAX.accounts).map((a) => clip(a.name || '')).filter(Boolean),
    recent,
    // Totals over EVERY row. `recent` is 20 rows of raw text so the model can see what
    // bank feeds look like for rule-writing; it is NOT the evidence for any number.
    summary: buildLedgerSummary(transactions, accounts),
    // #22: current bills only — same rule billUpcomingEvents applies, so a cancelled or
    // expired row never reads as "still going" to the model. Capped/clipped like every
    // other list here (`merchants` above) — a large register must not grow the prompt.
    bills: bills
      .filter((b) => isCharging(b, today))
      .slice(0, MAX.bills)
      .map((b) => ({
        vendor: clip(b.vendor),
        amount: b.amount,
        frequency: b.frequency,
        ...(b.nonNegotiable ? { nonNegotiable: true } : {}),
        ...(b.endDate ? { endDate: b.endDate } : {}),
        ...(b.installmentsRemaining !== undefined ? { installmentsRemaining: b.installmentsRemaining } : {}),
        ...(PAYMENT_METHODS[b.paymentMethodId]?.label ? { method: PAYMENT_METHODS[b.paymentMethodId].label } : {}),
      })),
    // detectRecurring's own active set, via behavior.ts's buildAssumptions — one
    // derivation, not a second copy of the pattern-matching rules. loadOverrides()
    // (the SAME read forecast/page.tsx does before calling buildAssumptions) matters
    // here: without it, a merchant the owner disabled or corrected on the Forecast
    // page would still show here with its raw detected amount, contradicting what
    // the Forecast page itself says. loadOverrides() already try/catches internally
    // (SSR/private-mode/corrupt JSON all fall back to {}), and this module is never
    // imported outside the browser (DataChatSheet.tsx is 'use client'; functions/
    // does not compile chat-actions.ts), so no extra guard is needed here.
    recurring: buildAssumptions(transactions, accounts, loadOverrides()).fixedBills
      .slice(0, MAX.recurring)
      .map((r) => ({ merchant: clip(r.merchant), amount: r.amount, cadence: r.cadence })),
  };
}

/** An object with no keys outside `allowed`. Arrays, null and primitives are not objects. */
function record(v: unknown, allowed: readonly string[]): Record<string, unknown> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  return Object.keys(o).every((k) => allowed.includes(k)) ? o : null;
}

/** Non-empty trimmed string, or null. */
function str(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = clip(v, max);
  return s || null;
}

function parseRule(raw: unknown, allowedCategories: readonly string[]): NewMappingRule | null {
  const r = record(raw, ['match', 'set']);
  if (!r) return null;

  const m = record(r.match, ['field', 'op', 'value']);
  if (!m) return null;
  const value = str(m.value, MAX.matchValue);
  if (!value) return null; // empty needle would match the whole ledger
  if (typeof m.field !== 'string' || !FIELDS.includes(m.field)) return null;
  if (typeof m.op !== 'string' || !OPS.includes(m.op)) return null;

  const s = record(r.set, ['category', 'sourceCategory', 'type', 'merchant']);
  if (!s) return null;

  const set: MappingRule['set'] = {};
  if (s.category !== undefined) {
    // cashflow-mobile#24: closed over the OWNER's resolved, assignable set —
    // still a fixed list, just not a hardcoded 13 anymore.
    if (typeof s.category !== 'string' || !allowedCategories.includes(s.category)) return null;
    set.category = s.category as ExpenseCategory;
  }
  if (s.type !== undefined) {
    if (typeof s.type !== 'string' || !TYPES.includes(s.type)) return null;
    set.type = s.type as TransactionType;
  }
  if (s.sourceCategory !== undefined) {
    const label = str(s.sourceCategory, MAX.str);
    if (!label) return null;
    set.sourceCategory = label;
  }
  if (s.merchant !== undefined) {
    const merchant = str(s.merchant, MAX.str);
    if (!merchant) return null;
    set.merchant = merchant;
  }
  if (!Object.keys(set).length) return null; // a rule that changes nothing

  return {
    match: { field: m.field as MappingRule['match']['field'], op: m.op as 'contains' | 'equals', value },
    set,
    enabled: true,
  };
}

// ---------------------------------------------------------------------------
// Recovery actions (FIN-RELATION-001 §7)
// ---------------------------------------------------------------------------

/** Every rejection is a reason CODE in telemetry, never the payload that caused it. */
function deny(ruleId: string): null {
  emit({
    eventName: 'Relation.ValidationRejected',
    eventCategory: 'activity',
    severity: 'warn',
    traceId: '',
    component: 'RecoveryRelations',
    resultStatus: 'error',
    metadata: { ruleId },
  });
  return null;
}

const POLLUTION_KEYS = ['__proto__', 'constructor', 'prototype'];

/**
 * P3 — prototype-pollution keys as OWN properties at any depth. This runs IN ADDITION to
 * record()'s unknown-key rejection, so a later edit to an `allowed` list cannot quietly
 * reopen it. getOwnPropertyNames, not Object.keys: `JSON.parse('{"__proto__":{}}')`
 * creates a real own property, which is exactly the payload shape that matters.
 */
function hasPollutedKey(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== 'object' || depth > 6) return false;
  if (Array.isArray(value)) return value.some((v) => hasPollutedKey(v, depth + 1));
  const names = Object.getOwnPropertyNames(value);
  if (names.some((n) => POLLUTION_KEYS.includes(n))) return true;
  return names.some((n) => hasPollutedKey((value as Record<string, unknown>)[n], depth + 1));
}

const txMap = (t: RecoveryContext['transactions']): Map<string, TxRef> =>
  t instanceof Map ? t : new Map(t.map((r) => [r.id, r]));

/** Actions carrying a candidateId, and the extra key each one may add beyond `reason`. */
const CANDIDATE_ACTIONS: Record<string, readonly string[]> = {
  confirm_refund_allocation: ['allocations'],
  adjust_refund_allocation: ['allocations'],
  reject_refund_candidate: [],
  confirm_duplicate_charge: [],
  confirm_duplicate_subscription: ['keepTransactionId'],
  mark_intentional_duplicate: [],
  mark_different_owner: [],
  mark_business_subscription: [],
  mark_subscription_cancelled: ['effectiveDate'],
  dismiss_review_candidate: [],
};

const TRANSACTION_ACTIONS: Record<string, readonly string[]> = {
  classify_card_credit: ['cardCreditKind'],
  mark_reward_credit: [],
  mark_chargeback_credit: ['targetTransactionId', 'allocatedAmountCents'],
};

const ALLOCATION_ACTIONS = ['confirm_refund_allocation', 'adjust_refund_allocation'];

const isIsoDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

/**
 * record_bill's nextDueDate: a few days of slack behind "today" (a payment just missed,
 * or the model reading a screenshot dated slightly stale), generous room ahead (an
 * annual bill's next date can be up to a year out), but never a wildly wrong year a
 * model hallucinated. Plain string comparison is safe — both sides are yyyy-MM-dd.
 */
const isNextDueDateInRange = (s: string): boolean => {
  if (!isIsoDate(s)) return false;
  const day = 24 * 60 * 60 * 1000;
  const min = new Date(Date.now() - 7 * day).toISOString().slice(0, 10);
  const max = new Date(Date.now() + 400 * day).toISOString().slice(0, 10);
  return s >= min && s <= max;
};

/**
 * The allocations a refund action proposes, checked against the SAME validator the store
 * and firestore.rules enforce, so "integer cents", "> 0", "Σ ≤ the credit" and "each ≤
 * its purchase" have exactly one definition in this codebase.
 *
 * The credit is not something the model names: it is read off the candidate's own
 * proposed links, so an action can only ever re-allocate the credit the application
 * already picked.
 */
function parseAllocations(
  raw: unknown,
  candidate: ReviewCandidate,
  ledger: Map<string, TxRef>
): Allocation[] | null {
  if (!Array.isArray(raw)) return deny('P2');
  // P10 — rejected, never truncated: silently dropping an entry changes what the owner
  // is agreeing to.
  if (!raw.length || raw.length > MAX_PROPOSED_LINKS) return deny('P10');

  const sources = new Set(candidate.proposedLinks.map((p) => p.sourceTransactionId));
  if (sources.size !== 1) return deny('P6');
  const sourceTransactionId = [...sources][0];
  if (!ledger.has(sourceTransactionId)) return deny('P5');

  const allocations: Allocation[] = [];
  const accumulated: ReturnType<typeof toLink>[] = [];

  for (const entry of raw) {
    const a = record(entry, ['targetTransactionId', 'allocatedAmountCents']);
    if (!a) return deny('P2');

    const targetTransactionId = str(a.targetTransactionId, MAX.transactionId);
    if (!targetTransactionId) return deny('P5');
    if (!ledger.has(targetTransactionId)) return deny('P5');
    // P6 — containment. The model may only act on rows the application chose for it.
    if (!candidate.transactionIds.includes(targetTransactionId)) return deny('P6');

    const cents = a.allocatedAmountCents;
    if (typeof cents !== 'number') return deny('P7');

    const draft: LinkDraft = {
      linkType: 'refund_of',
      sourceTransactionId,
      targetTransactionId,
      allocatedAmountCents: cents,
      status: 'confirmed',
      confirmedAt: new Date().toISOString(),
      confirmedBy: 'user',
      algorithmVersion: candidate.algorithmVersion,
    };
    // P7 -> V1, P8 -> V4, P9 -> V5. One predicate, three call sites.
    const check = validateLink(draft, { transactions: ledger, links: accumulated });
    if (!check.ok) return deny(check.ruleId === 'V1' ? 'P7' : check.ruleId === 'V4' ? 'P8' : check.ruleId === 'V5' ? 'P9' : 'P7');

    accumulated.push(toLink(draft));
    allocations.push({ targetTransactionId, allocatedAmountCents: cents });
  }
  return allocations;
}

/** A validated draft as a confirmed link, so the running totals in V4/V5 can see it. */
const toLink = (d: LinkDraft) => ({
  ...d,
  id: `${d.linkType}~${d.sourceTransactionId}~${d.targetTransactionId}`,
  createdAt: d.confirmedAt ?? '',
  updatedAt: d.confirmedAt ?? '',
  status: 'confirmed' as const,
});

function parseRecoveryAction(o: Record<string, unknown>, action: string, ctx?: RecoveryContext): RecoveryAction | null {
  // P13 — ownership. Candidates and rows are loaded from users/{uid}/…, so a caller with
  // no context has handed us nothing to act on and every recovery action is refused.
  if (!ctx) return deny('P13');
  const ledger = txMap(ctx.transactions);

  // P12 — a reason that says nothing, mirroring the existing "a rule that changes
  // nothing" guard.
  const reason = str(o.reason, MAX.explanation);
  if (!reason) return deny('P12');

  if (action in CANDIDATE_ACTIONS) {
    const candidateId = str(o.candidateId, MAX.candidateId);
    if (!candidateId) return deny('P4');
    // Accepts either identity: the doc id (identityKey) or the versioned audit form.
    const candidate = ctx.candidates.find((c) => c.id === candidateId || c.candidateId === candidateId);
    if (!candidate) return deny('P4');

    if (ALLOCATION_ACTIONS.includes(action)) {
      const allocations = parseAllocations(o.allocations, candidate, ledger);
      if (!allocations) return null;
      return { action, candidateId: candidate.id, allocations, reason } as RecoveryAction;
    }

    if (action === 'confirm_duplicate_subscription') {
      const keepTransactionId = str(o.keepTransactionId, MAX.transactionId);
      if (!keepTransactionId || !ledger.has(keepTransactionId)) return deny('P5');
      if (!candidate.transactionIds.includes(keepTransactionId)) return deny('P6');
      return { action, candidateId: candidate.id, keepTransactionId, reason };
    }

    if (action === 'mark_subscription_cancelled') {
      const effectiveDate = str(o.effectiveDate, 10);
      if (!effectiveDate || !isIsoDate(effectiveDate)) return deny('P2');
      return { action, candidateId: candidate.id, effectiveDate, reason };
    }

    // mark_business_subscription and mark_different_owner are labels on the ALERT, not
    // tax or ownership claims: they set status 'intentional' with a distinguishing
    // reason code, make no deductibility claim, and leave the expense fully counted.
    return { action, candidateId: candidate.id, reason } as RecoveryAction;
  }

  const transactionId = str(o.transactionId, MAX.transactionId);
  if (!transactionId || !ledger.has(transactionId)) return deny('P5');

  if (action === 'classify_card_credit') {
    // P11 — closed membership. No value in this list projects onto earned income.
    const kind = o.cardCreditKind;
    if (typeof kind !== 'string' || !(CARD_CREDIT_KINDS as readonly string[]).includes(kind)) return deny('P11');
    return { action, transactionId, cardCreditKind: kind as CardCreditKind, reason };
  }

  if (action === 'mark_chargeback_credit') {
    const targetTransactionId = str(o.targetTransactionId, MAX.transactionId);
    if (!targetTransactionId || !ledger.has(targetTransactionId)) return deny('P5');
    const cents = o.allocatedAmountCents;
    if (typeof cents !== 'number') return deny('P7');
    const check = validateLink(
      {
        linkType: 'chargeback_for',
        sourceTransactionId: transactionId,
        targetTransactionId,
        allocatedAmountCents: cents,
        status: 'confirmed',
        confirmedAt: new Date().toISOString(),
        confirmedBy: 'user',
        algorithmVersion: 'refund-match-v1',
      },
      { transactions: ledger }
    );
    if (!check.ok) return deny(check.ruleId === 'V1' ? 'P7' : check.ruleId === 'V4' ? 'P8' : 'P9');
    return { action, transactionId, targetTransactionId, allocatedAmountCents: cents, reason };
  }

  return { action: 'mark_reward_credit', transactionId, reason };
}

/**
 * Validate one `result` payload from the aiChat callable. Returns null when anything
 * is off — callers show the text, they never guess at a half-valid rule.
 *
 * `ctx` is required for the thirteen recovery actions and unused by the original two.
 * Without it a recovery action cannot be checked against the caller's own candidates and
 * ledger, so it is refused rather than trusted.
 *
 * `categories` (cashflow-mobile#24) is the owner's resolved set, used to validate
 * create_rule's set.category and the three category verbs below. Omitted falls back
 * to the 13 defaults — every existing call site (and every existing test) keeps
 * working exactly as before; add_category/rename_category/remove_category, which
 * have no meaning without a real owner set to check against, are refused outright
 * when it is absent (same "no context, no action" contract `ctx` already has).
 */
export function parseChatAction(
  raw: unknown,
  ctx?: RecoveryContext,
  categories?: readonly ResolvedCategory[]
): ChatAction | null {
  // P3 first, over the whole payload, before any key is read.
  if (hasPollutedKey(raw)) return deny('P3');

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const action = (raw as Record<string, unknown>).action;
  if (typeof action !== 'string') return null;

  if (action === 'set_account_balance') {
    const o = record(raw, ['action', 'accountName', 'balance', 'reason']);
    if (!o) return null;
    const accountName = str(o.accountName, MAX.str);
    const reason = str(o.reason, MAX.explanation);
    // Bounded and finite, or nothing: a model typo of 60097 instead of 600.97 is
    // exactly the kind of number the card must show and the owner must refuse —
    // but NaN, Infinity and absurd magnitudes never reach a card at all.
    const balance = o.balance;
    if (!accountName || !reason) return null;
    if (typeof balance !== 'number' || !Number.isFinite(balance) || Math.abs(balance) > 5_000_000) return null;
    return { action: 'set_account_balance', accountName, balance: Math.round(balance * 100) / 100, reason };
  }

  if (action === 'set_monthly_spend') {
    const o = record(raw, ['action', 'amount', 'reason']);
    if (!o) return null;
    const reason = str(o.reason, MAX.explanation);
    const amount = o.amount;
    if (!reason) return null;
    // Finite, positive, and bounded: a model typo (25000 instead of 2500) would
    // otherwise pass straight through as the owner's own runway assumption.
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) return null;
    return { action: 'set_monthly_spend', amount: Math.round(amount * 100) / 100, reason };
  }

  if (action === 'set_income_source') {
    const o = record(raw, ['action', 'name', 'matchText', 'reason']);
    if (!o) return null;
    const name = str(o.name, MAX.str);
    const reason = str(o.reason, MAX.explanation);
    if (!name || !reason) return null;
    // A 1-2 character alias matches nearly every statement line, which would turn
    // one sloppy source into "everything is my salary" — the same MIN_ALIAS floor
    // classify.ts enforces, applied before the proposal is ever shown.
    const raws = Array.isArray(o.matchText) ? o.matchText : [o.matchText];
    const matchText = [...new Set(
      raws.map((x) => (str(x, MAX.str) ?? '').toLowerCase()).filter((x) => x.length >= 3)
    )].slice(0, 12);
    if (!matchText.length) return null;
    return { action: 'set_income_source', name, matchText, reason };
  }

  if (action === 'record_bill') {
    const o = record(raw, [
      'action', 'vendor', 'amount', 'frequency', 'dueDay', 'nextDueDate', 'accountName',
      'endDate', 'installmentsRemaining', 'nonNegotiable', 'reason',
    ]);
    if (!o) return null;

    const vendor = str(o.vendor, MAX.vendor);
    const reason = str(o.reason, MAX.explanation);
    if (!vendor || !reason) return null;

    const amount = o.amount;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || amount > 100_000) return null;

    if (typeof o.frequency !== 'string' || !BILL_FREQUENCIES.includes(o.frequency)) return null;
    const frequency = o.frequency as BillFrequency;

    let dueDay: number | undefined;
    if (o.dueDay !== undefined) {
      if (typeof o.dueDay !== 'number' || !Number.isInteger(o.dueDay) || o.dueDay < 1 || o.dueDay > 31) return null;
      dueDay = o.dueDay;
    }

    let nextDueDate: string | undefined;
    if (o.nextDueDate !== undefined) {
      if (typeof o.nextDueDate !== 'string' || !isNextDueDateInRange(o.nextDueDate)) return null;
      nextDueDate = o.nextDueDate;
    }

    let accountName: string | undefined;
    if (o.accountName !== undefined) {
      const a = str(o.accountName, MAX.str);
      if (!a) return null; // present but empty — the model said nothing, don't pretend it did
      accountName = a;
    }

    let endDate: string | undefined;
    if (o.endDate !== undefined) {
      if (typeof o.endDate !== 'string' || !isIsoDate(o.endDate)) return null;
      endDate = o.endDate;
    }

    let installmentsRemaining: number | undefined;
    if (o.installmentsRemaining !== undefined) {
      if (
        typeof o.installmentsRemaining !== 'number' ||
        !Number.isInteger(o.installmentsRemaining) ||
        o.installmentsRemaining < 1 ||
        o.installmentsRemaining > 480
      ) return null;
      installmentsRemaining = o.installmentsRemaining;
    }

    // Either an end date or a payment count, never both — two answers to "when does
    // this stop" is worse than one, and the model can always ask instead of guessing.
    if (endDate !== undefined && installmentsRemaining !== undefined) return null;

    let nonNegotiable: boolean | undefined;
    if (o.nonNegotiable !== undefined) {
      if (typeof o.nonNegotiable !== 'boolean') return null;
      nonNegotiable = o.nonNegotiable;
    }

    return {
      action: 'record_bill',
      vendor,
      amount: Math.round(amount * 100) / 100,
      frequency,
      ...(dueDay !== undefined ? { dueDay } : {}),
      ...(nextDueDate !== undefined ? { nextDueDate } : {}),
      ...(accountName !== undefined ? { accountName } : {}),
      ...(endDate !== undefined ? { endDate } : {}),
      ...(installmentsRemaining !== undefined ? { installmentsRemaining } : {}),
      ...(nonNegotiable !== undefined ? { nonNegotiable } : {}),
      reason,
    };
  }

  // cashflow-mobile#24: add_category. No `value` accepted from the model — the app
  // derives a unique, collision-safe slug from label at apply time, never trusting
  // a model-picked identifier.
  if (action === 'add_category') {
    const o = record(raw, ['action', 'label', 'icon', 'reason']);
    if (!o) return null;
    const label = str(o.label, MAX.categoryLabel);
    const reason = str(o.reason, MAX.explanation);
    if (!label || !reason) return null;
    let icon: string | undefined;
    if (o.icon !== undefined) {
      const i = str(o.icon, MAX.categoryIcon);
      if (!i) return null; // present but empty — the model said nothing, don't pretend it did
      icon = i;
    }
    return { action: 'add_category', label, ...(icon !== undefined ? { icon } : {}), reason };
  }

  // rename_category / remove_category both require the OWNER's resolved set to
  // check `value` against — refused outright with no context, the same "no
  // context, no action" contract the recovery actions already have with no `ctx`.
  if (action === 'rename_category') {
    const o = record(raw, ['action', 'value', 'label', 'reason']);
    if (!o) return null;
    const value = str(o.value, MAX.categoryValue);
    const label = str(o.label, MAX.categoryLabel);
    const reason = str(o.reason, MAX.explanation);
    if (!value || !label || !reason || !categories) return null;
    // Only a CUSTOM category the owner already has can be renamed — never a
    // built-in default. Renaming one of the 13 would need a data model for
    // overriding a default, which this task deliberately does not build.
    const isDefault = DEFAULT_CATEGORIES.some((c) => c.value === value);
    if (isDefault || !categories.some((c) => c.value === value)) return null;
    return { action: 'rename_category', value, label, reason };
  }

  if (action === 'remove_category') {
    const o = record(raw, ['action', 'value', 'reassignTo', 'reason']);
    if (!o) return null;
    const value = str(o.value, MAX.categoryValue);
    const reason = str(o.reason, MAX.explanation);
    if (!value || !reason || !categories) return null;
    const isDefault = DEFAULT_CATEGORIES.some((c) => c.value === value);
    if (isDefault || !categories.some((c) => c.value === value)) return null;

    let reassignTo = 'other';
    if (o.reassignTo !== undefined) {
      const r = str(o.reassignTo, MAX.categoryValue);
      if (!r) return null;
      reassignTo = r;
    }
    if (reassignTo === value) return null; // can't reassign to the thing being removed
    // The target must be a live, assignable category — never archived, never the
    // removed value itself (checked above).
    if (!categories.some((c) => c.value === reassignTo && !c.archived)) return null;

    return { action: 'remove_category', value, reassignTo, reason };
  }

  if (action in CANDIDATE_ACTIONS || action in TRANSACTION_ACTIONS) {
    const allowed = [
      'action',
      'reason',
      ...(action in CANDIDATE_ACTIONS ? ['candidateId', ...CANDIDATE_ACTIONS[action]] : ['transactionId', ...TRANSACTION_ACTIONS[action]]),
    ];
    // P2 — unknown keys at the top level. Never a spread of raw input.
    const o = record(raw, allowed);
    if (!o) return deny('P2');
    return parseRecoveryAction(o, action, ctx);
  }

  const o = record(raw, ['action', 'rule', 'explanation']);
  if (!o) return null;

  const explanation = str(o.explanation, MAX.explanation);

  if (o.action === 'answer') {
    return explanation ? { action: 'answer', explanation } : null;
  }
  // P1 — anything outside the closed set. Never coerced, never guessed at.
  if (o.action !== 'create_rule') return null;

  // cashflow-mobile#24: the owner's resolved, assignable set — defaults when the
  // caller has not supplied one, exactly today's behaviour.
  const allowedCategories = (categories ?? DEFAULT_CATEGORIES).filter((c) => !c.archived).map((c) => c.value);
  const rule = parseRule(o.rule, allowedCategories);
  if (!rule) return null;

  return {
    action: 'create_rule',
    rule,
    // A terse model shouldn't cost the owner a valid rule — describeRule says it plainly.
    explanation: explanation || describeRule({ ...rule, id: '', createdAt: '' }),
  };
}
