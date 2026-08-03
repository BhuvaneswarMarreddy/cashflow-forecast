/**
 * The one ledger source for every MCP tool: CSV export by default, Firestore when
 * CASHFLOW_FIRESTORE_KEY is set. Tools never touch fs or firebase themselves.
 */
import * as fs from 'fs';
import * as path from 'path';
import { IncomeSource, PaymentAccount, Transaction } from '@/types';
import { IncomeContext } from '@/lib/classify';
import { loadFromCsvDir } from './load-csv';

export interface Ledger {
  transactions: Transaction[];
  accounts: PaymentAccount[];
  income?: IncomeContext;
  source: 'csv' | 'firestore';
  loadedAt: string;
}

/** The MCP error contract: message text only — never a stack, never a throw. */
export function fail(text: string) {
  return { isError: true as const, content: [{ type: 'text' as const, text }] };
}

export type LoadResult = { ok: true; ledger: Ledger } | { ok: false; error: ReturnType<typeof fail> };

// ponytail: one 60s whole-ledger cache — the export is static between Monarch pulls
// and every tool call re-derives everything from rows anyway.
const TTL_MS = 60_000;
let cache: { ledger: Ledger; at: number } | null = null;

/** Tests flip env vars between calls; the TTL would otherwise hide the change. */
export function resetLedgerCache(): void {
  cache = null;
}

export async function loadLedger(): Promise<LoadResult> {
  if (cache && Date.now() - cache.at < TTL_MS) return { ok: true, ledger: cache.ledger };
  const result = process.env.CASHFLOW_FIRESTORE_KEY
    ? await loadFromFirestore(process.env.CASHFLOW_FIRESTORE_KEY)
    : loadFromCsv();
  if (result.ok) cache = { ledger: result.ledger, at: Date.now() };
  return result;
}

function loadFromCsv(): LoadResult {
  const dir = path.resolve(process.env.CASHFLOW_CSV_DIR ?? path.join(process.cwd(), 'transactionsbyaccount'));
  if (!fs.existsSync(dir)) {
    return { ok: false, error: fail(`CSV folder not found at ${dir}. Export your transactions from Monarch (Settings -> Data -> Download transactions), unzip into transactionsbyaccount/ at the repo root, or set CASHFLOW_FIRESTORE_KEY=/path/to/service-account.json to read live data instead.`) };
  }
  if (!fs.readdirSync(dir).some((f) => f.endsWith('.csv'))) {
    return { ok: false, error: fail(`No .csv files in ${dir}. The Monarch export is one CSV per account; place them directly in this folder.`) };
  }
  const { transactions, accounts } = loadFromCsvDir(dir);
  return { ok: true, ledger: { transactions, accounts, source: 'csv', loadedAt: new Date().toISOString() } };
}

async function loadFromFirestore(keyPath: string): Promise<LoadResult> {
  try {
    fs.accessSync(keyPath, fs.constants.R_OK);
  } catch (e) {
    const errno = (e as NodeJS.ErrnoException).code ?? String(e);
    return { ok: false, error: fail(`CASHFLOW_FIRESTORE_KEY points to ${keyPath} but it cannot be read: ${errno}. Check the path, or unset it to fall back to the CSV export.`) };
  }
  const uid = process.env.CASHFLOW_FIRESTORE_UID;
  if (!uid) {
    return { ok: false, error: fail('CASHFLOW_FIRESTORE_UID is not set. It must be the Firebase Auth uid whose ledger to read (Firebase console -> Authentication -> Users).') };
  }
  // Lazy import: the default CSV path must not pay firebase-admin's startup cost.
  const { initializeApp, cert, getApps } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const app = getApps()[0] ?? initializeApp({ credential: cert(keyPath) });
  const db = getFirestore(app);
  const [txSnap, acctSnap, incomeSnap] = await Promise.all([
    db.collection(`users/${uid}/transactions`).get(),
    db.collection(`users/${uid}/accounts`).get(),
    db.collection(`users/${uid}/income`).get(),
  ]);
  const docs = <T>(snap: { docs: Array<{ id: string; data(): unknown }> }): T[] =>
    snap.docs.map((d) => ({ ...(d.data() as object), id: d.id } as T));
  return {
    ok: true,
    ledger: {
      transactions: docs<Transaction>(txSnap),
      accounts: docs<PaymentAccount>(acctSnap),
      income: { sources: docs<IncomeSource>(incomeSnap) },
      source: 'firestore',
      loadedAt: new Date().toISOString(),
    },
  };
}
