/**
 * MCP server checks, run by `npm run test:mcp` (node:test via tsx). The filename has
 * no test/spec segment ON PURPOSE: jest's testMatch must never collect this file, so
 * the app's jest baseline stays byte-identical.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { loadFromCsvDir } from './load-csv';
import { Ledger } from './load';
import { findTransactions, getLedgerSummary } from './tools';

const FIXTURES = path.join(process.cwd(), 'mcp', 'fixtures');

/** Load with console.error captured — the unknown-account warning is part of the contract. */
function quietLoad(dir: string) {
  const warnings: string[] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => { warnings.push(args.join(' ')); };
  try {
    return { ...loadFromCsvDir(dir), warnings };
  } finally {
    console.error = real;
  }
}

// ---------------------------------------------------------------------------
// STEP 2 — the loader
// ---------------------------------------------------------------------------

test('loader: full fixture row count', () => {
  const { transactions } = quietLoad(FIXTURES);
  assert.equal(transactions.length, 15);
  assert.equal(transactions.filter((t) => !t.accountId).length, 0);
});

test('loader: Credit Card Payment becomes a transfer with sign-derived direction', () => {
  const { transactions } = quietLoad(FIXTURES);
  const received = transactions.find((t) => t.description === 'ACME CARD PAYMENT RECEIVED')!;
  const funded = transactions.find((t) => t.description === 'ACME CARD AUTOPAY')!;
  assert.equal(received.type, 'transfer');
  assert.equal(received.transferDirection, 'in');   // +200.00
  assert.equal(funded.type, 'transfer');
  assert.equal(funded.transferDirection, 'out');    // -200.00
  assert.equal(received.sourceCategory, 'Credit Card Payment');
});

test('loader: amounts are absolute, sign moved into type/direction', () => {
  const { transactions } = quietLoad(FIXTURES);
  assert.ok(transactions.every((t) => t.amount >= 0));
  const groceries = transactions.find((t) => t.merchant === 'ACME Groceries')!;
  assert.equal(groceries.amount, 50);
  assert.equal(groceries.type, 'expense');
  const payroll = transactions.find((t) => t.merchant === 'ACME Payroll')!;
  assert.equal(payroll.type, 'income');
});

test('loader: the ® account name survives UTF-8 reading', () => {
  const { accounts } = quietLoad(FIXTURES);
  assert.ok(accounts.some((a) => a.name === 'ACME Rewards® Card'));
});

test('loader: unknown account generates a bank_account and warns on stderr, never crashes', () => {
  const { transactions, accounts, warnings } = quietLoad(FIXTURES);
  // Neither ACME fixture account is in the frozen real-name table.
  const gen = accounts.find((a) => a.name === 'ACME Bank Checking')!;
  assert.equal(gen.type, 'bank_account');
  assert.equal(gen.openingBalance, 0);
  assert.ok(warnings.some((w) => w.includes('unknown account "ACME Bank Checking"')));
  assert.ok(warnings.some((w) => w.includes('ACME Rewards® Card')));
  // Rows still landed on the generated accounts.
  assert.ok(transactions.every((t) => accounts.some((a) => a.id === t.accountId)));
});

// ---------------------------------------------------------------------------
// STEP 3 — get_ledger_summary + find_transactions (handlers, no transport)
// ---------------------------------------------------------------------------

function fixtureLedger(): Ledger {
  const { transactions, accounts } = quietLoad(FIXTURES);
  return { transactions, accounts, source: 'csv', loadedAt: '2026-08-03T00:00:00.000Z' };
}

test('get_ledger_summary: envelope + exact app-computed totals in dollars', () => {
  const s = getLedgerSummary(fixtureLedger());
  assert.equal(s.source, 'csv');
  assert.equal(s.loadedAt, '2026-08-03T00:00:00.000Z');
  assert.deepEqual(s.span, { from: '2026-04-10', to: '2026-07-15', transactions: 15 });
  // 2026: income 3000; spending 50+5+100+9.99*4+25*2 = 244.96; 5 transfers excluded.
  assert.deepEqual(s.byYear[0], { period: '2026', income: 3000, spending: 244.96, net: 2755.04, count: 10 });
  // Transferred is tracked per merchant and is neither income nor spending.
  const zelle = s.topMerchants.find((m) => m.name === 'Zelle')!;
  assert.equal(zelle.transferred, 500);
  assert.equal(zelle.spending, 0);
});

test('find_transactions: date range is inclusive on both ends', () => {
  const r = findTransactions(fixtureLedger(), { start_date: '2026-07-02', end_date: '2026-07-03' });
  assert.equal(r.totalMatches, 2);
  assert.deepEqual(r.rows.map((x) => x.date), ['2026-07-03', '2026-07-02']); // newest first
});

test('find_transactions: transfers are excluded from expenseCents and land in transferredCents', () => {
  const r = findTransactions(fixtureLedger());
  // expenses 24496c; income 300000c; transfers 50000+20000+20000+20000+30000 = 140000c
  assert.deepEqual(r.totals, { incomeCents: 300000, expenseCents: 24496, transferredCents: 140000 });
});

test('find_transactions: totals cover ALL matches even beyond the row limit', () => {
  const r = findTransactions(fixtureLedger(), { limit: 3 });
  assert.equal(r.totalMatches, 15);
  assert.equal(r.returned, 3);
  assert.equal(r.truncated, true);
  assert.equal(r.totals.expenseCents, 24496); // same as the unlimited call
});

test('find_transactions: kind comes from the classifier, and rows carry the envelope shape', () => {
  const r = findTransactions(fixtureLedger(), { kind: 'transfer' });
  assert.equal(r.totalMatches, 5); // 1 savings + 2 card-payment legs + 2 Zelle legs
  assert.ok(r.rows.every((x) => x.kind === 'transfer'));
  assert.equal(r.span.transactions, 15);
  const row = r.rows[0];
  assert.deepEqual(Object.keys(row).sort(), [
    'accountName', 'amount', 'date', 'description', 'id', 'kind',
    'merchant', 'pending', 'sourceCategory', 'title',
  ]);
});

test('find_transactions: query, account and amount filters', () => {
  const l = fixtureLedger();
  assert.equal(findTransactions(l, { query: 'groceries' }).totalMatches, 1);
  assert.equal(findTransactions(l, { account: 'rewards®' }).totalMatches, 9);
  assert.equal(findTransactions(l, { min_amount: 100, max_amount: 500 }).totalMatches, 6);
});

test('loader: id is file:rowIndex and text columns map verbatim', () => {
  const { transactions } = quietLoad(FIXTURES);
  const first = transactions.find((t) => t.id === 'acme-checking.csv:0')!;
  assert.equal(first.merchant, 'ACME Groceries');
  assert.equal(first.title, 'ACME Groceries');
  assert.equal(first.description, 'ACME GROCERIES #100 SPRINGFIELD');
  assert.equal(first.sourceCategory, 'Groceries');
  assert.equal(first.date, '2026-07-01');
});
