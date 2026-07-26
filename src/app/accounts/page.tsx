'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { useUserProfile } from '@/context/UserProfileContext';
import { useTransactions } from '@/context/TransactionContext';
import Navbar from '@/components/Navbar';
import AccountsList from '@/components/AccountsList';
import AccountTransactions from '@/components/AccountTransactions';
import BudgetSettingsPanel from '@/components/BudgetSettingsPanel';
import BudgetStatusPanel from '@/components/BudgetStatusPanel';
import DebtPlannerPanel from '@/components/DebtPlannerPanel';
import { PAYMENT_METHODS, ACCOUNT_TYPES, PaymentAccount, IncomeSource, AccountType, PaymentMethod, CategoryBudget } from '@/types';
import { deriveAccountBalance, withDerivedBalances } from '@/lib/forecast';
import { matchTransfers } from '@/lib/transfers';
import {
  TrendingUp,
  CreditCard,
  DollarSign,
  Calendar,
  Plus,
  Trash2,
  Edit3,
  Wallet,
  Building2,
  Banknote,
  X,
  Check,
  AlertCircle,
  FileText,
  Percent,
  Receipt,
  BarChart3,
  ArrowLeftRight,
  AlertTriangle,
} from 'lucide-react';

export default function AccountsPage() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { 
    profile, 
    isLoading: profileLoading, 
    addPaymentAccount, 
    updatePaymentAccount,
    reorderPaymentAccounts,
    deletePaymentAccount,
    addIncomeSource,
    updateIncomeSource,
    deleteIncomeSource,
    updateProfile,
  } = useUserProfile();
  const { transactions } = useTransactions();
  const router = useRouter();
  
  const [activeTab, setActiveTab] = useState<'accounts' | 'spending' | 'transfers' | 'income' | 'budget' | 'budgets' | 'debt'>('accounts');

  // Live transfer pairing: match each leg leaving an account to the leg arriving in
  // another, so an internal move reads as ONE net-zero movement. Unpaired legs = the
  // other side is in an account you didn't import (external / a Zelle to a person).
  const transfers = useMemo(
    () => matchTransfers(transactions, withDerivedBalances(profile?.paymentAccounts || [], transactions)),
    [transactions, profile?.paymentAccounts]
  );
  const acctName = (id?: string) => profile?.paymentAccounts?.find(a => a.id === id)?.name || 'Untracked';
  const transferRoutes = useMemo(() => {
    const m = new Map<string, { from: string; to: string; total: number; count: number }>();
    transfers.pairs.forEach(p => {
      const key = `${p.fromAccountId}->${p.toAccountId}`;
      const r = m.get(key) || { from: acctName(p.fromAccountId), to: acctName(p.toAccountId), total: 0, count: 0 };
      r.total += p.amount; r.count += 1;
      m.set(key, r);
    });
    return [...m.values()].sort((a, b) => b.total - a.total);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transfers, profile?.paymentAccounts]);
  const unmatchedOutTotal = transfers.unmatchedOut.reduce((s, t) => s + t.amount, 0);
  const unmatchedInTotal = transfers.unmatchedIn.reduce((s, t) => s + t.amount, 0);
  const [showAccountModal, setShowAccountModal] = useState(false);
  const [showIncomeModal, setShowIncomeModal] = useState(false);
  const [editingAccount, setEditingAccount] = useState<PaymentAccount | null>(null);
  const [editingIncome, setEditingIncome] = useState<IncomeSource | null>(null);
  
  const [accountForm, setAccountForm] = useState({
    name: '',
    type: 'credit_card' as AccountType,
    provider: 'chase' as PaymentMethod,
    balance: '',
    creditLimit: '',
    apr: '',
    statementDate: '',
    dueDate: '',
    lastFourDigits: '',
    paymentFromAccountId: '', // Which checking account pays this card/loan
    // Loan specific
    originalAmount: '',
    monthlyPayment: '',
    loanTerm: '',
  });

  const [incomeForm, setIncomeForm] = useState({
    name: '',
    amount: '',
    frequency: 'monthly' as 'weekly' | 'biweekly' | 'monthly' | 'yearly',
    payDate: '',
  });

  const [budgetAmount, setBudgetAmount] = useState('');
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [deleteType, setDeleteType] = useState<'account' | 'income' | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      router.push('/login');
    }
  }, [isAuthenticated, authLoading, router]);

  useEffect(() => {
    if (profile?.monthlyBudget) {
      setBudgetAmount(profile.monthlyBudget.toString());
    }
  }, [profile?.monthlyBudget]);

  if (authLoading || profileLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse-glow w-16 h-16 rounded-2xl bg-gradient-to-br from-[var(--accent-primary)] to-[var(--accent-secondary)] flex items-center justify-center">
          <TrendingUp className="w-8 h-8 text-white" />
        </div>
      </div>
    );
  }

  const getAccountIcon = (type: AccountType) => {
    switch (type) {
      case 'credit_card':
      case 'debit_card':
        return <CreditCard className="w-5 h-5" />;
      case 'bank_account':
        return <Building2 className="w-5 h-5" />;
      case 'cash':
        return <Wallet className="w-5 h-5" />;
      case 'personal_loan':
        return <FileText className="w-5 h-5" />;
    }
  };

  const openEditAccount = (account: PaymentAccount) => {
    setEditingAccount(account);
    setAccountForm({
      name: account.name,
      type: account.type,
      provider: account.provider,
      balance: account.balance.toString(),
      creditLimit: account.creditLimit?.toString() || '',
      apr: account.apr?.toString() || '',
      statementDate: account.statementDate?.toString() || '',
      dueDate: account.dueDate?.toString() || '',
      lastFourDigits: account.lastFourDigits || '',
      paymentFromAccountId: account.paymentFromAccountId || '',
      originalAmount: account.originalAmount?.toString() || '',
      monthlyPayment: account.monthlyPayment?.toString() || '',
      loanTerm: account.loanTerm?.toString() || '',
    });
    setShowAccountModal(true);
  };

  const openEditIncome = (income: IncomeSource) => {
    setEditingIncome(income);
    setIncomeForm({
      name: income.name,
      amount: income.amount.toString(),
      frequency: income.frequency,
      payDate: income.payDate?.toString() || '',
    });
    setShowIncomeModal(true);
  };

  const handleSaveAccount = async () => {
    const providerInfo = PAYMENT_METHODS.find((p) => p.value === accountForm.provider);
    const isLoan = accountForm.type === 'personal_loan';
    const isCard = accountForm.type === 'credit_card';
    const needsPaymentSource = isCard || isLoan;
    
    const accountData = {
      name: accountForm.name,
      type: accountForm.type,
      provider: accountForm.provider,
      balance: parseFloat(accountForm.balance) || 0,
      creditLimit: isCard ? parseFloat(accountForm.creditLimit) || undefined : undefined,
      apr: (isCard || isLoan) ? parseFloat(accountForm.apr) || undefined : undefined,
      statementDate: isCard ? (accountForm.statementDate ? parseInt(accountForm.statementDate) : undefined) : undefined,
      dueDate: (isCard || isLoan) ? (accountForm.dueDate ? parseInt(accountForm.dueDate) : undefined) : undefined,
      lastFourDigits: accountForm.lastFourDigits || undefined,
      paymentFromAccountId: needsPaymentSource && accountForm.paymentFromAccountId ? accountForm.paymentFromAccountId : undefined,
      originalAmount: isLoan ? parseFloat(accountForm.originalAmount) || undefined : undefined,
      monthlyPayment: isLoan ? parseFloat(accountForm.monthlyPayment) || undefined : undefined,
      loanTerm: isLoan ? parseInt(accountForm.loanTerm) || undefined : undefined,
      color: isLoan ? '#f59e0b' : (providerInfo?.color || '#8b949e'),
      isActive: true,
    };

    if (editingAccount) {
      await updatePaymentAccount(editingAccount.id, accountData);
    } else {
      await addPaymentAccount(accountData);
    }

    resetAccountForm();
  };

  const handleSaveIncome = async () => {
    const incomeData = {
      name: incomeForm.name,
      amount: parseFloat(incomeForm.amount) || 0,
      frequency: incomeForm.frequency,
      payDate: incomeForm.payDate ? parseInt(incomeForm.payDate) : undefined,
      isActive: true,
    };

    if (editingIncome) {
      await updateIncomeSource(editingIncome.id, incomeData);
    } else {
      await addIncomeSource(incomeData);
    }

    resetIncomeForm();
  };

  const handleSaveBudget = async () => {
    await updateProfile({ monthlyBudget: parseFloat(budgetAmount) || 0 });
  };

  const resetAccountForm = () => {
    setAccountForm({
      name: '',
      type: 'credit_card',
      provider: 'chase',
      balance: '',
      creditLimit: '',
      apr: '',
      statementDate: '',
      dueDate: '',
      lastFourDigits: '',
      paymentFromAccountId: '',
      originalAmount: '',
      monthlyPayment: '',
      loanTerm: '',
    });
    setEditingAccount(null);
    setShowAccountModal(false);
  };

  const resetIncomeForm = () => {
    setIncomeForm({
      name: '',
      amount: '',
      frequency: 'monthly',
      payDate: '',
    });
    setEditingIncome(null);
    setShowIncomeModal(false);
  };

  const confirmDelete = (id: string, type: 'account' | 'income') => {
    setDeleteConfirmId(id);
    setDeleteType(type);
  };

  const handleDelete = async () => {
    if (!deleteConfirmId || !deleteType) return;
    
    setIsDeleting(true);
    try {
      if (deleteType === 'account') {
        await deletePaymentAccount(deleteConfirmId);
      } else {
        await deleteIncomeSource(deleteConfirmId);
      }
    } finally {
      setIsDeleting(false);
      setDeleteConfirmId(null);
      setDeleteType(null);
    }
  };

  const cancelDelete = () => {
    setDeleteConfirmId(null);
    setDeleteType(null);
  };

  const getItemToDelete = () => {
    if (!deleteConfirmId || !deleteType) return null;
    if (deleteType === 'account') {
      return profile?.paymentAccounts?.find(a => a.id === deleteConfirmId);
    }
    return profile?.incomeSources?.find(i => i.id === deleteConfirmId);
  };

  // Balances derived from linked transactions for every DISPLAY below. The edit form
  // still reads/writes account.balance as the OPENING balance (openEditAccount uses the
  // original account, not a derived copy), so the write path is unchanged.
  const derivedAccounts = withDerivedBalances(profile?.paymentAccounts || [], transactions);

  const totalCreditLimit = derivedAccounts
    .filter((a) => a.type === 'credit_card')
    .reduce((sum, a) => sum + (a.creditLimit || 0), 0);

  const totalCreditUsed = derivedAccounts
    .filter((a) => a.type === 'credit_card')
    .reduce((sum, a) => sum + a.balance, 0);

  const totalBankBalance = derivedAccounts
    .filter((a) => a.type === 'bank_account' || a.type === 'debit_card')
    .reduce((sum, a) => sum + a.balance, 0);

  const monthlyIncome = profile?.incomeSources?.reduce((sum, inc) => {
    const monthly = inc.frequency === 'yearly' ? inc.amount / 12 :
      inc.frequency === 'biweekly' ? inc.amount * 2 :
      inc.frequency === 'weekly' ? inc.amount * 4 : inc.amount;
    return sum + monthly;
  }, 0) || 0;

  return (
    <div className="min-h-screen relative">
      <div className="bg-pattern" />
      <Navbar />
      
      <main className="pt-24 pb-12 px-4 sm:px-6 lg:px-8 max-w-6xl mx-auto relative z-10">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-[var(--foreground)]">Account Settings</h1>
          <p className="text-[var(--foreground-secondary)] mt-1">
            Manage your payment accounts, income sources, and budget
          </p>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <div className="stat-card">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[var(--foreground-secondary)] text-sm">Bank Balance</span>
              <Building2 className="w-5 h-5 text-[var(--accent-secondary)]" />
            </div>
            <p className="text-2xl font-bold text-[var(--accent-success)]">
              ${totalBankBalance.toLocaleString()}
            </p>
          </div>
          <div className="stat-card">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[var(--foreground-secondary)] text-sm">Credit Used</span>
              <CreditCard className="w-5 h-5 text-[var(--accent-primary)]" />
            </div>
            <p className="text-2xl font-bold text-[var(--accent-danger)]">
              ${totalCreditUsed.toLocaleString()}
            </p>
            <p className="text-xs text-[var(--foreground-muted)]">
              of ${totalCreditLimit.toLocaleString()} limit
            </p>
          </div>
          <div className="stat-card">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[var(--foreground-secondary)] text-sm">Monthly Income</span>
              <Banknote className="w-5 h-5 text-[var(--accent-success)]" />
            </div>
            <p className="text-2xl font-bold text-[var(--accent-success)]">
              ${monthlyIncome.toLocaleString()}
            </p>
          </div>
          <div className="stat-card">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[var(--foreground-secondary)] text-sm">Monthly Budget</span>
              <DollarSign className="w-5 h-5 text-[var(--accent-warning)]" />
            </div>
            <p className="text-2xl font-bold text-[var(--foreground)]">
              ${(profile?.monthlyBudget || 0).toLocaleString()}
            </p>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex flex-wrap gap-2 mb-6 scroll-x-mobile">
          {[
            { key: 'accounts', label: 'Accounts', fullLabel: 'Payment Accounts', icon: CreditCard },
            { key: 'spending', label: 'Spending', fullLabel: 'Account Spending', icon: Receipt },
            { key: 'transfers', label: 'Transfers', fullLabel: 'Transfers', icon: ArrowLeftRight },
            { key: 'income', label: 'Income', fullLabel: 'Income Sources', icon: Banknote },
            { key: 'budget', label: 'Budget', fullLabel: 'Monthly Budget', icon: DollarSign },
            { key: 'budgets', label: 'Categories', fullLabel: 'Category Budgets', icon: BarChart3 },
            { key: 'debt', label: 'Debt Plan', fullLabel: 'Debt Planner', icon: TrendingUp },
          ].map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key as any)}
                className={`flex items-center gap-2 px-3 sm:px-4 py-2 rounded-lg font-medium transition-all text-sm sm:text-base ${
                  activeTab === tab.key
                    ? 'bg-[var(--accent-primary)] text-[#16181c]'
                    : 'bg-[var(--background-tertiary)] text-[var(--foreground-secondary)] hover:text-[var(--foreground)]'
                }`}
              >
                <Icon className="w-4 h-4" />
                <span className="sm:hidden">{tab.label}</span>
                <span className="hidden sm:inline">{tab.fullLabel}</span>
              </button>
            );
          })}
        </div>

        {/* Tab Content */}
        <div className="glass-card p-6">
          {/* Accounts Tab */}
          {activeTab === 'accounts' && (
            <div>
              <div className="flex justify-between items-center mb-6">
                <h2 className="text-xl font-semibold text-[var(--foreground)]">
                  Payment Accounts ({profile?.paymentAccounts?.length || 0})
                </h2>
                <button
                  onClick={() => setShowAccountModal(true)}
                  className="btn-primary flex items-center gap-2"
                >
                  <Plus className="w-4 h-4" />
                  Add Account
                </button>
              </div>

              {profile?.paymentAccounts && profile.paymentAccounts.length > 0 ? (
                <AccountsList
                  accounts={profile.paymentAccounts}
                  onReorder={reorderPaymentAccounts}
                  renderRow={(account) => (
                    <div
                      className="flex items-center justify-between p-4 rounded-xl bg-[var(--background-tertiary)] border-l-4 hover:bg-[var(--background-secondary)] transition-colors"
                      style={{ borderLeftColor: account.color }}
                    >
                      <div className="flex items-center gap-4">
                        <div
                          className="w-12 h-12 rounded-xl flex items-center justify-center"
                          style={{ backgroundColor: `${account.color}20`, color: account.color }}
                        >
                          {getAccountIcon(account.type)}
                        </div>
                        <div>
                          <p className="font-medium text-[var(--foreground)]">
                            {account.name}
                            {account.lastFourDigits && (
                              <span className="text-[var(--foreground-muted)]"> •••• {account.lastFourDigits}</span>
                            )}
                          </p>
                          <p className="text-sm text-[var(--foreground-secondary)]">
                            {PAYMENT_METHODS.find((m) => m.value === account.provider)?.label} • {ACCOUNT_TYPES.find((t) => t.value === account.type)?.label}
                          </p>
                          {account.type === 'credit_card' && (
                            <p className="text-xs text-[var(--foreground-muted)]">
                              {account.apr && `APR: ${account.apr}%`}
                              {account.apr && (account.statementDate || account.dueDate) && ' • '}
                              {account.statementDate && `Statement: ${account.statementDate}th`}
                              {account.statementDate && account.dueDate && ' • '}
                              {account.dueDate && `Due: ${account.dueDate}th`}
                            </p>
                          )}
                          {/* Show linked payment account */}
                          {(account.type === 'credit_card' || account.type === 'personal_loan') && account.paymentFromAccountId && (
                            <p className="text-xs text-[var(--accent-primary)] flex items-center gap-1 mt-1">
                              <Building2 className="w-3 h-3" />
                              Paid from: {profile?.paymentAccounts?.find(a => a.id === account.paymentFromAccountId)?.name || 'Unknown'}
                            </p>
                          )}
                          {(account.type === 'credit_card' || account.type === 'personal_loan') && !account.paymentFromAccountId && (
                            <p className="text-xs text-amber-500 flex items-center gap-1 mt-1">
                              <AlertCircle className="w-3 h-3" />
                              No payment account linked
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-4">
                        <div className="text-right">
                          {/* The balance YOU set is the truth (the CSV has no balance). */}
                          <p className={`text-lg font-semibold ${account.type === 'credit_card' || account.type === 'personal_loan' ? 'text-[var(--accent-danger)]' : 'text-[var(--accent-success)]'}`}>
                            {account.type === 'credit_card' || account.type === 'personal_loan' ? '-' : ''}${Math.abs(account.balance).toLocaleString()}
                          </p>
                          {(() => {
                            const est = deriveAccountBalance(account, transactions);
                            return Math.round(est) !== Math.round(account.balance) ? (
                              <button
                                onClick={() => updatePaymentAccount(account.id, { balance: est })}
                                className="text-xs text-[var(--accent-primary)] hover:underline"
                                title="Set the balance to the value estimated from transactions (edit the account to enter your real balance instead)"
                              >
                                set ≈ ${Math.abs(est).toLocaleString()} from txns
                              </button>
                            ) : null;
                          })()}
                          {account.creditLimit && (
                            <p className="text-xs text-[var(--foreground-muted)]">
                              Limit: ${account.creditLimit.toLocaleString()}
                            </p>
                          )}
                        </div>
                        <div className="flex gap-1">
                          <button
                            onClick={() => openEditAccount(account)}
                            className="p-2 rounded-lg text-[var(--foreground-muted)] hover:text-[var(--accent-primary)] hover:bg-[var(--accent-primary)]/10 transition-colors"
                          >
                            <Edit3 className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => confirmDelete(account.id, 'account')}
                            className="p-2 rounded-lg text-[var(--foreground-muted)] hover:text-[var(--accent-danger)] hover:bg-[var(--accent-danger)]/10 transition-colors"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                />
              ) : (
                <div className="text-center py-12">
                  <CreditCard className="w-16 h-16 text-[var(--foreground-muted)] mx-auto mb-4" />
                  <h3 className="text-lg font-medium text-[var(--foreground)] mb-2">No accounts yet</h3>
                  <p className="text-[var(--foreground-secondary)] mb-4">Add your credit cards and bank accounts to track spending</p>
                  <button onClick={() => setShowAccountModal(true)} className="btn-primary">
                    Add Your First Account
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Spending Tab - Transactions by Account */}
          {activeTab === 'spending' && (
            <div>
              <div className="flex justify-between items-center mb-6">
                <div>
                  <h2 className="text-xl font-semibold text-[var(--foreground)]">
                    Account Spending
                  </h2>
                  <p className="text-sm text-[var(--foreground-muted)]">
                    See transactions linked to each account
                  </p>
                </div>
              </div>

              {profile?.paymentAccounts && profile.paymentAccounts.length > 0 ? (
                <div className="space-y-4">
                  {derivedAccounts.map((account) => (
                    <AccountTransactions
                      key={account.id}
                      account={account}
                      transactions={transactions}
                    />
                  ))}
                  
                  {/* Unlinked Transactions */}
                  {(() => {
                    const unlinkedTxns = transactions.filter(t => !t.accountId);
                    if (unlinkedTxns.length === 0) return null;
                    
                    return (
                      <div className="bg-[var(--background-secondary)] border border-[var(--border-color)] rounded-xl p-6">
                        <div className="flex items-center gap-3 mb-4">
                          <div className="w-12 h-12 rounded-xl flex items-center justify-center bg-gray-500/20 text-gray-400">
                            <Receipt className="w-5 h-5" />
                          </div>
                          <div>
                            <p className="font-medium text-[var(--foreground)]">Unlinked Transactions</p>
                            <p className="text-sm text-[var(--foreground-muted)]">
                              {unlinkedTxns.length} transaction{unlinkedTxns.length !== 1 ? 's' : ''} without account
                            </p>
                          </div>
                        </div>
                        <p className="text-sm text-[var(--foreground-secondary)]">
                          These transactions are not linked to any payment account. 
                          Select an account when adding transactions to track spending per card/account.
                        </p>
                      </div>
                    );
                  })()}
                </div>
              ) : (
                <div className="text-center py-12">
                  <CreditCard className="w-16 h-16 text-[var(--foreground-muted)] mx-auto mb-4" />
                  <h3 className="text-lg font-medium text-[var(--foreground)] mb-2">No accounts yet</h3>
                  <p className="text-[var(--foreground-secondary)] mb-4">
                    Add your credit cards and bank accounts to track spending per account
                  </p>
                  <button onClick={() => setActiveTab('accounts')} className="btn-primary">
                    Add Accounts
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Transfers Tab — paired internal movements + unmatched review */}
          {activeTab === 'transfers' && (
            <div>
              <div className="mb-6">
                <h2 className="text-xl font-semibold text-[var(--foreground)]">Transfers between your accounts</h2>
                <p className="text-sm text-[var(--foreground-secondary)] mt-1">
                  Each leg leaving one account is matched to the leg arriving in another. Matched
                  moves net to zero and are excluded from income and expenses — money changing
                  pockets, not coming in or going out.
                </p>
              </div>

              {/* Summary */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
                <div className="stat-card">
                  <p className="text-sm text-[var(--foreground-secondary)] mb-1">Matched (net zero)</p>
                  <p className="text-2xl font-bold text-[var(--foreground)]">
                    ${transfers.matchedTotal.toLocaleString('en-US', { maximumFractionDigits: 0 })}
                  </p>
                  <p className="text-xs text-[var(--foreground-muted)]">{transfers.pairs.length} paired moves</p>
                </div>
                <div className="stat-card">
                  <p className="text-sm text-[var(--foreground-secondary)] mb-1">Left to untracked</p>
                  <p className="text-2xl font-bold text-[var(--accent-danger)]">
                    ${unmatchedOutTotal.toLocaleString('en-US', { maximumFractionDigits: 0 })}
                  </p>
                  <p className="text-xs text-[var(--foreground-muted)]">{transfers.unmatchedOut.length} unmatched out</p>
                </div>
                <div className="stat-card">
                  <p className="text-sm text-[var(--foreground-secondary)] mb-1">Arrived from untracked</p>
                  <p className="text-2xl font-bold text-[var(--accent-success)]">
                    ${unmatchedInTotal.toLocaleString('en-US', { maximumFractionDigits: 0 })}
                  </p>
                  <p className="text-xs text-[var(--foreground-muted)]">{transfers.unmatchedIn.length} unmatched in</p>
                </div>
              </div>

              {/* Matched routes */}
              {transferRoutes.length > 0 ? (
                <div className="glass-card divide-y divide-[var(--border-color)] mb-6">
                  {transferRoutes.map((r, i) => (
                    <div key={i} className="flex items-center justify-between p-4">
                      <div className="flex items-center gap-2 text-[var(--foreground)]">
                        <span className="font-medium">{r.from}</span>
                        <ArrowLeftRight className="w-4 h-4 text-[var(--accent-primary)]" />
                        <span className="font-medium">{r.to}</span>
                      </div>
                      <div className="text-right">
                        <p className="font-semibold text-[var(--foreground)]">
                          ${r.total.toLocaleString('en-US', { maximumFractionDigits: 0 })}
                        </p>
                        <p className="text-xs text-[var(--foreground-muted)]">{r.count} moves</p>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-12 bg-[var(--background-secondary)] rounded-xl border border-[var(--border-color)] mb-6">
                  <ArrowLeftRight className="w-12 h-12 mx-auto mb-3 text-[var(--foreground-muted)]" />
                  <p className="text-[var(--foreground-secondary)]">
                    No matched transfers yet. Import your accounts — moves between two imported
                    accounts pair up here automatically.
                  </p>
                </div>
              )}

              {/* Unmatched review */}
              {(transfers.unmatchedOut.length > 0 || transfers.unmatchedIn.length > 0) && (
                <div className="glass-card p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <AlertTriangle className="w-4 h-4 text-amber-500" />
                    <span className="font-medium text-[var(--foreground)]">Needs a look — unmatched legs</span>
                  </div>
                  <p className="text-sm text-[var(--foreground-secondary)] mb-3">
                    The other side of these is in an account you didn&apos;t import (external savings,
                    a Zelle to a person, a loan servicer) — so they may be real money in/out, or a
                    mislabel to reclassify.
                  </p>
                  <div className="max-h-[280px] overflow-y-auto divide-y divide-[var(--border-color)]">
                    {[...transfers.unmatchedOut.map(t => ({ t, dir: 'out' as const })),
                      ...transfers.unmatchedIn.map(t => ({ t, dir: 'in' as const }))]
                      .sort((a, b) => b.t.date.localeCompare(a.t.date))
                      .slice(0, 40)
                      .map(({ t, dir }) => (
                        <div key={t.id} className="flex items-center justify-between py-2 text-sm">
                          <div>
                            <span className="text-[var(--foreground)]">{t.title}</span>
                            <span className="text-[var(--foreground-muted)]"> · {acctName(t.accountId)}</span>
                          </div>
                          <span className={dir === 'in' ? 'text-emerald-500' : 'text-[var(--accent-danger)]'}>
                            {dir === 'in' ? '+' : '-'}${t.amount.toLocaleString()}
                          </span>
                        </div>
                      ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Income Tab */}
          {activeTab === 'income' && (
            <div>
              <div className="flex justify-between items-center mb-6">
                <h2 className="text-xl font-semibold text-[var(--foreground)]">
                  Income Sources ({profile?.incomeSources?.length || 0})
                </h2>
                <button
                  onClick={() => setShowIncomeModal(true)}
                  className="btn-primary flex items-center gap-2"
                >
                  <Plus className="w-4 h-4" />
                  Add Income
                </button>
              </div>

              {profile?.incomeSources && profile.incomeSources.length > 0 ? (
                <div className="space-y-3">
                  {profile.incomeSources.map((income) => (
                    <div
                      key={income.id}
                      className="flex items-center justify-between p-4 rounded-xl bg-[var(--background-tertiary)] border-l-4 border-l-[var(--accent-success)] hover:bg-[var(--background-secondary)] transition-colors"
                    >
                      <div className="flex items-center gap-4">
                        <div className="w-12 h-12 rounded-xl flex items-center justify-center bg-[var(--accent-success)]/20 text-[var(--accent-success)]">
                          <Banknote className="w-5 h-5" />
                        </div>
                        <div>
                          <p className="font-medium text-[var(--foreground)]">{income.name}</p>
                          <p className="text-sm text-[var(--foreground-secondary)]">
                            {income.frequency.charAt(0).toUpperCase() + income.frequency.slice(1)}
                            {income.payDate && ` • Pay day: ${income.payDate}${getOrdinalSuffix(income.payDate)}`}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-4">
                        <p className="text-lg font-semibold text-[var(--accent-success)]">
                          +${income.amount.toLocaleString()}
                        </p>
                        <div className="flex gap-1">
                          <button
                            onClick={() => openEditIncome(income)}
                            className="p-2 rounded-lg text-[var(--foreground-muted)] hover:text-[var(--accent-primary)] hover:bg-[var(--accent-primary)]/10 transition-colors"
                          >
                            <Edit3 className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => confirmDelete(income.id, 'income')}
                            className="p-2 rounded-lg text-[var(--foreground-muted)] hover:text-[var(--accent-danger)] hover:bg-[var(--accent-danger)]/10 transition-colors"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-12">
                  <Banknote className="w-16 h-16 text-[var(--foreground-muted)] mx-auto mb-4" />
                  <h3 className="text-lg font-medium text-[var(--foreground)] mb-2">No income sources yet</h3>
                  <p className="text-[var(--foreground-secondary)] mb-4">Add your salary and other income to forecast cash flow</p>
                  <button onClick={() => setShowIncomeModal(true)} className="btn-primary">
                    Add Your First Income
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Budget Tab */}
          {activeTab === 'budget' && (
            <div>
              <h2 className="text-xl font-semibold text-[var(--foreground)] mb-6">
                Monthly Budget
              </h2>

              <div className="max-w-md">
                <div className="p-6 rounded-xl bg-[var(--background-tertiary)] mb-6">
                  <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
                    Target Monthly Spending
                  </label>
                  <div className="relative">
                    <DollarSign className="absolute left-[1.1rem] top-1/2 -translate-y-1/2 w-6 h-6 text-[var(--foreground-muted)]" />
                    <input
                      type="number"
                      value={budgetAmount}
                      onChange={(e) => setBudgetAmount(e.target.value)}
                      placeholder="3000"
                      className="input-field pl-[3.5rem] text-xl font-bold"
                    />
                  </div>
                </div>

                <button onClick={handleSaveBudget} className="btn-primary w-full">
                  Save Budget
                </button>

                {monthlyIncome > 0 && (
                  <div className="mt-6 p-4 rounded-xl bg-[var(--accent-success)]/10 border border-[var(--accent-success)]/30">
                    <p className="text-sm text-[var(--foreground-secondary)] mb-1">Monthly Income</p>
                    <p className="text-xl font-bold text-[var(--accent-success)]">${monthlyIncome.toLocaleString()}</p>
                    {parseFloat(budgetAmount) > 0 && (
                      <p className="text-sm text-[var(--foreground-secondary)] mt-2">
                        Savings potential: ${(monthlyIncome - parseFloat(budgetAmount)).toLocaleString()}/month
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Category Budgets Tab */}
          {activeTab === 'budgets' && (
            <div>
              <div className="flex justify-between items-start mb-6">
                <div>
                  <h2 className="text-xl font-semibold text-[var(--foreground)]">
                    Category Budgets
                  </h2>
                  <p className="text-sm text-[var(--foreground-muted)] mt-1">
                    Set spending limits for each category to track and control expenses
                  </p>
                </div>
              </div>

              {/* Current Status */}
              {profile?.settings?.categoryBudgets && profile.settings.categoryBudgets.length > 0 && (
                <div className="mb-6">
                  <h3 className="text-sm font-medium text-[var(--foreground-muted)] uppercase tracking-wide mb-3">
                    Current Month Status
                  </h3>
                  <BudgetStatusPanel
                    budgets={profile.settings.categoryBudgets}
                    transactions={transactions}
                    compact={false}
                  />
                </div>
              )}

              {/* Budget Settings */}
              <div className="border-t border-[var(--border-color)] pt-6">
                <h3 className="text-sm font-medium text-[var(--foreground-muted)] uppercase tracking-wide mb-3">
                  Set Category Limits
                </h3>
                <BudgetSettingsPanel
                  budgets={profile?.settings?.categoryBudgets || []}
                  monthlyIncome={monthlyIncome}
                  onSave={async (budgets: CategoryBudget[]) => {
                    await updateProfile({
                      settings: {
                        ...profile?.settings,
                        categoryBudgets: budgets,
                      },
                    });
                  }}
                />
              </div>
            </div>
          )}

          {/* Debt Planner Tab */}
          {activeTab === 'debt' && (
            <div>
              <div className="flex justify-between items-start mb-6">
                <div>
                  <h2 className="text-xl font-semibold text-[var(--foreground)]">
                    Debt Payoff Planner
                  </h2>
                  <p className="text-sm text-[var(--foreground-muted)] mt-1">
                    Create a strategic plan to pay off credit cards and loans faster
                  </p>
                </div>
              </div>

              <DebtPlannerPanel
                accounts={derivedAccounts}
                currentCash={totalBankBalance}
              />
            </div>
          )}
        </div>
      </main>

      {/* Account Modal */}
      {showAccountModal && (
        <div className="modal-overlay" onClick={resetAccountForm}>
          <div className="modal-content max-w-lg" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-bold text-[var(--foreground)]">
                {editingAccount ? 'Edit Account' : 'Add Account'}
              </h2>
              <button onClick={resetAccountForm} className="p-2 rounded-lg text-[var(--foreground-muted)] hover:bg-[var(--background-tertiary)]">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">Account Name</label>
                  <input
                    type="text"
                    value={accountForm.name}
                    onChange={(e) => setAccountForm({ ...accountForm, name: e.target.value })}
                    placeholder="e.g., Chase Sapphire"
                    className="input-field"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">Last 4 Digits</label>
                  <input
                    type="text"
                    value={accountForm.lastFourDigits}
                    onChange={(e) => setAccountForm({ ...accountForm, lastFourDigits: e.target.value.slice(0, 4) })}
                    placeholder="1234"
                    maxLength={4}
                    className="input-field"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">Type</label>
                  <select
                    value={accountForm.type}
                    onChange={(e) => setAccountForm({ ...accountForm, type: e.target.value as AccountType })}
                    className="select-field"
                  >
                    {ACCOUNT_TYPES.map((type) => (
                      <option key={type.value} value={type.value}>{type.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">Provider</label>
                  <select
                    value={accountForm.provider}
                    onChange={(e) => setAccountForm({ ...accountForm, provider: e.target.value as PaymentMethod })}
                    className="select-field"
                  >
                    {PAYMENT_METHODS.map((method) => (
                      <option key={method.value} value={method.value}>{method.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">Current Balance</label>
                  <div className="relative">
                    <DollarSign className="absolute left-[1.1rem] top-1/2 -translate-y-1/2 w-5 h-5 text-[var(--foreground-muted)]" />
                    <input
                      type="number"
                      value={accountForm.balance}
                      onChange={(e) => setAccountForm({ ...accountForm, balance: e.target.value })}
                      placeholder="0.00"
                      className="input-field pl-[3.25rem]"
                    />
                  </div>
                </div>
                {accountForm.type === 'credit_card' && (
                  <div>
                    <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">Credit Limit</label>
                    <div className="relative">
                      <DollarSign className="absolute left-[1.1rem] top-1/2 -translate-y-1/2 w-5 h-5 text-[var(--foreground-muted)]" />
                      <input
                        type="number"
                        value={accountForm.creditLimit}
                        onChange={(e) => setAccountForm({ ...accountForm, creditLimit: e.target.value })}
                        placeholder="5000"
                        className="input-field pl-[3.25rem]"
                      />
                    </div>
                  </div>
                )}
              </div>

              {accountForm.type === 'credit_card' && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">APR (%)</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      max="100"
                      value={accountForm.apr}
                      onChange={(e) => setAccountForm({ ...accountForm, apr: e.target.value })}
                      placeholder="24.99"
                      className="input-field"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">Statement Date</label>
                      <input
                        type="number"
                        min="1"
                        max="31"
                        value={accountForm.statementDate}
                        onChange={(e) => setAccountForm({ ...accountForm, statementDate: e.target.value })}
                        placeholder="15"
                        className="input-field"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">Due Date</label>
                      <input
                        type="number"
                        min="1"
                        max="31"
                        value={accountForm.dueDate}
                        onChange={(e) => setAccountForm({ ...accountForm, dueDate: e.target.value })}
                        placeholder="5"
                        className="input-field"
                      />
                    </div>
                  </div>
                </>
              )}

              {/* Payment Source Account (for credit cards and loans) */}
              {(accountForm.type === 'credit_card' || accountForm.type === 'personal_loan') && (
                <div className="p-4 rounded-lg bg-[var(--accent-primary)]/5 border border-[var(--accent-primary)]/20">
                  <label className="block text-sm font-medium text-[var(--foreground)] mb-2">
                    Pay this {accountForm.type === 'credit_card' ? 'card' : 'loan'} from:
                  </label>
                  <select
                    value={accountForm.paymentFromAccountId}
                    onChange={(e) => setAccountForm({ ...accountForm, paymentFromAccountId: e.target.value })}
                    className="input-field"
                  >
                    <option value="">Select checking account...</option>
                    {profile?.paymentAccounts
                      ?.filter(a => a.type === 'bank_account' || a.type === 'debit_card')
                      .filter(a => a.id !== editingAccount?.id)
                      .map(account => (
                        <option key={account.id} value={account.id}>
                          {account.name} {account.lastFourDigits ? `(•${account.lastFourDigits})` : ''}
                        </option>
                      ))
                    }
                  </select>
                  <p className="text-xs text-[var(--foreground-muted)] mt-2">
                    This links payments to your forecast. When this {accountForm.type === 'credit_card' ? 'card' : 'loan'} is due, 
                    the payment will show in your checking account forecast.
                  </p>
                </div>
              )}

              <button
                onClick={handleSaveAccount}
                disabled={!accountForm.name}
                className="btn-primary w-full disabled:opacity-50"
              >
                {editingAccount ? 'Update Account' : 'Add Account'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Income Modal */}
      {showIncomeModal && (
        <div className="modal-overlay" onClick={resetIncomeForm}>
          <div className="modal-content max-w-lg" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-bold text-[var(--foreground)]">
                {editingIncome ? 'Edit Income' : 'Add Income'}
              </h2>
              <button onClick={resetIncomeForm} className="p-2 rounded-lg text-[var(--foreground-muted)] hover:bg-[var(--background-tertiary)]">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">Income Name</label>
                <input
                  type="text"
                  value={incomeForm.name}
                  onChange={(e) => setIncomeForm({ ...incomeForm, name: e.target.value })}
                  placeholder="e.g., Salary, Freelance"
                  className="input-field"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">Amount</label>
                  <div className="relative">
                    <DollarSign className="absolute left-[1.1rem] top-1/2 -translate-y-1/2 w-5 h-5 text-[var(--foreground-muted)]" />
                    <input
                      type="number"
                      value={incomeForm.amount}
                      onChange={(e) => setIncomeForm({ ...incomeForm, amount: e.target.value })}
                      placeholder="5000"
                      className="input-field pl-[3.25rem]"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">Frequency</label>
                  <select
                    value={incomeForm.frequency}
                    onChange={(e) => setIncomeForm({ ...incomeForm, frequency: e.target.value as any })}
                    className="select-field"
                  >
                    <option value="weekly">Weekly</option>
                    <option value="biweekly">Bi-weekly</option>
                    <option value="monthly">Monthly</option>
                    <option value="yearly">Yearly</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">Pay Date (Day of Month)</label>
                <input
                  type="number"
                  min="1"
                  max="31"
                  value={incomeForm.payDate}
                  onChange={(e) => setIncomeForm({ ...incomeForm, payDate: e.target.value })}
                  placeholder="1"
                  className="input-field"
                />
              </div>

              <button
                onClick={handleSaveIncome}
                disabled={!incomeForm.name || !incomeForm.amount}
                className="btn-primary w-full disabled:opacity-50"
              >
                {editingIncome ? 'Update Income' : 'Add Income'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteConfirmId && deleteType && (
        <div className="modal-overlay" onClick={cancelDelete}>
          <div className="delete-confirm-modal" onClick={(e) => e.stopPropagation()}>
            <Trash2 className="w-12 h-12 text-[var(--accent-danger)] mx-auto mb-4" />
            <h3 className="text-xl font-bold text-[var(--foreground)] mb-2">
              Delete {deleteType === 'account' ? 'Account' : 'Income Source'}?
            </h3>
            <p className="text-[var(--foreground-secondary)] mb-6">
              Are you sure you want to delete &quot;{getItemToDelete()?.name}&quot;? This action cannot be undone.
            </p>
            <div className="flex gap-3">
              <button
                onClick={cancelDelete}
                className="btn-secondary flex-1"
                disabled={isDeleting}
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                className="btn-danger flex-1 flex items-center justify-center gap-2"
                disabled={isDeleting}
              >
                {isDeleting ? (
                  <>
                    <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                    Deleting...
                  </>
                ) : (
                  <>
                    <Trash2 className="w-4 h-4" />
                    Delete
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function getOrdinalSuffix(day: number): string {
  if (day > 3 && day < 21) return 'th';
  switch (day % 10) {
    case 1: return 'st';
    case 2: return 'nd';
    case 3: return 'rd';
    default: return 'th';
  }
}

