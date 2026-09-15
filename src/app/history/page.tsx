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
import { withDerivedBalances } from '@/lib/forecast';
import { classifyTransaction, isPositive, isReward, sumExpenseCents, sumIncomeCents } from '@/lib/classify';
import { pairedLegId } from '@/lib/transfers';
import { executePairedDelete, PairedDeleteChoice } from '@/lib/paired-delete';
import Sheet from '@/components/Sheet';
import { Transaction, TransactionType, displayCategory } from '@/types';
import {
  Upload,
  Calendar,
  Search,
  Filter,
  Trash2,
  Edit2,
  ChevronDown,
  ChevronUp,
  DollarSign,
  Camera,
  Sparkles,
  MoreHorizontal,
} from 'lucide-react';
import { format, parseISO, startOfMonth, subMonths, isWithinInterval } from 'date-fns';
import { currentOf, balanceCaption } from '@/lib/accounts';
import { formatMoney } from '@/lib/money';
import { askAbout, askAboutTransaction } from '@/lib/ask';
import LoadingScreen from '@/components/LoadingScreen';
import Link from 'next/link';
import { displayName } from '@/lib/merchant';

type DateFilter = 'all' | 'thisMonth' | 'lastMonth' | 'last3Months' | 'last6Months';
type GroupBy = 'month' | 'year' | 'category';

export default function HistoryPage() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { transactions, deleteTransaction, isLoading: txnLoading } = useTransactions();
  const { profile, isLoading: profileLoading, isOnboarded, incomeContext } = useUserProfile();
  const router = useRouter();

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
  // Phones: one "More" button per row opens this sheet instead of three 44px icons,
  // which left the title about 120px and crushed every row (owner screenshot, 390px).
  const [rowActions, setRowActions] = useState<Transaction | null>(null);
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

  // CRITICAL-4 (#14): the feedless double-count guard lives on `feedCoveredPeriods`,
  // a field withDerivedBalances() attaches IN MEMORY — it is never on the raw profile
  // accounts. Every classify/forecast call below must read THIS, not
  // profile?.paymentAccounts directly, or the guard silently never trips (measured:
  // $1,400 vs $600 for the same month between two screens reading different account
  // lists). One memo so every computation on this page agrees with every other page
  // that already does this (e.g. Accounts).
  const derivedAccounts = useMemo(
    () => withDerivedBalances(profile?.paymentAccounts || [], transactions, incomeContext),
    [profile?.paymentAccounts, transactions, incomeContext]
  );

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
      filtered = filtered.filter(t => classifyTransaction(t, derivedAccounts) === typeFilter);
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
  }, [transactions, dateFilter, typeFilter, accountFilter, categoryFilter, searchQuery, sortOrder, derivedAccounts]);

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
      income: sumIncomeCents(txns, derivedAccounts, incomeContext) / 100,
      expenses: sumExpenseCents(txns, derivedAccounts, incomeContext) / 100,
    }));

    // Time groups read newest-first; category groups read biggest-spend-first, which is
    // what "sort my categories" means when you are looking at where money went.
    return groupBy === 'category'
      ? entries.sort((a, b) => (b.expenses + b.income) - (a.expenses + a.income))
      : entries.sort((a, b) => b.key.localeCompare(a.key));
  }, [filteredTransactions, groupBy, derivedAccounts, incomeContext]);

  // The header's In/Out/Net — from the ENGINE, so History can never disagree with
  // Flow or the XLSX export. In = earned income matched to approved sources only;
  // a refund or an unreviewed credit is not "In".
  const totals = useMemo(() => {
    const income = sumIncomeCents(filteredTransactions, derivedAccounts, incomeContext) / 100;
    const expenses = sumExpenseCents(filteredTransactions, derivedAccounts, incomeContext) / 100;
    return { income, expenses, net: income - expenses };
  }, [filteredTransactions, derivedAccounts, incomeContext]);

  // Per-account summary — appears when History is filtered to one account. The metrics
  // shown differ by account type (loan / credit card / bank), computed from the filtered
  // rows with the same classifier the rest of the app uses.
  const accountSummary = useMemo(() => {
    const acct = derivedAccounts.find(a => a.id === accountFilter);
    if (!acct) return null;
    // Earned/spent from the engine; transfers and rewards counted separately.
    const spent = sumExpenseCents(filteredTransactions, derivedAccounts, incomeContext) / 100;
    const income = sumIncomeCents(filteredTransactions, derivedAccounts, incomeContext) / 100;
    let inbound = 0, outbound = 0, rewards = 0;
    filteredTransactions.forEach(t => {
      const cls = classifyTransaction(t, derivedAccounts);
      if (cls === 'income' && isReward(t)) rewards += t.amount;
      else if (cls === 'transfer') {
        if (isPositive(t, derivedAccounts)) inbound += t.amount;
        else outbound += t.amount;
      }
    });
    return { acct, spent, income, inbound, outbound, rewards };
  }, [accountFilter, filteredTransactions, derivedAccounts, incomeContext]);

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
      <LoadingScreen />
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

  return (
    <div className="min-h-screen relative">
      <div className="bg-pattern" />
      <Navbar />

      <main className="pt-24 pb-24 md:pb-16 px-4 sm:px-6 lg:px-8 max-w-7xl mx-auto relative z-10">
        {/* Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-8">
          <div>
            <h1 className="text-3xl font-bold text-[var(--foreground)]">Activity</h1>
            <p className="text-[var(--foreground-secondary)] mt-1">
              Every transaction, newest first
            </p>
            {/* Flow is not a tab (UI spec B1); this is how a phone gets there. */}
            <Link
              href="/flow"
              className="tap-target inline-block mt-2 text-sm font-medium text-[var(--accent-primary)] hover:text-[var(--accent-secondary)]"
            >
              View as flow →
            </Link>
          </div>
        </div>

        {/* Activity is the list (tonight's queue, #196). Its Insights and Runway tabs are
            gone: spending pace belongs with Flow (#199), what-if runway with Forecast (#198);
            /analytics now redirects to /flow. The components are kept for those homes. */}
        <>
            {/* Compact Header with Actions and Stats */}
            <div className="bg-[var(--background-secondary)] rounded-card border border-[var(--border-color)] p-4 mb-6">
              {/* Top Row - Stats Summary. A labelled 3-column grid: the old unwrapped row of
                  three figures ran 4px past a 390px screen (#177). Money tokens only. Add is
                  not repeated here; the header Add (phone) / corner FAB (desktop) is the one. */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-[var(--border-color)]">
                <dl className="grid grid-cols-3 gap-3 sm:gap-6 min-w-0">
                  <div className="min-w-0">
                    <dt className="text-xs text-[var(--foreground-muted)]">In</dt>
                    <dd className="font-semibold tnum truncate text-[var(--money-in)]">{formatMoney(totals.income, 'USD', 2)}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-xs text-[var(--foreground-muted)]">Out</dt>
                    <dd className="font-semibold tnum truncate text-[var(--money-out)]">{formatMoney(totals.expenses, 'USD', 2)}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-xs text-[var(--foreground-muted)]">Net</dt>
                    <dd className={`font-semibold tnum truncate ${totals.net >= 0 ? 'text-[var(--money-in)]' : 'text-[var(--money-out)]'}`}>
                      {totals.net >= 0 ? '+' : '−'}{formatMoney(Math.abs(totals.net), 'USD', 2)}
                    </dd>
                  </div>
                </dl>
                <div className="flex items-center gap-2">
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
                  aria-label="Account"
                  className="px-3 py-2 rounded-control bg-[var(--background)] border border-[var(--border-color)] text-sm text-[var(--foreground-secondary)] cursor-pointer min-w-[140px] max-w-full"
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
                        ? 'bg-[var(--money-in)] text-[var(--background)]'
                        : 'text-[var(--money-in)] hover:bg-[var(--background-tertiary)]'
                    }`}
                  >
                    In
                  </button>
                  <button
                    onClick={() => setTypeFilter('expense')}
                    className={`min-h-[44px] px-3 py-1 rounded-control text-xs font-medium transition-all ${
                      typeFilter === 'expense'
                        ? 'bg-[var(--money-out)] text-[var(--background)]'
                        : 'text-[var(--money-out)] hover:bg-[var(--background-tertiary)]'
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
                  ['Interest / cost', money(Math.max(0, outbound - inbound)), 'text-[var(--accent-warning)]'],
                  ['Balance owed', currentOf(acct) > 0 ? money(currentOf(acct)) : 'Paid off', currentOf(acct) > 0 ? 'text-[var(--money-out)]' : 'text-[var(--money-in)]', caption],
                ];
              } else if (acct.type === 'credit_card') {
                tiles = [
                  ['Spent (purchases)', money(spent), 'text-[var(--foreground)]'],
                  ['Paid to card', money(inbound), 'text-[var(--money-in)]'],
                  ['Rewards earned', money(rewards), 'text-[var(--accent-primary)]'],
                  ['Balance owed', currentOf(acct) > 0 ? money(currentOf(acct)) : 'Paid off', currentOf(acct) > 0 ? 'text-[var(--money-out)]' : 'text-[var(--money-in)]', caption],
                ];
              } else {
                tiles = [
                  ['Income in', money(income), 'text-[var(--money-in)]'],
                  ['Spent', money(spent), 'text-[var(--money-out)]'],
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
                    {/* Group Header — label and count stacked left, in/out stacked right, so a
                        390px screen never has to fit four fragments on one line. */}
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
                      aria-expanded={!collapsedGroups.has(group.key)}
                      className="w-full px-4 py-3 flex items-center justify-between gap-3 text-left hover:bg-[var(--background-tertiary)] transition-colors"
                    >
                      <div className="min-w-0">
                        <p className="font-semibold text-[var(--foreground)] truncate">{group.label}</p>
                        <p className="text-xs text-[var(--foreground-muted)]">
                          {group.transactions.length} transaction{group.transactions.length !== 1 ? 's' : ''}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <div className="text-right text-sm tnum leading-tight">
                          <p className="text-[var(--money-in)]">+{formatMoney(group.income, 'USD', 2)}</p>
                          <p className="text-[var(--money-out)]">−{formatMoney(group.expenses, 'USD', 2)}</p>
                        </div>
                        {collapsedGroups.has(group.key) ? (
                          <ChevronDown className="w-5 h-5 text-[var(--foreground-muted)]" aria-hidden="true" />
                        ) : (
                          <ChevronUp className="w-5 h-5 text-[var(--foreground-muted)]" aria-hidden="true" />
                        )}
                      </div>
                    </button>

                    {/* Transactions */}
                    {!collapsedGroups.has(group.key) && (
                      <ul className="border-t border-[var(--border-color)]">
                        {group.transactions.map((txn) => {
                          const linkedAccount = txn.accountId
                            ? profile?.paymentAccounts?.find(a => a.id === txn.accountId)
                            : null;
                          const positive = isPositive(txn, derivedAccounts);
                          // A transfer moves money between the owner's own accounts: never
                          // painted as spend or income (invariant 5). Pending: not counted yet.
                          const isTransfer = classifyTransaction(txn, derivedAccounts) === 'transfer';
                          const amountColor = txn.pending || isTransfer
                            ? 'text-[var(--foreground-muted)]'
                            : positive ? 'text-[var(--money-in)]' : 'text-[var(--money-out)]';
                          return (
                            // One line of name + one line of detail + one amount. The old row
                            // stacked an avatar, a Pending badge, a merchant pill and a
                            // wrapping account pill beside three icons, so on a phone each row
                            // ran several hundred pixels tall and the amount split in two.
                            <li
                              key={txn.id}
                              className="px-4 py-3 flex items-center gap-3 hover:bg-[var(--background-tertiary)] border-b border-[var(--border-color)] last:border-b-0"
                            >
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2 min-w-0">
                                  {/* Full string kept in `title`: the reference blob is the only
                                      handle on a mystery charge. */}
                                  <p className="font-medium text-[var(--foreground)] truncate" title={txn.title}>
                                    {displayName(txn.title)}
                                  </p>
                                  {/* A hold is excluded from this group's +/- header (classify.ts:
                                      `held` → income/expense 'excluded'). Without this badge the row
                                      reads as counted money and the header looks broken. */}
                                  {txn.pending && <span className="badge badge-projected flex-shrink-0">Pending</span>}
                                  {isTransfer && (
                                    <span className="flex-shrink-0 px-2 py-0.5 rounded-pill text-[11px] font-medium bg-[var(--background-tertiary)] text-[var(--foreground-secondary)]">
                                      Transfer
                                    </span>
                                  )}
                                </div>
                                <p className="text-xs text-[var(--foreground-muted)] truncate" title={txn.description || undefined}>
                                  {format(parseISO(txn.date), 'MMM d, yyyy')}
                                  {linkedAccount && ` · ${linkedAccount.name}${linkedAccount.lastFourDigits ? ` ··${linkedAccount.lastFourDigits}` : ''}`}
                                  {` · ${displayCategory(txn)}`}
                                  {txn.description && ` · ${txn.description}`}
                                </p>
                              </div>
                              <p className={`font-semibold tnum whitespace-nowrap flex-shrink-0 ${amountColor}`}>
                                {positive ? '+' : '−'}{formatMoney(txn.amount, 'USD', 2)}
                              </p>
                              {deleteConfirm === txn.id ? (
                                <div className="flex items-center gap-2 flex-shrink-0">
                                  <button
                                    onClick={() => handleDelete(txn.id)}
                                    aria-label={`Confirm delete ${txn.title}`}
                                    className="text-xs px-2 py-1 rounded-control bg-[var(--money-out)] text-[var(--background)] min-w-[44px] min-h-[44px]"
                                  >
                                    Confirm
                                  </button>
                                  <button
                                    onClick={() => setDeleteConfirm(null)}
                                    aria-label="Cancel delete"
                                    className="text-xs px-2 py-1 rounded-control bg-[var(--background-tertiary)] min-w-[44px] min-h-[44px]"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              ) : (
                                <>
                                  {/* Phone: one button, the three actions live in a sheet. */}
                                  <button
                                    onClick={() => setRowActions(txn)}
                                    aria-label={`More actions for ${txn.title}`}
                                    className="sm:hidden flex-shrink-0 w-11 h-11 -mr-2 rounded-control flex items-center justify-center text-[var(--foreground-muted)] hover:bg-[var(--background-tertiary)]"
                                  >
                                    <MoreHorizontal className="w-5 h-5" aria-hidden="true" />
                                  </button>
                                  <div className="hidden sm:flex items-center gap-1 flex-shrink-0">
                                    {/* The owner's chat-first rule: any transaction is a
                                        conversation. The question ships the row AND its
                                        account neighbours, so "the next one" means something. */}
                                    <button
                                      onClick={() => askAbout(askAboutTransaction(txn, profile?.paymentAccounts ?? [], transactions))}
                                      aria-label={`Ask about ${txn.title}`}
                                      className="p-2 rounded-control text-[var(--foreground-muted)] hover:text-[var(--accent-primary)] hover:bg-[var(--background-tertiary)] transition-colors flex items-center justify-center"
                                      title="Ask about this transaction"
                                    >
                                      <Sparkles className="w-4 h-4" aria-hidden="true" />
                                    </button>
                                    <button
                                      onClick={() => {
                                        setEditingTransaction(txn);
                                        setIsAddModalOpen(true);
                                      }}
                                      aria-label={`Edit ${txn.title}`}
                                      className="p-2 rounded-control text-[var(--foreground-muted)] hover:text-[var(--accent-primary)] hover:bg-[var(--background-tertiary)] transition-colors flex items-center justify-center"
                                      title="Edit transaction"
                                    >
                                      <Edit2 className="w-4 h-4" aria-hidden="true" />
                                    </button>
                                    <button
                                      onClick={() => setDeleteConfirm(txn.id)}
                                      aria-label={`Delete ${txn.title}`}
                                      className="p-2 rounded-control text-[var(--foreground-muted)] hover:text-[var(--money-out)] hover:bg-[var(--background-tertiary)] transition-colors flex items-center justify-center"
                                      title="Delete transaction"
                                    >
                                      <Trash2 className="w-4 h-4" aria-hidden="true" />
                                    </button>
                                  </div>
                                </>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            )}
        </>
      </main>

      {/* Phone row actions — the same three as the desktop icons. Delete hands off to the
          row's inline Confirm, so paired rows still reach the #28 three-way sheet. */}
      <Sheet
        open={rowActions !== null}
        onClose={() => setRowActions(null)}
        ariaLabel="Transaction actions"
        className="p-4"
      >
        {rowActions && (
          <>
            <p className="font-semibold text-[var(--foreground)] truncate mb-1" title={rowActions.title}>
              {displayName(rowActions.title)}
            </p>
            <p className="text-sm text-[var(--foreground-muted)] tnum mb-4">
              {format(parseISO(rowActions.date), 'MMM d, yyyy')} · {formatMoney(rowActions.amount, 'USD', 2)}
            </p>
            <div className="flex flex-col gap-2">
              <button
                onClick={() => {
                  const txn = rowActions;
                  setRowActions(null);
                  askAbout(askAboutTransaction(txn, profile?.paymentAccounts ?? [], transactions));
                }}
                className="min-h-[44px] px-4 rounded-control flex items-center gap-3 bg-[var(--background-tertiary)] text-[var(--foreground)] font-medium"
              >
                <Sparkles className="w-4 h-4 text-[var(--accent-primary)]" aria-hidden="true" /> Ask about this
              </button>
              <button
                onClick={() => {
                  const txn = rowActions;
                  setRowActions(null);
                  setEditingTransaction(txn);
                  setIsAddModalOpen(true);
                }}
                className="min-h-[44px] px-4 rounded-control flex items-center gap-3 bg-[var(--background-tertiary)] text-[var(--foreground)] font-medium"
              >
                <Edit2 className="w-4 h-4" aria-hidden="true" /> Edit
              </button>
              <button
                onClick={() => {
                  const id = rowActions.id;
                  setRowActions(null);
                  setDeleteConfirm(id);
                }}
                className="min-h-[44px] px-4 rounded-control flex items-center gap-3 bg-[var(--background-tertiary)] text-[var(--money-out)] font-medium"
              >
                <Trash2 className="w-4 h-4" aria-hidden="true" /> Delete
              </button>
            </div>
          </>
        )}
      </Sheet>

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

