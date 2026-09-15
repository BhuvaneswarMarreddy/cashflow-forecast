/**
 * #184 XFER-SCHWAB-001 — Schwab checking→brokerage and bank→card must never read as spending.
 *
 * The lies these pin, by name:
 * - "Schwab checking→brokerage counted as spend": moving $2,000 into your own brokerage
 *   shrinks cash (true) but is not money spent — no surface may add it to spending.
 * - "card payment charged twice": the purchase is the spend; paying the card is not.
 * And the two old lies the transfer rule must not bring back:
 * - a payroll deposit is income, not a transfer;
 * - a Zelle to a person is money leaving, not a transfer.
 *
 * SYNTHETIC ROWS. These are the shapes plaid_ingest.py writes for Plaid's whitelisted
 * own-account categories (TRANSFER_*_INVESTMENT_AND_RETIREMENT_FUNDS, *_ACCOUNT_TRANSFER,
 * LOAN_PAYMENTS_CREDIT_CARD_PAYMENT) — see test_plaid.py for the ingest half. What
 * Schwab actually sends is captured after the first link; widening the whitelist waits
 * for that evidence (#184), it is not guessed here.
 */
import * as XLSX from 'xlsx';
import type { IncomeSource, PaymentAccount, Transaction, UserProfile } from '@/types';
import { classifyTransaction, sumExpenseCents, sumIncomeCents, POSTED_ONLY, type IncomeContext } from '@/lib/classify';
import { buildFlowGraph } from '@/lib/flows';
import { calculateCurrentCash, monthlyAverages, withDerivedBalances } from '@/lib/forecast';
import { matchTransfers } from '@/lib/transfers';
import { getAllCategorySpending } from '@/lib/budgets';
import { buildExportWorkbook } from '@/lib/export-xlsx';

const accounts: PaymentAccount[] = [
  { id: 'schwab-chk', name: 'Schwab Checking', type: 'bank_account', provider: 'bank-transfer', openingBalance: 10000, openingDate: '2000-01-01', color: '#000', isActive: true },
  { id: 'schwab-brk', name: 'Schwab Brokerage', type: 'investment', provider: 'other', openingBalance: 80000, openingDate: '2000-01-01', color: '#000', isActive: true },
  { id: 'card', name: 'Rewards Card', type: 'credit_card', provider: 'amex', lastFourDigits: '9021', openingBalance: 0, openingDate: '2000-01-01', color: '#000', isActive: true },
];

const EMPLOYER: IncomeSource = { id: 'src', name: 'Larkspur Studio', amount: 4200, frequency: 'monthly', isActive: true, kind: 'employment' };
const INCOME: IncomeContext = { sources: [EMPLOYER] };

// Last calendar month, so monthlyAverages' trailing window sees every row.
const now = new Date();
const monthKey = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
const on = (dd: string) => `${monthKey}-${dd}`;

const tx = (o: Partial<Transaction> & { id: string; title: string; amount: number; accountId: string; date: string }): Transaction =>
  ({ type: 'expense', category: 'other', paymentMethod: 'other', ...o } as Transaction);

const TO_BROKERAGE_OUT = tx({ id: 'b1', title: 'Funds Transfer to Brokerage', amount: 2000, type: 'transfer', transferDirection: 'out', accountId: 'schwab-chk', date: on('05') });
const TO_BROKERAGE_IN = tx({ id: 'b2', title: 'Funds Received from Checking', amount: 2000, type: 'transfer', transferDirection: 'in', accountId: 'schwab-brk', date: on('05') });
const SWEEP_OUT = tx({ id: 'b3', title: 'Transfer to Checking', amount: 150, type: 'transfer', transferDirection: 'out', accountId: 'schwab-brk', date: on('08') });
const SWEEP_IN = tx({ id: 'b4', title: 'Transfer from Brokerage', amount: 150, type: 'transfer', transferDirection: 'in', accountId: 'schwab-chk', date: on('09') });
const PURCHASE = tx({ id: 'c1', title: 'Brightleaf Coffee', amount: 400, category: 'food', accountId: 'card', date: on('03') });
const CARD_PAY_BANK = tx({ id: 'c2', title: 'AMEX EPAYMENT ACH PMT', amount: 400, type: 'transfer', transferDirection: 'out', accountId: 'schwab-chk', date: on('12') });
const CARD_PAY_CARD = tx({ id: 'c3', title: 'AUTOPAY PAYMENT - THANK YOU', amount: 400, type: 'transfer', transferDirection: 'in', accountId: 'card', date: on('12') });
const PAYROLL = tx({ id: 'p1', title: 'Direct Deposit - Larkspur Studio', amount: 4200, type: 'income', accountId: 'schwab-chk', date: on('01') });
const ZELLE = tx({ id: 'z1', title: 'Zelle to Priya', amount: 75, accountId: 'schwab-chk', date: on('14') });

const MOVEMENTS = [TO_BROKERAGE_OUT, TO_BROKERAGE_IN, SWEEP_OUT, SWEEP_IN, CARD_PAY_BANK, CARD_PAY_CARD];
const REAL = [PURCHASE, PAYROLL, ZELLE];
const LEDGER = [...REAL, ...MOVEMENTS];

const SPEND_CENTS = 40000 + 7500; // the coffee on the card + the Zelle. Nothing else.

describe('Schwab checking→brokerage counted as spend (#184)', () => {
  it('History: every movement leg is a transfer, never an expense or income row', () => {
    for (const t of MOVEMENTS) expect([t.id, classifyTransaction(t, accounts)]).toEqual([t.id, 'transfer']);
  });

  it('the engine totals: spend is the coffee and the Zelle; income is the paycheck', () => {
    expect(sumExpenseCents(LEDGER, accounts, POSTED_ONLY)).toBe(SPEND_CENTS);
    expect(sumIncomeCents(LEDGER, accounts, INCOME)).toBe(420000);
    expect(sumExpenseCents(MOVEMENTS, accounts, POSTED_ONLY)).toBe(0);
    expect(sumIncomeCents(MOVEMENTS, accounts, INCOME)).toBe(0);
  });

  it('both legs pair: checking→brokerage, brokerage→checking sweep, and bank→card', () => {
    const m = matchTransfers(LEDGER, accounts);
    expect(m.pairs.map((p) => `${p.fromAccountId}→${p.toAccountId}:${p.amount}`).sort())
      .toEqual(['schwab-brk→schwab-chk:150', 'schwab-chk→card:400', 'schwab-chk→schwab-brk:2000']);
    expect(m.unmatchedOut).toHaveLength(0);
    expect(m.unmatchedIn).toHaveLength(0);
  });

  it('a move to a brokerage that is NOT linked (one leg only) is still not spend', () => {
    expect(sumExpenseCents([TO_BROKERAGE_OUT], accounts.filter((a) => a.id !== 'schwab-brk'), POSTED_ONLY)).toBe(0);
  });

  it('Flow: nothing routes out to spending but the coffee (a category) and the Zelle (a person)', () => {
    const spentOnFlow = (rows: Transaction[]) => {
      const g = buildFlowGraph(rows, accounts, {}, { income: INCOME });
      const kind = new Map(g.nodes.map((n) => [n.id, n.kind]));
      return g.links.filter((l) => ['category', 'person'].includes(kind.get(l.target) ?? '')).reduce((s, l) => s + l.cents, 0);
    };
    expect(spentOnFlow(LEDGER)).toBe(spentOnFlow(REAL));
    expect(spentOnFlow(LEDGER)).toBe(SPEND_CENTS);
  });

  it('Forecast: the monthly spending average ignores the movements', () => {
    expect(monthlyAverages(LEDGER, accounts, 6, INCOME).spending).toBe(monthlyAverages(REAL, accounts, 6, INCOME).spending);
  });

  it('Budgets/Analytics: category spending ignores the movements', () => {
    const month = new Date(`${on('15')}T12:00:00`);
    expect(getAllCategorySpending(LEDGER, month, accounts, undefined, INCOME))
      .toEqual(getAllCategorySpending(REAL, month, accounts, undefined, INCOME));
  });

  it('Export: Total Expenses is the same with or without the movements', () => {
    const profile = { name: 'T', email: 't@example.com', monthlyBudget: 0, currency: 'USD', settings: undefined } as unknown as Pick<UserProfile, 'name' | 'email' | 'monthlyBudget' | 'currency' | 'settings'>;
    const totalExpenses = (rows: Transaction[]) => {
      const wb = buildExportWorkbook({ profile, accounts, incomeSources: [EMPLOYER], transactions: rows });
      const summary = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets['Summary'], { header: 1 });
      return summary.find((r) => r[0] === 'Total Expenses')?.[1];
    };
    expect(totalExpenses(LEDGER)).toBe(SPEND_CENTS / 100);
    expect(totalExpenses(LEDGER)).toBe(totalExpenses(REAL));
  });

  it('cash moves with the money (it left checking) — but only into net worth, never into spend', () => {
    const cash = (rows: Transaction[]) => calculateCurrentCash(withDerivedBalances(accounts, rows, INCOME));
    // 10,000 + 4,200 pay − 75 Zelle − 2,000 to brokerage + 150 sweep − 400 card payment
    expect(cash(LEDGER)).toBeCloseTo(11875, 2);
  });
});

describe('card payment charged twice (#184)', () => {
  it('the purchase counts once; the payment, on either side, counts zero', () => {
    expect(sumExpenseCents([PURCHASE, CARD_PAY_BANK, CARD_PAY_CARD], accounts, POSTED_ONLY)).toBe(40000);
  });

  it('a card payment Plaid did not type as a transfer is still recognised by the engine, not charged', () => {
    const untyped = { ...CARD_PAY_BANK, type: 'expense' as const, transferDirection: undefined };
    const untypedCardLeg = { ...CARD_PAY_CARD, type: 'income' as const, transferDirection: undefined };
    expect(sumExpenseCents([PURCHASE, untyped, untypedCardLeg], accounts, POSTED_ONLY)).toBe(40000);
    expect(sumIncomeCents([untypedCardLeg], accounts, INCOME)).toBe(0);
  });
});

describe('the transfer rule does not bring back the old lies (#184)', () => {
  it('a payroll deposit on Schwab checking is earned income, not a transfer', () => {
    expect(classifyTransaction(PAYROLL, accounts)).not.toBe('transfer');
    expect(sumIncomeCents([PAYROLL], accounts, INCOME)).toBe(420000);
  });

  it('a Zelle to a person is money leaving, not a transfer', () => {
    expect(classifyTransaction(ZELLE, accounts)).not.toBe('transfer');
    expect(sumExpenseCents([ZELLE], accounts, POSTED_ONLY)).toBe(7500);
  });
});
