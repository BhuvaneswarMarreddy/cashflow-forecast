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
import { day, toCents } from '@/lib/flows';
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
