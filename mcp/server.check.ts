/**
 * MCP server checks, run by `npm run test:mcp` (node:test via tsx). The filename has
 * no test/spec segment ON PURPOSE: jest's testMatch must never collect this file, so
 * the app's jest baseline stays byte-identical.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { loadFromCsvDir } from './load-csv';

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

test('loader: id is file:rowIndex and text columns map verbatim', () => {
  const { transactions } = quietLoad(FIXTURES);
  const first = transactions.find((t) => t.id === 'acme-checking.csv:0')!;
  assert.equal(first.merchant, 'ACME Groceries');
  assert.equal(first.title, 'ACME Groceries');
  assert.equal(first.description, 'ACME GROCERIES #100 SPRINGFIELD');
  assert.equal(first.sourceCategory, 'Groceries');
  assert.equal(first.date, '2026-07-01');
});
