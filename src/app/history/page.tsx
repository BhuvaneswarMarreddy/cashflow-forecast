'use client';

import React, { useEffect, useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { useTransactions } from '@/context/TransactionContext';
import { useUserProfile } from '@/context/UserProfileContext';
import Navbar from '@/components/Navbar';
import AddTransactionModal from '@/components/AddTransactionModal';
import CSVImportModal from '@/components/CSVImportModal';
import ReceiptScannerModal from '@/components/ReceiptScannerModal';
import RunwayCalculator from '@/components/RunwayCalculator';
import { generateForecast, calculateCurrentCash } from '@/lib/forecast';
import { EXPENSE_CATEGORIES, Transaction, getMerchantColor } from '@/types';
import {
  TrendingUp,
  Plus,
  Upload,
  Calendar,
  Search,
  Filter,
  Trash2,
  Edit2,
  ChevronDown,
  ChevronUp,
  DollarSign,
  ArrowUpRight,
  ArrowDownRight,
  Clock,
  FileText,
  BarChart2,
  Camera,
  Sparkles,
} from 'lucide-react';
import { format, parseISO, startOfMonth, endOfMonth, subMonths, isWithinInterval } from 'date-fns';

type ViewMode = 'history' | 'runway';
type DateFilter = 'all' | 'thisMonth' | 'lastMonth' | 'last3Months' | 'last6Months';
type GroupBy = 'month' | 'year';

export default function HistoryPage() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { transactions, deleteTransaction, isLoading: txnLoading } = useTransactions();
  const { profile, isLoading: profileLoading, isOnboarded } = useUserProfile();
  const router = useRouter();

  const [viewMode, setViewMode] = useState<ViewMode>('history');
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [dateFilter, setDateFilter] = useState<DateFilter>('all');
  const [typeFilter, setTypeFilter] = useState<'all' | 'income' | 'expense'>('all');
  const [accountFilter, setAccountFilter] = useState<string>('all');
  const [sortOrder, setSortOrder] = useState<'newest' | 'oldest' | 'highest' | 'lowest'>('newest');
  const [groupBy, setGroupBy] = useState<GroupBy>('month');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [editingTransaction, setEditingTransaction] = useState<Transaction | null>(null);

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

  // Filter and sort transactions
  const filteredTransactions = useMemo(() => {
    let filtered = [...transactions];

    // Date filter
    const now = new Date();
    if (dateFilter !== 'all') {
      let startDate: Date;
      const endDate = now;
      
      switch (dateFilter) {
        case 'thisMonth':
          startDate = startOfMonth(now);
          break;
        case 'lastMonth':
          startDate = startOfMonth(subMonths(now, 1));
          break;
        case 'last3Months':
          startDate = subMonths(now, 3);
          break;
        case 'last6Months':
          startDate = subMonths(now, 6);
          break;
        default:
          startDate = new Date(0);
      }
      
      filtered = filtered.filter(t => {
        const txnDate = parseISO(t.date);
        return isWithinInterval(txnDate, { start: startDate, end: endDate });
      });
    }

    // Type filter
    if (typeFilter !== 'all') {
      filtered = filtered.filter(t => t.type === typeFilter);
    }

    // Account filter
    if (accountFilter !== 'all') {
      if (accountFilter === 'unlinked') {
        filtered = filtered.filter(t => !t.accountId);
      } else {
        filtered = filtered.filter(t => t.accountId === accountFilter);
      }
    }

    // Search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(t => 
        t.title.toLowerCase().includes(query) ||
        t.description?.toLowerCase().includes(query) ||
        t.category.toLowerCase().includes(query) ||
        t.merchant?.toLowerCase().includes(query)
      );
    }

    // Sort
    switch (sortOrder) {
      case 'newest':
        filtered.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        break;
      case 'oldest':
        filtered.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
        break;
      case 'highest':
        filtered.sort((a, b) => b.amount - a.amount);
        break;
      case 'lowest':
        filtered.sort((a, b) => a.amount - b.amount);
        break;
    }

    return filtered;
  }, [transactions, dateFilter, typeFilter, accountFilter, searchQuery, sortOrder]);

  // Group transactions by month or year
  // Transfers between accounts don't count as real income/expense
  const groupedTransactions = useMemo(() => {
    const groups: { [key: string]: { transactions: Transaction[]; income: number; expenses: number } } = {};
    
    // Helper to classify transaction
    const classifyTransaction = (t: Transaction): 'income' | 'expense' | 'transfer' => {
      const titleLower = t.title.toLowerCase();
      const linkedAccount = t.accountId ? profile?.paymentAccounts?.find(a => a.id === t.accountId) : null;
      const isCreditCard = linkedAccount?.type === 'credit_card';
      
      // Internal transfers between accounts - don't count in totals
      if (titleLower.includes('transfer from') || titleLower.includes('transfer to') || 
          titleLower.includes('online transfer')) {
        return 'transfer';
      }
      
      // Credit card payments - also transfers (from bank to card)
      const paymentKeywords = ['payment', 'autopay', 'auto pay'];
      if (isCreditCard && paymentKeywords.some(kw => titleLower.includes(kw))) {
        return 'transfer';
      }
      
      // Real deposits/income
      if (titleLower.includes('deposit') || titleLower.includes('direct dep') || 
          titleLower.includes('payroll') || titleLower.includes('salary')) {
        return 'income';
      }
      
      return t.type === 'income' ? 'income' : 'expense';
    };
    
    filteredTransactions.forEach(t => {
      const groupKey = groupBy === 'month' 
        ? format(parseISO(t.date), 'yyyy-MM')
        : format(parseISO(t.date), 'yyyy');
      
      if (!groups[groupKey]) {
        groups[groupKey] = { transactions: [], income: 0, expenses: 0 };
      }
      groups[groupKey].transactions.push(t);
      
      const classification = classifyTransaction(t);
      if (classification === 'income') {
        groups[groupKey].income += t.amount;
      } else if (classification === 'expense') {
        groups[groupKey].expenses += t.amount;
      }
      // 'transfer' transactions don't add to income or expense totals
    });

    return Object.entries(groups)
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([key, data]) => ({
        key,
        label: groupBy === 'month' 
          ? format(parseISO(key + '-01'), 'MMMM yyyy')
          : key,
        ...data,
      }));
  }, [filteredTransactions, groupBy, profile?.paymentAccounts]);

  // Calculate totals for stats - excludes transfers between own accounts
  const totals = useMemo(() => {
    // Helper to classify transaction
    const classifyTransaction = (t: Transaction): 'income' | 'expense' | 'transfer' => {
      const titleLower = t.title.toLowerCase();
      const linkedAccount = t.accountId ? profile?.paymentAccounts?.find(a => a.id === t.accountId) : null;
      const isCreditCard = linkedAccount?.type === 'credit_card';
      
      // Internal transfers - don't count
      if (titleLower.includes('transfer from') || titleLower.includes('transfer to') || 
          titleLower.includes('online transfer')) {
        return 'transfer';
      }
      
      // Credit card payments - transfers from bank to card
      const paymentKeywords = ['payment', 'autopay', 'auto pay'];
      if (isCreditCard && paymentKeywords.some(kw => titleLower.includes(kw))) {
        return 'transfer';
      }
      
      // Real deposits/income
      if (titleLower.includes('deposit') || titleLower.includes('direct dep') || 
          titleLower.includes('payroll') || titleLower.includes('salary')) {
        return 'income';
      }
      
      return t.type === 'income' ? 'income' : 'expense';
    };
    
    let income = 0;
    let expenses = 0;
    
    filteredTransactions.forEach(t => {
      const classification = classifyTransaction(t);
      if (classification === 'income') {
        income += t.amount;
      } else if (classification === 'expense') {
        expenses += t.amount;
      }
      // 'transfer' transactions don't count
    });
    
    return { income, expenses, net: income - expenses };
  }, [filteredTransactions, profile?.paymentAccounts]);

  // Calculate monthly averages for runway
  const monthlyStats = useMemo(() => {
    const pastTxns = transactions.filter(t => parseISO(t.date) < new Date());
    if (pastTxns.length === 0) {
      return { avgExpenses: profile?.monthlyBudget || 3000, avgIncome: 0 };
    }

    // Helper to check if transaction is real income (not credit card payment)
    const isRealIncome = (t: Transaction) => {
      if (t.type !== 'income') return false;
      if (t.accountId && profile?.paymentAccounts) {
        const account = profile.paymentAccounts.find(a => a.id === t.accountId);
        if (account?.type === 'credit_card') return false;
      }
      return true;
    };

    const months = new Set(pastTxns.map(t => format(parseISO(t.date), 'yyyy-MM'))).size || 1;
    const totalExpenses = pastTxns.filter(t => t.type === 'expense').reduce((sum, t) => sum + t.amount, 0);
    const totalIncome = pastTxns.filter(isRealIncome).reduce((sum, t) => sum + t.amount, 0);

    return {
      avgExpenses: totalExpenses / months,
      avgIncome: totalIncome / months,
    };
  }, [transactions, profile?.monthlyBudget, profile?.paymentAccounts]);

  // Generate forecast for runway
  const forecast = useMemo(() => {
    if (!profile) return null;
    const currentCash = calculateCurrentCash(profile?.paymentAccounts || []);
    return generateForecast(
      currentCash,
      profile?.paymentAccounts || [],
      profile?.incomeSources || [],
      transactions,
      profile?.settings?.safetyThreshold || 500,
      90
    );
  }, [profile, transactions]);

  const handleDelete = async (id: string) => {
    await deleteTransaction(id);
    setDeleteConfirm(null);
  };

  if (authLoading || profileLoading) {
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

  const currentCash = calculateCurrentCash(profile?.paymentAccounts || []);
  const monthlyIncome = profile?.incomeSources?.reduce((sum, inc) => {
    const monthly = inc.frequency === 'yearly' ? inc.amount / 12 :
      inc.frequency === 'biweekly' ? inc.amount * 26 / 12 :
      inc.frequency === 'weekly' ? inc.amount * 52 / 12 : inc.amount;
    return sum + monthly;
  }, 0) || monthlyStats.avgIncome;

  return (
    <div className="min-h-screen relative">
      <div className="bg-pattern" />
      <Navbar />

      <main className="pt-24 pb-12 px-4 sm:px-6 lg:px-8 max-w-7xl mx-auto relative z-10">
        {/* Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-8">
          <div>
            <h1 className="text-3xl font-bold text-[var(--foreground)]">
              {viewMode === 'history' ? 'Transaction History' : 'Wealth Runway'}
            </h1>
            <p className="text-[var(--foreground-secondary)] mt-1">
              {viewMode === 'history' 
                ? 'View, add, and import your transactions'
                : 'See how long your money will last'}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {/* View Toggle */}
            <div className="flex bg-[var(--background-tertiary)] rounded-lg p-1">
              <button
                onClick={() => setViewMode('history')}
                className={`px-4 py-2 rounded-md text-sm font-medium transition-all ${
                  viewMode === 'history'
                    ? 'bg-[var(--accent-primary)] text-white'
                    : 'text-[var(--foreground-secondary)] hover:text-[var(--foreground)]'
                }`}
              >
                <FileText className="w-4 h-4 inline mr-2" />
                History
              </button>
              <button
                onClick={() => setViewMode('runway')}
                className={`px-4 py-2 rounded-md text-sm font-medium transition-all ${
                  viewMode === 'runway'
                    ? 'bg-[var(--accent-primary)] text-white'
                    : 'text-[var(--foreground-secondary)] hover:text-[var(--foreground)]'
                }`}
              >
                <BarChart2 className="w-4 h-4 inline mr-2" />
                Runway
              </button>
            </div>
          </div>
        </div>

        {viewMode === 'history' ? (
          <>
            {/* Compact Header with Actions and Stats */}
            <div className="bg-[var(--background-secondary)] rounded-xl border border-[var(--border-color)] p-4 mb-6">
              {/* Top Row - Stats Summary */}
              <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-[var(--border-color)]">
                <div className="flex items-center gap-6">
                  <div className="flex items-center gap-2">
                    <ArrowUpRight className="w-4 h-4 text-emerald-500" />
                    <span className="text-emerald-500 font-semibold">${totals.income.toLocaleString()}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <ArrowDownRight className="w-4 h-4 text-red-400" />
                    <span className="text-red-400 font-semibold">${totals.expenses.toLocaleString()}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <DollarSign className="w-4 h-4 text-[var(--foreground-muted)]" />
                    <span className={`font-semibold ${totals.net >= 0 ? 'text-emerald-500' : 'text-red-400'}`}>
                      {totals.net >= 0 ? '+' : ''}${totals.net.toLocaleString()}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setIsAddModalOpen(true)}
                    className="btn-primary px-3 py-1.5 text-sm flex items-center gap-1.5"
                  >
                    <Plus className="w-4 h-4" />
                    Add
                  </button>
                  <button
                    onClick={() => setIsScannerOpen(true)}
                    className="btn-gradient px-3 py-1.5 text-sm flex items-center gap-1.5"
                  >
                    <Camera className="w-4 h-4" />
                    Scan
                  </button>
                  <button
                    onClick={() => setIsImportModalOpen(true)}
                    className="btn-secondary px-3 py-1.5 text-sm flex items-center gap-1.5"
                  >
                    <Upload className="w-4 h-4" />
                    Import
                  </button>
                </div>
              </div>

              {/* Filters Row */}
              <div className="flex flex-wrap items-center gap-3 pt-4">
                {/* Search */}
                <div className="relative flex-1 min-w-[200px]">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--foreground-muted)]" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search..."
                    className="w-full py-2 pl-9 pr-3 rounded-lg bg-[var(--background)] border border-[var(--border-color)] text-sm text-[var(--foreground)] placeholder:text-[var(--foreground-muted)]"
                  />
                </div>

                {/* Account Dropdown */}
                <select
                  value={accountFilter}
                  onChange={(e) => setAccountFilter(e.target.value)}
                  className="px-3 py-2 rounded-lg bg-[var(--background)] border border-[var(--border-color)] text-sm cursor-pointer min-w-[140px]"
                  style={{
                    color: accountFilter !== 'all' && accountFilter !== 'unlinked'
                      ? profile?.paymentAccounts?.find(a => a.id === accountFilter)?.color
                      : 'var(--foreground-secondary)'
                  }}
                >
                  <option value="all">All Accounts</option>
                  {profile?.paymentAccounts?.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name} {account.lastFourDigits ? `••${account.lastFourDigits}` : ''}
                    </option>
                  ))}
                  <option value="unlinked">Unlinked</option>
                </select>

                {/* Time Period Dropdown */}
                <select
                  value={dateFilter}
                  onChange={(e) => setDateFilter(e.target.value as DateFilter)}
                  className="px-3 py-2 rounded-lg bg-[var(--background)] border border-[var(--border-color)] text-sm text-[var(--foreground-secondary)] cursor-pointer"
                >
                  <option value="all">All Time</option>
                  <option value="thisMonth">This Month</option>
                  <option value="lastMonth">Last Month</option>
                  <option value="last3Months">3 Months</option>
                  <option value="last6Months">6 Months</option>
                </select>

                {/* Type Filter */}
                <div className="flex items-center gap-1 p-1 bg-[var(--background)] rounded-lg border border-[var(--border-color)]">
                  <button
                    onClick={() => setTypeFilter('all')}
                    className={`px-2.5 py-1 rounded text-xs font-medium transition-all ${
                      typeFilter === 'all'
                        ? 'bg-[var(--accent-primary)] text-white'
                        : 'text-[var(--foreground-secondary)] hover:bg-[var(--background-tertiary)]'
                    }`}
                  >
                    All
                  </button>
                  <button
                    onClick={() => setTypeFilter('income')}
                    className={`px-2.5 py-1 rounded text-xs font-medium transition-all ${
                      typeFilter === 'income'
                        ? 'bg-emerald-500 text-white'
                        : 'text-emerald-500 hover:bg-emerald-500/10'
                    }`}
                  >
                    In
                  </button>
                  <button
                    onClick={() => setTypeFilter('expense')}
                    className={`px-2.5 py-1 rounded text-xs font-medium transition-all ${
                      typeFilter === 'expense'
                        ? 'bg-red-500 text-white'
                        : 'text-red-400 hover:bg-red-500/10'
                    }`}
                  >
                    Out
                  </button>
                </div>

                {/* Group Toggle */}
                <div className="flex items-center gap-1 p-1 bg-[var(--background)] rounded-lg border border-[var(--border-color)]">
                  <button
                    onClick={() => setGroupBy('month')}
                    className={`px-2.5 py-1 rounded text-xs font-medium transition-all ${
                      groupBy === 'month'
                        ? 'bg-[var(--accent-primary)] text-white'
                        : 'text-[var(--foreground-secondary)] hover:bg-[var(--background-tertiary)]'
                    }`}
                  >
                    Month
                  </button>
                  <button
                    onClick={() => setGroupBy('year')}
                    className={`px-2.5 py-1 rounded text-xs font-medium transition-all ${
                      groupBy === 'year'
                        ? 'bg-[var(--accent-primary)] text-white'
                        : 'text-[var(--foreground-secondary)] hover:bg-[var(--background-tertiary)]'
                    }`}
                  >
                    Year
                  </button>
                </div>

                {/* Sort */}
                <select
                  value={sortOrder}
                  onChange={(e) => setSortOrder(e.target.value as typeof sortOrder)}
                  className="px-3 py-2 rounded-lg bg-[var(--background)] border border-[var(--border-color)] text-sm text-[var(--foreground-secondary)] cursor-pointer"
                >
                  <option value="newest">Newest</option>
                  <option value="oldest">Oldest</option>
                  <option value="highest">Highest</option>
                  <option value="lowest">Lowest</option>
                </select>

                {/* Count */}
                <span className="text-xs text-[var(--foreground-muted)] ml-auto">
                  {filteredTransactions.length} txns
                </span>
              </div>
            </div>

            {/* Transactions List */}
            {filteredTransactions.length === 0 ? (
              <div className="text-center py-16 bg-[var(--background-secondary)] rounded-xl border border-[var(--border-color)]">
                <Calendar className="w-16 h-16 mx-auto mb-4 text-[var(--foreground-muted)]" />
                <h3 className="text-xl font-semibold text-[var(--foreground)] mb-2">No transactions found</h3>
                <p className="text-[var(--foreground-secondary)] mb-6">
                  {searchQuery || dateFilter !== 'all' || typeFilter !== 'all'
                    ? 'Try adjusting your filters'
                    : 'Start by adding your first transaction or importing from CSV'}
                </p>
                <div className="flex justify-center gap-3">
                  <button onClick={() => setIsAddModalOpen(true)} className="btn-primary">
                    Add Transaction
                  </button>
                  <button onClick={() => setIsImportModalOpen(true)} className="btn-secondary">
                    Import CSV
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                {groupedTransactions.map((group) => (
                  <div key={group.key} className="bg-[var(--background-secondary)] rounded-xl border border-[var(--border-color)] overflow-hidden">
                    {/* Group Header */}
                    <button
                      onClick={() => {
                        setCollapsedGroups(prev => {
                          const newSet = new Set(prev);
                          if (newSet.has(group.key)) {
                            newSet.delete(group.key);
                          } else {
                            newSet.add(group.key);
                          }
                          return newSet;
                        });
                      }}
                      className="w-full p-4 flex items-center justify-between hover:bg-[var(--background-tertiary)] transition-colors"
                    >
                      <div className="flex items-center gap-4">
                        <span className="font-semibold text-[var(--foreground)] text-lg">{group.label}</span>
                        <span className="text-sm text-[var(--foreground-muted)]">
                          {group.transactions.length} transaction{group.transactions.length !== 1 ? 's' : ''}
                        </span>
                      </div>
                      <div className="flex items-center gap-4">
                        <span className="text-sm text-emerald-500">+${group.income.toLocaleString()}</span>
                        <span className="text-sm text-red-400">-${group.expenses.toLocaleString()}</span>
                        {collapsedGroups.has(group.key) ? (
                          <ChevronDown className="w-5 h-5 text-[var(--foreground-muted)]" />
                        ) : (
                          <ChevronUp className="w-5 h-5 text-[var(--foreground-muted)]" />
                        )}
                      </div>
                    </button>

                    {/* Transactions */}
                    {!collapsedGroups.has(group.key) && (
                      <div className="border-t border-[var(--border-color)]">
                        {group.transactions.map((txn) => {
                          const category = EXPENSE_CATEGORIES.find(c => c.value === txn.category);
                          const merchantColor = txn.merchant ? getMerchantColor(txn.merchant) : null;
                          const linkedAccount = txn.accountId 
                            ? profile?.paymentAccounts?.find(a => a.id === txn.accountId) 
                            : null;
                          return (
                            <div
                              key={txn.id}
                              className="p-4 flex items-center justify-between hover:bg-[var(--background-tertiary)] border-b border-[var(--border-color)] last:border-b-0"
                            >
                              <div className="flex items-center gap-4">
                                {/* Show merchant badge or category icon */}
                                {txn.merchant ? (
                                  <div 
                                    className="w-10 h-10 rounded-lg flex items-center justify-center text-white font-bold text-sm"
                                    style={{ backgroundColor: merchantColor || undefined }}
                                  >
                                    {txn.merchant.charAt(0).toUpperCase()}
                                  </div>
                                ) : (
                                  <div className="w-10 h-10 rounded-lg bg-[var(--background-tertiary)] flex items-center justify-center text-xl">
                                    {category?.icon || '📋'}
                                  </div>
                                )}
                                <div>
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <p className="font-medium text-[var(--foreground)]">{txn.title}</p>
                                    {txn.merchant && (
                                      <span 
                                        className="text-xs px-2 py-0.5 rounded-full text-white"
                                        style={{ backgroundColor: merchantColor || undefined }}
                                      >
                                        {txn.merchant}
                                      </span>
                                    )}
                                    {linkedAccount && (
                                      <span 
                                        className="text-xs px-2 py-0.5 rounded-full border"
                                        style={{ 
                                          borderColor: linkedAccount.color, 
                                          color: linkedAccount.color,
                                          backgroundColor: `${linkedAccount.color}10`
                                        }}
                                      >
                                        {linkedAccount.name}
                                        {linkedAccount.lastFourDigits && ` ••${linkedAccount.lastFourDigits}`}
                                      </span>
                                    )}
                                  </div>
                                  <p className="text-sm text-[var(--foreground-muted)]">
                                    {format(parseISO(txn.date), 'MMM d, yyyy')}
                                    {' • '}
                                    <span className="text-xs">{category?.icon} {category?.label || txn.category}</span>
                                    {txn.description && ` • ${txn.description}`}
                                  </p>
                                </div>
                              </div>
                              <div className="flex items-center gap-4">
                                {/* Smart display based on transaction type and account */}
                                {(() => {
                                  const isCreditCard = linkedAccount?.type === 'credit_card';
                                  const isLoan = linkedAccount?.type === 'personal_loan';
                                  const isDebtAccount = isCreditCard || isLoan;
                                  const titleLower = txn.title.toLowerCase();
                                  
                                  // Detect transaction nature from title
                                  const paymentKeywords = ['payment', 'autopay', 'auto pay', 'statement credit'];
                                  const isPaymentByName = paymentKeywords.some(kw => titleLower.includes(kw));
                                  
                                  // Transfers: "from" = money IN, "to" = money OUT
                                  const isTransferIn = titleLower.includes('transfer from') || titleLower.includes('online transfer from');
                                  const isTransferOut = titleLower.includes('transfer to') || titleLower.includes('online transfer to');
                                  
                                  // Deposits
                                  const isDeposit = titleLower.includes('deposit') || titleLower.includes('direct dep');
                                  
                                  // Determine if this should show as positive (green)
                                  let isPositive = txn.type === 'income';
                                  
                                  // Override based on transaction description
                                  if (isTransferIn || isDeposit) {
                                    isPositive = true;
                                  } else if (isTransferOut) {
                                    isPositive = false;
                                  } else if (isDebtAccount && isPaymentByName) {
                                    // Credit card/loan payment = reduces debt = positive
                                    isPositive = true;
                                  }
                                  
                                  return (
                                    <p className={`font-semibold ${isPositive ? 'text-emerald-500' : 'text-[var(--foreground)]'}`}>
                                      {isPositive ? '+' : '-'}${txn.amount.toLocaleString()}
                                    </p>
                                  );
                                })()}
                                {deleteConfirm === txn.id ? (
                                  <div className="flex items-center gap-2">
                                    <button
                                      onClick={() => handleDelete(txn.id)}
                                      className="text-xs px-2 py-1 rounded bg-red-500 text-white"
                                    >
                                      Confirm
                                    </button>
                                    <button
                                      onClick={() => setDeleteConfirm(null)}
                                      className="text-xs px-2 py-1 rounded bg-[var(--background-tertiary)]"
                                    >
                                      Cancel
                                    </button>
                                  </div>
                                ) : (
                                  <div className="flex items-center gap-1">
                                    <button
                                      onClick={() => {
                                        setEditingTransaction(txn);
                                        setIsAddModalOpen(true);
                                      }}
                                      className="p-2 rounded-lg text-[var(--foreground-muted)] hover:text-[var(--accent-primary)] hover:bg-[var(--accent-primary)]/10 transition-colors"
                                      title="Edit transaction"
                                    >
                                      <Edit2 className="w-4 h-4" />
                                    </button>
                                    <button
                                      onClick={() => setDeleteConfirm(txn.id)}
                                      className="p-2 rounded-lg text-[var(--foreground-muted)] hover:text-red-500 hover:bg-red-500/10 transition-colors"
                                      title="Delete transaction"
                                    >
                                      <Trash2 className="w-4 h-4" />
                                    </button>
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          /* Runway View */
          forecast && (
            <RunwayCalculator
              currentCash={currentCash}
              monthlyExpenses={monthlyStats.avgExpenses || profile?.monthlyBudget || 3000}
              monthlyIncome={monthlyIncome}
              forecast={forecast}
            />
          )
        )}
      </main>

      <AddTransactionModal 
        isOpen={isAddModalOpen} 
        onClose={() => {
          setIsAddModalOpen(false);
          setEditingTransaction(null);
        }}
        editTransaction={editingTransaction}
      />
      <CSVImportModal isOpen={isImportModalOpen} onClose={() => setIsImportModalOpen(false)} />
      <ReceiptScannerModal isOpen={isScannerOpen} onClose={() => setIsScannerOpen(false)} />
    </div>
  );
}

