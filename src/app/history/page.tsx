'use client';

import React, { useEffect, useState, useMemo } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { useTransactions } from '@/context/TransactionContext';
import { useUserProfile } from '@/context/UserProfileContext';
import Navbar from '@/components/Navbar';
import AddTransactionModal from '@/components/AddTransactionModal';
// Lazy (#41): CSVImportModal pulls in `xlsx`, ~836KB, and History rendered it on every
// visit for a modal that is closed until someone clicks Import. `ssr: false` because
// there is nothing to prerender behind a closed dialog.
const CSVImportModal = dynamic(() => import('@/components/CSVImportModal'), { ssr: false });
import ReceiptScannerModal from '@/components/ReceiptScannerModal';
import RunwayCalculator from '@/components/RunwayCalculator';
import InsightsTab from '@/components/InsightsTab';
import { generateForecast, calculateCurrentCash, monthlyAverages, withDerivedBalances } from '@/lib/forecast';
import { classifyTransaction, isPositive, isReward, sumExpenseCents, sumIncomeCents } from '@/lib/classify';
import { pairedLegId } from '@/lib/transfers';
import { executePairedDelete, PairedDeleteChoice } from '@/lib/paired-delete';
import Sheet from '@/components/Sheet';
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
  Camera,
  Sparkles,
} from 'lucide-react';
import { format, parseISO, startOfMonth, subMonths, isWithinInterval } from 'date-fns';
import { currentOf, balanceCaption } from '@/lib/accounts';
import { formatMoney, monthlyIncomeOf } from '@/lib/money';
import { askAbout, askAboutTransaction } from '@/lib/ask';

type ViewMode = 'history' | 'insights' | 'runway';
type DateFilter = 'all' | 'thisMonth' | 'lastMonth' | 'last3Months' | 'last6Months';
type GroupBy = 'month' | 'year' | 'category';

export default function HistoryPage() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { transactions, deleteTransaction, isLoading: txnLoading } = useTransactions();
  const { profile, isLoading: profileLoading, isOnboarded, incomeContext } = useUserProfile();
  const router = useRouter();

  // UI-104: /analytics folded in as the Insights tab; ?tab= deep-links (its old
  // route redirects here). Lazy init, hydration-safe behind the auth gate.
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    if (typeof window === 'undefined') return 'history';
    const t = new URLSearchParams(window.location.search).get('tab');
    return t === 'insights' || t === 'runway' ? t : 'history';
  });
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
  // #28: a paired row awaiting the three-way delete choice (nothing deletes until chosen).
  const [pairedDelete, setPairedDelete] = useState<{ id: string; other: string } | null>(null);
  const [editingTransaction, setEditingTransaction] = useState<Transaction | null>(null);
  // Mobile-only: filters collapse behind a "Filters (n)" toggle; desktop always shows them
  const [filtersOpen, setFiltersOpen] = useState(false);

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
    const byKey = new Map<string, Transaction[]>();
    for (const t of filteredTransactions) {
      const groupKey = groupBy === 'month'
        ? format(parseISO(t.date), 'yyyy-MM')
        : groupBy === 'year'
        ? format(parseISO(t.date), 'yyyy')
        : displayCategory(t);
      const arr = byKey.get(groupKey);
      if (arr) arr.push(t); else byKey.set(groupKey, [t]);
    }

    // The ENGINE's sums, per group — earned income only, confirmed spending included.
    // The per-row classifyTransaction accumulation this replaces counted every inflow
    // as income, which is the drift the runway block below was already fixed for.
    const entries = [...byKey.entries()].map(([key, txns]) => ({
      key,
      label: groupBy === 'month' ? format(parseISO(key + '-01'), 'MMMM yyyy') : key,
      transactions: txns,
      income: sumIncomeCents(txns, profile?.paymentAccounts, incomeContext) / 100,
      expenses: sumExpenseCents(txns, profile?.paymentAccounts, incomeContext) / 100,
    }));

    // Time groups read newest-first; category groups read biggest-spend-first, which is
    // what "sort my categories" means when you are looking at where money went.
    return groupBy === 'category'
      ? entries.sort((a, b) => (b.expenses + b.income) - (a.expenses + a.income))
      : entries.sort((a, b) => b.key.localeCompare(a.key));
  }, [filteredTransactions, groupBy, profile?.paymentAccounts, incomeContext]);

  // The header's In/Out/Net — from the ENGINE, so History can never disagree with
  // Flow or the XLSX export. In = earned income matched to approved sources only;
  // a refund or an unreviewed credit is not "In".
  const totals = useMemo(() => {
    const income = sumIncomeCents(filteredTransactions, profile?.paymentAccounts, incomeContext) / 100;
    const expenses = sumExpenseCents(filteredTransactions, profile?.paymentAccounts, incomeContext) / 100;
    return { income, expenses, net: income - expenses };
  }, [filteredTransactions, profile?.paymentAccounts, incomeContext]);

  // Per-account summary — appears when History is filtered to one account. The metrics
  // shown differ by account type (loan / credit card / bank), computed from the filtered
  // rows with the same classifier the rest of the app uses.
  const accountSummary = useMemo(() => {
    const acct = profile?.paymentAccounts?.find(a => a.id === accountFilter);
    if (!acct) return null;
    // Earned/spent from the engine; transfers and rewards counted separately.
    const spent = sumExpenseCents(filteredTransactions, profile?.paymentAccounts, incomeContext) / 100;
    const income = sumIncomeCents(filteredTransactions, profile?.paymentAccounts, incomeContext) / 100;
    let inbound = 0, outbound = 0, rewards = 0;
    filteredTransactions.forEach(t => {
      const cls = classifyTransaction(t, profile?.paymentAccounts);
      if (cls === 'income' && isReward(t)) rewards += t.amount;
      else if (cls === 'transfer') {
        if (isPositive(t, profile?.paymentAccounts)) inbound += t.amount;
        else outbound += t.amount;
      }
    });
    return { acct, spent, income, inbound, outbound, rewards };
  }, [accountFilter, filteredTransactions, profile?.paymentAccounts, incomeContext]);

  // Calculate monthly averages for runway
  /**
   * The runway headline, from the SAME function the dashboard and forecast use.
   *
   * This used to be a fourth private reduce on this page, and it disagreed twice
   * over: it averaged across every month present (32 on the owner's export) where
   * monthlyAverages() uses the last 6 FULL calendar months, and it counted every
   * classifier-level inflow as income where the rest of the app counts only income
   * matched to an approved source. Measured on the real export, same 6-month
   * window: $11,681.38/mo here against $8,675.00/mo everywhere else — a $3,006.38
   * gap on a figure that drives "how long does my money last".
   *
   * Spending was already right (it agreed to 18¢), but it is derived here too so
   * one function owns both halves.
   */
  const monthlyStats = useMemo(() => {
    const past = transactions.filter(t => parseISO(t.date) < new Date());
    if (past.length === 0) {
      return { avgExpenses: profile?.monthlyBudget || 3000, avgIncome: 0 };
    }
    const avg = monthlyAverages(past, profile?.paymentAccounts || [], 6, incomeContext);
    // A brand-new ledger has no full prior month; fall back rather than show a zero
    // runway on real data.
    if (avg.spending === 0 && avg.income === 0) {
      const months = new Set(past.map(t => format(parseISO(t.date), 'yyyy-MM'))).size || 1;
      // STATE-002: counts what the owner confirmed as spending, like every other total.
      const spent = sumExpenseCents(past, profile?.paymentAccounts, incomeContext) / 100;
      return { avgExpenses: spent / months, avgIncome: 0 };
    }
    return { avgExpenses: avg.spending, avgIncome: avg.income };
  }, [transactions, profile?.monthlyBudget, profile?.paymentAccounts, incomeContext]);

  // Generate forecast for runway. Balances derived from linked transactions so the
  // runway starts from the real current cash, not the stored opening figure.
  const forecast = useMemo(() => {
    if (!profile) return null;
    const derivedAccounts = withDerivedBalances(profile?.paymentAccounts || [], transactions, incomeContext);
    const currentCash = calculateCurrentCash(derivedAccounts);
    return generateForecast(
      currentCash,
      derivedAccounts,
      profile?.incomeSources || [],
      transactions,
      incomeContext,
      profile?.settings?.safetyThreshold || 500,
      90
    );
    // STATE-001 (#105): `incomeContext` MUST be in this list. It was not, so this memo
    // held a forecast computed under the previous policy — flip the pending setting and
    // History's runway silently kept the old answer until something else invalidated it.
  }, [profile, transactions, incomeContext]);

  const handleDelete = async (id: string) => {
    // A card payment / internal move is TWO paired halves. Deleting only one desyncs
    // the two derived balances — but window.confirm can only say OK/Cancel, and Cancel
    // means ABORT everywhere else in the OS; the old dialog deleted on Cancel too and
    // users lost rows (#28). Paired rows now get a real three-choice sheet.
    const other = pairedLegId(id, transactions, profile?.paymentAccounts || []);
    if (other) {
      setPairedDelete({ id, other });
      setDeleteConfirm(null);
      return; // nothing is deleted until a choice is made in the sheet
    }
    await deleteTransaction(id);
    setDeleteConfirm(null);
  };

  const handlePairedChoice = async (choice: PairedDeleteChoice) => {
    if (!pairedDelete) return;
    await executePairedDelete(choice, pairedDelete.id, pairedDelete.other, deleteTransaction);
    setPairedDelete(null);
  };

  if (authLoading || profileLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="bg-pattern" />
        <div className="animate-pulse-glow w-16 h-16 rounded-card bg-gradient-to-br from-[var(--accent-primary)] to-[var(--accent-secondary)] flex items-center justify-center">
          <TrendingUp className="w-8 h-8 text-white" />
        </div>
      </div>
    );
  }

  if (!isAuthenticated) return null;

  // How many filters differ from their defaults — shown on the mobile "Filters" toggle
  const activeFilterCount =
    (searchQuery ? 1 : 0) +
    (dateFilter !== 'all' ? 1 : 0) +
    (typeFilter !== 'all' ? 1 : 0) +
    (accountFilter !== 'all' ? 1 : 0) +
    (categoryFilter !== 'all' ? 1 : 0);

  const currentCash = calculateCurrentCash(withDerivedBalances(profile?.paymentAccounts || [], transactions, incomeContext));
  // ACTIVE sources only: getIncomeSources() now returns paused sources too (so they
  // can be resumed), and a paused source is not money arriving.
  const monthlyIncome = monthlyIncomeOf(profile?.incomeSources?.filter((i) => i.isActive) ?? []) || monthlyStats.avgIncome;

  return (
    <div className="min-h-screen relative">
      <div className="bg-pattern" />
      <Navbar />

      <main className="pt-24 pb-40 md:pb-16 px-4 sm:px-6 lg:px-8 max-w-7xl mx-auto relative z-10">
        {/* Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-8">
          <div>
            <h1 className="text-3xl font-bold text-[var(--foreground)]">Activity</h1>
            <p className="text-[var(--foreground-secondary)] mt-1">
              {viewMode === 'history'
                ? 'View, add, and import your transactions'
                : viewMode === 'insights'
                  ? 'Your spending pace and where it goes'
                  : 'See how long your money will last'}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {/* UI-104: three tabs — Transactions | Insights | Runway */}
            <div className="flex bg-[var(--background-tertiary)] rounded-control p-1">
              {([['history', 'Transactions'], ['insights', 'Insights'], ['runway', 'Runway']] as [ViewMode, string][]).map(([v, label]) => (
                <button
                  key={v}
                  onClick={() => {
                    setViewMode(v);
                    window.history.replaceState(null, '', v === 'history' ? '/history' : `/history?tab=${v}`);
                  }}
                  aria-pressed={viewMode === v}
                  className={`min-h-[44px] px-4 rounded-control text-sm font-medium transition-all ${
                    viewMode === v
                      ? 'bg-[var(--accent-primary)] text-[#16181c]'
                      : 'text-[var(--foreground-secondary)] hover:text-[var(--foreground)]'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {viewMode === 'insights' ? (
          <InsightsTab />
        ) : viewMode === 'history' ? (
          <>
            {/* Compact Header with Actions and Stats */}
            <div className="bg-[var(--background-secondary)] rounded-card border border-[var(--border-color)] p-4 mb-6">
              {/* Top Row - Stats Summary */}
              <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-[var(--border-color)]">
                <div className="flex items-center gap-6">
                  <div className="flex items-center gap-2">
                    <ArrowUpRight className="w-4 h-4 text-emerald-500" />
                    <span className="text-emerald-500 font-semibold tabular-nums">{formatMoney(totals.income, 'USD', 2)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <ArrowDownRight className="w-4 h-4 text-red-400" />
                    <span className="text-red-400 font-semibold tabular-nums">{formatMoney(totals.expenses, 'USD', 2)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <DollarSign className="w-4 h-4 text-[var(--foreground-muted)]" />
                    <span className={`font-semibold ${totals.net >= 0 ? 'text-emerald-500' : 'text-red-400'}`}>
                      {totals.net >= 0 ? '+' : ''}{formatMoney(totals.net, 'USD', 2)}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setIsAddModalOpen(true)}
                    className="btn-primary min-h-[44px] px-3 py-2 text-sm flex items-center gap-2"
                  >
                    <Plus className="w-4 h-4" />
                    Add
                  </button>
                  <button
                    onClick={() => setIsScannerOpen(true)}
                    className="btn-gradient min-h-[44px] px-3 py-2 text-sm flex items-center gap-2"
                  >
                    <Camera className="w-4 h-4" />
                    Scan
                  </button>
                  <button
                    onClick={() => setIsImportModalOpen(true)}
                    className="btn-secondary min-h-[44px] px-3 py-2 text-sm flex items-center gap-2"
                  >
                    <Upload className="w-4 h-4" />
                    Import
                  </button>
                </div>
              </div>

              {/* Mobile-only disclosure toggle for the filters row below */}
              <button
                type="button"
                onClick={() => setFiltersOpen(o => !o)}
                aria-expanded={filtersOpen}
                className="sm:hidden mt-4 w-full min-h-[44px] px-3 py-2 rounded-control bg-[var(--background)] border border-[var(--border-color)] text-sm text-[var(--foreground-secondary)] flex items-center justify-between"
              >
                <span className="flex items-center gap-2">
                  <Filter className="w-4 h-4" />
                  Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
                </span>
                {filtersOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </button>

              {/* Filters Row — always visible on sm+, collapsed behind the toggle on mobile */}
              <div className={`${filtersOpen ? 'flex' : 'hidden sm:flex'} flex-wrap items-center gap-3 pt-4`}>
                {/* Search */}
                <div className="relative flex-1 min-w-[200px]">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--foreground-muted)]" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search..."
                    aria-label="Search transactions"
                    className="w-full py-2 pl-9 pr-3 rounded-control bg-[var(--background)] border border-[var(--border-color)] text-base sm:text-sm text-[var(--foreground)] placeholder:text-[var(--foreground-muted)]"
                  />
                </div>

                {/* Account Dropdown */}
                <select
                  value={accountFilter}
                  onChange={(e) => setAccountFilter(e.target.value)}
                  className="px-3 py-2 rounded-control bg-[var(--background)] border border-[var(--border-color)] text-sm cursor-pointer min-w-[140px]"
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
                  className="px-3 py-2 rounded-control bg-[var(--background)] border border-[var(--border-color)] text-sm text-[var(--foreground-secondary)] cursor-pointer"
                >
                  <option value="all">All Time</option>
                  <option value="thisMonth">This Month</option>
                  <option value="lastMonth">Last Month</option>
                  <option value="last3Months">3 Months</option>
                  <option value="last6Months">6 Months</option>
                </select>

                {/* Type Filter */}
                <div className="flex items-center gap-1 p-1 bg-[var(--background)] rounded-control border border-[var(--border-color)]">
                  <button
                    onClick={() => setTypeFilter('all')}
                    className={`min-h-[44px] px-3 py-1 rounded-control text-xs font-medium transition-all ${
                      typeFilter === 'all'
                        ? 'bg-[var(--accent-primary)] text-[#16181c]'
                        : 'text-[var(--foreground-secondary)] hover:bg-[var(--background-tertiary)]'
                    }`}
                  >
                    All
                  </button>
                  <button
                    onClick={() => setTypeFilter('income')}
                    className={`min-h-[44px] px-3 py-1 rounded-control text-xs font-medium transition-all ${
                      typeFilter === 'income'
                        ? 'bg-emerald-500 text-white'
                        : 'text-emerald-500 hover:bg-emerald-500/10'
                    }`}
                  >
                    In
                  </button>
                  <button
                    onClick={() => setTypeFilter('expense')}
                    className={`min-h-[44px] px-3 py-1 rounded-control text-xs font-medium transition-all ${
                      typeFilter === 'expense'
                        ? 'bg-red-500 text-white'
                        : 'text-red-400 hover:bg-red-500/10'
                    }`}
                  >
                    Out
                  </button>
                </div>

                {/* Group Toggle */}
                <div className="flex items-center gap-1 p-1 bg-[var(--background)] rounded-control border border-[var(--border-color)]">
                  <button
                    onClick={() => setGroupBy('month')}
                    className={`min-h-[44px] px-3 py-1 rounded-control text-xs font-medium transition-all ${
                      groupBy === 'month'
                        ? 'bg-[var(--accent-primary)] text-[#16181c]'
                        : 'text-[var(--foreground-secondary)] hover:bg-[var(--background-tertiary)]'
                    }`}
                  >
                    Month
                  </button>
                  <button
                    onClick={() => setGroupBy('year')}
                    className={`min-h-[44px] px-3 py-1 rounded-control text-xs font-medium transition-all ${
                      groupBy === 'year'
                        ? 'bg-[var(--accent-primary)] text-[#16181c]'
                        : 'text-[var(--foreground-secondary)] hover:bg-[var(--background-tertiary)]'
                    }`}
                  >
                    Year
                  </button>
                  <button
                    onClick={() => setGroupBy('category')}
                    className={`min-h-[44px] px-3 py-1 rounded-control text-xs font-medium transition-all ${
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
                  className="px-3 py-2 rounded-control bg-[var(--background)] border border-[var(--border-color)] text-sm text-[var(--foreground-secondary)] cursor-pointer max-w-[180px]"
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
                  className="px-3 py-2 rounded-control bg-[var(--background)] border border-[var(--border-color)] text-sm text-[var(--foreground-secondary)] cursor-pointer"
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
              // #83 Finding 3: this block is per-account (`acct` is ONE account, filtered
              // to by accountFilter) — not a total, so the disclosure is the same as-of /
              // net-since caption Accounts and the detail modal use for a single account,
              // not <UnanchoredNote> (worded for a total that "includes N" of many).
              // Attached to the tile that actually shows the balance/balance-owed figure,
              // not the whole card, so it can't be read as covering Spent/Paid/Rewards too.
              const caption = balanceCaption(acct, transactions);
              // (label, value, color, caption?) tiles, chosen by account type
              let tiles: [string, string, string, string?][];
              if (acct.type === 'personal_loan') {
                tiles = [
                  ['Borrowed', money(inbound), 'text-[var(--foreground)]'],
                  ['Paid back', money(outbound), 'text-[var(--foreground)]'],
                  ['Interest / cost', money(Math.max(0, outbound - inbound)), 'text-amber-500'],
                  ['Balance owed', currentOf(acct) > 0 ? money(currentOf(acct)) : 'Paid off', currentOf(acct) > 0 ? 'text-[var(--accent-danger)]' : 'text-emerald-500', caption],
                ];
              } else if (acct.type === 'credit_card') {
                tiles = [
                  ['Spent (purchases)', money(spent), 'text-[var(--foreground)]'],
                  ['Paid to card', money(inbound), 'text-emerald-500'],
                  ['Rewards earned', money(rewards), 'text-[var(--accent-primary)]'],
                  ['Balance owed', currentOf(acct) > 0 ? money(currentOf(acct)) : 'Paid off', currentOf(acct) > 0 ? 'text-[var(--accent-danger)]' : 'text-emerald-500', caption],
                ];
              } else {
                tiles = [
                  ['Income in', money(income), 'text-emerald-500'],
                  ['Spent', money(spent), 'text-[var(--accent-danger)]'],
                  ['Transfers in / out', `${money(inbound)} / ${money(outbound)}`, 'text-[var(--foreground-secondary)]'],
                  ['Balance', money(currentOf(acct)), 'text-[var(--foreground)]', caption],
                ];
              }
              return (
                <div className="mb-6 p-5 rounded-card bg-[var(--background-secondary)] border border-[var(--border-color)]">
                  <div className="flex items-center gap-2 mb-4">
                    <DollarSign className="w-5 h-5 text-[var(--accent-primary)]" />
                    <h3 className="font-semibold text-[var(--foreground)]">{acct.name} — summary</h3>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                    {tiles.map(([label, value, color, caption]) => (
                      <div key={label}>
                        <p className="text-xs text-[var(--foreground-muted)]">{label}</p>
                        <p className={`text-lg font-bold ${color}`}>{value}</p>
                        {caption && <p className="text-xs text-[var(--foreground-muted)]">{caption}</p>}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

            {/* Transactions List */}
            {filteredTransactions.length === 0 ? (
              <div className="text-center py-16 bg-[var(--background-secondary)] rounded-card border border-[var(--border-color)]">
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
                  <div key={group.key} className="bg-[var(--background-secondary)] rounded-card border border-[var(--border-color)] overflow-hidden">
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
                        <span className="text-sm text-emerald-500 tabular-nums">+{formatMoney(group.income, 'USD', 2)}</span>
                        <span className="text-sm text-red-400 tabular-nums">-{formatMoney(group.expenses, 'USD', 2)}</span>
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
                              <div className="flex items-center gap-4 max-sm:min-w-0">
                                {/* Show merchant badge or category icon */}
                                {txn.merchant ? (
                                  <div 
                                    className="w-10 h-10 rounded-control flex items-center justify-center text-white font-bold text-sm"
                                    style={{ backgroundColor: merchantColor || undefined }}
                                  >
                                    {txn.merchant.charAt(0).toUpperCase()}
                                  </div>
                                ) : (
                                  <div className="w-10 h-10 rounded-control bg-[var(--background-tertiary)] flex items-center justify-center text-xl">
                                    {category?.icon || '📋'}
                                  </div>
                                )}
                                <div className="max-sm:min-w-0">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    {/* max-sm: long titles ellipsize instead of wrapping the 360px row */}
                                    <p className="font-medium text-[var(--foreground)] max-sm:min-w-0 max-sm:truncate">{txn.title}</p>
                                    {/* A hold is excluded from this group's +/- header (classify.ts:
                                        `held` → income/expense 'excluded'). Without this badge the row
                                        reads as counted money and the header looks broken — which is
                                        exactly how a pending payroll credit made In show $0.00. */}
                                    {txn.pending && <span className="badge badge-projected flex-shrink-0">Pending</span>}
                                    {txn.merchant && (
                                      <span 
                                        className="text-xs px-2 py-1 rounded-pill text-white"
                                        style={{ backgroundColor: merchantColor || undefined }}
                                      >
                                        {txn.merchant}
                                      </span>
                                    )}
                                    {linkedAccount && (
                                      <span 
                                        className="text-xs px-2 py-1 rounded-pill border"
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
                                    <p className={`font-semibold ${txn.pending ? 'text-[var(--foreground-muted)]' : positive ? 'text-emerald-500' : 'text-[var(--foreground)]'}`}>
                                      {positive ? '+' : '-'}{formatMoney(txn.amount, 'USD', 2)}
                                    </p>
                                  );
                                })()}
                                {deleteConfirm === txn.id ? (
                                  <div className="flex items-center gap-2">
                                    <button
                                      onClick={() => handleDelete(txn.id)}
                                      aria-label={`Confirm delete ${txn.title}`}
                                      className="text-xs px-2 py-1 rounded-control bg-red-500 text-white max-sm:min-w-[44px] max-sm:min-h-[44px]"
                                    >
                                      Confirm
                                    </button>
                                    <button
                                      onClick={() => setDeleteConfirm(null)}
                                      aria-label="Cancel delete"
                                      className="text-xs px-2 py-1 rounded-control bg-[var(--background-tertiary)] max-sm:min-w-[44px] max-sm:min-h-[44px]"
                                    >
                                      Cancel
                                    </button>
                                  </div>
                                ) : (
                                  <div className="flex items-center gap-1">
                                    {/* The owner's chat-first rule: any transaction is a
                                        conversation. The question ships the row AND its
                                        account neighbours, so "the next one" means something. */}
                                    <button
                                      onClick={() => askAbout(askAboutTransaction(txn, profile?.paymentAccounts ?? [], transactions))}
                                      aria-label={`Ask about ${txn.title}`}
                                      className="p-2 rounded-control text-[var(--foreground-muted)] hover:text-[var(--accent-primary)] hover:bg-[var(--accent-primary)]/10 transition-colors max-sm:min-w-[44px] max-sm:min-h-[44px] flex items-center justify-center"
                                      title="Ask about this transaction"
                                    >
                                      <Sparkles className="w-4 h-4" />
                                    </button>
                                    <button
                                      onClick={() => {
                                        setEditingTransaction(txn);
                                        setIsAddModalOpen(true);
                                      }}
                                      aria-label={`Edit ${txn.title}`}
                                      className="p-2 rounded-control text-[var(--foreground-muted)] hover:text-[var(--accent-primary)] hover:bg-[var(--accent-primary)]/10 transition-colors max-sm:min-w-[44px] max-sm:min-h-[44px] flex items-center justify-center"
                                      title="Edit transaction"
                                    >
                                      <Edit2 className="w-4 h-4" />
                                    </button>
                                    <button
                                      onClick={() => setDeleteConfirm(txn.id)}
                                      aria-label={`Delete ${txn.title}`}
                                      className="p-2 rounded-control text-[var(--foreground-muted)] hover:text-red-500 hover:bg-red-500/10 transition-colors max-sm:min-w-[44px] max-sm:min-h-[44px] flex items-center justify-center"
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

      {/* #28: three-way paired delete — Keep both is a true abort */}
      <Sheet
        open={pairedDelete !== null}
        onClose={() => setPairedDelete(null)}
        ariaLabel="Delete a paired transfer"
        className="p-6"
      >
        <h3 className="text-lg font-semibold text-[var(--foreground)] mb-2">
          This payment is half of a transfer
        </h3>
        <p className="text-sm text-[var(--foreground-secondary)] mb-5">
          It has a matching entry in the other account. Deleting only one half can make
          the two account balances stop matching your bank.
        </p>
        <div className="flex flex-col gap-2">
          <button
            onClick={() => handlePairedChoice('both')}
            className="btn-primary min-h-[44px] px-4 rounded-control font-semibold"
          >
            Delete both halves
          </button>
          <button
            onClick={() => handlePairedChoice('one')}
            className="btn-secondary min-h-[44px] px-4 rounded-control font-medium"
          >
            Delete only this one
          </button>
          <button
            onClick={() => setPairedDelete(null)}
            className="min-h-[44px] px-4 rounded-control font-medium text-[var(--foreground-secondary)] hover:text-[var(--foreground)]"
          >
            Keep both
          </button>
        </div>
      </Sheet>

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

