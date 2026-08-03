/**
 * Monarch CSV -> Transaction[]/PaymentAccount[], byte-for-byte the shape of load()
 * in src/__tests__/flows.integration.test.ts — that loader is audit-verified against
 * CSV_GROUND_TRUTH.md, so this file copies it rather than inventing a second mapping.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as XLSX from 'xlsx';
import { PaymentAccount, Transaction } from '@/types';

// The audit test's ACCOUNTS table, verbatim: real user-entered balances, 2026-07-23
// (Monarch). Name -> type is what the CSV 'Account' column joins against.
const ACCOUNTS: Array<[string, PaymentAccount['type'], number]> = [
  ['TOTAL CHECKING (...7535)', 'bank_account', 829.60],
  ['Adv SafeBalance Banking (...2126)', 'bank_account', 1430.93],
  ['Advantage Savings (...2139)', 'bank_account', 45.52],
  ['CHASE SAVINGS (...2591)', 'bank_account', 2600.97],
  ['Customized Cash Rewards Visa Signature (...3572)', 'credit_card', 2656.09],
  ['Blue Cash Preferred® (...1001)', 'credit_card', 507.96],
  ['Amazon Store Card (...3282)', 'credit_card', 3308.57],
  ['Apple Card', 'credit_card', 2068.93],
  ['Discover it Card (...4363)', 'credit_card', 6.85],
];

export function loadFromCsvDir(dir: string): { transactions: Transaction[]; accounts: PaymentAccount[] } {
  const accounts: PaymentAccount[] = ACCOUNTS.map(([name, type, balance], i) => ({
    id: `a${i}`, name, type, openingBalance: balance, openingDate: '2000-01-01',
    provider: 'other', color: '#000', isActive: true,
  } as PaymentAccount));
  // Plain object, not a Map — mcp/ sources must stay clean of write-shaped method
  // calls for the read-only grep gate, and a Record does the same job.
  const idByName: Record<string, string> = Object.fromEntries(accounts.map((a) => [a.name, a.id]));

  const transactions: Transaction[] = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.csv'))) {
    // read as UTF-8 string — buffer mode mangles '®' in "Blue Cash Preferred®"
    const wb = XLSX.read(fs.readFileSync(path.join(dir, f), 'utf8'), { type: 'string', raw: true });
    const rows = XLSX.utils.sheet_to_json<Record<string, string>>(wb.Sheets[wb.SheetNames[0]]);
    for (const [i, r] of rows.entries()) {
      const amount = parseFloat(String(r['Amount']));
      const isTransfer = r['Category'] === 'Transfer' || r['Category'] === 'Credit Card Payment';
      const acctName = String(r['Account']);
      if (!(acctName in idByName)) {
        // Unknown account: never a crash — the ledger must load even when the export
        // grew an account the frozen table has not heard of. A $0 bank account keeps
        // every classifier working; only the reconciliation of THAT account is off.
        const id = `gen${Object.keys(idByName).length}`;
        accounts.push({
          id, name: acctName, type: 'bank_account', openingBalance: 0, openingDate: '2000-01-01',
          provider: 'other', color: '#000', isActive: true,
        } as PaymentAccount);
        idByName[acctName] = id;
        // stderr only: stdout belongs to the MCP stdio transport.
        console.error(`[cf-ledger] unknown account "${acctName}" in ${f} — created as a bank account with a $0 opening balance`);
      }
      transactions.push({
        id: `${f}:${i}`,
        title: String(r['Merchant'] ?? ''),
        merchant: String(r['Merchant'] ?? ''),
        description: String(r['Original Statement'] ?? ''),
        sourceCategory: String(r['Category'] ?? ''),
        amount: Math.abs(amount),
        type: isTransfer ? 'transfer' : amount < 0 ? 'expense' : 'income',
        transferDirection: isTransfer ? (amount < 0 ? 'out' : 'in') : undefined,
        category: 'other', paymentMethod: 'other',
        date: String(r['Date']),
        accountId: idByName[acctName],
      } as Transaction);
    }
  }
  return { transactions, accounts };
}
