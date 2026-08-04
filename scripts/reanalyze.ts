/**
 * Batch reanalysis — the owner's answers, replayed against the ledger.
 *
 * Every decision below was stated BY THE OWNER, in their own words, in the working
 * session of 2026-08-04 ("Canton is my employer", "Upstart is my loan", "the March
 * cluster is my chit pool", "IRS is a tax refund", "label the Business Income rows
 * freelance", "my own name is in-between transfers"). This script is data entry for
 * those answers, not a classifier: nothing here guesses, and a row no stated decision
 * matches is left exactly as it is.
 *
 * THE CONTRACT
 *  - DRY RUN by default. Prints what would be written and writes the batch to
 *    reanalysis-batch.local.json. Nothing touches Firestore without --apply.
 *  - An existing review in a TERMINAL state (confirmed / dismissed) is never replaced.
 *    The owner's earlier answer beats this batch, always.
 *  - --apply first backs up every review document it is about to overwrite to
 *    reanalysis-backup.local.json, then writes with a batchId on every document, so
 *    the whole run is identifiable and reversible.
 *  - The Remitly decision moves $120k+ into spending and changes every headline
 *    number, so it is gated separately behind --include-remitly.
 *
 * MODES
 *    npx tsx --tsconfig tsconfig.json scripts/reanalyze.ts --csv     # verify on export
 *    npx tsx --tsconfig tsconfig.json scripts/reanalyze.ts           # dry run, live
 *    npx tsx --tsconfig tsconfig.json scripts/reanalyze.ts --apply   # write, live
 *
 * Live mode needs CASHFLOW_FIRESTORE_KEY + CASHFLOW_FIRESTORE_UID (mcp/README.md).
 * --apply additionally needs the service account to hold roles/datastore.user for the
 * duration of the run; grant it, run, revoke it.
 */
import * as fs from 'fs';
import * as path from 'path';
import { FinancialMeaning, IncomeSource, InflowReview, PaymentAccount, Transaction } from '@/types';
import { interpretTransaction, matchApprovedSources, IncomeContext } from '@/lib/classify';
import { toCents, day } from '@/lib/flows';
import { loadFromCsvDir } from '../mcp/load-csv';
import { loadFromFirestore } from '../mcp/load-firestore';
import { Ledger } from '../mcp/load';

const BATCH_ID = 'reanalysis-2026-08-04';
const NOW = new Date().toISOString();
const money = (c: number) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const hayOf = (t: Transaction) => norm(`${t.title} ${t.merchant ?? ''} ${t.description ?? ''}`);

/**
 * The owner's own name AS THE COUNTERPARTY — not merely on the bank line. Every ACH row
 * names the account holder in its INDN: field, so a substring test over the whole
 * description claimed 130 rows ($158,841.01) including all of Upstart, an IRS refund and
 * 14 Agile paychecks (measured on the export; that is what --csv is for). Only the
 * Zelle counterparty and the merchant field say who the OTHER party is.
 */
const OWNER_TOKENS = ['bhuvaneswar'];
const isOwnName = (who: string) => OWNER_TOKENS.some((t) => norm(who).includes(t));
const zelleParty = (t: Transaction) =>
  (t.description ?? '').match(/zelle payment (?:from|to) ([A-Za-z .]+?)\s*(?:for|;|Conf)/i)?.[1] ?? '';
const counterpartyIsOwner = (t: Transaction) =>
  isOwnName(zelleParty(t)) || isOwnName(t.merchant ?? '');

// ---------------------------------------------------------------------------
// The decisions. First match wins; order is load-bearing (the owner's own Zelle
// notes mention "upstart", so the own-name rule must run before the Upstart one).
// ---------------------------------------------------------------------------

interface Decision {
  key: string;
  /** The owner's words — written into each review's `explanation`. */
  owner: string;
  meaning: FinancialMeaning;
  incomeSourceKey?: string;
  gated?: boolean; // --include-remitly
  test(t: Transaction, hay: string): boolean;
}

const DECISIONS: Decision[] = [
  {
    key: 'own-name',
    owner: 'My own name is in-between transactions — me moving my own money.',
    meaning: 'internal_transfer',
    test: (t) => t.type !== 'transfer' && counterpartyIsOwner(t),
  },
  {
    key: 'chit-payout',
    owner: 'The March 2026 cluster is my chit pool payout.',
    meaning: 'chit_fund_payout',
    // Shape, not names: Zelle from a person, the payout window, the three pot amounts.
    // Names of the seven payers deliberately do not appear in this repo.
    test: (t, hay) => {
      if (!/zelle payment from/i.test(t.description ?? '')) return false;
      if (counterpartyIsOwner(t)) return false;
      const d = day(t.date);
      if (d < '2026-03-03' || d > '2026-03-10') return false;
      return [100000, 120000, 150000].includes(toCents(t.amount));
    },
  },
  {
    key: 'upstart-in',
    owner: 'Upstart is my personal loan — this credit is the loan paid out to me.',
    meaning: 'loan_proceeds',
    test: (t, hay) => hay.includes('upstart') && t.type === 'income',
  },
  {
    key: 'upstart-out',
    owner: 'Loan payment to Upstart. A loan payment is also spending.',
    meaning: 'loan_repayment',
    test: (t, hay) => hay.includes('upstart') && t.type === 'expense',
  },
  {
    key: 'irs',
    owner: 'An IRS deposit is my tax refund — my own money back, not income.',
    meaning: 'other_non_income_credit',
    test: (t, hay) => t.type === 'income' && (hay.includes('internal revenue') || hay.includes('irs treas')),
  },
  {
    key: 'agile',
    owner: 'Agile was my previous employer, ended 2025-05-30. This is old payroll.',
    meaning: 'earned_income',
    incomeSourceKey: 'agile',
    test: (t, hay) => t.type === 'income' && hay.includes('agile'),
  },
  {
    key: 'freelance',
    owner: 'The Business Income rows are my freelance work.',
    meaning: 'earned_income',
    incomeSourceKey: 'freelance',
    test: (t) => t.type === 'income' && t.sourceCategory === 'Business Income' && !counterpartyIsOwner(t),
  },
  {
    key: 'remitly',
    owner: 'Remitly is money I send to India — an expense.',
    meaning: 'personal_expense',
    gated: true,
    test: (t, hay) => hay.includes('remitly'),
  },
];

// The sources the decisions anchor to. Canton is ACTIVE with a live alias — matching
// claims every past and future deposit by NAME, whatever the amount or account, which
// is exactly the split-paycheck plan. Agile is INACTIVE with its end date: the review
// records above claim its historical rows, and an inactive source adds nothing to any
// current income total or forecast. Freelance is a label anchor: active but amount 0
// and no bank alias, so it claims nothing on its own and inflates nothing.
const SOURCES: Record<string, Omit<IncomeSource, 'id'>> = {
  canton: {
    name: 'The Canton', amount: 8660, frequency: 'monthly', isActive: true,
    userApproved: true, matchAliases: ['canton'], kind: 'employment',
  } as Omit<IncomeSource, 'id'>,
  agile: {
    name: 'Agile', amount: 0, frequency: 'monthly', isActive: false, endDate: '2025-05-30',
    userApproved: true, matchAliases: ['agile'], kind: 'employment',
  } as Omit<IncomeSource, 'id'>,
  freelance: {
    name: 'Freelance work', amount: 0, frequency: 'monthly', isActive: true,
    userApproved: true, matchAliases: [], kind: 'contract',
  } as Omit<IncomeSource, 'id'>,
};

// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const useCsv = args.includes('--csv');
  const apply = args.includes('--apply');
  const includeRemitly = args.includes('--include-remitly');
  if (apply && useCsv) throw new Error('--apply and --csv are mutually exclusive.');

  // The uid is an ADDRESS, not a credential — users/{uid}/… is where one owner's tree
  // lives, and the Admin SDK bypasses firestore.rules, so it has to be told which tree.
  // With exactly one user there is nothing to ask: discover it. More than one is an
  // error by count only — no uid is ever printed for a tree this run does not touch.
  if (!useCsv && process.env.CASHFLOW_FIRESTORE_KEY && !process.env.CASHFLOW_FIRESTORE_UID) {
    const { initializeApp, cert, getApps } = await import('firebase-admin/app');
    const { getFirestore } = await import('firebase-admin/firestore');
    const app = getApps()[0] ?? initializeApp({ credential: cert(process.env.CASHFLOW_FIRESTORE_KEY) });
    const users = await getFirestore(app).collection('users').listDocuments();
    if (users.length !== 1) throw new Error(`users/ holds ${users.length} trees — set CASHFLOW_FIRESTORE_UID to pick one.`);
    process.env.CASHFLOW_FIRESTORE_UID = users[0].id;
    console.log('uid auto-discovered (single-user project)\n');
  }

  const ledger: Ledger = useCsv
    ? { ...loadFromCsvDir(path.join(process.cwd(), 'transactionsbyaccount')), income: { sources: [], reviews: {} }, source: 'csv', loadedAt: NOW }
    : await loadFromFirestore();
  const { transactions, accounts } = ledger;
  const existingSources = ledger.income?.sources ?? [];
  const existingReviews = ledger.income?.reviews ?? {};
  console.log(`ledger: ${transactions.length} rows, ${accounts.length} accounts, ` +
    `${existingSources.length} income sources, ${Object.keys(existingReviews).length} reviews (${ledger.source})\n`);

  // -- sources to create (skip any that already exist by normalized name) ----
  const have = new Set(existingSources.map((s) => norm(s.name)));
  const newSources = Object.entries(SOURCES)
    .filter(([, s]) => !have.has(norm(s.name)))
    .map(([key, s]) => ({ key, id: `src-${key}-${BATCH_ID}`, doc: { ...s, batchId: BATCH_ID } }));

  // -- review records ---------------------------------------------------------
  const sourceIdOf = (key?: string) => {
    if (!key) return undefined;
    const created = newSources.find((s) => s.key === key);
    if (created) return created.id;
    return existingSources.find((s) => norm(s.name) === norm(SOURCES[key].name))?.id;
  };

  const excluded = new Set((args.find((a) => a.startsWith('--exclude='))?.slice(10) ?? '').split(',').filter(Boolean));
  const reviews: (InflowReview & { batchId: string })[] = [];
  const rowsOf = new Map<string, Transaction[]>();
  const tally = new Map<string, { n: number; cents: number }>();
  let skippedTerminal = 0;
  for (const t of transactions) {
    const hay = hayOf(t);
    const d = DECISIONS.find((x) => (!x.gated || includeRemitly) && x.test(t, hay));
    if (!d) continue;
    if (excluded.has(t.id)) continue;
    const prior = existingReviews[t.id];
    if (prior && (prior.state === 'confirmed' || prior.state === 'dismissed')) { skippedTerminal++; continue; }
    reviews.push({
      transactionId: t.id, state: 'confirmed', meaning: d.meaning,
      ...(d.incomeSourceKey ? { incomeSourceId: sourceIdOf(d.incomeSourceKey) } : {}),
      explanation: d.owner, confirmedAt: NOW, updatedAt: NOW, source: 'user', batchId: BATCH_ID,
    });
    const r = tally.get(d.key) ?? { n: 0, cents: 0 };
    r.n++; r.cents += toCents(t.amount);
    tally.set(d.key, r);
    rowsOf.set(d.key, [...(rowsOf.get(d.key) ?? []), t]);
  }

  console.log('DECISIONS' + (includeRemitly ? ' (Remitly INCLUDED)' : ' (Remitly excluded — pass --include-remitly)'));
  for (const d of DECISIONS) {
    const r = tally.get(d.key);
    console.log(`  ${d.key.padEnd(14)} ${String(r?.n ?? 0).padStart(4)} rows  ${money(r?.cents ?? 0).padStart(13)}  -> ${d.meaning}`);
  }
  if (skippedTerminal) console.log(`  (${skippedTerminal} rows already answered in the app — left untouched)`);

  // Every row of a small decision, so a wrong claim is vetoed BEFORE apply
  // (--exclude=<id,id>). Terminal output only; nothing here reaches the repo.
  for (const d of DECISIONS) {
    const rows = rowsOf.get(d.key) ?? [];
    if (!rows.length || rows.length > 15) continue;
    console.log(`\n  ${d.key}:`);
    for (const t of rows) console.log(`    ${t.id}  ${day(t.date)}  ${(t.merchant || t.title).slice(0, 40).padEnd(40)} ${money(toCents(t.amount)).padStart(12)}`);
  }

  // -- what the Canton source claims by matching alone (no records needed) ----
  const cantonProbe: IncomeSource = { id: 'probe', ...(SOURCES.canton as Omit<IncomeSource, 'id'>) } as IncomeSource;
  const claimed = transactions.filter((t) => t.type === 'income' && matchApprovedSources(t, [cantonProbe]).length === 1);
  console.log(`\nCANTON source claims by name-match: ${claimed.length} rows, ` +
    `${money(claimed.reduce((s, t) => s + toCents(t.amount), 0))} (past and future, any account, any amount)`);
  const cantonTransfers = transactions.filter((t) => t.type === 'transfer' && hayOf(t).includes('canton'));
  if (cantonTransfers.length) {
    console.log(`  note: ${cantonTransfers.length} Canton rows are provider-typed Transfer ` +
      `(${money(cantonTransfers.reduce((s, t) => s + toCents(t.amount), 0))}) — left for review, the transfer veto applies`);
  }

  console.log(`\nSOURCES to create: ${newSources.map((s) => s.doc.name).join(', ') || '(all exist already)'}`);

  // -- before / after ---------------------------------------------------------
  const ctx = (extraSources: IncomeSource[], extraReviews: Record<string, InflowReview>): IncomeContext => ({
    sources: [...existingSources, ...extraSources],
    reviews: { ...existingReviews, ...extraReviews },
  });
  const totals = (income?: IncomeContext) => {
    let inc = 0, exp = 0;
    for (const t of transactions) {
      const i = interpretTransaction(t, accounts as PaymentAccount[], income);
      if (i.income === 'counted') inc += toCents(t.amount);
      if (i.expense === 'counted') exp += toCents(t.amount);
    }
    return { inc, exp };
  };
  const before = totals(ctx([], {}));
  const after = totals(ctx(
    newSources.map((s) => ({ id: s.id, ...(s.doc as Omit<IncomeSource, 'id'>) } as IncomeSource)),
    Object.fromEntries(reviews.map((r) => [r.transactionId, r]))
  ));
  console.log('\nWHOLE-LEDGER TOTALS        before          after');
  console.log(`  earned income   ${money(before.inc).padStart(15)} ${money(after.inc).padStart(15)}`);
  console.log(`  spending        ${money(before.exp).padStart(15)} ${money(after.exp).padStart(15)}`);

  // -- emit -------------------------------------------------------------------
  const batch = { batchId: BATCH_ID, generatedAt: NOW, mode: ledger.source, sources: newSources, reviews };
  fs.writeFileSync('reanalysis-batch.local.json', JSON.stringify(batch, null, 2));
  console.log(`\nbatch written to reanalysis-batch.local.json (${reviews.length} reviews, ${newSources.length} sources)`);

  if (!apply) { console.log('DRY RUN — nothing was written. Re-run with --apply to execute.'); return; }

  // -- apply ------------------------------------------------------------------
  const keyPath = process.env.CASHFLOW_FIRESTORE_KEY;
  const uid = process.env.CASHFLOW_FIRESTORE_UID; // set above when auto-discovered
  if (!keyPath || !uid) throw new Error('--apply needs CASHFLOW_FIRESTORE_KEY (uid is auto-discovered).');
  const { initializeApp, cert, getApps } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const app = getApps()[0] ?? initializeApp({ credential: cert(keyPath) });
  const db = getFirestore(app);

  // Backup every review doc this run replaces, before the first write.
  const backup: Record<string, unknown> = {};
  for (const r of reviews) {
    const prior = existingReviews[r.transactionId];
    if (prior) backup[r.transactionId] = prior;
  }
  fs.writeFileSync('reanalysis-backup.local.json', JSON.stringify({ batchId: BATCH_ID, backedUpAt: NOW, reviews: backup }, null, 2));
  console.log(`backed up ${Object.keys(backup).length} existing reviews to reanalysis-backup.local.json`);

  for (const s of newSources) {
    await db.doc(`users/${uid}/income/${s.id}`).set(s.doc);
    console.log(`wrote income source ${s.doc.name}`);
  }
  for (let i = 0; i < reviews.length; i += 400) {
    const chunk = reviews.slice(i, i + 400);
    const wb = db.batch();
    for (const r of chunk) wb.set(db.doc(`users/${uid}/reviews/${r.transactionId}`), r, { merge: true });
    await wb.commit();
    console.log(`wrote reviews ${i + 1}-${i + chunk.length} of ${reviews.length}`);
  }
  console.log('\nDONE. Refresh the app — everything is derived on read.');
  console.log('Now revoke roles/datastore.user from the service account.');
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
