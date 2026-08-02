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
import { describeRule, MappingRule, NewMappingRule } from './mapping-rules';

export interface ChatContext {
  categories: ExpenseCategory[];
  merchants: string[];
  accounts: string[];
  recent: { title: string; merchant?: string; amount: number; category?: string }[];
}

export type ChatAction =
  | { action: 'answer'; explanation: string }
  | { action: 'create_rule'; rule: NewMappingRule; explanation: string };

const MAX = {
  merchants: 40,
  recent: 15,
  accounts: 20,
  str: 60,
  matchValue: 120,
  explanation: 500,
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

/**
 * Validate one `result` payload from the aiChat callable. Returns null when anything
 * is off — callers show the text, they never guess at a half-valid rule.
 */
export function parseChatAction(raw: unknown): ChatAction | null {
  const o = record(raw, ['action', 'rule', 'explanation']);
  if (!o) return null;

  const explanation = str(o.explanation, MAX.explanation);

  if (o.action === 'answer') {
    return explanation ? { action: 'answer', explanation } : null;
  }
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
