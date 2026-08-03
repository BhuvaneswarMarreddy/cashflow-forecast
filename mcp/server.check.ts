/**
 * MCP server checks, run by `npm run test:mcp` (node:test via tsx). The filename has
 * no test/spec segment ON PURPOSE: jest's testMatch must never collect this file, so
 * the app's jest baseline stays byte-identical.
 */
// Keep the obs console sink out of the TAP stream (same reason server.ts sets it).
process.env.NEXT_PUBLIC_OBS_LEVEL ??= 'off';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findSecrets, redactString } from '@/lib/obs/redact';
import { loadFromCsvDir } from './load-csv';
import { Ledger, loadLedger, resetLedgerCache } from './load';
import { buildServer } from './server';
import {
  TOOL_DESCRIPTIONS,
  explainCounterparty, findTransactions, getLedgerSummary, getRecurring, listUnmapped,
} from './tools';

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

// ---------------------------------------------------------------------------
// STEP 4 — explain_counterparty + get_recurring
// ---------------------------------------------------------------------------

test('explain_counterparty: resolves a Zelle-shaped description and reports signFlips', () => {
  const r = explainCounterparty(fixtureLedger(), { name: 'John Doe' });
  assert.equal(r.name, 'JOHN DOE');
  assert.equal(r.displayName, 'John Doe');
  assert.equal(r.matchedBy, 'counterparty'); // personFrom equality, not text fallback
  // Lend-and-repay: out $200 then in $300 — the balance crosses zero once.
  assert.equal(r.ledger!.outCents, 20000);
  assert.equal(r.ledger!.inCents, 30000);
  assert.equal(r.ledger!.netCents, -10000); // negative: more received than sent
  assert.equal(r.ledger!.signFlips, 1);
  assert.equal(r.ledger!.firstDirection, 'out');
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0].date, '2026-07-15'); // newest first
});

test('explain_counterparty: text fallback when the extractor has no shape for the name', () => {
  const r = explainCounterparty(fixtureLedger(), { name: 'ACME GYM' });
  assert.equal(r.matchedBy, 'text');
  assert.equal(r.ledger!.outRows, 2);
  assert.equal(r.ledger!.inRows, 0);
  assert.equal(r.ledger!.netCents, 5000);
});

test('get_recurring: finds the planted monthly series and rejects the 2-occurrence one', () => {
  const r = getRecurring(fixtureLedger(), {}, '2026-07-20');
  const streaming = r.items.find((i) => i.merchant === 'ACME STREAMING')!;
  assert.equal(streaming.cadence, 'monthly');
  assert.equal(streaming.medianCents, 999);
  assert.equal(streaming.occurrences, 4);
  assert.equal(streaming.active, true); // last seen 07-10, 10 days before injected today
  assert.equal(r.items.some((i) => i.merchant === 'ACME GYM'), false); // only 2 occurrences
  assert.equal(r.monthlyTotalActiveCents, 999);
});

test('get_recurring: active_only and merchant filters', () => {
  const l = fixtureLedger();
  // 200 days after the last charge, the monthly series reads lapsed.
  const stale = getRecurring(l, { active_only: true }, '2027-01-26');
  assert.equal(stale.items.length, 0);
  assert.equal(stale.monthlyTotalActiveCents, 0);
  const named = getRecurring(l, { merchant: 'streaming' }, '2026-07-20');
  assert.equal(named.items.length, 1);
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

// ---------------------------------------------------------------------------
// STEP 5 — list_unmapped
// ---------------------------------------------------------------------------

test('list_unmapped: groups drop transactionIds and the counterparty line reaches the queue', () => {
  const r = listUnmapped(fixtureLedger(), {});
  assert.ok(r.groupCount >= 1);
  assert.equal(r.groups.length, Math.min(r.groupCount, 20));
  assert.equal(typeof r.decisionsFor80Percent, 'number');
  assert.ok(r.rowCount >= r.groupCount);
  for (const g of r.groups) {
    assert.ok(!('transactionIds' in g));
    assert.ok(['unknown_inflow', 'unpaired_leg', 'counterparty_line'].includes(g.kind));
    assert.equal(typeof g.totalCents, 'number');
  }
  // FIN-SETTLEMENT-003: the person lanes must not be terminal.
  assert.ok(r.groups.some((g) => g.kind === 'counterparty_line' && g.label === 'JOHN DOE'));
  // limit caps the group list only — the counts still describe the whole queue.
  const limited = listUnmapped(fixtureLedger(), { limit: 1 });
  assert.equal(limited.groups.length, 1);
  assert.equal(limited.groupCount, r.groupCount);
});

// ---------------------------------------------------------------------------
// STEP 5 — the five descriptions (key phrases, not snapshots)
// ---------------------------------------------------------------------------

test('descriptions: all five tools exist and every one states its units', () => {
  assert.deepEqual(Object.keys(TOOL_DESCRIPTIONS).sort(), [
    'explain_counterparty', 'find_transactions', 'get_ledger_summary', 'get_recurring', 'list_unmapped',
  ]);
  for (const d of Object.values(TOOL_DESCRIPTIONS)) assert.ok(/DOLLARS|INTEGER CENTS/.test(d));
});

test('descriptions: get_ledger_summary routes statement-text payees and defines SENT', () => {
  const d = TOOL_DESCRIPTIONS.get_ledger_summary;
  assert.ok(d.includes('explain_counterparty'));
  assert.ok(d.includes('statement text'));
  assert.ok(d.includes('spending + transferred'));
  assert.ok(d.includes('SENT'));
});

test('descriptions: find_transactions — classifier kind, card payment is a transfer, use cents totals', () => {
  const d = TOOL_DESCRIPTIONS.find_transactions;
  assert.ok(d.includes('classifier'));
  assert.ok(/card payment is a transfer/.test(d));
  assert.ok(d.includes('cents totals rather than adding'));
});

test('descriptions: explain_counterparty — signFlips semantics and netCents sign', () => {
  const d = TOOL_DESCRIPTIONS.explain_counterparty;
  assert.ok(d.includes('signFlips'));
  assert.ok(/0-1 flips is loan-shaped/.test(d));
  assert.ok(/running tab/.test(d));
  assert.ok(d.includes('netCents'));
  assert.ok(/positive means the owner has SENT more/.test(d));
});

test('descriptions: list_unmapped — strictly read-only, in-app confirmation only', () => {
  const d = TOOL_DESCRIPTIONS.list_unmapped;
  assert.ok(d.includes('STRICTLY READ-ONLY'));
  assert.ok(d.includes('in-app confirmation'));
});

test('descriptions: get_recurring — 3+ occurrences >= $5, today-relative active, detected cadence', () => {
  const d = TOOL_DESCRIPTIONS.get_recurring;
  assert.ok(/at least 3 occurrences/.test(d));
  assert.ok(d.includes('$5'));
  assert.ok(d.includes('today'));
  assert.ok(d.includes('lapsed'));
  assert.ok(/never guessed from the merchant name/.test(d));
});

// ---------------------------------------------------------------------------
// STEP 5 — error contract: exact messages, isError shape, no stack
// ---------------------------------------------------------------------------

const withEnv = async (env: Record<string, string | undefined>, run: () => Promise<void>) => {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetLedgerCache();
  try {
    await run();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetLedgerCache();
  }
};

const expectError = async (text: string) => {
  const r = await loadLedger();
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error.isError, true);
  assert.equal(r.error.content.length, 1);
  assert.equal(r.error.content[0].type, 'text');
  assert.equal(r.error.content[0].text, text); // exact, verbatim
  assert.ok(!r.error.content[0].text.includes('    at ')); // never a stack
};

test('error contract: CSV folder not found', () =>
  withEnv({ CASHFLOW_CSV_DIR: '/nonexistent-cf-ledger-check', CASHFLOW_FIRESTORE_KEY: undefined }, () =>
    expectError(
      'CSV folder not found at /nonexistent-cf-ledger-check. Export your transactions from Monarch ' +
      '(Settings -> Data -> Download transactions), unzip into transactionsbyaccount/ at the repo root, or set ' +
      'CASHFLOW_FIRESTORE_KEY=/path/to/service-account.json to read live data instead.'
    )));

test('error contract: folder exists but holds no CSVs', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-ledger-empty-'));
  try {
    await withEnv({ CASHFLOW_CSV_DIR: empty, CASHFLOW_FIRESTORE_KEY: undefined }, () =>
      expectError(`No .csv files in ${empty}. The Monarch export is one CSV per account; place them directly in this folder.`));
  } finally {
    fs.rmdirSync(empty);
  }
});

test('error contract: unreadable Firestore key carries the errno', () =>
  withEnv({ CASHFLOW_FIRESTORE_KEY: '/nonexistent/key.json' }, () =>
    expectError(
      'CASHFLOW_FIRESTORE_KEY points to /nonexistent/key.json but it cannot be read: ENOENT. ' +
      'Check the path, or unset it to fall back to the CSV export.'
    )));

test('error contract: readable key but no uid', () =>
  withEnv(
    { CASHFLOW_FIRESTORE_KEY: path.join(FIXTURES, 'acme-checking.csv'), CASHFLOW_FIRESTORE_UID: undefined },
    () =>
      expectError(
        'CASHFLOW_FIRESTORE_UID is not set. It must be the Firebase Auth uid whose ledger to read ' +
        '(Firebase console -> Authentication -> Users).'
      )));

// ---------------------------------------------------------------------------
// STEP 5 — redaction: the wrapper's exact pass over every tool's output
// ---------------------------------------------------------------------------

test('redaction: every tool output over the planted-secret fixture yields zero findSecrets hits', () => {
  const l = fixtureLedger();
  const outputs: Record<string, string> = {
    get_ledger_summary: redactString(JSON.stringify(getLedgerSummary(l))),
    find_transactions: redactString(JSON.stringify(findTransactions(l))),
    explain_counterparty: redactString(JSON.stringify(explainCounterparty(l, { name: 'John Doe' }))),
    get_recurring: redactString(JSON.stringify(getRecurring(l, {}, '2026-07-20'))),
    list_unmapped: redactString(JSON.stringify(listUnmapped(l, {}))),
  };
  for (const [tool, text] of Object.entries(outputs)) {
    assert.deepEqual(findSecrets(text), [], `findSecrets hit in ${tool} output`);
    assert.ok(!text.includes('4111111111111111'), `raw PAN leaked from ${tool}`);
    assert.ok(!text.includes('sometoken'), `credential URL leaked from ${tool}`);
  }
  // The planted card number survives only as ****-masked digits.
  const coffee = redactString(JSON.stringify(findTransactions(l, { query: 'coffee' })));
  assert.ok(coffee.includes('****1111'));
  assert.deepEqual(findSecrets(coffee), []);
});

// ---------------------------------------------------------------------------
// STEP 5 — read-only: no write-shaped call anywhere in the mcp sources
// ---------------------------------------------------------------------------

test('read-only: mcp/*.ts sources contain no write-shaped calls', () => {
  // Needles assembled at runtime so this file cannot match itself.
  const dot = (m: string) => '.' + m + '(';
  const needles = [dot('set'), dot('update'), dot('delete'), dot('add'), 'write' + 'Batch', 'batch' + '('];
  const dir = path.join(process.cwd(), 'mcp');
  const sources = fs.readdirSync(dir).filter((f) => f.endsWith('.ts'));
  assert.ok(sources.length >= 4);
  for (const f of sources) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const needle of needles) {
      assert.ok(!text.includes(needle), `${f} contains "${needle}"`);
    }
  }
});

// ---------------------------------------------------------------------------
// STEP 5 — wiring smoke over InMemoryTransport
// ---------------------------------------------------------------------------

test('wiring: listTools returns exactly the five tools and a call round-trips', async () => {
  await withEnv({ CASHFLOW_CSV_DIR: FIXTURES, CASHFLOW_FIRESTORE_KEY: undefined }, async () => {
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const server = buildServer();
    const client = new Client({ name: 'server-check', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name).sort();
      assert.deepEqual(names, [
        'explain_counterparty', 'find_transactions', 'get_ledger_summary', 'get_recurring', 'list_unmapped',
      ]);
      const res = await client.callTool({ name: 'get_recurring', arguments: {} });
      const body = JSON.parse((res.content as Array<{ type: string; text: string }>)[0].text);
      assert.equal(body.source, 'csv');
      assert.equal(body.span.transactions, 15);
      assert.ok(Array.isArray(body.items));
    } finally {
      await client.close();
      await server.close();
    }
  });
});
