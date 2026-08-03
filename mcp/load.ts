/**
 * The one ledger source for every MCP tool: CSV export by default, Firestore when
 * CASHFLOW_FIRESTORE_KEY is set. Tools never touch fs or firebase themselves.
 */
import * as fs from 'fs';
import * as path from 'path';
import { PaymentAccount, Transaction } from '@/types';
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
  // Firestore connects only when BOTH env vars are set; the key alone routes here so a
  // half-configured setup gets the missing-uid message instead of silently reading a
  // stale CSV and reporting numbers the owner thinks are live.
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
  if (!process.env.CASHFLOW_FIRESTORE_UID) {
    return { ok: false, error: fail('CASHFLOW_FIRESTORE_UID is not set. It must be the Firebase Auth uid whose ledger to read (Firebase console -> Authentication -> Users).') };
  }
  // Lazy import: the default CSV path must not pay firebase-admin's startup cost.
  // The loader reads the same two env vars — both are known set by the time it runs.
  try {
    const { loadFromFirestore: read } = await import('./load-firestore');
    return { ok: true, ledger: await read() };
  } catch (e) {
    return { ok: false, error: fail(firestoreFailure(e)) };
  }
}

/**
 * Firestore's own failures, translated once. The permission case names the exact role
 * and no more: firestore.rules do not apply to the Admin SDK, so IAM is the only thing
 * that actually keeps this server read-only, and a wider grant would silently work.
 */
export function firestoreFailure(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  const message = e instanceof Error ? e.message : String(e);
  if (code === 7 || code === 'permission-denied' || /PERMISSION_DENIED|insufficient permissions/i.test(message)) {
    return 'The service account was refused by Firestore. It needs the roles/datastore.viewer role on the project — and nothing more; this server is read-only by design.';
  }
  // Message only, never the stack: a stack here would carry paths and row data.
  return `Firestore read failed: ${message}. Check CASHFLOW_FIRESTORE_UID and the service account's project, or unset CASHFLOW_FIRESTORE_KEY to fall back to the CSV export.`;
}
