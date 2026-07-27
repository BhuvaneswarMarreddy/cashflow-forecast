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
