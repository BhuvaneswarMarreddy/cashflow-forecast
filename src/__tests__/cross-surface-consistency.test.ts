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

import * as fs from 'node:fs';
import * as XLSX from 'xlsx';
import { IncomeSource, PaymentAccount, Transaction, UserProfile } from '@/types';
import {
  sumIncomeCents, sumExpenseCents, postedOnly, interpretTransaction,
  selectInflowReviewQueue, IncomeContext, POSTED_ONLY } from '@/lib/classify';
import { getAllCategorySpending } from '@/lib/budgets';
import { generateTransactionReminders } from '@/lib/reminders';
import { buildExportWorkbook } from '@/lib/export-xlsx';
import { buildFlowGraph, toCents } from '@/lib/flows';
import { deriveAccountBalance } from '@/lib/forecast';
import { matchTransfers } from '@/lib/transfers';
import { monthlyAverages } from '@/lib/forecast';

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

/**
 * FIN-INCOME-001: the owner's ONE approved income source. Every surface reads the
 * same `INCOME` context, which is what makes a single earned-income total possible.
 */
const EMPLOYER: IncomeSource = {
  id: 'src-employer', name: 'Larkspur Studio', amount: 3200, frequency: 'biweekly',
  isActive: true, kind: 'employment',
};
const INCOME: IncomeContext = { sources: [EMPLOYER] };

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
// Income:   Direct Deposit 320000 ONLY — it is the one row the approved source
//   "Larkspur Studio" explains.
//   FIN-INCOME-001 changed this figure from 330300: the $15.00 refund and the $88.00
//   unknown credit used to be counted as income merely because they were positive.
//   Both are still real cash on the balance; neither is earnings.
const EXPECTED_EXPENSE_CENTS = 22920;
const EXPECTED_INCOME_CENTS = 320000;

const profile = {
  name: 'Test', email: 't@example.com', monthlyBudget: 5000, currency: 'USD', settings: undefined,
} as unknown as Pick<UserProfile, 'name' | 'email' | 'monthlyBudget' | 'currency' | 'settings'>;

describe('cross-surface consistency', () => {
  it('the shared totals are the authoritative answer', () => {
    expect(sumExpenseCents(LEDGER, accounts, POSTED_ONLY)).toBe(EXPECTED_EXPENSE_CENTS);
    expect(sumIncomeCents(LEDGER, accounts, INCOME)).toBe(EXPECTED_INCOME_CENTS);
  });

  it('Dashboard and Calendar agree with the shared totals', () => {
    // Both pages sum through the same helper; a per-page reduce would drift.
    const dashboardExpense = sumExpenseCents(LEDGER, accounts, POSTED_ONLY);
    const calendarIncome = sumIncomeCents(LEDGER, accounts, INCOME);
    const calendarExpense = sumExpenseCents(LEDGER, accounts, POSTED_ONLY);
    expect(dashboardExpense).toBe(EXPECTED_EXPENSE_CENTS);
    expect(calendarExpense).toBe(EXPECTED_EXPENSE_CENTS);
    expect(calendarIncome).toBe(EXPECTED_INCOME_CENTS);
  });

  it('Budgets agrees with Analytics for classified expenses', () => {
    const spending = getAllCategorySpending(LEDGER, new Date('2026-03-15'), accounts);
    const budgetTotalCents = Object.values(spending).reduce((s, v) => s + toCents(v), 0);
    expect(budgetTotalCents).toBe(EXPECTED_EXPENSE_CENTS);
    expect(toCents(spending.food)).toBe(16500);      // 120.00 + 45.00
    expect(toCents(spending.shopping)).toBe(6420);   // posted replacement only
  });

  it('Export matches the app authoritative classification', () => {
    const wb = buildExportWorkbook({ profile, accounts, incomeSources: [EMPLOYER], transactions: LEDGER });
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets['Summary'], { header: 1 });
    const cell = (label: string) => rows.find((r) => r[0] === label)?.[1] as number;
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
    expect(interpretTransaction(CARD_PAYMENT_CARD_LEG, accounts, INCOME).income).toBe('excluded');
    expect(interpretTransaction(CARD_PAYMENT_CARD_LEG, accounts, INCOME).meaning).toBe('card_payment');
    expect(sumIncomeCents([CARD_PAYMENT_CARD_LEG], accounts, INCOME)).toBe(0);
  });

  it('card payments are not double-counted as expense', () => {
    expect(sumExpenseCents([CARD_PAYMENT_BANK_LEG, CARD_PAYMENT_CARD_LEG], accounts, POSTED_ONLY)).toBe(0);
  });

  it('internal transfers net to zero aggregate income and expense', () => {
    expect(sumIncomeCents([TRANSFER_OUT, TRANSFER_IN], accounts, INCOME)).toBe(0);
    expect(sumExpenseCents([TRANSFER_OUT, TRANSFER_IN], accounts, POSTED_ONLY)).toBe(0);
    const m = matchTransfers(LEDGER, accounts);
    // savings move + card payment, both two-sided
    expect(m.pairs).toHaveLength(2);
    expect(m.unmatchedOut).toHaveLength(0);
    expect(m.unmatchedIn).toHaveLength(0);
  });

  it('pending rows never silently become final truth', () => {
    expect(postedOnly(LEDGER)).toHaveLength(LEDGER.length - 1);
    // Card: purchase 45 + posted replacement 64.20 - payment 300 + refund -15 = -205.80 owed
    expect(deriveAccountBalance(accounts[2], LEDGER, POSTED_ONLY)).toBeCloseTo(-205.8, 2);
    // and the hold is not in the budget either
    const spending = getAllCategorySpending(LEDGER, new Date('2026-03-15'), accounts);
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
    // Accounts are what let the classifier see that f6 is a card-payment leg.
    const out = generateTransactionReminders(recurringLedger, undefined, [], 400, accounts);
    expect([...new Set(out.map((r) => r.relatedTransactionId))].sort()).toEqual(['f1']);
  });

  it('Forecast starts from the posted balance, not the pending one', () => {
    const withHold = deriveAccountBalance(accounts[2], LEDGER, POSTED_ONLY);
    const withoutHold = deriveAccountBalance(accounts[2], postedOnly(LEDGER), POSTED_ONLY);
    expect(withHold).toBeCloseTo(withoutHold, 2);
  });

  // --- FIN-INCOME-001 §8: ONE earned-income total ---------------------------

  it('every surface reports the SAME earned-income total from the same context', () => {
    const shared = sumIncomeCents(LEDGER, accounts, INCOME);

    // Calendar (per-day sum) and Dashboard/Analytics (whole-ledger sum)
    const byDay = [...new Set(LEDGER.map((t) => t.date))]
      .map((d) => sumIncomeCents(LEDGER.filter((t) => t.date === d), accounts, INCOME))
      .reduce((a, b) => a + b, 0);
    expect(byDay).toBe(shared);

    // Export
    const wb = buildExportWorkbook({ profile, accounts, incomeSources: [EMPLOYER], transactions: LEDGER });
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets['Summary'], { header: 1 });
    const total = rows.find((r) => r[0] === 'Total Income')?.[1] as number;
    expect(toCents(total)).toBe(shared);

    // Forecast / Accounts / AI context, via monthlyAverages over the same rule
    const inWindow = LEDGER.map((t) => ({ ...t, date: monthAgo(t.date) }));
    expect(monthlyAverages(inWindow, accounts, 1, INCOME).income * 100).toBe(shared);

    expect(shared).toBe(EXPECTED_INCOME_CENTS);
  });

  it('the unknown inflow is on the balance but in no income total, on any surface', () => {
    // It really arrived: the checking balance includes it.
    const chk = deriveAccountBalance(accounts[0], LEDGER, POSTED_ONLY);
    const withoutIt = deriveAccountBalance(accounts[0], LEDGER.filter((t) => t.id !== 'f11'), POSTED_ONLY);
    expect(chk - withoutIt).toBeCloseTo(88, 2);

    // And it is income nowhere.
    expect(interpretTransaction(UNKNOWN_INFLOW, accounts, INCOME).financialMeaning).toBe('unknown_inflow');
    expect(sumIncomeCents([UNKNOWN_INFLOW], accounts, INCOME)).toBe(0);
    const wb = buildExportWorkbook({ profile, accounts, incomeSources: [EMPLOYER], transactions: [UNKNOWN_INFLOW] });
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets['Summary'], { header: 1 });
    expect(rows.find((r) => r[0] === 'Total Income')?.[1]).toBe(0);
  });

  it('the review queue holds exactly the credits nothing explains', () => {
    // The $88.00 unknown credit. The paycheck is explained, the refund and the card
    // payment are named by the ledger layer, and the transfers are settled.
    expect(selectInflowReviewQueue(LEDGER, accounts, INCOME).map((i) => i.transactionId)).toEqual(['f11']);
  });

  it('a refund is income nowhere and reduces spending, on every surface', () => {
    expect(interpretTransaction(REFUND, accounts, INCOME).financialMeaning).toBe('refund');
    expect(sumIncomeCents([REFUND], accounts, INCOME)).toBe(0);
  });
});

// #83: an unanchored account's total is net movement over the rows we hold, not a
// bank balance. Accounts already discloses that (Task 6); this closes Dashboard and
// Forecast, which build totals from the same accounts and said nothing.
// Grepping for `UnanchoredNote` (not `isUnanchored`) on the two screens matters: the
// screens are expected to REUSE the shared component, not re-inline the check —
// a page that hand-rolls its own `isUnanchored` call would pass a naive grep for
// that symbol while still duplicating markup Task 6 extracted specifically to share.
// Finding 2: the substring 'UnanchoredNote' also matches a dead import or a comment
// mentioning the name, neither of which renders anything — asserting the JSX open
// tag `<UnanchoredNote` is the smallest change that forces the component to
// actually be mounted on the page, not merely referenced.
describe('unanchored disclosure is not one screen only (#83)', () => {
  it.each(['src/app/accounts/page.tsx', 'src/app/dashboard/page.tsx', 'src/app/forecast/page.tsx'])(
    '%s discloses unanchored accounts via the shared UnanchoredNote component',
    (path) => {
      expect(fs.readFileSync(path, 'utf8')).toContain('<UnanchoredNote');
    }
  );

  it('UnanchoredNote defers to the shared accounts.ts helper, not a reinvented check', () => {
    const src = fs.readFileSync('src/components/UnanchoredNote.tsx', 'utf8');
    // Round 4b: the count-and-pluralize logic moved into accounts.ts's
    // `unanchoredPhrase` (shared with export-xlsx.ts, see its own test) so the two
    // sentences can't independently drift — but that call still bottoms out in
    // `isUnanchored`, so this guard's real intent (no private `!a.openingDate`
    // copy hiding here) still holds.
    expect(src).toContain('unanchoredPhrase');
    expect(src).not.toMatch(/openingDate/); // would be a reinvented check, not a shared one
  });
});

/** Shift an ISO day into the previous calendar month, for monthlyAverages' window. */
function monthAgo(iso: string): string {
  const now = new Date();
  const d = Number(iso.split('T')[0].slice(8, 10));
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, Math.min(d, 28)))
    .toISOString()
    .slice(0, 10);
}
