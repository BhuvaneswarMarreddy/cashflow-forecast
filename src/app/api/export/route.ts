/**
 * Data Export API Route
 * 
 * Generates Excel (.xlsx) export with multiple sheets:
 * 1) Summary - settings + totals
 * 2) Accounts - all payment accounts
 * 3) Income - all income sources
 * 4) Transactions_All - all transactions
 * 5) Transactions_ByAccount_<name> - per account
 * 6) Budgets - category budgets
 * 7) Goals - savings goals
 * 8) DebtPlan - if applicable
 */

import { NextRequest, NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import { withDerivedBalances } from '@/lib/forecast';
import { PaymentAccount, Transaction } from '@/types';
import { currentOf } from '@/lib/accounts';

interface ExportRequest {
  profile: {
    name: string;
    email: string;
    monthlyBudget: number;
    currency: string;
    settings?: {
      safetyThreshold?: number;
      emergencyFundGoal?: number;
      categoryBudgets?: Array<{
        categoryId: string;
        monthlyLimit: number;
        isEnabled: boolean;
      }>;
    };
  };
  accounts: Array<{
    id: string;
    name: string;
    type: string;
    provider: string;
    balance: number;
    creditLimit?: number;
    apr?: number;
    dueDate?: number;
    lastFourDigits?: string;
    isActive: boolean;
  }>;
  incomeSources: Array<{
    id: string;
    name: string;
    amount: number;
    frequency: string;
    payDate?: number;
    isActive: boolean;
  }>;
  transactions: Array<{
    id: string;
    title: string;
    amount: number;
    type: string;
    transferDirection?: 'in' | 'out';
    category: string;
    paymentMethod: string;
    accountId?: string;
    date: string;
    merchant?: string;
    isRecurring?: boolean;
  }>;
  savingsGoals?: Array<{
    id: string;
    name: string;
    targetAmount: number;
    currentAmount: number;
    targetDate?: string;
    priority: number;
    isActive: boolean;
  }>;
  debtPlan?: {
    strategy: string;
    extraMonthlyPayment: number;
    debts: Array<{
      accountName: string;
      originalBalance: number;
      apr: number;
      payoffOrder: number;
      payoffDate: string;
      totalInterestPaid: number;
      monthsToPayoff: number;
    }>;
    totalInterestPaid: number;
    totalMonths: number;
    interestSaved: number;
  };
}

export async function POST(request: NextRequest) {
  try {
    const data: ExportRequest = await request.json();

    // Export the balances the app shows (derived from transactions), not the raw
    // opening figures — otherwise auto-created accounts export as $0. The route's local
    // shapes are looser than the domain types, but derivation only reads type/id/balance.
    const accounts = withDerivedBalances(
      data.accounts as unknown as PaymentAccount[],
      data.transactions as unknown as Transaction[]
    );

    // Create workbook
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
      ['Total Income Sources', data.incomeSources.length],
      ['Monthly Income Estimate', calculateMonthlyIncome(data.incomeSources)],
      [''],
      ['Transaction Summary'],
      ['Total Transactions', data.transactions.length],
      ['Total Income', data.transactions.filter(t => t.type === 'income').reduce((sum, t) => sum + t.amount, 0)],
      ['Total Expenses', data.transactions.filter(t => t.type === 'expense').reduce((sum, t) => sum + t.amount, 0)],
    ];
    const summarySheet = XLSX.utils.aoa_to_sheet(summaryData);
    XLSX.utils.book_append_sheet(wb, summarySheet, 'Summary');
    
    // 2. Accounts Sheet
    if (data.accounts.length > 0) {
      const accountHeaders = ['Name', 'Type', 'Provider', 'Balance', 'Credit Limit', 'APR (%)', 'Due Date', 'Last 4 Digits', 'Active'];
      const accountRows = accounts.map(a => [
        a.name,
        a.type,
        a.provider,
        currentOf(a),
        a.creditLimit || '',
        a.apr || '',
        a.dueDate || '',
        a.lastFourDigits || '',
        a.isActive ? 'Yes' : 'No',
      ]);
      const accountsSheet = XLSX.utils.aoa_to_sheet([accountHeaders, ...accountRows]);
      XLSX.utils.book_append_sheet(wb, accountsSheet, 'Accounts');
    }
    
    // 3. Income Sheet
    if (data.incomeSources.length > 0) {
      const incomeHeaders = ['Name', 'Amount', 'Frequency', 'Pay Date', 'Monthly Estimate', 'Active'];
      const incomeRows = data.incomeSources.map(i => [
        i.name,
        i.amount,
        i.frequency,
        i.payDate || '',
        getMonthlyAmount(i.amount, i.frequency),
        i.isActive ? 'Yes' : 'No',
      ]);
      const incomeSheet = XLSX.utils.aoa_to_sheet([incomeHeaders, ...incomeRows]);
      XLSX.utils.book_append_sheet(wb, incomeSheet, 'Income');
    }
    
    // 4. All Transactions Sheet
    if (data.transactions.length > 0) {
      const txnHeaders = ['Date', 'Title', 'Merchant', 'Category', 'Type', 'Amount', 'Payment Method', 'Account', 'Recurring'];
      const txnRows = data.transactions
        .sort((a, b) => b.date.localeCompare(a.date))
        .map(t => {
          const account = data.accounts.find(a => a.id === t.accountId);
          return [
            formatDate(t.date),
            t.title,
            t.merchant || '',
            t.category,
            t.type,
            // A transfer is not income: without the direction check an outbound
            // $5,000 move exports as +$5,000 and the Amount column is off by $10,000.
            t.type === 'expense' || (t.type === 'transfer' && t.transferDirection === 'out')
              ? -t.amount
              : t.amount,
            t.paymentMethod,
            account?.name || 'Unlinked',
            t.isRecurring ? 'Yes' : 'No',
          ];
        });
      const allTxnSheet = XLSX.utils.aoa_to_sheet([txnHeaders, ...txnRows]);
      XLSX.utils.book_append_sheet(wb, allTxnSheet, 'Transactions_All');
      
      // 5. Per-Account Transaction Sheets
      const accountsWithTxns = new Map<string, typeof data.transactions>();
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
        
        const sheetName = `Txn_${sanitizeSheetName(account.name)}`;
        const rows = txns
          .sort((a, b) => b.date.localeCompare(a.date))
          .map(t => [
            formatDate(t.date),
            t.title,
            t.merchant || '',
            t.category,
            t.type,
            // A transfer is not income: without the direction check an outbound
            // $5,000 move exports as +$5,000 and the Amount column is off by $10,000.
            t.type === 'expense' || (t.type === 'transfer' && t.transferDirection === 'out')
              ? -t.amount
              : t.amount,
            t.isRecurring ? 'Yes' : 'No',
          ]);
        const sheet = XLSX.utils.aoa_to_sheet([
          ['Date', 'Title', 'Merchant', 'Category', 'Type', 'Amount', 'Recurring'],
          ...rows
        ]);
        XLSX.utils.book_append_sheet(wb, sheet, sheetName);
      });
    }
    
    // 6. Budgets Sheet
    if (data.profile.settings?.categoryBudgets && data.profile.settings.categoryBudgets.length > 0) {
      const budgetHeaders = ['Category', 'Monthly Limit', 'Enabled'];
      const budgetRows = data.profile.settings.categoryBudgets
        .filter(b => b.isEnabled)
        .map(b => [
          b.categoryId,
          b.monthlyLimit,
          'Yes',
        ]);
      const budgetsSheet = XLSX.utils.aoa_to_sheet([budgetHeaders, ...budgetRows]);
      XLSX.utils.book_append_sheet(wb, budgetsSheet, 'Budgets');
    }
    
    // 7. Savings Goals Sheet
    if (data.savingsGoals && data.savingsGoals.length > 0) {
      const goalHeaders = ['Name', 'Target Amount', 'Current Amount', 'Progress %', 'Target Date', 'Priority', 'Active'];
      const goalRows = data.savingsGoals.map(g => [
        g.name,
        g.targetAmount,
        g.currentAmount,
        g.targetAmount > 0 ? Math.round((g.currentAmount / g.targetAmount) * 100) : 0,
        g.targetDate ? formatDate(g.targetDate) : '',
        g.priority,
        g.isActive ? 'Yes' : 'No',
      ]);
      const goalsSheet = XLSX.utils.aoa_to_sheet([goalHeaders, ...goalRows]);
      XLSX.utils.book_append_sheet(wb, goalsSheet, 'Goals');
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
          d.payoffOrder,
          d.accountName,
          d.originalBalance,
          d.apr,
          d.monthsToPayoff,
          formatDate(d.payoffDate),
          d.totalInterestPaid,
        ]),
      ];
      const debtSheet = XLSX.utils.aoa_to_sheet(debtPlanData);
      XLSX.utils.book_append_sheet(wb, debtSheet, 'DebtPlan');
    }
    
    // Generate buffer
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    
    // Return as downloadable file
    const filename = `cashflow-export-${new Date().toISOString().split('T')[0]}.xlsx`;
    
    return new NextResponse(buffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
    
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Export error:', error);
    return NextResponse.json(
      { error: 'Failed to generate export', details: errorMessage },
      { status: 500 }
    );
  }
}

// Helper functions
function calculateMonthlyIncome(sources: ExportRequest['incomeSources']): number {
  return sources.reduce((sum, i) => sum + getMonthlyAmount(i.amount, i.frequency), 0);
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
    return new Date(isoDate).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return isoDate;
  }
}

function sanitizeSheetName(name: string): string {
  // Excel sheet names: max 31 chars, no special chars
  return name
    .replace(/[:\\/?*\[\]]/g, '')
    .substring(0, 20);
}


