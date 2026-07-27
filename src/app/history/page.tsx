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
import { generateForecast, calculateCurrentCash, withDerivedBalances } from '@/lib/forecast';
import { classifyTransaction, isPositive, isReward } from '@/lib/classify';
import { pairedLegId } from '@/lib/transfers';
import { EXPENSE_CATEGORIES, Transaction, TransactionType, getMerchantColor, displayCategory } from '@/types';
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
import { currentOf } from '@/lib/accounts';
import { formatMoney } from '@/lib/money';

type ViewMode = 'history' | 'runway';
type DateFilter = 'all' | 'thisMonth' | 'lastMonth' | 'last3Months' | 'last6Months';
type GroupBy = 'month' | 'year' | 'category';

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
  const [typeFilter, setTypeFilter] = useState<'all' | TransactionType>('all');
  // Deep-link from the Accounts page: /history?account=<id> pre-selects that account
  // (drills into one account's transactions + summary, grouped month/year/all-time).
  // Read in the initializer (not an effect) so there's no set-state-in-effect and no
  // useSearchParams prerender bailout; the page SSRs a spinner during auth load, so the
  // client-only initial value can't cause a hydration mismatch.
  const [accountFilter, setAccountFilter] = useState<string>(
    () => (typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('account') || 'all' : 'all')
  );
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
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
      // Must match the classifier, not the stored type — otherwise a card payment
      // stored as 'income' shows under the In chip while contributing $0 to the In total.
      filtered = filtered.filter(t => classifyTransaction(t, profile?.paymentAccounts) === typeFilter);
    }

    // Account filter
    if (accountFilter !== 'all') {
      if (accountFilter === 'unlinked') {
        filtered = filtered.filter(t => !t.accountId);
      } else {
        filtered = filtered.filter(t => t.accountId === accountFilter);
      }
    }

    // Category filter — matches the label the user actually sees (their own Monarch
    // category when present), not the coarse enum underneath.
    if (categoryFilter !== 'all') {
      filtered = filtered.filter(t => displayCategory(t) === categoryFilter);
    }

    // Search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(t =>
        t.title.toLowerCase().includes(query) ||
        t.description?.toLowerCase().includes(query) ||
        displayCategory(t).toLowerCase().includes(query) ||
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
  }, [transactions, dateFilter, typeFilter, accountFilter, categoryFilter, searchQuery, sortOrder, profile?.paymentAccounts]);

  // Every distinct category present, most-used first — drives the filter dropdown so
  // it lists the user's own labels ("AI Tools", "Coffee Shops") rather than the enum.
  const categoryOptions = useMemo(() => {
    const counts = new Map<string, number>();
    transactions.forEach(t => {
      const label = displayCategory(t);
      counts.set(label, (counts.get(label) || 0) + 1);
    });
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([label]) => label);
  }, [transactions]);

  // Group transactions by month or year
  // Transfers between accounts don't count as real income/expense
  const groupedTransactions = useMemo(() => {
    const groups: { [key: string]: { transactions: Transaction[]; income: number; expenses: number } } = {};
    
    filteredTransactions.forEach(t => {
      const groupKey = groupBy === 'month'
        ? format(parseISO(t.date), 'yyyy-MM')
        : groupBy === 'year'
        ? format(parseISO(t.date), 'yyyy')
        : displayCategory(t);

      if (!groups[groupKey]) {
        groups[groupKey] = { transactions: [], income: 0, expenses: 0 };
      }
      groups[groupKey].transactions.push(t);

      const classification = classifyTransaction(t, profile?.paymentAccounts);
      if (classification === 'income') {
        groups[groupKey].income += t.amount;
      } else if (classification === 'expense') {
        groups[groupKey].expenses += t.amount;
      }
      // 'transfer' transactions don't add to income or expense totals
    });

    const entries = Object.entries(groups).map(([key, data]) => ({
      key,
      label: groupBy === 'month' ? format(parseISO(key + '-01'), 'MMMM yyyy') : key,
      ...data,
    }));

    // Time groups read newest-first; category groups read biggest-spend-first, which is
    // what "sort my categories" means when you are looking at where money went.
    return groupBy === 'category'
      ? entries.sort((a, b) => (b.expenses + b.income) - (a.expenses + a.income))
      : entries.sort((a, b) => b.key.localeCompare(a.key));
  }, [filteredTransactions, groupBy, profile?.paymentAccounts]);

  // Calculate totals for stats - excludes transfers between own accounts
  const totals = useMemo(() => {
    let income = 0;
    let expenses = 0;

    filteredTransactions.forEach(t => {
      const classification = classifyTransaction(t, profile?.paymentAccounts);
      if (classification === 'income') {
        income += t.amount;
      } else if (classification === 'expense') {
        expenses += t.amount;
      }
      // 'transfer' transactions don't count
    });
    
    return { income, expenses, net: income - expenses };
  }, [filteredTransactions, profile?.paymentAccounts]);

  // Per-account summary — appears when History is filtered to one account. The metrics
  // shown differ by account type (loan / credit card / bank), computed from the filtered
  // rows with the same classifier the rest of the app uses.
  const accountSummary = useMemo(() => {
    const acct = profile?.paymentAccounts?.find(a => a.id === accountFilter);
    if (!acct) return null;
    let spent = 0, income = 0, inbound = 0, outbound = 0, rewards = 0;
    filteredTransactions.forEach(t => {
      const cls = classifyTransaction(t, profile?.paymentAccounts);
      if (cls === 'expense') spent += t.amount;
      else if (cls === 'income') { income += t.amount; if (isReward(t)) rewards += t.amount; }
      else if (cls === 'transfer') {
        if (isPositive(t, profile?.paymentAccounts)) inbound += t.amount;
        else outbound += t.amount;
      }
    });
    return { acct, spent, income, inbound, outbound, rewards };
  }, [accountFilter, filteredTransactions, profile?.paymentAccounts]);

  // Calculate monthly averages for runway
  const monthlyStats = useMemo(() => {
    const pastTxns = transactions.filter(t => parseISO(t.date) < new Date());
    if (pastTxns.length === 0) {
      return { avgExpenses: profile?.monthlyBudget || 3000, avgIncome: 0 };
    }

    // Both sides go through the one classifier. Previously expenses used the raw
    // `t.type` (so transfers inflated it) while income used a separate credit-card
    // check — a row could therefore be excluded from expenses AND rejected by the
    // income test, evaporating from both. These numbers drive the runway headline.
    const months = new Set(pastTxns.map(t => format(parseISO(t.date), 'yyyy-MM'))).size || 1;
    const totalExpenses = pastTxns
      .filter(t => classifyTransaction(t, profile?.paymentAccounts) === 'expense')
      .reduce((sum, t) => sum + t.amount, 0);
    const totalIncome = pastTxns
      .filter(t => classifyTransaction(t, profile?.paymentAccounts) === 'income')
      .reduce((sum, t) => sum + t.amount, 0);

    return {
      avgExpenses: totalExpenses / months,
      avgIncome: totalIncome / months,
    };
  }, [transactions, profile?.monthlyBudget, profile?.paymentAccounts]);

  // Generate forecast for runway. Balances derived from linked transactions so the
  // runway starts from the real current cash, not the stored opening figure.
  const forecast = useMemo(() => {
    if (!profile) return null;
    const derivedAccounts = withDerivedBalances(profile?.paymentAccounts || [], transactions);
    const currentCash = calculateCurrentCash(derivedAccounts);
    return generateForecast(
      currentCash,
      derivedAccounts,
      profile?.incomeSources || [],
      transactions,
      profile?.settings?.safetyThreshold || 500,
      90
    );
  }, [profile, transactions]);

  const handleDelete = async (id: string) => {
    // A card payment / internal move is TWO paired legs. Deleting only one desyncs the
    // two derived balances, so offer to delete both.
    const other = pairedLegId(id, transactions, profile?.paymentAccounts || []);
    if (other) {
      const both = window.confirm(
        'This is one leg of a transfer between your accounts. Delete BOTH legs?\n\nOK = delete both · Cancel = delete only this one (balances may drift until you reconcile).'
      );
      if (both) await deleteTransaction(other);
    }
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

  const currentCash = calculateCurrentCash(withDerivedBalances(profile?.paymentAccounts || [], transactions));
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
                    ? 'bg-[var(--accent-primary)] text-[#16181c]'
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
                    ? 'bg-[var(--accent-primary)] text-[#16181c]'
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
                        ? 'bg-[var(--accent-primary)] text-[#16181c]'
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
                        ? 'bg-[var(--accent-primary)] text-[#16181c]'
                        : 'text-[var(--foreground-secondary)] hover:bg-[var(--background-tertiary)]'
                    }`}
                  >
                    Month
                  </button>
                  <button
                    onClick={() => setGroupBy('year')}
                    className={`px-2.5 py-1 rounded text-xs font-medium transition-all ${
                      groupBy === 'year'
                        ? 'bg-[var(--accent-primary)] text-[#16181c]'
                        : 'text-[var(--foreground-secondary)] hover:bg-[var(--background-tertiary)]'
                    }`}
                  >
                    Year
                  </button>
                  <button
                    onClick={() => setGroupBy('category')}
                    className={`px-2.5 py-1 rounded text-xs font-medium transition-all ${
                      groupBy === 'category'
                        ? 'bg-[var(--accent-primary)] text-[#16181c]'
                        : 'text-[var(--foreground-secondary)] hover:bg-[var(--background-tertiary)]'
                    }`}
                  >
                    Category
                  </button>
                </div>

                {/* Category filter — populated from the user's own labels */}
                <select
                  value={categoryFilter}
                  onChange={(e) => setCategoryFilter(e.target.value)}
                  className="px-3 py-2 rounded-lg bg-[var(--background)] border border-[var(--border-color)] text-sm text-[var(--foreground-secondary)] cursor-pointer max-w-[180px]"
                >
                  <option value="all">All categories</option>
                  {categoryOptions.map(c => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>

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

            {/* Per-account summary — metrics adapt to the account type */}
            {accountSummary && (() => {
              const { acct, spent, income, inbound, outbound, rewards } = accountSummary;
              const money = (n: number) => formatMoney(n, profile?.currency ?? 'USD', 2);
              // (label, value, color) tiles, chosen by account type
              let tiles: [string, string, string][];
              if (acct.type === 'personal_loan') {
                tiles = [
                  ['Borrowed', money(inbound), 'text-[var(--foreground)]'],
                  ['Paid back', money(outbound), 'text-[var(--foreground)]'],
                  ['Interest / cost', money(Math.max(0, outbound - inbound)), 'text-amber-500'],
                  ['Balance owed', currentOf(acct) > 0 ? money(currentOf(acct)) : 'Paid off', currentOf(acct) > 0 ? 'text-[var(--accent-danger)]' : 'text-emerald-500'],
                ];
              } else if (acct.type === 'credit_card') {
                tiles = [
                  ['Spent (purchases)', money(spent), 'text-[var(--foreground)]'],
                  ['Paid to card', money(inbound), 'text-emerald-500'],
                  ['Rewards earned', money(rewards), 'text-[var(--accent-primary)]'],
                  ['Balance owed', currentOf(acct) > 0 ? money(currentOf(acct)) : 'Paid off', currentOf(acct) > 0 ? 'text-[var(--accent-danger)]' : 'text-emerald-500'],
                ];
              } else {
                tiles = [
                  ['Income in', money(income), 'text-emerald-500'],
                  ['Spent', money(spent), 'text-[var(--accent-danger)]'],
                  ['Transfers in / out', `${money(inbound)} / ${money(outbound)}`, 'text-[var(--foreground-secondary)]'],
                  ['Balance', money(currentOf(acct)), 'text-[var(--foreground)]'],
                ];
              }
              return (
                <div className="mb-6 p-5 rounded-xl bg-[var(--background-secondary)] border border-[var(--border-color)]">
                  <div className="flex items-center gap-2 mb-4">
                    <DollarSign className="w-5 h-5 text-[var(--accent-primary)]" />
                    <h3 className="font-semibold text-[var(--foreground)]">{acct.name} — summary</h3>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                    {tiles.map(([label, value, color]) => (
                      <div key={label}>
                        <p className="text-xs text-[var(--foreground-muted)]">{label}</p>
                        <p className={`text-lg font-bold ${color}`}>{value}</p>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

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
                                    <span className="text-xs">{category?.icon} {displayCategory(txn)}</span>
                                    {txn.description && ` • ${txn.description}`}
                                  </p>
                                </div>
                              </div>
                              <div className="flex items-center gap-4">
                                {/* Smart display based on transaction type and account */}
                                {(() => {
                                  const positive = isPositive(txn, profile?.paymentAccounts);
                                  return (
                                    <p className={`font-semibold ${positive ? 'text-emerald-500' : 'text-[var(--foreground)]'}`}>
                                      {positive ? '+' : '-'}${txn.amount.toLocaleString()}
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

