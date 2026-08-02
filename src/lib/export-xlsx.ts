/**
 * Excel export — pure compute, runs entirely in the browser (moved out of the
 * old /api/export route so it works in a static bundle and offline).
 *
 * Sheets: Summary · Accounts · Income · Transactions_All · Txn_<account> ·
 * Budgets · Goals · DebtPlan.
 */

import * as XLSX from 'xlsx';
import { withDerivedBalances } from '@/lib/forecast';
import { PaymentAccount, Transaction, IncomeSource, InflowReview, SavingsGoal, DebtPayoffPlan, UserProfile } from '@/types';
import { currentOf } from '@/lib/accounts';
import { interpretTransaction, isPositive, sumIncomeCents, sumExpenseCents, IncomeContext } from '@/lib/classify';

export interface ExportData {
  profile: Pick<UserProfile, 'name' | 'email' | 'monthlyBudget' | 'currency' | 'settings'>;
  accounts: PaymentAccount[];
  incomeSources: IncomeSource[];
  /** `users/{uid}/reviews` — the owner's confirmed inflow classifications. */
  inflowReviews?: Record<string, InflowReview>;
  transactions: Transaction[];
  savingsGoals?: SavingsGoal[];
  debtPlan?: DebtPayoffPlan;
}

export function buildExportWorkbook(data: ExportData): XLSX.WorkBook {
  // The one earned-income context: approved sources + confirmed reviews. Built here
  // from what the caller already passes, so the export cannot drift from the app.
  const income: IncomeContext = { sources: data.incomeSources, reviews: data.inflowReviews };
  // Export the balances the app shows (derived from transactions), not the raw
  // opening figures — otherwise auto-created accounts export as $0.
  const accounts = withDerivedBalances(data.accounts, data.transactions);

  const wb = XLSX.utils.book_new();

  // 1. Summary Sheet
  const summaryData = [
    ['CashFlow Forecast - Data Export'],
    ['Generated', new Date().toISOString()],
    [''],
    ['Profile Summary'],
    ['Name', data.profile.name],
    ['Email', data.profile.email],
    ['Currency', data.profile.currency],
    ['Monthly Budget', data.profile.monthlyBudget],
    ['Safety Threshold', data.profile.settings?.safetyThreshold || 'Not set'],
    ['Emergency Fund Goal (months)', data.profile.settings?.emergencyFundGoal || 'Not set'],
    [''],
    ['Account Totals'],
    ['Total Accounts', data.accounts.length],
    ['Total Bank Balance', accounts.filter(a => a.type === 'bank_account' || a.type === 'debit_card').reduce((sum, a) => sum + currentOf(a), 0)],
    ['Total Credit Card Debt', accounts.filter(a => a.type === 'credit_card').reduce((sum, a) => sum + currentOf(a), 0)],
    ['Total Loan Balance', accounts.filter(a => a.type === 'personal_loan').reduce((sum, a) => sum + currentOf(a), 0)],
    [''],
    ['Income Summary'],
    ['Total Income Sources', data.incomeSources.filter(i => i.isActive).length],
    // ACTIVE sources only — a paused source is kept so it can be resumed, not counted.
    ['Monthly Income Estimate', data.incomeSources.filter(i => i.isActive).reduce((sum, i) => sum + getMonthlyAmount(i.amount, i.frequency), 0)],
    [''],
    ['Transaction Summary'],
    ['Total Transactions', data.transactions.length],
    // The app's authoritative classification, not the stored type: a card payment is
    // a transfer, so it is neither income nor spending here — same as every screen.
    // PENDING: EXCLUDED from these totals (they are the posted accounting truth) but
    // still exported row-by-row below with a Pending column, so nothing is hidden.
    ['Total Income', sumIncomeCents(data.transactions, accounts, income) / 100],
    ['Total Expenses', sumExpenseCents(data.transactions, accounts) / 100],
    ['Pending (not in the totals above)', data.transactions.filter(t => t.pending).length],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summaryData), 'Summary');

  // 2. Accounts Sheet
  if (data.accounts.length > 0) {
    const accountHeaders = ['Name', 'Type', 'Provider', 'Balance', 'Credit Limit', 'APR (%)', 'Due Date', 'Last 4 Digits', 'Active'];
    const accountRows = accounts.map(a => [
      a.name, a.type, a.provider, currentOf(a),
      a.creditLimit || '', a.apr || '', a.dueDate || '', a.lastFourDigits || '',
      a.isActive ? 'Yes' : 'No',
    ]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([accountHeaders, ...accountRows]), 'Accounts');
  }

  // 3. Income Sheet
  if (data.incomeSources.length > 0) {
    const incomeHeaders = ['Name', 'Amount', 'Frequency', 'Pay Date', 'Monthly Estimate', 'Active'];
    const incomeRows = data.incomeSources.map(i => [
      i.name, i.amount, i.frequency, i.payDate || '',
      getMonthlyAmount(i.amount, i.frequency),
      i.isActive ? 'Yes' : 'No',
    ]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([incomeHeaders, ...incomeRows]), 'Income');
  }

  // 4. All Transactions Sheet
  if (data.transactions.length > 0) {
    const txnHeaders = ['Date', 'Title', 'Merchant', 'Category', 'Type', 'Amount', 'Payment Method', 'Account', 'Recurring', 'Pending'];
    const txnRows = [...data.transactions]
      .sort((a, b) => b.date.localeCompare(a.date))
      .map(t => {
        const account = data.accounts.find(a => a.id === t.accountId);
        return [
          // Type is the AUTHORITATIVE classification. The stored provider value is
          // never mutated — this column just reports what the app actually believes.
          formatDate(t.date), t.title, t.merchant || '', t.category,
          interpretTransaction(t, accounts).type,
          signedAmount(t, accounts),
          t.paymentMethod, account?.name || 'Unlinked',
          t.isRecurring ? 'Yes' : 'No',
          t.pending ? 'Yes' : 'No',
        ];
      });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([txnHeaders, ...txnRows]), 'Transactions_All');

    // 5. Per-Account Transaction Sheets
    const accountsWithTxns = new Map<string, Transaction[]>();
    data.transactions.forEach(t => {
      if (t.accountId) {
        const existing = accountsWithTxns.get(t.accountId) || [];
        existing.push(t);
        accountsWithTxns.set(t.accountId, existing);
      }
    });
    accountsWithTxns.forEach((txns, accountId) => {
      const account = data.accounts.find(a => a.id === accountId);
      if (!account) return;
      const rows = [...txns]
        .sort((a, b) => b.date.localeCompare(a.date))
        .map(t => [
          formatDate(t.date), t.title, t.merchant || '', t.category,
          interpretTransaction(t, accounts).type,
          signedAmount(t, accounts),
          t.isRecurring ? 'Yes' : 'No',
          t.pending ? 'Yes' : 'No',
        ]);
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.aoa_to_sheet([['Date', 'Title', 'Merchant', 'Category', 'Type', 'Amount', 'Recurring', 'Pending'], ...rows]),
        `Txn_${sanitizeSheetName(account.name)}`
      );
    });
  }

  // 6. Budgets Sheet
  const budgets = data.profile.settings?.categoryBudgets;
  if (budgets && budgets.length > 0) {
    const budgetRows = budgets.filter(b => b.isEnabled).map(b => [b.categoryId, b.monthlyLimit, 'Yes']);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Category', 'Monthly Limit', 'Enabled'], ...budgetRows]), 'Budgets');
  }

  // 7. Savings Goals Sheet
  if (data.savingsGoals && data.savingsGoals.length > 0) {
    const goalRows = data.savingsGoals.map(g => [
      g.name, g.targetAmount, g.currentAmount,
      g.targetAmount > 0 ? Math.round((g.currentAmount / g.targetAmount) * 100) : 0,
      g.targetDate ? formatDate(g.targetDate) : '', g.priority,
      g.isActive ? 'Yes' : 'No',
    ]);
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([['Name', 'Target Amount', 'Current Amount', 'Progress %', 'Target Date', 'Priority', 'Active'], ...goalRows]),
      'Goals'
    );
  }

  // 8. Debt Plan Sheet
  if (data.debtPlan && data.debtPlan.debts.length > 0) {
    const debtPlanData = [
      ['Debt Payoff Plan'],
      ['Strategy', data.debtPlan.strategy === 'avalanche' ? 'Avalanche (Highest APR First)' : 'Snowball (Smallest Balance First)'],
      ['Extra Monthly Payment', data.debtPlan.extraMonthlyPayment],
      ['Total Months to Debt-Free', data.debtPlan.totalMonths],
      ['Total Interest to Pay', data.debtPlan.totalInterestPaid],
      ['Interest Saved vs Minimums', data.debtPlan.interestSaved],
      [''],
      ['Payoff Order'],
      ['#', 'Account', 'Balance', 'APR %', 'Months', 'Payoff Date', 'Interest'],
      ...data.debtPlan.debts.map(d => [
        d.payoffOrder, d.accountName, d.originalBalance, d.apr,
        d.monthsToPayoff, formatDate(d.payoffDate), d.totalInterestPaid,
      ]),
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(debtPlanData), 'DebtPlan');
  }

  return wb;
}

/** Workbook → downloadable Blob (browser-safe: array, not Node buffer). */
export function workbookToBlob(wb: XLSX.WorkBook): Blob {
  const array = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  return new Blob([array], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

// A transfer is not income: without the direction check an outbound
// $5,000 move exports as +$5,000 and the Amount column is off by $10,000.
// isPositive() is the same sign rule every screen renders with, so the export and
// the app can never disagree about which way a row moved.
function signedAmount(t: Transaction, accounts?: PaymentAccount[]): number {
  return isPositive(t, accounts) ? t.amount : -t.amount;
}

function getMonthlyAmount(amount: number, frequency: string): number {
  switch (frequency) {
    case 'weekly': return amount * 4;
    case 'biweekly': return amount * 2;
    case 'monthly': return amount;
    case 'yearly': return amount / 12;
    default: return amount;
  }
}

function formatDate(isoDate: string): string {
  try {
    return new Date(isoDate).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return isoDate;
  }
}

function sanitizeSheetName(name: string): string {
  // Excel sheet names: max 31 chars, no special chars
  return name.replace(/[:\\/?*\[\]]/g, '').substring(0, 20);
}
