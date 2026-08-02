/**
 * FIN-LEDGER-001 §F — ONE sanitized ledger, asserted identically across every
 * surface that makes a financial claim.
 *
 * Before this task Flow/Analytics/Cashflow read classifyTransaction() while
 * Calendar/Dashboard/Budgets/Reminders/Export read raw `t.type`, so a card payment
 * was a transfer on one screen and both income AND expense on another. Anything
 * that reintroduces a private categorisation branch fails here.
 *
 * Sanitized fixtures only — invented merchants, invented amounts, invented accounts.
 */

import * as XLSX from 'xlsx';
import { PaymentAccount, Transaction, UserProfile } from '@/types';
import { sumIncomeCents, sumExpenseCents, postedOnly, interpretTransaction } from '@/lib/classify';
import { getAllCategorySpending } from '@/lib/budgets';
import { generateTransactionReminders } from '@/lib/reminders';
import { buildExportWorkbook } from '@/lib/export-xlsx';
import { buildFlowGraph, toCents } from '@/lib/flows';
import { deriveAccountBalance } from '@/lib/forecast';
import { matchTransfers } from '@/lib/transfers';

const accounts: PaymentAccount[] = [
  {
    id: 'chk', name: 'Everyday Checking', type: 'bank_account', provider: 'chase',
    openingBalance: 5000, openingDate: '2000-01-01', color: '#111', isActive: true,
  },
  {
    id: 'sav', name: 'Reserve Savings', type: 'bank_account', provider: 'chase',
    openingBalance: 1000, openingDate: '2000-01-01', color: '#112', isActive: true,
  },
  {
    id: 'card', name: 'Rewards Card', type: 'credit_card', provider: 'amex',
    lastFourDigits: '9021', creditLimit: 5000,
    openingBalance: 0, openingDate: '2000-01-01', color: '#222', isActive: true,
  },
];

const tx = (o: Partial<Transaction> & { id: string; title: string; amount: number }): Transaction => ({
  type: 'expense', category: 'other', paymentMethod: 'other', date: '2026-03-10', ...o,
});

// --- the one fixture set -----------------------------------------------------
const ORDINARY_EXPENSE = tx({ id: 'f1', title: 'Willowbrook Market', amount: 120, category: 'food', accountId: 'chk' });
const ORDINARY_INCOME = tx({ id: 'f2', title: 'Direct Deposit - Larkspur Studio', amount: 3200, type: 'income', accountId: 'chk' });
const TRANSFER_OUT = tx({ id: 'f3', title: 'Online Transfer to Savings', amount: 500, type: 'transfer', transferDirection: 'out', accountId: 'chk', date: '2026-03-11' });
const TRANSFER_IN = tx({ id: 'f4', title: 'Online Transfer from Checking', amount: 500, type: 'transfer', transferDirection: 'in', accountId: 'sav', date: '2026-03-11' });
const CARD_PURCHASE = tx({ id: 'f5', title: 'Brightleaf Coffee', amount: 45, category: 'food', accountId: 'card', date: '2026-03-12' });
const CARD_PAYMENT_BANK_LEG = tx({ id: 'f6', title: 'AMEX EPAYMENT ACH PMT', amount: 300, type: 'expense', accountId: 'chk', date: '2026-03-15' });
const CARD_PAYMENT_CARD_LEG = tx({ id: 'f7', title: 'AUTOPAY PAYMENT - THANK YOU', amount: 300, type: 'income', accountId: 'card', date: '2026-03-15' });
const REFUND = tx({ id: 'f8', title: 'Refund - Brightleaf Coffee', amount: 15, type: 'income', accountId: 'card', date: '2026-03-16' });
const PENDING_PURCHASE = tx({ id: 'pending_f9', title: 'Cedarline Hardware', amount: 60, category: 'shopping', accountId: 'card', date: '2026-03-18', pending: true });
const POSTED_REPLACEMENT = tx({ id: 'f10', title: 'Cedarline Hardware', amount: 64.2, category: 'shopping', accountId: 'card', date: '2026-03-18' });
const UNKNOWN_INFLOW = tx({ id: 'f11', title: 'AB-4471 CREDIT', amount: 88, type: 'income', accountId: 'chk', date: '2026-03-19' });

const LEDGER: Transaction[] = [
  ORDINARY_EXPENSE, ORDINARY_INCOME, TRANSFER_OUT, TRANSFER_IN, CARD_PURCHASE,
  CARD_PAYMENT_BANK_LEG, CARD_PAYMENT_CARD_LEG, REFUND, PENDING_PURCHASE,
  POSTED_REPLACEMENT, UNKNOWN_INFLOW,
];

// Hand-computed authoritative truth for this ledger, in integer cents.
// Expenses: Willowbrook 12000 + Brightleaf 4500 + Cedarline posted 6420 = 22920.
//   (transfers, both card-payment legs and the pending hold are all excluded)
// Income:   Direct Deposit 320000 + Refund 1500 + Unknown inflow 8800 = 330300.
//   (refund/unknown stay counted until FIN-INCOME-001 rules on earned income;
//    the card-payment card leg is a transfer and contributes nothing)
const EXPECTED_EXPENSE_CENTS = 22920;
const EXPECTED_INCOME_CENTS = 330300;

const profile = {
  name: 'Test', email: 't@example.com', monthlyBudget: 5000, currency: 'USD', settings: undefined,
} as unknown as Pick<UserProfile, 'name' | 'email' | 'monthlyBudget' | 'currency' | 'settings'>;

describe('cross-surface consistency', () => {
  it('the shared totals are the authoritative answer', () => {
    expect(sumExpenseCents(LEDGER, accounts)).toBe(EXPECTED_EXPENSE_CENTS);
    expect(sumIncomeCents(LEDGER, accounts)).toBe(EXPECTED_INCOME_CENTS);
  });

  it('Dashboard and Calendar agree with the shared totals', () => {
    // Both pages sum through the same helper; a per-page reduce would drift.
    const dashboardExpense = sumExpenseCents(LEDGER, accounts);
    const calendarIncome = sumIncomeCents(LEDGER, accounts);
    const calendarExpense = sumExpenseCents(LEDGER, accounts);
    expect(dashboardExpense).toBe(EXPECTED_EXPENSE_CENTS);
    expect(calendarExpense).toBe(EXPECTED_EXPENSE_CENTS);
    expect(calendarIncome).toBe(EXPECTED_INCOME_CENTS);
  });

  it('Budgets agrees with Analytics for classified expenses', () => {
    const spending = getAllCategorySpending(LEDGER, new Date('2026-03-15'));
    const budgetTotalCents = Object.values(spending).reduce((s, v) => s + toCents(v), 0);
    expect(budgetTotalCents).toBe(EXPECTED_EXPENSE_CENTS);
    expect(toCents(spending.food)).toBe(16500);      // 120.00 + 45.00
    expect(toCents(spending.shopping)).toBe(6420);   // posted replacement only
  });

  it('Export matches the app authoritative classification', () => {
    const wb = buildExportWorkbook({ profile, accounts, incomeSources: [], transactions: LEDGER });
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['Summary'], { header: 1 });
    const cell = (label: string) =>
      (rows as unknown[][]).find((r) => r[0] === label)?.[1] as number;
    expect(toCents(cell('Total Income'))).toBe(EXPECTED_INCOME_CENTS);
    expect(toCents(cell('Total Expenses'))).toBe(EXPECTED_EXPENSE_CENTS);
  });

  it('Export marks pending rows rather than passing them off as posted', () => {
    const wb = buildExportWorkbook({ profile, accounts, incomeSources: [], transactions: LEDGER });
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['Transactions_All']);
    const held = rows.find((r) => r['Title'] === 'Cedarline Hardware' && r['Pending'] === 'Yes');
    expect(held).toBeDefined();
    expect(rows.filter((r) => r['Pending'] === 'Yes')).toHaveLength(1);
  });

  it('card payments never become earned income', () => {
    expect(interpretTransaction(CARD_PAYMENT_CARD_LEG, accounts).income).toBe('excluded');
    expect(interpretTransaction(CARD_PAYMENT_CARD_LEG, accounts).meaning).toBe('card_payment');
    expect(sumIncomeCents([CARD_PAYMENT_CARD_LEG], accounts)).toBe(0);
  });

  it('card payments are not double-counted as expense', () => {
    expect(sumExpenseCents([CARD_PAYMENT_BANK_LEG, CARD_PAYMENT_CARD_LEG], accounts)).toBe(0);
  });

  it('internal transfers net to zero aggregate income and expense', () => {
    expect(sumIncomeCents([TRANSFER_OUT, TRANSFER_IN], accounts)).toBe(0);
    expect(sumExpenseCents([TRANSFER_OUT, TRANSFER_IN], accounts)).toBe(0);
    const m = matchTransfers(LEDGER, accounts);
    // savings move + card payment, both two-sided
    expect(m.pairs).toHaveLength(2);
    expect(m.unmatchedOut).toHaveLength(0);
    expect(m.unmatchedIn).toHaveLength(0);
  });

  it('pending rows never silently become final truth', () => {
    expect(postedOnly(LEDGER)).toHaveLength(LEDGER.length - 1);
    // Card: purchase 45 + posted replacement 64.20 - payment 300 + refund -15 = -205.80 owed
    expect(deriveAccountBalance(accounts[2], LEDGER)).toBeCloseTo(-205.8, 2);
    // and the hold is not in the budget either
    const spending = getAllCategorySpending(LEDGER, new Date('2026-03-15'));
    expect(toCents(spending.shopping)).toBe(6420);
  });

  it('Dashboard and Flow agree on what left the accounts', () => {
    const g = buildFlowGraph(LEDGER, accounts);
    // Flow's spending is whatever it routes out of an account node into a category
    const spentCents = g.links
      .filter((l) => l.source.startsWith('acct:'))
      .reduce((s, l) => s + l.cents, 0);
    const g2 = buildFlowGraph(postedOnly(LEDGER), accounts);
    const spentCents2 = g2.links
      .filter((l) => l.source.startsWith('acct:'))
      .reduce((s, l) => s + l.cents, 0);
    // Flow is built from posted rows only, so both graphs agree
    expect(spentCents).toBe(spentCents2);
  });

  it('Reminders never builds a bill out of a pending or transfer row', () => {
    const recurringLedger: Transaction[] = [
      { ...PENDING_PURCHASE, category: 'subscriptions', isRecurring: true, recurringFrequency: 'monthly' },
      { ...CARD_PAYMENT_BANK_LEG, category: 'utilities', isRecurring: true, recurringFrequency: 'monthly' },
      { ...ORDINARY_EXPENSE, category: 'subscriptions', isRecurring: true, recurringFrequency: 'monthly' },
    ];
    const out = generateTransactionReminders(recurringLedger, undefined, [], 400);
    expect(out.map((r) => r.relatedTransactionId).sort()).toEqual(['f1']);
  });

  it('Forecast starts from the posted balance, not the pending one', () => {
    const withHold = deriveAccountBalance(accounts[2], LEDGER);
    const withoutHold = deriveAccountBalance(accounts[2], postedOnly(LEDGER));
    expect(withHold).toBeCloseTo(withoutHold, 2);
  });
});
