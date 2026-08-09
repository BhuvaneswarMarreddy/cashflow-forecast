import * as XLSX from 'xlsx';
import { PaymentAccount, Transaction, UserProfile } from '@/types';
import { buildExportWorkbook } from '@/lib/export-xlsx';

const acct = (o: Partial<PaymentAccount> & { id: string }): PaymentAccount => ({
  name: o.id, type: 'bank_account', provider: 'chase', openingBalance: 0, openingDate: '2000-01-01',
  color: '#000', isActive: true, ...o,
} as PaymentAccount);
const tx = (o: Partial<Transaction> & { id: string; amount: number; date: string }): Transaction => ({
  title: o.id, type: 'expense', category: 'other', paymentMethod: 'bank-transfer', ...o,
} as Transaction);

const profile = {
  name: 'Test', email: 't@example.com', monthlyBudget: 5000, currency: 'USD', settings: undefined,
} as unknown as Pick<UserProfile, 'name' | 'email' | 'monthlyBudget' | 'currency' | 'settings'>;

describe('buildExportWorkbook', () => {
  const bank = acct({ id: 'Checking', openingBalance: 100 });
  const card = acct({ id: 'Card', type: 'credit_card', provider: 'amex', openingBalance: 50 });
  const txns = [
    tx({ id: 'inc', amount: 500, type: 'income', accountId: 'Checking', date: '2026-01-05' }),
    tx({ id: 'exp', amount: 200, type: 'expense', accountId: 'Checking', date: '2026-01-10' }),
    // outbound transfer — MUST export negative (the documented $10,000 bug class)
    tx({ id: 'xfer', amount: 5000, type: 'transfer', transferDirection: 'out', accountId: 'Checking', date: '2026-01-12' }),
  ];

  const wb = buildExportWorkbook({ profile, accounts: [bank, card], incomeSources: [], transactions: txns });

  it('creates the expected sheets', () => {
    expect(wb.SheetNames).toEqual(
      expect.arrayContaining(['Summary', 'Accounts', 'Transactions_All', 'Txn_Checking'])
    );
  });

  it('signs an outbound transfer negative in the Amount column', () => {
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['Transactions_All']);
    const xfer = rows.find((r) => r['Title'] === 'xfer')!;
    expect(xfer['Amount']).toBe(-5000);
    const inc = rows.find((r) => r['Title'] === 'inc')!;
    expect(inc['Amount']).toBe(500);
    const exp = rows.find((r) => r['Title'] === 'exp')!;
    expect(exp['Amount']).toBe(-200);
  });

  it('exports derived balances, not raw opening figures', () => {
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['Accounts']);
    const checking = rows.find((r) => r['Name'] === 'Checking')!;
    // opening 100 + 500 income − 200 expense − 5000 transfer-out = −4600
    expect(checking['Balance']).toBe(-4600);
  });
});

// #83 Fix 4: an export leaves the app entirely, so an unanchored account's balance
// needs its own disclosure IN the sheet — a UI-only note never reaches whoever opens
// this file. The number itself must never be suppressed, only the claim attached to it.
describe('buildExportWorkbook — unanchored disclosure (#83 Fix 4)', () => {
  const anchoredBank = acct({ id: 'Checking', openingBalance: 100 });
  // No openingDate: nobody ever asserted a starting balance for this one (prod has
  // exactly this shape today — "Amazon Store Card").
  const unanchoredCard = acct({ id: 'Card', type: 'credit_card', provider: 'amex', openingBalance: 0, openingDate: undefined });
  const txns = [tx({ id: 'purchase', amount: 300, type: 'expense', accountId: 'Card', date: '2026-02-01' })];
  const wb = buildExportWorkbook({ profile, accounts: [anchoredBank, unanchoredCard], incomeSources: [], transactions: txns });

  it('the Accounts sheet marks the unanchored row net-since, the anchored row as-of, and never hides the balance', () => {
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['Accounts']);
    const card = rows.find((r) => r['Name'] === 'Card')!;
    expect(card['Balance As Of']).toBe('net since 2026-02-01 · no starting balance set');
    expect(card['Balance']).toBe(300); // the number is still shown
    const bank = rows.find((r) => r['Name'] === 'Checking')!;
    expect(bank['Balance As Of']).toBe('as of 2000-01-01');
  });

  it('the Summary sheet notes the total the unanchored card is IN, not the one it is excluded from', () => {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets['Summary'], { header: 1 });
    const creditIdx = rows.findIndex((r) => r[0] === 'Total Credit Card Debt');
    const bankIdx = rows.findIndex((r) => r[0] === 'Total Bank Balance');
    expect(String(rows[creditIdx + 1]?.[0] ?? '')).toContain('includes 1 unanchored account');
    // The bank total excludes the card entirely — attaching the note here would be
    // exactly the inversion Fix 1 exists to correct, one layer up in the app.
    expect(String(rows[bankIdx + 1]?.[0] ?? '')).not.toContain('unanchored');
  });
});

// Round 4b Fix 4: DebtPlan wrote `originalBalance` with no caption at all — the same
// number the Accounts sheet already never leaves silent. The spreadsheet is the most
// authoritative-looking thing this app produces and it leaves the app entirely, so the
// claim has to travel with the number here too, not just on-screen.
describe('buildExportWorkbook — DebtPlan sheet discloses an unanchored debt (round 4b Fix 4)', () => {
  const unanchoredCard = acct({ id: 'Card', type: 'credit_card', provider: 'amex', openingBalance: 0, openingDate: undefined });
  const txns = [tx({ id: 'purchase', amount: 300, type: 'expense', accountId: 'Card', date: '2026-02-01' })];
  const debtPlan = {
    strategy: 'avalanche' as const,
    extraMonthlyPayment: 100,
    totalInterestPaid: 50,
    totalMonths: 6,
    interestSaved: 20,
    debts: [{
      accountId: 'Card', accountName: 'Card', originalBalance: 300, apr: 24.99,
      payoffOrder: 1, payoffDate: '2026-08-01', totalInterestPaid: 50, monthsToPayoff: 6,
    }],
  };
  const wb = buildExportWorkbook({
    profile, accounts: [unanchoredCard], incomeSources: [], transactions: txns, debtPlan,
  });

  it('carries the same balanceCaption the Accounts sheet uses for this account, never a blank claim', () => {
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['DebtPlan'], { range: 8 });
    const row = rows.find((r) => r['Account'] === 'Card')!;
    expect(row['Balance']).toBe(300); // the number is still shown
    expect(row['Balance As Of']).toBe('net since 2026-02-01 · no starting balance set');
  });
});
