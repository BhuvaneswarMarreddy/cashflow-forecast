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
  EXPENSE_CATEGORIES,
  ExpenseCategory,
  PaymentAccount,
  Transaction,
  TransactionType,
} from '@/types';
import { buildLedgerSummary, LedgerSummary } from './chat-summary';
import { describeRule, MappingRule, NewMappingRule } from './mapping-rules';
import { MAX_PROPOSED_LINKS, ReviewCandidate } from './candidates';
import { CARD_CREDIT_KINDS, CardCreditKind, LinkDraft, TxRef, validateLink } from './relations';
import { emit } from './obs/events';

export interface ChatContext {
  categories: ExpenseCategory[];
  merchants: string[];
  accounts: string[];
  recent: { title: string; merchant?: string; amount: number; category?: string }[];
  /** App-computed totals over EVERY row — see chat-summary.ts. */
  summary?: LedgerSummary;
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
  | RecoveryAction;

/**
 * The prose an action carries, if it carries any. The two original actions explain
 * themselves; the thirteen recovery actions carry `reason` and are rendered by their own
 * confirmation card, so callers that only want a line of text ask for it here rather than
 * reaching into a union member that may not have one.
 */
export const explanationOf = (a: ChatAction | null | undefined): string | undefined =>
  a && 'explanation' in a ? a.explanation : undefined;

const MAX = {
  merchants: 40,
  recent: 15,
  accounts: 20,
  str: 60,
  matchValue: 120,
  explanation: 500,
  candidateId: 400,
  transactionId: 128,
} as const;

const CATEGORIES: readonly string[] = EXPENSE_CATEGORIES.map((c) => c.value);
const FIELDS: readonly string[] = ['merchant', 'title', 'description'];
const OPS: readonly string[] = ['contains', 'equals'];
const TYPES: readonly string[] = ['expense', 'income', 'transfer'];

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
  accounts: PaymentAccount[] = []
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

  return {
    categories: EXPENSE_CATEGORIES.map((c) => c.value),
    merchants,
    accounts: accounts.slice(0, MAX.accounts).map((a) => clip(a.name || '')).filter(Boolean),
    recent,
    // Totals over EVERY row. `recent` is 20 rows of raw text so the model can see what
    // bank feeds look like for rule-writing; it is NOT the evidence for any number.
    summary: buildLedgerSummary(transactions, accounts),
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

function parseRule(raw: unknown): NewMappingRule | null {
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
    if (typeof s.category !== 'string' || !CATEGORIES.includes(s.category)) return null;
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
 */
export function parseChatAction(raw: unknown, ctx?: RecoveryContext): ChatAction | null {
  // P3 first, over the whole payload, before any key is read.
  if (hasPollutedKey(raw)) return deny('P3');

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const action = (raw as Record<string, unknown>).action;
  if (typeof action !== 'string') return null;

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

  const rule = parseRule(o.rule);
  if (!rule) return null;

  return {
    action: 'create_rule',
    rule,
    // A terse model shouldn't cost the owner a valid rule — describeRule says it plainly.
    explanation: explanation || describeRule({ ...rule, id: '', createdAt: '' }),
  };
}
