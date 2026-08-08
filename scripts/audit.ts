import { POSTED_ONLY } from '@/lib/classify';
/**
 * LEDGER AUDIT — the checks that catch a wrong number before a human does.
 *
 *     npm run audit           # report, exit 1 if any check FAILS
 *     npm run audit -- --json # machine-readable, for a scheduled job
 *
 * WHY THIS EXISTS
 * Every money defect this project has shipped was found the same way: the owner
 * looked at a figure and said "that's odd." Not by a test — the unit suites prove
 * FUNCTIONS behave, and every one of them was green while the ledger was wrong:
 *
 *   - transfers untyped        -> $357,639.72 of "spending" (card payments counted
 *                                 twice: as the payment and as what it settled)
 *   - a redundant second feed  -> 310 duplicate rows, $122,194.67 of phantom money
 *   - a too-broad transfer rule-> 18 of 36 paychecks stopped counting as income
 *
 * Unit tests could not have caught any of them: each needs the WHOLE ledger to see.
 * These invariants do, and they run against the real data in seconds.
 *
 * READ-ONLY, ALWAYS. This script opens Firestore and never writes. It prints
 * amounts and account names (the owner's own data, on the owner's own machine) and
 * never touches meta/ credentials.
 */
import { loadFromFirestore } from '../mcp/load-firestore';
import type { PaymentAccount, Transaction } from '../src/types';
import type { IncomeContext } from '../src/lib/classify';

type Status = 'PASS' | 'WARN' | 'FAIL';
interface Check {
  name: string;
  status: Status;
  detail: string;
  /** Rows/accounts worth looking at, printed under the check. */
  evidence?: string[];
}

const money = (cents: number) =>
  '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (d: string) => String(d).slice(0, 10);
const cents = (n: number) => Math.round(n * 100);

// ---------------------------------------------------------------------------
// The invariants
// ---------------------------------------------------------------------------

/**
 * Two rows describing the same real charge. The ingest fingerprint is supposed to
 * make this impossible across sources; when a second live feed was added it
 * produced 310 of them, worth $122,194.67, and nothing noticed for a day.
 *
 * Same account + same signed amount + same day is not PROOF of a duplicate — three
 * $35 bag fees on one flight are real — so identical PROVIDER TEXT is required too.
 */
function duplicateRows(txns: Transaction[]): Check {
  const seen = new Map<string, Transaction[]>();
  for (const t of txns) {
    const signed = t.type === 'income' || (t.type === 'transfer' && t.transferDirection === 'in')
      ? cents(t.amount) : -cents(t.amount);
    const text = (t.merchant || t.title || '').trim().toLowerCase();
    const key = `${t.accountId ?? 'none'}|${signed}|${day(t.date)}|${text}`;
    const bucket = seen.get(key);
    if (bucket) bucket.push(t); else seen.set(key, [t]);
  }
  const groups = [...seen.values()].filter((g) => g.length > 1);

  // PROVABLE vs merely repeated. A group whose rows carry DIFFERENT source sets is
  // the same charge ingested twice — that is a defect, and it is what produced 310
  // phantom rows. A group from ONE source is usually real life: six identical
  // Southwest charges is six tickets, three $35 Alaska charges is three bags.
  // Failing on those would train the owner to ignore this check, which is worse
  // than not having it.
  // The provable signature is TWO INGEST PATHS, and the document id records which
  // one wrote each row (`pl_` Plaid, `sf_` SimpleFIN, `imp_` file import, `mn_`
  // Monarch). Two rows under different prefixes are one charge ingested twice.
  //
  // NOT the `sources` array: enrichment legitimately adds a source to an existing
  // row, so ["plaid"] beside ["plaid","simplefin"] is the dedupe WORKING, and
  // failing on it would cry wolf about the very mechanism that prevents the bug.
  const pathOf = (t: Transaction) => (t.id.match(/^([a-z]+)_/)?.[1] ?? 'app');
  const crossSource = groups.filter((g) => new Set(g.map(pathOf)).size > 1);
  const sameSource = groups.filter((g) => !crossSource.includes(g));
  const phantom = crossSource.reduce((s, g) => s + cents(g[0].amount) * (g.length - 1), 0);
  // Evidence carries the document ids: the whole point of this check is that the
  // next person can open the rows immediately instead of writing a query.
  const fmt = (g: Transaction[]) =>
    `${day(g[0].date)}  ${money(cents(g[0].amount))}  x${g.length}  ` +
    `${(g[0].merchant || g[0].title || '').slice(0, 30)}\n             ids: ${g.map((t) => t.id).join(' ')}`;

  if (crossSource.length) {
    return {
      name: 'No duplicate transactions',
      status: 'FAIL',
      detail: `${crossSource.length} charge(s) ingested by more than one source — ${money(phantom)} of phantom money`,
      evidence: crossSource.slice(0, 8).map(fmt),
    };
  }
  return {
    name: 'No duplicate transactions',
    status: sameSource.length ? 'WARN' : 'PASS',
    detail: sameSource.length
      ? `${sameSource.length} same-day identical charge group(s) from ONE source — usually genuine (several tickets, several bags), worth an eye`
      : `${txns.length} rows, none repeated`,
    evidence: sameSource.slice(0, 6).map(fmt),
  };
}


/**
 * Every account must reconcile: opening balance + everything dated on/after the
 * anchor = the balance the app shows. A mismatch means the anchor is wrong or rows
 * are missing — the exact shape of the defect that once put an account $2,000 out.
 */
function accountsReconcile(txns: Transaction[], accounts: PaymentAccount[]): Check {
  const bad: string[] = [];
  for (const a of accounts) {
    if (a.isActive === false) continue;
    const anchor = day(a.openingDate ?? '');
    const movement = txns
      .filter((t) => t.accountId === a.id && (!anchor || day(t.date) >= anchor))
      .reduce((s, t) => {
        const inbound = t.type === 'income' || (t.type === 'transfer' && t.transferDirection === 'in');
        const debt = a.type === 'credit_card' || a.type === 'personal_loan';
        // On a debt account an expense INCREASES what is owed.
        const signed = debt ? (inbound ? -cents(t.amount) : cents(t.amount))
                            : (inbound ? cents(t.amount) : -cents(t.amount));
        return s + signed;
      }, 0);
    const expected = cents(a.openingBalance ?? 0) + movement;
    const actual = cents(a.currentBalance ?? a.openingBalance ?? 0);
    // A future-dated anchor legitimately means "no rows count yet".
    if (anchor && anchor > new Date().toISOString().slice(0, 10)) continue;
    if (Math.abs(expected - actual) > 1) {
      bad.push(`${a.name.slice(0, 34)}: shows ${money(actual)}, rows imply ${money(expected)} (out by ${money(actual - expected)})`);
    }
  }
  return {
    name: 'Every account reconciles',
    status: bad.length ? 'WARN' : 'PASS',
    detail: bad.length ? `${bad.length} account(s) do not reconcile` : `${accounts.filter((a) => a.isActive !== false).length} accounts balance`,
    evidence: bad,
  };
}

/**
 * A feed that stops is invisible: the app keeps showing yesterday's truth. Monarch
 * died silently for days, and one card sat 25 days stale before anyone looked.
 */
function feedsAreFresh(txns: Transaction[], accounts: PaymentAccount[], todayISO: string): Check {
  const stale: string[] = [];
  for (const a of accounts) {
    if (a.isActive === false) continue;
    const days = txns.filter((t) => t.accountId === a.id).map((t) => day(t.date)).sort();
    const last = days[days.length - 1];
    if (!last) { stale.push(`${a.name.slice(0, 34)}: no transactions at all`); continue; }
    const age = Math.round((Date.parse(todayISO) - Date.parse(last)) / 86_400_000);
    if (age > 7) stale.push(`${a.name.slice(0, 34)}: ${age} days since the last row (${last})`);
  }
  return {
    name: 'Feeds are fresh',
    status: stale.length ? 'WARN' : 'PASS',
    detail: stale.length ? `${stale.length} account(s) look stalled` : 'every active account has a row within 7 days',
    evidence: stale,
  };
}

/**
 * Money moving between the owner's own accounts is not spending. When the type was
 * missing entirely, transfers were ~0% of rows and spending read four times its
 * real size; a ledger with several accounts should show a healthy share of them.
 */
function transfersArePresent(txns: Transaction[], accounts: PaymentAccount[]): Check {
  const share = txns.filter((t) => t.type === 'transfer').length / Math.max(1, txns.length);
  const multiAccount = accounts.filter((a) => a.isActive !== false).length > 1;
  const suspicious = multiAccount && share < 0.02;
  return {
    name: 'Transfers are classified',
    status: suspicious ? 'FAIL' : 'PASS',
    detail: `${(share * 100).toFixed(1)}% of rows are transfers` +
      (suspicious ? ' — with several accounts this is implausibly low; card payments are probably counted as spending' : ''),
  };
}

/**
 * Spending far above income, sustained over years, means something is being
 * double-counted — not that the owner is bankrupt. It is the cheapest smoke alarm
 * in the file: it fires on exactly the defect class that hurts most.
 */
function spendingIsPlausible(
  income: number, spending: number, hasSource: boolean
): Check {
  if (!hasSource) {
    return {
      name: 'Spending is plausible against income',
      status: 'WARN',
      detail: 'no approved income source yet, so income is $0 by design — ratio not meaningful',
    };
  }
  const ratio = income > 0 ? spending / income : Infinity;
  return {
    name: 'Spending is plausible against income',
    status: ratio > 2 ? 'FAIL' : ratio > 1.3 ? 'WARN' : 'PASS',
    detail: `spending ${money(cents(spending))} vs income ${money(cents(income))} (${ratio === Infinity ? '∞' : ratio.toFixed(2)}x)`,
  };
}

/** A row on no account cannot be reconciled, drilled into, or trusted in a total. */
function everyRowHasAnAccount(txns: Transaction[], accounts: PaymentAccount[]): Check {
  const ids = new Set(accounts.map((a) => a.id));
  const orphans = txns.filter((t) => !t.accountId || !ids.has(t.accountId));
  return {
    name: 'Every row belongs to a known account',
    status: orphans.length ? 'FAIL' : 'PASS',
    detail: orphans.length ? `${orphans.length} row(s) reference a missing account` : 'no orphaned rows',
    evidence: orphans.slice(0, 6).map((t) => `${day(t.date)}  ${money(cents(t.amount))}  ${(t.merchant || t.title || '').slice(0, 36)}`),
  };
}

/**
 * Unknown inflows are BY DESIGN — real money the owner has not explained yet, which
 * counts for nothing until they do. A large backlog is not a bug; it is a queue
 * nobody is working, and the figure people trust least.
 */
function unknownInflowBacklog(txns: Transaction[], income: IncomeContext | undefined): Check {
  const reviews = income?.reviews ?? {};
  const unexplained = txns.filter((t) =>
    t.type === 'income' && !reviews[t.id]);
  const total = unexplained.reduce((s, t) => s + cents(t.amount), 0);
  return {
    name: 'Unknown-inflow backlog',
    status: unexplained.length > 50 ? 'WARN' : 'PASS',
    detail: `${unexplained.length} unreviewed credit(s), ${money(total)} — real money counting as $0 income until explained`,
  };
}

// ---------------------------------------------------------------------------

async function main() {
  const json = process.argv.includes('--json');
  const { initializeApp, cert, getApps } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const key = process.env.CASHFLOW_FIRESTORE_KEY;
  if (!key) throw new Error('CASHFLOW_FIRESTORE_KEY must point at the service-account file.');
  const app = getApps()[0] ?? initializeApp({ credential: cert(key) });
  const users = await getFirestore(app).collection('users').listDocuments();
  if (!users.length) throw new Error('no user documents — nothing to audit');
  process.env.CASHFLOW_FIRESTORE_UID = process.env.CASHFLOW_FIRESTORE_UID ?? users[0].id;

  const { transactions, accounts, income } = await loadFromFirestore();
  // #102: the audit reads the same policy the app does; `?? POSTED_ONLY` is the honest
  // default for a profile that has never set one, not a silent undefined.
  const policy = income ?? POSTED_ONLY;
  const { sumIncomeCents, sumExpenseCents } = await import('../src/lib/classify');
  const todayISO = new Date().toISOString().slice(0, 10);

  const checks: Check[] = [
    duplicateRows(transactions),
    everyRowHasAnAccount(transactions, accounts),
    transfersArePresent(transactions, accounts),
    accountsReconcile(transactions, accounts),
    feedsAreFresh(transactions, accounts, todayISO),
    spendingIsPlausible(
      sumIncomeCents(transactions, accounts, policy) / 100,
      sumExpenseCents(transactions, accounts, policy) / 100,
      Boolean(income?.sources?.some((s) => s.isActive !== false))
    ),
    unknownInflowBacklog(transactions, income),
  ];

  const failed = checks.filter((c) => c.status === 'FAIL').length;
  const warned = checks.filter((c) => c.status === 'WARN').length;

  if (json) {
    console.log(JSON.stringify({ todayISO, rows: transactions.length, accounts: accounts.length, checks }, null, 2));
  } else {
    console.log(`\nLEDGER AUDIT — ${transactions.length} rows, ${accounts.length} accounts, ${todayISO}\n`);
    for (const c of checks) {
      const mark = c.status === 'PASS' ? '  ok  ' : c.status === 'WARN' ? ' warn ' : ' FAIL ';
      console.log(`[${mark}] ${c.name}`);
      console.log(`         ${c.detail}`);
      for (const e of c.evidence ?? []) console.log(`           · ${e}`);
    }
    console.log(`\n${checks.length - failed - warned} passed, ${warned} warning(s), ${failed} failure(s)\n`);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('audit failed:', e.message); process.exit(2); });
