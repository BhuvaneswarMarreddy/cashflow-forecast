/**
 * The MCP tool handlers, as plain functions (ledger, args) => object so tests call
 * them without a transport. server.ts owns load-dispatch, JSON serialization, the
 * redaction pass and the error contract — nothing here does I/O.
 *
 * Money discipline: totals are INTEGER CENTS computed via toCents + the classifier;
 * row amounts stay dollars exactly as the app stores them. The only arithmetic
 * allowed in this file is the find_transactions totals reduce — anything more
 * belongs in src/lib.
 */
import { z } from 'zod';
import { Transaction } from '@/types';
import { buildLedgerSummary } from '@/lib/chat-summary';
import { classifyTransaction } from '@/lib/classify';
import { displayPerson, personFrom } from '@/lib/counterparty';
import { day, detectRecurring, normalizeMerchant, toCents } from '@/lib/flows';
import { detectCounterpartyLedger } from '@/lib/mapping-evidence';
import { rowDirection } from '@/lib/mapping-rules';
import { Ledger } from './load';

// ---------------------------------------------------------------------------
// Tool descriptions — the contract the model reads before touching any numbers.
// Every description states its units; server.check.ts asserts the key phrases.
// ---------------------------------------------------------------------------

export const TOOL_DESCRIPTIONS = {
  get_ledger_summary:
    'Complete app-computed totals over EVERY transaction: span, income/spending/net by year and by month, ' +
    'spending by category this year, and top merchants by total money moved. All amounts are DOLLARS. ' +
    'Every number is exact and computed over all rows — nothing is sampled; only list breadth is capped, and each ' +
    'cap reports how many entries it omitted. A merchant\'s `transferred` is money that moved while classified as ' +
    'a transfer, so it is neither income nor spending — the amount SENT to a payee is spending + transferred, ' +
    'not spending alone. For a payee that appears in statement text rather than the merchant column (a Zelle ' +
    'recipient, a remittance destination), use explain_counterparty instead — the merchant column there names ' +
    'the transport, not the person.',
  find_transactions:
    'Search transactions by text, date range, kind, account and amount, newest first. Row amounts are DOLLARS ' +
    '(absolute value); the `totals` block is INTEGER CENTS. Each row\'s `kind` comes from the app\'s classifier, ' +
    'never from the stored type — a credit card payment is a transfer, neither income nor spending. ' +
    '`totals` {incomeCents, expenseCents, transferredCents} are computed over ALL matches even when the row list ' +
    'is truncated: use the cents totals rather than adding the returned rows yourself.',
  explain_counterparty:
    'The whole two-way relationship with ONE counterparty — a person or payee named in statement text (a Zelle ' +
    'recipient, a remittance destination), where the merchant column only names the transport. Matches rows by ' +
    'the extracted counterparty name first, falling back to a case-insensitive text search over ' +
    'description/title. Ledger amounts are INTEGER CENTS; row amounts are DOLLARS. `netCents` is outbound minus ' +
    'inbound — positive means the owner has SENT more than they received. `signFlips` counts how many times the ' +
    'running balance with this party changes sign, and separates the two relationship kinds: 0-1 flips is ' +
    'loan-shaped (one side fronted money and it came back), 2 or more is a running tab both sides keep adding ' +
    'to. Returns up to 25 newest matching rows.',
  get_recurring:
    'Recurring charges detected from repetition in the ledger itself. Amounts are INTEGER CENTS (medianCents, ' +
    'monthlyCents, monthlyTotalActiveCents). Detection requires at least 3 occurrences on distinct days with a ' +
    'median amount of at least $5 and a stable gap; the cadence (weekly/biweekly/monthly/quarterly/yearly) is ' +
    'DETECTED from the observed gaps, never guessed from the merchant name. `active` is judged against today — ' +
    'seen within ~1.5 of its own cycle length — so a stale export makes a healthy subscription read as lapsed; ' +
    'check the ledger span before trusting a lapse. monthlyTotalActiveCents sums the detector\'s own ' +
    'monthlyCents over active items only.',
} as const;

// ---------------------------------------------------------------------------
// The envelope every response carries
// ---------------------------------------------------------------------------

function spanOf(ledger: Ledger) {
  let from = '', to = '';
  for (const t of ledger.transactions) {
    const d = day(t.date);
    if (!from || d < from) from = d;
    if (!to || d > to) to = d;
  }
  return { from, to, transactions: ledger.transactions.length };
}

const envelope = (ledger: Ledger) => ({
  source: ledger.source,
  loadedAt: ledger.loadedAt,
  span: spanOf(ledger),
});

/** The one row shape every tool returns. `kind` is the classifier's verdict, never the stored type. */
function rowOf(t: Transaction, ledger: Ledger) {
  const account = t.accountId ? ledger.accounts.find((a) => a.id === t.accountId) : undefined;
  return {
    id: t.id,
    date: day(t.date),
    kind: classifyTransaction(t, ledger.accounts),
    amount: t.amount, // dollars, absolute
    merchant: t.merchant ?? '',
    title: t.title,
    description: t.description ?? '',
    sourceCategory: t.sourceCategory ?? '',
    accountName: account?.name ?? '',
    pending: t.pending === true,
  };
}

const newestFirst = (rows: Transaction[]) =>
  [...rows].sort((x, y) => day(y.date).localeCompare(day(x.date)) || y.id.localeCompare(x.id));

// ---------------------------------------------------------------------------
// get_ledger_summary
// ---------------------------------------------------------------------------

/** The LedgerSummary as-is (dollars) — its own span IS the envelope span. */
export function getLedgerSummary(ledger: Ledger) {
  return {
    source: ledger.source,
    loadedAt: ledger.loadedAt,
    ...buildLedgerSummary(ledger.transactions, ledger.accounts),
  };
}

// ---------------------------------------------------------------------------
// find_transactions
// ---------------------------------------------------------------------------

export const findTransactionsShape = {
  query: z.string().describe('Case-insensitive substring matched over merchant + title + description').optional(),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('YYYY-MM-DD, inclusive').optional(),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('YYYY-MM-DD, inclusive').optional(),
  kind: z.enum(['income', 'expense', 'transfer']).describe("The classifier's verdict per row, never the stored type").optional(),
  account: z.string().describe('Substring of the account name').optional(),
  min_amount: z.number().describe('Dollars, absolute value').optional(),
  max_amount: z.number().describe('Dollars, absolute value').optional(),
  limit: z.number().int().min(1).max(100).describe('Rows to return, newest first (default 20, max 100)').optional(),
};
const FindArgs = z.object(findTransactionsShape);

export function findTransactions(ledger: Ledger, args: z.input<typeof FindArgs> = {}) {
  const a = FindArgs.parse(args);
  const limit = a.limit ?? 20;
  const { transactions, accounts } = ledger;
  const nameOf = (t: Transaction) =>
    (t.accountId && ledger.accounts.find((acc) => acc.id === t.accountId)?.name) || '';
  const q = a.query?.toLowerCase();
  const acctQ = a.account?.toLowerCase();

  const matches = transactions.filter((t) => {
    const d = day(t.date);
    if (a.start_date && d < a.start_date) return false;
    if (a.end_date && d > a.end_date) return false;
    if (q && !`${t.merchant ?? ''} ${t.title} ${t.description ?? ''}`.toLowerCase().includes(q)) return false;
    if (a.kind && classifyTransaction(t, accounts) !== a.kind) return false;
    if (acctQ && !nameOf(t).toLowerCase().includes(acctQ)) return false;
    if (a.min_amount !== undefined && t.amount < a.min_amount) return false;
    if (a.max_amount !== undefined && t.amount > a.max_amount) return false;
    return true;
  });

  // Exact cents over ALL matches (not just the returned page) — the one allowed
  // piece of arithmetic here, so the model never sums truncated rows itself.
  const totals = { incomeCents: 0, expenseCents: 0, transferredCents: 0 };
  for (const t of matches) {
    const kind = classifyTransaction(t, accounts);
    const cents = toCents(t.amount);
    if (kind === 'income') totals.incomeCents += cents;
    else if (kind === 'expense') totals.expenseCents += cents;
    else totals.transferredCents += cents;
  }

  const rows = newestFirst(matches).slice(0, limit).map((t) => rowOf(t, ledger));
  return {
    ...envelope(ledger),
    totalMatches: matches.length,
    returned: rows.length,
    truncated: matches.length > rows.length,
    totals,
    rows,
  };
}

// ---------------------------------------------------------------------------
// explain_counterparty
// ---------------------------------------------------------------------------

export const explainCounterpartyShape = {
  name: z.string().min(1).describe('The counterparty, e.g. "REMITLY" or a person named in Zelle statement text'),
};
const ExplainArgs = z.object(explainCounterpartyShape);

export function explainCounterparty(ledger: Ledger, args: z.input<typeof ExplainArgs>) {
  const { name } = ExplainArgs.parse(args);
  const target = name.trim().toUpperCase();
  // Extraction equality first — the same personFrom the flow graph groups by — then a
  // plain text fallback so a payee the extractor has no shape for is still answerable.
  const byPerson = ledger.transactions.filter((t) => personFrom(t.description ?? t.title) === target);
  const q = name.trim().toLowerCase();
  const rows = byPerson.length
    ? byPerson
    : ledger.transactions.filter(
        (t) => (t.description ?? '').toLowerCase().includes(q) || t.title.toLowerCase().includes(q)
      );
  // The same direction predicate mapping-suggestions uses: rowDirection, null -> 'in'.
  const direction = (t: Transaction): 'in' | 'out' => (rowDirection(t) === 'outflow' ? 'out' : 'in');
  return {
    ...envelope(ledger),
    name: target,
    displayName: displayPerson(target),
    matchedBy: (byPerson.length ? 'counterparty' : 'text') as 'counterparty' | 'text',
    ledger: detectCounterpartyLedger(rows, direction),
    rows: newestFirst(rows).slice(0, 25).map((t) => rowOf(t, ledger)),
  };
}

// ---------------------------------------------------------------------------
// get_recurring
// ---------------------------------------------------------------------------

export const getRecurringShape = {
  active_only: z.boolean().describe('Only items still active against today (default false)').optional(),
  merchant: z.string().describe('Substring filter on the normalized merchant name').optional(),
};
const RecurringArgs = z.object(getRecurringShape);

export function getRecurring(
  ledger: Ledger,
  args: z.input<typeof RecurringArgs> = {},
  // Wall-clock by contract; injectable so the fixture tests are deterministic.
  todayISO: string = new Date().toISOString().slice(0, 10)
) {
  const a = RecurringArgs.parse(args);
  let items = detectRecurring(ledger.transactions, ledger.accounts, todayISO);
  if (a.merchant) {
    const q = normalizeMerchant(a.merchant);
    items = items.filter((i) => i.merchant.includes(q));
  }
  if (a.active_only) items = items.filter((i) => i.active);
  // Allowed display sum: the lib's own monthlyCents over active items.
  const monthlyTotalActiveCents = items
    .filter((i) => i.active)
    .reduce((s, i) => s + i.monthlyCents, 0);
  return { ...envelope(ledger), items, monthlyTotalActiveCents };
}
