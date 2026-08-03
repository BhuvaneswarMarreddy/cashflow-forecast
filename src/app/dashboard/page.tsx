'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { useTransactions } from '@/context/TransactionContext';
import { useUserProfile } from '@/context/UserProfileContext';
import Navbar from '@/components/Navbar';
import AddTransactionModal from '@/components/AddTransactionModal';
import ChartSrTable from '@/components/ChartSrTable';
import { PAYMENT_METHODS, EXPENSE_CATEGORIES, AccountType } from '@/types';
import { isPositive, sumExpenseCents } from '@/lib/classify';
import {
  TrendingUp,
  TrendingDown,
  DollarSign,
  Plus,
  ArrowUpRight,
  ArrowDownRight,
  CreditCard,
  Calendar,
  Filter,
  ChevronRight,
  Building2,
  Wallet,
  Banknote,
  AlertCircle,
  Clock,
  FileText,
  Settings,
  ArrowRight,
  LineChart as LineChartIcon,
  Shield,
} from 'lucide-react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  LineChart,
  Line,
  Legend,
} from 'recharts';
import { format, parseISO, isAfter, startOfDay, addDays, isWithinInterval, startOfMonth, endOfMonth } from 'date-fns';
import { generateForecast, calculateCurrentCash, withDerivedBalances, monthlyAverages } from '@/lib/forecast';
import { currentOf } from '@/lib/accounts';

export default function DashboardPage() {
  const { isAuthenticated, isLoading: authLoading, user } = useAuth();
  const {
    transactions,
    isLoading: txnLoading,
    getTotalByPaymentMethod,
    getTotalByCategory,
    getMonthlyTotals,
    getPastTransactions,
    getFutureTransactions,
  } = useTransactions();
  const { profile, isLoading: profileLoading, isOnboarded, incomeContext } = useUserProfile();
  const router = useRouter();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [filter, setFilter] = useState<'all' | 'past' | 'future'>('all');

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      router.push('/login');
    }
  }, [isAuthenticated, authLoading, router]);

  useEffect(() => {
    if (!authLoading && !profileLoading && isAuthenticated && !isOnboarded) {
      router.push('/onboarding');
    }
  }, [isAuthenticated, isOnboarded, authLoading, profileLoading, router]);

  // Only show full loading screen if auth is loading
  // For profile/transactions, we show the UI immediately with localStorage data
  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="bg-pattern" />
        <div className="animate-pulse-glow w-16 h-16 rounded-2xl bg-gradient-to-br from-[var(--accent-primary)] to-[var(--accent-secondary)] flex items-center justify-center">
          <TrendingUp className="w-8 h-8 text-white" />
        </div>
      </div>
    );
  }

  if (!isAuthenticated) return null;

  const today = startOfDay(new Date());
  
  const pastTransactions = getPastTransactions();
  const futureTransactions = getFutureTransactions();
  
  // Scoped to THIS MONTH because it is compared against profile.monthlyBudget below.
  // Summing every past expense ever worked only while all data was hand-entered;
  // importing a year of history made "Budget Remaining" a six-figure negative.
  // Spending goes through the SHARED classifier (raw t.type charged a credit-card
  // payment to the budget as if it were a purchase, on top of the purchases it paid
  // for). PENDING: EXCLUDED — a hold is not settled spending and often posts at a
  // different amount, so it must not eat this month's budget twice.
  const pastExpenses = sumExpenseCents(
    pastTransactions.filter((t) =>
      isWithinInterval(parseISO(t.date), {
        start: startOfMonth(new Date()),
        end: endOfMonth(new Date()),
      })
    ),
    profile?.paymentAccounts,
    incomeContext
  ) / 100;
  

  const paymentMethodTotals = getTotalByPaymentMethod(profile?.paymentAccounts);
  const categoryTotals = getTotalByCategory(profile?.paymentAccounts);
  const monthlyTotals = getMonthlyTotals(profile?.paymentAccounts);

  // Balances are derived from linked transactions (opening balance + past effects),
  // so every card/total/forecast below reflects reality, not the stored opening figure.
  const derivedAccounts = withDerivedBalances(profile?.paymentAccounts || [], transactions);

  // Calculate account summaries
  const totalBankBalance = derivedAccounts
    .filter((a) => a.type === 'bank_account' || a.type === 'debit_card' || a.type === 'cash')
    .reduce((sum, a) => sum + currentOf(a), 0);

  const totalCreditUsed = derivedAccounts
    .filter((a) => a.type === 'credit_card')
    .reduce((sum, a) => sum + currentOf(a), 0);

  const totalCreditLimit = derivedAccounts
    .filter((a) => a.type === 'credit_card')
    .reduce((sum, a) => sum + (a.creditLimit || 0), 0);

  const totalLoanBalance = derivedAccounts
    .filter((a) => a.type === 'personal_loan')
    .reduce((sum, a) => sum + currentOf(a), 0);

  const totalMonthlyLoanPayments = derivedAccounts
    .filter((a) => a.type === 'personal_loan')
    .reduce((sum, a) => sum + (a.monthlyPayment || 0), 0);

  // ACTIVE sources only — a paused source is still stored (so it can be resumed) but
  // must not be claimed as income.
  const incomeFromSources = profile?.incomeSources?.filter((i) => i.isActive).reduce((sum, inc) => {
    const monthly = inc.frequency === 'yearly' ? inc.amount / 12 :
      inc.frequency === 'biweekly' ? inc.amount * 26 / 12 :
      inc.frequency === 'weekly' ? inc.amount * 52 / 12 : inc.amount;
    return sum + monthly;
  }, 0) || 0;
  // Fall back to a figure DERIVED from the last 6 months of transactions when the user
  // hasn't hand-entered income sources / a budget — so these never show a bare $0.
  const derivedMonthly = monthlyAverages(transactions, derivedAccounts, 6, incomeContext);
  const monthlyIncome = incomeFromSources > 0 ? incomeFromSources : derivedMonthly.income;
  const effectiveBudget = (profile?.monthlyBudget || 0) > 0 ? profile!.monthlyBudget! : derivedMonthly.spending;
  const budgetIsDerived = !((profile?.monthlyBudget || 0) > 0) && effectiveBudget > 0;
  const netWorth = totalBankBalance - totalCreditUsed - totalLoanBalance;
  const creditUtilization = totalCreditLimit > 0 ? Math.round((totalCreditUsed / totalCreditLimit) * 100) : 0;

  // Check if setup is incomplete
  const hasAccounts = (profile?.paymentAccounts?.length || 0) > 0;
  const hasIncome = (profile?.incomeSources?.length || 0) > 0;
  const hasBudget = (profile?.monthlyBudget || 0) > 0;
  const setupIncomplete = !hasAccounts || !hasIncome || !hasBudget;

  // Generate forecast for quick summary
  const forecast = profile ? generateForecast(
    calculateCurrentCash(derivedAccounts),
    derivedAccounts,
    profile?.incomeSources || [],
    transactions,
    profile?.settings?.safetyThreshold || 500,
    90
  ) : null;

  // Get upcoming bill due dates
  const getUpcomingBills = () => {
    if (!profile?.paymentAccounts) return [];

    const currentDay = new Date().getDate();
    const currentMonth = new Date().getMonth();
    const currentYear = new Date().getFullYear();

    return derivedAccounts
      .filter((a) => a.type === 'credit_card' && a.dueDate && currentOf(a) > 0)
      .map((account) => {
        let dueDate = new Date(currentYear, currentMonth, account.dueDate!);
        
        // If due date has passed this month, move to next month
        if (account.dueDate! < currentDay) {
          dueDate = new Date(currentYear, currentMonth + 1, account.dueDate!);
        }
        
        const daysUntilDue = Math.ceil((dueDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
        
        return {
          ...account,
          dueDate: dueDate,
          daysUntilDue,
        };
      })
      .sort((a, b) => a.daysUntilDue - b.daysUntilDue);
  };

  const upcomingBills = getUpcomingBills();

  // Prepare chart data
  const pieChartData = paymentMethodTotals.map((pm) => {
    const methodInfo = PAYMENT_METHODS.find((m) => m.value === pm.method);
    return {
      name: methodInfo?.label || pm.method,
      value: pm.total,
      color: methodInfo?.color || '#8b949e',
    };
  });

  const categoryChartData = categoryTotals
    .sort((a, b) => b.total - a.total)
    .slice(0, 6)
    .map((cat) => {
      const catInfo = EXPENSE_CATEGORIES.find((c) => c.value === cat.category);
      return {
        name: catInfo?.label || cat.category,
        total: cat.total,
        icon: catInfo?.icon || '📋',
      };
    });

  const monthlyChartData = monthlyTotals.map((m) => ({
    month: format(new Date(m.month + '-01'), 'MMM yyyy'),
    income: m.income,
    expenses: m.expenses,
  }));

  // Headline figures for the charts' aria-labels (text alternative, not new math)
  const latestMonth = monthlyChartData[monthlyChartData.length - 1];
  const pieTotal = pieChartData.reduce((sum, d) => sum + d.value, 0);

  // Filter transactions for the list
  const getFilteredTransactions = () => {
    let filtered = transactions;
    if (filter === 'past') {
      filtered = pastTransactions;
    } else if (filter === 'future') {
      filtered = futureTransactions;
    }
    return filtered.sort((a, b) => 
      new Date(b.date).getTime() - new Date(a.date).getTime()
    ).slice(0, 8);
  };

  const recentTransactions = getFilteredTransactions();

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

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-[var(--background-tertiary)] border border-[var(--border-color)] rounded-lg p-3 shadow-lg">
          <p className="text-[var(--foreground)] font-medium">{label}</p>
          {payload.map((entry: any, index: number) => (
            <p key={index} style={{ color: entry.color }} className="text-sm">
              {entry.name}: ${entry.value.toLocaleString()}
            </p>
          ))}
        </div>
      );
    }
    return null;
  };

  // Calculate budget usage against the effective (set or derived) monthly budget
  const budgetUsed = pastExpenses;
  const budgetRemaining = effectiveBudget - budgetUsed;
  const budgetPercentage = effectiveBudget ? Math.min((budgetUsed / effectiveBudget) * 100, 100) : 0;

  return (
    <div className="min-h-screen relative">
      <div className="bg-pattern" />
      <Navbar />
      
      <main className="pt-24 pb-12 px-4 sm:px-6 lg:px-8 max-w-7xl mx-auto relative z-10">
        {/* Setup Incomplete Banner */}
        {setupIncomplete && (
          <div className="mb-6 p-4 rounded-xl bg-gradient-to-r from-[var(--accent-primary)]/20 to-[var(--accent-secondary)]/20 border border-[var(--accent-primary)]/30">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-[var(--accent-primary)]/30 flex items-center justify-center">
                  <Settings className="w-5 h-5 text-[var(--accent-primary)]" />
                </div>
                <div>
                  <p className="font-medium text-[var(--foreground)]">Complete your setup</p>
                  <p className="text-sm text-[var(--foreground-secondary)]">
                    {!hasAccounts && 'Add your accounts • '}
                    {!hasIncome && 'Set up income • '}
                    {!hasBudget && 'Set a budget'}
                  </p>
                </div>
              </div>
              <button
                onClick={() => router.push('/onboarding?continue=true')}
                className="btn-primary text-sm py-2 px-4 flex items-center gap-2"
              >
                Continue Setup
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {/* Forecast Summary Card — a real link, so keyboard/AT reach it */}
        {forecast && !setupIncomplete && (
          <Link
            href="/forecast"
            className="block mb-8 p-6 rounded-xl bg-[var(--background-secondary)] border border-[var(--border-color)] hover:border-[var(--border-glow)] transition-all cursor-pointer"
          >
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
              <div className="flex items-center gap-4">
                <div className="w-14 h-14 rounded-xl bg-gradient-to-br from-[var(--accent-primary)] to-[var(--accent-secondary)] flex items-center justify-center">
                  <LineChartIcon className="w-7 h-7 text-white" />
                </div>
                <div>
                  <h2 className="text-xl font-bold text-[var(--foreground)]">Cash Flow Forecast</h2>
                  <p className="text-sm text-[var(--foreground-secondary)]">
                    See your financial future for the next 90 days
                  </p>
                </div>
              </div>
              
              <div className="flex flex-wrap items-center gap-4 lg:gap-8">
                <div className="text-center">
                  <p className="text-xs text-[var(--foreground-muted)] mb-1">Lowest Point</p>
                  <p className={`text-xl font-bold ${forecast.lowestBalance < (profile?.settings?.safetyThreshold || 500) ? 'text-red-500' : 'text-[var(--foreground)]'}`}>
                    ${forecast.lowestBalance.toLocaleString()}
                  </p>
                </div>
                <div className="text-center">
                  <p className="text-xs text-[var(--foreground-muted)] mb-1">Safety Status</p>
                  <div className={`flex items-center gap-1.5 ${forecast.daysUntilUnsafe !== null ? 'text-amber-500' : 'text-emerald-500'}`}>
                    <Shield className="w-4 h-4" />
                    <span className="font-semibold">
                      {forecast.daysUntilUnsafe !== null ? `${forecast.daysUntilUnsafe} days` : 'Safe'}
                    </span>
                  </div>
                </div>
                <span className="btn-primary flex items-center gap-2">
                  View Forecast
                  <ArrowRight className="w-4 h-4" />
                </span>
              </div>
            </div>
          </Link>
        )}

        {/* Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-8">
          <div>
            <h1 className="text-3xl font-bold text-[var(--foreground)]">
              Welcome back, {user?.name?.split(' ')[0]}!
            </h1>
            <p className="text-[var(--foreground-secondary)] mt-1">
              Here&apos;s your financial overview
            </p>
          </div>
          <button
            onClick={() => setIsModalOpen(true)}
            className="btn-primary flex items-center gap-2"
          >
            <Plus className="w-5 h-5" />
            Add Transaction
          </button>
        </div>

        {/* Account Cards */}
        {profile?.paymentAccounts && profile.paymentAccounts.length > 0 && (
          <div className="mb-8">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-semibold text-[var(--foreground)]">Your Accounts</h2>
              <button
                onClick={() => router.push('/accounts')}
                className="text-sm text-[var(--accent-primary)] hover:underline flex items-center gap-1"
              >
                Manage <ChevronRight className="w-4 h-4" />
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {derivedAccounts.slice(0, 4).map((account) => (
                <Link
                  key={account.id}
                  href="/accounts"
                  className="block p-4 rounded-xl bg-[var(--background-secondary)] border border-[var(--border-color)] border-l-4 hover:border-[var(--border-glow)] transition-all cursor-pointer"
                  style={{ borderLeftColor: account.color }}
                >
                  <div className="flex items-center justify-between mb-3">
                    <div
                      className="w-10 h-10 rounded-lg flex items-center justify-center"
                      style={{ backgroundColor: `${account.color}20`, color: account.color }}
                    >
                      {getAccountIcon(account.type)}
                    </div>
                    {account.type === 'credit_card' && account.creditLimit && (
                      <span className="text-xs text-[var(--foreground-muted)]">
                        {Math.round((currentOf(account) / account.creditLimit) * 100)}% used
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-[var(--foreground-secondary)] mb-1 truncate">
                    {account.name}
                    {account.lastFourDigits && ` •••• ${account.lastFourDigits}`}
                  </p>
                  <p className={`text-xl font-bold ${account.type === 'credit_card' ? 'text-[var(--accent-danger)]' : 'text-[var(--accent-success)]'}`}>
                    {account.type === 'credit_card' && currentOf(account) > 0 ? '-' : ''}${currentOf(account).toLocaleString()}
                  </p>
                  {account.type === 'credit_card' && account.creditLimit && (
                    <div className="mt-2">
                      <div className="h-1.5 bg-[var(--background-tertiary)] rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all"
                          style={{
                            width: `${Math.min((currentOf(account) / account.creditLimit) * 100, 100)}%`,
                            backgroundColor: currentOf(account) / account.creditLimit > 0.8 ? 'var(--accent-danger)' : account.color,
                          }}
                        />
                      </div>
                    </div>
                  )}
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* Stats Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
          <div className="stat-card">
            <div className="flex items-center justify-between mb-4">
              <span className="text-[var(--foreground-secondary)] text-sm font-medium">Net Worth</span>
              <div className="w-10 h-10 rounded-xl bg-[var(--accent-primary)]/20 flex items-center justify-center">
                <Wallet className="w-5 h-5 text-[var(--accent-primary)]" />
              </div>
            </div>
            <p className={`text-3xl font-bold ${netWorth >= 0 ? 'text-[var(--accent-success)]' : 'text-[var(--accent-danger)]'}`}>
              {netWorth < 0 ? '-' : ''}${Math.abs(netWorth).toLocaleString()}
            </p>
            <p className="text-[var(--foreground-muted)] text-sm mt-1">
              Cash − all debt
            </p>
          </div>

          <div className="stat-card">
            <div className="flex items-center justify-between mb-4">
              <span className="text-[var(--foreground-secondary)] text-sm font-medium">Cash Available</span>
              <div className="w-10 h-10 rounded-xl bg-[var(--accent-success)]/20 flex items-center justify-center">
                <Building2 className="w-5 h-5 text-[var(--accent-success)]" />
              </div>
            </div>
            <p className="text-3xl font-bold text-[var(--accent-success)]">
              ${totalBankBalance.toLocaleString()}
            </p>
            <p className="text-[var(--foreground-muted)] text-sm mt-1">
              Bank & cash accounts
            </p>
          </div>

          <div className="stat-card">
            <div className="flex items-center justify-between mb-4">
              <span className="text-[var(--foreground-secondary)] text-sm font-medium">Credit Used</span>
              <div className="w-10 h-10 rounded-xl bg-[var(--accent-danger)]/20 flex items-center justify-center">
                <CreditCard className="w-5 h-5 text-[var(--accent-danger)]" />
              </div>
            </div>
            <p className="text-3xl font-bold text-[var(--accent-danger)]">
              ${totalCreditUsed.toLocaleString()}
            </p>
            <p className="text-[var(--foreground-muted)] text-sm mt-1">
              {creditUtilization}% of ${totalCreditLimit.toLocaleString()} limit
            </p>
          </div>

          <div className="stat-card">
            <div className="flex items-center justify-between mb-4">
              <span className="text-[var(--foreground-secondary)] text-sm font-medium">Monthly Income</span>
              <div className="w-10 h-10 rounded-xl bg-[var(--accent-primary)]/20 flex items-center justify-center">
                <Banknote className="w-5 h-5 text-[var(--accent-primary)]" />
              </div>
            </div>
            <p className="text-3xl font-bold text-[var(--accent-primary)]">
              ${monthlyIncome.toLocaleString()}
            </p>
            <p className="text-[var(--foreground-muted)] text-sm mt-1">
              {incomeFromSources > 0 ? 'Expected per month' : 'Avg / month (from transactions)'}
            </p>
          </div>

          <div className="stat-card">
            <div className="flex items-center justify-between mb-4">
              <span className="text-[var(--foreground-secondary)] text-sm font-medium">Budget Remaining</span>
              <div className="w-10 h-10 rounded-xl bg-[var(--accent-warning)]/20 flex items-center justify-center">
                <DollarSign className="w-5 h-5 text-[var(--accent-warning)]" />
              </div>
            </div>
            <p className={`text-3xl font-bold ${budgetRemaining >= 0 ? 'text-[var(--accent-success)]' : 'text-[var(--accent-danger)]'}`}>
              ${Math.abs(budgetRemaining).toLocaleString()}
            </p>
            {effectiveBudget > 0 && (
              <div className="mt-2">
                <div className="h-1.5 bg-[var(--background-tertiary)] rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      width: `${budgetPercentage}%`,
                      backgroundColor: budgetPercentage > 90 ? 'var(--accent-danger)' : budgetPercentage > 70 ? 'var(--accent-warning)' : 'var(--accent-success)',
                    }}
                  />
                </div>
                <p className="text-xs text-[var(--foreground-muted)] mt-1">
                  {Math.round(budgetPercentage)}% of ${effectiveBudget.toLocaleString()} used
                  {budgetIsDerived && ' (typical spend)'}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Upcoming Bills Alert */}
        {upcomingBills.length > 0 && (
          <div className="mb-8 p-4 rounded-xl bg-[var(--accent-warning)]/10 border border-[var(--accent-warning)]/30">
            <div className="flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-[var(--accent-warning)] mt-0.5 flex-shrink-0" />
              <div className="flex-1">
                <h3 className="font-semibold text-[var(--foreground)] mb-2">Upcoming Bills</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {upcomingBills.slice(0, 3).map((bill) => (
                    <div key={bill.id} className="flex items-center justify-between p-3 rounded-lg bg-[var(--background)]/50">
                      <div className="flex items-center gap-3">
                        <div
                          className="w-8 h-8 rounded-lg flex items-center justify-center"
                          style={{ backgroundColor: `${bill.color}20`, color: bill.color }}
                        >
                          <CreditCard className="w-4 h-4" />
                        </div>
                        <div>
                          <p className="text-sm font-medium text-[var(--foreground)]">{bill.name}</p>
                          <p className="text-xs text-[var(--foreground-muted)]">
                            Due {format(bill.dueDate, 'MMM d')} ({bill.daysUntilDue} days)
                          </p>
                        </div>
                      </div>
                      <p className="text-sm font-semibold text-[var(--accent-danger)]">
                        ${(bill.currentBalance ?? bill.openingBalance).toLocaleString()}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Charts Row */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
          {/* Monthly Overview Chart */}
          <div className="chart-container">
            <h3 className="text-lg font-semibold text-[var(--foreground)] mb-6">Monthly Overview</h3>
            {monthlyChartData.length > 0 ? (
              <>
                <div
                  className="h-[240px] sm:h-[300px]"
                  role="img"
                  aria-label={`Line chart of income versus expenses across ${monthlyChartData.length} months; ${latestMonth.month}: income $${latestMonth.income.toLocaleString()}, expenses $${latestMonth.expenses.toLocaleString()}.`}
                >
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={monthlyChartData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" />
                      <XAxis dataKey="month" stroke="var(--foreground-secondary)" fontSize={12} />
                      <YAxis stroke="var(--foreground-secondary)" fontSize={12} />
                      <Tooltip content={<CustomTooltip />} />
                      <Legend />
                      <Line isAnimationActive={false}
                        type="monotone"
                        dataKey="income"
                        stroke="var(--accent-success)"
                        strokeWidth={3}
                        dot={{ fill: 'var(--accent-success)', strokeWidth: 2 }}
                        name="Income"
                      />
                      <Line isAnimationActive={false}
                        type="monotone"
                        dataKey="expenses"
                        stroke="var(--accent-danger)"
                        strokeWidth={3}
                        dot={{ fill: 'var(--accent-danger)', strokeWidth: 2 }}
                        name="Expenses"
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <ChartSrTable
                  caption="Monthly income and expenses"
                  columns={['Month', 'Income', 'Expenses']}
                  rows={monthlyChartData.map((m) => [m.month, `$${m.income.toLocaleString()}`, `$${m.expenses.toLocaleString()}`])}
                />
              </>
            ) : (
              <div className="h-[300px] flex flex-col items-center justify-center text-[var(--foreground-muted)]">
                <TrendingUp className="w-12 h-12 mb-3 opacity-50" />
                <p>No transaction data yet</p>
                <button onClick={() => setIsModalOpen(true)} className="mt-2 text-[var(--accent-primary)] hover:underline">
                  Add your first transaction
                </button>
              </div>
            )}
          </div>

          {/* Payment Method Breakdown */}
          <div className="below-fold-chart chart-container">
            <h3 className="text-lg font-semibold text-[var(--foreground)] mb-6">By Payment Method</h3>
            {pieChartData.length > 0 ? (
              <>
                <div
                  className="h-[240px] sm:h-[300px]"
                  role="img"
                  aria-label={`Donut chart of $${pieTotal.toLocaleString()} in spending split across ${pieChartData.length} payment methods.`}
                >
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie isAnimationActive={false}
                        data={pieChartData}
                        cx="50%"
                        cy="50%"
                        innerRadius={60}
                        outerRadius={100}
                        paddingAngle={2}
                        dataKey="value"
                      >
                        {pieChartData.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={entry.color} />
                        ))}
                      </Pie>
                      <Tooltip content={<CustomTooltip />} />
                      <Legend
                        layout="vertical"
                        align="right"
                        verticalAlign="middle"
                        formatter={(value) => <span className="text-[var(--foreground-secondary)] text-sm">{value}</span>}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <ChartSrTable
                  caption="Spending by payment method"
                  columns={['Payment method', 'Total']}
                  rows={pieChartData.map((d) => [d.name, `$${d.value.toLocaleString()}`])}
                />
              </>
            ) : (
              <div className="h-[300px] flex flex-col items-center justify-center text-[var(--foreground-muted)]">
                <CreditCard className="w-12 h-12 mb-3 opacity-50" />
                <p>No payment data yet</p>
              </div>
            )}
          </div>
        </div>

        {/* Category Breakdown */}
        {categoryChartData.length > 0 && (
          <div className="below-fold-chart chart-container mb-8">
            <h3 className="text-lg font-semibold text-[var(--foreground)] mb-6">Expenses by Category</h3>
            <div
              className="h-[240px] sm:h-[300px]"
              role="img"
              aria-label={`Bar chart of the top ${categoryChartData.length} expense categories; highest is ${categoryChartData[0].name} at $${categoryChartData[0].total.toLocaleString()}.`}
            >
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={categoryChartData} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" horizontal={false} />
                  <XAxis type="number" stroke="var(--foreground-secondary)" fontSize={12} />
                  <YAxis
                    dataKey="name"
                    type="category"
                    stroke="var(--foreground-secondary)"
                    fontSize={12}
                    width={120}
                    tickFormatter={(value, index) => `${categoryChartData[index]?.icon || ''} ${value}`}
                  />
                  <Tooltip content={<CustomTooltip />} />
                  <Bar isAnimationActive={false} dataKey="total" fill="url(#colorGradient)" radius={[0, 8, 8, 0]} name="Total">
                    <defs>
                      <linearGradient id="colorGradient" x1="0" y1="0" x2="1" y2="0">
                        <stop offset="0%" stopColor="var(--accent-primary)" />
                        <stop offset="100%" stopColor="var(--accent-secondary)" />
                      </linearGradient>
                    </defs>
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <ChartSrTable
              caption="Top expense categories"
              columns={['Category', 'Total']}
              rows={categoryChartData.map((c) => [c.name, `$${c.total.toLocaleString()}`])}
            />
          </div>
        )}

        {/* Income Sources */}
        {profile?.incomeSources && profile.incomeSources.length > 0 && (
          <div className="glass-card p-6 mb-8">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-semibold text-[var(--foreground)]">Income Sources</h3>
              <button
                onClick={() => router.push('/accounts')}
                className="text-sm text-[var(--accent-primary)] hover:underline flex items-center gap-1"
              >
                Manage <ChevronRight className="w-4 h-4" />
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {profile.incomeSources.map((income) => (
                <div
                  key={income.id}
                  className="p-4 rounded-xl bg-[var(--background-tertiary)] border border-[var(--border-color)] border-l-4 border-l-[var(--accent-success)]"
                >
                  <div className="flex items-center gap-3 mb-2">
                    <div className="w-10 h-10 rounded-lg bg-[var(--accent-success)]/20 flex items-center justify-center text-[var(--accent-success)]">
                      <Banknote className="w-5 h-5" />
                    </div>
                    <div>
                      <p className="font-medium text-[var(--foreground)]">{income.name}</p>
                      <p className="text-xs text-[var(--foreground-muted)]">
                        {income.frequency.charAt(0).toUpperCase() + income.frequency.slice(1)}
                        {income.payDate && ` • Day ${income.payDate}`}
                      </p>
                    </div>
                  </div>
                  <p className="text-xl font-bold text-[var(--accent-success)]">
                    +${income.amount.toLocaleString()}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Recent Transactions */}
        <div className="glass-card p-6">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
            <h3 className="text-lg font-semibold text-[var(--foreground)]">Recent Transactions</h3>
            <div className="flex items-center gap-2">
              <Filter className="w-4 h-4 text-[var(--foreground-muted)]" />
              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value as 'all' | 'past' | 'future')}
                className="select-field py-2 px-3 text-sm"
              >
                <option value="all">All Transactions</option>
                <option value="past">Past Only</option>
                <option value="future">Future/Projected</option>
              </select>
            </div>
          </div>

          <div className="space-y-3">
            {recentTransactions.length === 0 ? (
              <div className="text-center py-12">
                <Calendar className="w-16 h-16 text-[var(--foreground-muted)] mx-auto mb-4" />
                <h3 className="text-lg font-medium text-[var(--foreground)] mb-2">No transactions yet</h3>
                <p className="text-[var(--foreground-secondary)] mb-4">Start tracking your expenses</p>
                <button onClick={() => setIsModalOpen(true)} className="btn-primary">
                  Add First Transaction
                </button>
              </div>
            ) : (
              recentTransactions.map((txn) => {
                const category = EXPENSE_CATEGORIES.find((c) => c.value === txn.category);
                const paymentMethod = PAYMENT_METHODS.find((m) => m.value === txn.paymentMethod);
                // Not `type === 'expense'`: that renders a transfer green with a '+'
                // regardless of which way the money actually moved.
                const isExpense = !isPositive(txn, profile?.paymentAccounts);
                const isFuture = isAfter(parseISO(txn.date), today) || txn.isProjected;

                return (
                  <div
                    key={txn.id}
                    className={`flex items-center justify-between p-4 rounded-xl bg-[var(--background-tertiary)] border border-[var(--border-color)] hover:border-[var(--border-glow)] transition-all payment-${txn.paymentMethod}`}
                  >
                    <div className="flex items-center gap-4">
                      <div className="w-12 h-12 rounded-xl bg-[var(--background-secondary)] flex items-center justify-center text-2xl">
                        {category?.icon || '📋'}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="font-medium text-[var(--foreground)]">{txn.title}</p>
                          {isFuture && (
                            <span className="badge badge-projected">Projected</span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 text-sm text-[var(--foreground-secondary)]">
                          <span>{format(parseISO(txn.date), 'MMM dd, yyyy')}</span>
                          <span>•</span>
                          <span style={{ color: paymentMethod?.color }}>{paymentMethod?.label}</span>
                        </div>
                      </div>
                    </div>
                    <p className={`text-lg font-semibold ${isExpense ? 'text-[var(--accent-danger)]' : 'text-[var(--accent-success)]'}`}>
                      {isExpense ? '-' : '+'}${txn.amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                    </p>
                  </div>
                );
              })
            )}
          </div>

          {transactions.length > 8 && (
            <button
              onClick={() => router.push('/calendar')}
              className="w-full mt-4 py-3 rounded-xl bg-[var(--background-tertiary)] text-[var(--foreground-secondary)] hover:text-[var(--foreground)] hover:bg-[var(--background-secondary)] transition-all flex items-center justify-center gap-2"
            >
              View All Transactions
              <ChevronRight className="w-4 h-4" />
            </button>
          )}
        </div>
      </main>

      <AddTransactionModal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} />
    </div>
  );
}
