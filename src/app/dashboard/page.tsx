'use client';

import React, { useEffect, useState } from 'react';
import { formatMoney } from '@/lib/money';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { useTransactions } from '@/context/TransactionContext';
import { useUserProfile } from '@/context/UserProfileContext';
import Navbar from '@/components/Navbar';
import AddTransactionModal from '@/components/AddTransactionModal';
import { PAYMENT_METHODS, EXPENSE_CATEGORIES } from '@/types';
import { isPositive } from '@/lib/classify';
import {
  TrendingUp,
  CreditCard,
  Calendar,
  Filter,
  ChevronRight,
  AlertCircle,
  Settings,
  ArrowRight,
} from 'lucide-react';
import { format, parseISO, isAfter, startOfDay } from 'date-fns';
import { generateForecast, calculateCurrentCash, withDerivedBalances, monthlyAverages } from '@/lib/forecast';
import { currentOf } from '@/lib/accounts';
import { clampedMonthlyDate } from '@/lib/dates';
import { homeSummary } from '@/lib/home';
import { nonNegotiableMonthly, Bill } from '@/lib/bills';
import * as firestoreService from '@/lib/firestore';

export default function DashboardPage() {
  const { isAuthenticated, isLoading: authLoading, user } = useAuth();
  const {
    transactions,
    isLoading: txnLoading,
    getPastTransactions,
    getFutureTransactions,
  } = useTransactions();
  const { profile, isLoading: profileLoading, isOnboarded, incomeContext } = useUserProfile();
  const router = useRouter();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [filter, setFilter] = useState<'all' | 'past' | 'future'>('all');
  // UI-102: the locked (non-negotiable) bills feed the hero's reserved chip.
  const [bills, setBills] = useState<Bill[]>([]);
  useEffect(() => {
    if (!user?.id) return;
    let alive = true;
    firestoreService.getBills(user.id).then((rows) => { if (alive) setBills(rows); });
    return () => { alive = false; };
  }, [user?.id]);

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
  
  

  // incomeContext is load-bearing, not decoration: without it interpretTransaction
  // has no approved sources to match and counts NOTHING as income, so this chart
  // rendered $0 income over the whole ledger for every user. pastExpenses two lines
  // above always passed it; these three had no parameter to pass it to.

  // Balances are derived from linked transactions (opening balance + past effects),
  // so every card/total/forecast below reflects reality, not the stored opening figure.
  const derivedAccounts = withDerivedBalances(profile?.paymentAccounts || [], transactions);

  // Calculate account summaries

  const totalCreditUsed = derivedAccounts
    .filter((a) => a.type === 'credit_card')
    .reduce((sum, a) => sum + currentOf(a), 0);




  // ACTIVE sources only — a paused source is still stored (so it can be resumed) but
  // must not be claimed as income.
  // Fall back to a figure DERIVED from the last 6 months of transactions when the user
  // hasn't hand-entered income sources / a budget — so these never show a bare $0.
  const derivedMonthly = monthlyAverages(transactions, derivedAccounts, 6, incomeContext);

  // UI-102: the hero's numbers — one computation (lib/home.ts), tested there.
  const home = homeSummary({
    currentCash: calculateCurrentCash(derivedAccounts),
    avgMonthlyExpense: derivedMonthly.spending,
    cardsOwed: totalCreditUsed,
    lockedMonthly: nonNegotiableMonthly(bills),
    today: new Date(),
  });

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
        // #30: clamp the due DAY to the month's length — new Date(y, m, 31) in a
        // 30-day month silently rolls into next month and shows a wrong due date.
        let dueDate = clampedMonthlyDate(currentYear, currentMonth, account.dueDate!);

        // If due date has passed this month, move to next month
        if (account.dueDate! < currentDay) {
          dueDate = clampedMonthlyDate(currentYear, currentMonth + 1, account.dueDate!);
        }
        
        const daysUntilDue = Math.ceil((dueDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
        
        return {
          ...account,
          balanceDue: currentOf(account),
          dueDate: dueDate,
          daysUntilDue,
        };
      })
      .sort((a, b) => a.daysUntilDue - b.daysUntilDue);
  };

  const upcomingBills = getUpcomingBills();

  // Prepare chart data

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

        {/* UI-102: the runway hero — one number owns this screen. Everything the
            old dashboard shouted (5 stat cards, 4 account tiles, 3 charts, income
            panel) either lives here as one quiet chip or on the screen that owns it. */}
        <h1 className="sr-only">Home</h1>
        {!setupIncomplete && (
          <section className="mb-6 p-5 lg:p-6 rounded-2xl bg-[var(--background-secondary)] border border-[var(--border-color)]">
            <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--accent-primary)]">Runway</p>
            {txnLoading ? (
              <div className="animate-pulse mt-2 space-y-3">
                <div className="h-9 w-48 rounded bg-[var(--background-tertiary)]" />
                <div className="h-4 w-64 rounded bg-[var(--background-tertiary)]" />
                <div className="h-2 w-full rounded bg-[var(--background-tertiary)]" />
              </div>
            ) : (
              <>
                <p className="hero-number text-[var(--foreground)] mt-1">
                  {format(home.runwayDate, 'MMM d, yyyy')}
                </p>
                <p className="text-sm text-[var(--foreground-secondary)] mt-1 tnum">
                  Cash lasts {home.runwayMonths} month{home.runwayMonths === 1 ? '' : 's'} at your real spending
                </p>
                <div className="mt-4 h-2 rounded-full bg-[var(--background-tertiary)] overflow-hidden" role="img" aria-label={`${Math.round(home.reserveProgress * 100)}% of the 5-month reserve target`}>
                  <div className="h-full rounded-full bg-[var(--progress)] transition-all" style={{ width: `${home.reserveProgress * 100}%` }} />
                </div>
                <p className="text-xs text-[var(--foreground-muted)] mt-1.5 tnum">
                  {Math.round(home.reserveProgress * 100)}% of the 5-month reserve target
                </p>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  {forecast && (
                    <span className={`px-3 py-1.5 rounded-full text-sm font-medium tnum bg-[var(--background-tertiary)] ${forecast.lowestBalance < (profile?.settings?.safetyThreshold || 500) ? 'text-[var(--money-out)]' : 'text-[var(--foreground-secondary)]'}`}>
                      Lowest in 90 days: {formatMoney(forecast.lowestBalance, profile?.currency, 2)}
                    </span>
                  )}
                  {home.cardsOwed > 0 && (
                    <span className="px-3 py-1.5 rounded-full text-sm font-medium tnum bg-[var(--background-tertiary)] text-[var(--money-out)]">
                      Cards owed: {formatMoney(-home.cardsOwed, profile?.currency, 2)}
                    </span>
                  )}
                  {home.lockedMonthly > 0 && (
                    <span className="px-3 py-1.5 rounded-full text-sm font-medium tnum bg-[var(--background-tertiary)] text-[var(--accent-primary)]">
                      🔒 {formatMoney(home.lockedMonthly, profile?.currency, 2)}/mo locked
                    </span>
                  )}
                  <Link href="/forecast" className="px-3 py-1.5 rounded-full text-sm font-medium text-[var(--accent-primary)] hover:underline">
                    Full forecast →
                  </Link>
                  <Link href="/accounts" className="px-3 py-1.5 rounded-full text-sm font-medium text-[var(--accent-primary)] hover:underline">
                    Accounts →
                  </Link>
                </div>
              </>
            )}
          </section>
        )}

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
                        {formatMoney(bill.balanceDue, profile?.currency, 2)}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Recent Transactions */}
        <div className="glass-card p-6">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
            <h3 className="text-lg font-semibold text-[var(--foreground)]">Recent Transactions</h3>
            {/* UI-102: 3 choices = 3 visible segments (a select is two taps and
                hides the active state; audit wrongControl). Plain words: no
                'Projected' jargon. */}
            <div className="flex items-center gap-1.5 p-1 rounded-lg bg-[var(--background-tertiary)]" role="group" aria-label="Filter transactions">
              {([['all', 'All'], ['past', 'Past'], ['future', 'Upcoming']] as const).map(([value, label]) => (
                <button
                  key={value}
                  onClick={() => setFilter(value)}
                  aria-pressed={filter === value}
                  className={`min-h-[44px] px-4 rounded-md text-sm font-semibold transition-all ${
                    filter === value
                      ? 'bg-[var(--accent-primary)] text-[#16181c]'
                      : 'text-[var(--foreground-secondary)] hover:text-[var(--foreground)]'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-3">
            {recentTransactions.length === 0 ? (
              // UI-102: the empty copy must tell the truth about WHICH filter is
              // empty — "No transactions yet" while hundreds exist was a lie.
              <div className="text-center py-12">
                <Calendar className="w-16 h-16 text-[var(--foreground-muted)] mx-auto mb-4" />
                {transactions.length === 0 ? (
                  <>
                    <h3 className="text-lg font-medium text-[var(--foreground)] mb-2">No transactions yet</h3>
                    <p className="text-[var(--foreground-secondary)] mb-4">Start tracking your expenses</p>
                    <button onClick={() => setIsModalOpen(true)} className="btn-primary">
                      Add First Transaction
                    </button>
                  </>
                ) : (
                  <h3 className="text-lg font-medium text-[var(--foreground)]">
                    {filter === 'future' ? 'Nothing scheduled ahead' : 'Nothing in this view'}
                  </h3>
                )}
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
                      {isExpense ? '-' : '+'}{formatMoney(txn.amount, profile?.currency, 2)}
                    </p>
                  </div>
                );
              })
            )}
          </div>

          {transactions.length > 8 && (
            // #30: the label promises the transactions list — send it there (and as a
            // real link, not a button pretending to be one).
            <Link
              href="/history"
              className="w-full mt-4 py-3 rounded-xl bg-[var(--background-tertiary)] text-[var(--foreground-secondary)] hover:text-[var(--foreground)] hover:bg-[var(--background-secondary)] transition-all flex items-center justify-center gap-2"
            >
              View All Transactions
              <ChevronRight className="w-4 h-4" />
            </Link>
          )}
        </div>
      </main>

      <AddTransactionModal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} />
    </div>
  );
}
