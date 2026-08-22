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
  Calendar,
  ChevronRight,
  AlertCircle,
  Settings,
  ArrowRight,
} from 'lucide-react';
import { format, parseISO, isAfter, startOfDay } from 'date-fns';
import { generateForecast, calculateCurrentCash, withDerivedBalances, monthlyAverages } from '@/lib/forecast';
import { currentOf, accountsBehindFigure } from '@/lib/accounts';
import { clampedMonthlyDate } from '@/lib/dates';
import { homeSummary, runwayLabel, RESERVE_TARGET_MONTHS } from '@/lib/home';
import { sanitizeAssumedSpend } from '@/lib/profile-settings';
import { displayName } from '@/lib/merchant';
import { nonNegotiableMonthly, Bill } from '@/lib/bills';
import { UnanchoredNote } from '@/components/UnanchoredNote';
import * as firestoreService from '@/lib/firestore';

export default function DashboardPage({ initialBills }: { initialBills?: Bill[] } = {}) {
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
  const [bills, setBills] = useState<Bill[]>(initialBills ?? []);
  useEffect(() => {
    if (initialBills || !user?.id) return; // fixtures supply their own; never read Firestore
    let alive = true;
    firestoreService.getBills(user.id).then((rows) => { if (alive) setBills(rows); });
    return () => { alive = false; };
  }, [user?.id, initialBills]);

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
        <div className="animate-pulse-glow w-16 h-16 rounded-card bg-[var(--accent-primary)] flex items-center justify-center">
          <TrendingUp className="w-8 h-8 text-[var(--background)]" aria-hidden="true" />
        </div>
        <span className="sr-only">Loading</span>
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
  const derivedAccounts = withDerivedBalances(profile?.paymentAccounts || [], transactions, incomeContext);

  // Calculate account summaries

  const totalCreditUsed = derivedAccounts
    .filter((a) => a.type === 'credit_card')
    .reduce((sum, a) => sum + currentOf(a), 0);




  // ACTIVE sources only — a paused source is still stored (so it can be resumed) but
  // must not be claimed as income.
  // Fall back to a figure DERIVED from the last 6 months of transactions when the user
  // hasn't hand-entered income sources / a budget — so these never show a bare $0.
  const derivedMonthly = monthlyAverages(transactions, derivedAccounts, 6, incomeContext);
  // FIN-SPEND-001 (#133): the owner's own number, set from chat, always wins over
  // the derived average — same resolution homeSnapshot uses server-side, so the
  // mobile client and this screen can never disagree about what drives runway.
  const avgMonthlyExpense = sanitizeAssumedSpend(profile?.settings?.assumedMonthlySpend) ?? derivedMonthly.spending;

  // UI-102: the hero's numbers — one computation (lib/home.ts), tested there.
  const home = homeSummary({
    currentCash: calculateCurrentCash(derivedAccounts),
    avgMonthlyExpense,
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
    incomeContext,
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
      
      {/* UI-112: content caps at the reading measure. At full desktop width a row's
          merchant and its amount sat a foot apart, which is a stretched phone
          layout, not a desktop one. */}
      <main className="pt-24 pb-40 md:pb-16 px-4 lg:px-8 max-w-content mx-auto relative z-10">
        {/* Setup Incomplete Banner */}
        {setupIncomplete && (
          <div className="mb-6 p-4 rounded-card bg-[var(--background-secondary)] border border-[var(--accent-primary)]">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <Settings className="w-5 h-5 text-[var(--accent-primary)] flex-shrink-0" />
                <div>
                  <p className="font-medium text-[var(--foreground)]">Finish setting up</p>
                  <p className="text-sm text-[var(--foreground-secondary)]">
                    {[
                      !hasAccounts && 'add your accounts',
                      !hasIncome && 'set up income',
                      !hasBudget && 'set a budget',
                    ].filter(Boolean).join(' · ')}
                  </p>
                </div>
              </div>
              <button
                onClick={() => router.push('/onboarding?continue=true')}
                className="btn-primary text-sm min-h-[44px] px-4 flex items-center gap-2"
              >
                Continue
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
          <section className="mb-4 lg:mb-6 p-4 lg:p-5 rounded-card bg-[var(--background-secondary)] border border-[var(--border-color)]">
            <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--accent-primary)]">Runway</p>
            {txnLoading ? (
              <div className="animate-pulse mt-2 space-y-3">
                <div className="h-9 w-48 rounded-control bg-[var(--background-tertiary)]" />
                <div className="h-4 w-64 rounded-control bg-[var(--background-tertiary)]" />
                <div className="h-2 w-full rounded-pill bg-[var(--background-tertiary)]" />
              </div>
            ) : !home.hasBurn ? (
              // No burn measured means no runway exists to report. The old code
              // filled the gap with the 5-month target, which showed a full
              // reserve to someone who had simply never imported anything.
              <>
                <p className="hero-number text-[var(--foreground)] mt-1">Not measured yet</p>
                <p className="text-sm text-[var(--foreground-secondary)] mt-1">
                  Import or link an account and your runway appears here.
                </p>
                <Link href="/accounts" className="inline-flex items-center gap-1 mt-3 min-h-[44px] font-medium text-[var(--accent-primary)]">
                  Connect an account <ArrowRight className="w-4 h-4" />
                </Link>
              </>
            ) : (
              <>
                {/* Days, not "0.3 months" — the unit a short runway is actually
                    thought in. The date it runs dry stays, one size down. */}
                <p className="hero-number text-[var(--foreground)] mt-1 tnum">{runwayLabel(home)}</p>
                <p className="text-sm text-[var(--foreground-secondary)] mt-1">
                  of cash at your usual spending · dry on {format(home.runwayDate, 'MMM d, yyyy')}
                </p>

                <div
                  className="mt-4 h-2 rounded-pill bg-[var(--background-tertiary)] overflow-hidden"
                  role="img"
                  aria-label={`${Math.round(home.reserveProgress * 100)}% of the ${RESERVE_TARGET_MONTHS}-month reserve target`}
                >
                  <div className="h-full rounded-pill bg-[var(--progress)] transition-all" style={{ width: `${home.reserveProgress * 100}%` }} />
                </div>

                {/* The motivating line. A percentage is a grade; a dollar figure
                    with a month attached is something to do this week. */}
                {home.nextMonthTarget > 0 ? (
                  <p className="mt-2 font-semibold text-[var(--accent-primary)] tnum">
                    {formatMoney(home.amountToNextMonth, profile?.currency, 2)} more makes it{' '}
                    {home.nextMonthTarget} month{home.nextMonthTarget === 1 ? '' : 's'}
                    <span className="ml-2 font-normal text-xs text-[var(--foreground-muted)]">
                      {Math.round(home.reserveProgress * 100)}% of {RESERVE_TARGET_MONTHS} months
                    </span>
                  </p>
                ) : (
                  <p className="mt-2 font-semibold text-[var(--money-in)] tnum">
                    {RESERVE_TARGET_MONTHS}-month reserve reached
                  </p>
                )}

                <div className="mt-4 flex flex-wrap items-center gap-2">
                  {forecast && (
                    <span className={`px-3 py-2 rounded-pill text-sm font-medium tnum bg-[var(--background-tertiary)] ${forecast.lowestBalance < (profile?.settings?.safetyThreshold || 500) ? 'text-[var(--money-out)]' : 'text-[var(--foreground-secondary)]'}`}>
                      Lowest in 90 days {formatMoney(forecast.lowestBalance, profile?.currency, 2)}
                    </span>
                  )}
                  {home.cardsOwed > 0 && (
                    // Round 4b Fix 1: totalCreditUsed (credit_card accounts only) feeds
                    // THIS chip, not the cash figure above — production's one unanchored
                    // account (Amazon Store Card) is a credit card, so it is IN this
                    // number. The earlier fix disclosed the cash total and left this one
                    // silent: false confidence on the only figure the account is actually
                    // in. Wrapped so the note reads under Cards owed specifically, not
                    // stacked ambiguously against the cash note below the chip row.
                    <div className="flex flex-col">
                      <span className="px-3 py-2 rounded-pill text-sm font-medium tnum bg-[var(--background-tertiary)] text-[var(--money-out)]">
                        Cards owed {formatMoney(-home.cardsOwed, profile?.currency, 2)}
                      </span>
                      <UnanchoredNote accounts={accountsBehindFigure('all', derivedAccounts, 'debt')} />
                    </div>
                  )}
                  {home.lockedMonthly > 0 && (
                    <span className="px-3 py-2 rounded-pill text-sm font-medium tnum bg-[var(--background-tertiary)] text-[var(--accent-primary)]">
                      Locked {formatMoney(home.lockedMonthly, profile?.currency, 2)}/mo
                    </span>
                  )}
                </div>

                {/* Honesty: the runway is only as complete as what is linked. The
                    hero stated a hard number without ever saying what it counted. */}
                <p className="mt-3 text-xs text-[var(--foreground-muted)]">
                  Counting {derivedAccounts.length} linked account{derivedAccounts.length === 1 ? '' : 's'}
                  {' · '}
                  <Link href="/accounts" className="text-[var(--accent-primary)] underline underline-offset-2">
                    manage
                  </Link>
                  {' · '}
                  <Link href="/forecast" className="text-[var(--accent-primary)] underline underline-offset-2">
                    full forecast
                  </Link>
                </p>
                {/* #83 Finding 1 (round 2): the hero's cash figure is calculateCurrentCash
                    (cash-type accounts only, see line 114 above) — NOT derivedAccounts.
                    Passing the full roster here named an unanchored credit card as the
                    reason for a cash number it cannot affect. accountsBehindFigure('all', …)
                    is the same cash-only filter, kept in one place so it can't drift from
                    calculateCurrentCash (see its doc comment in lib/accounts.ts). */}
                <UnanchoredNote accounts={accountsBehindFigure('all', derivedAccounts)} />
              </>
            )}
          </section>
        )}

        {/* Card payments due. UI-112: the per-account colour chips are gone — a
            card's brand hue carried no meaning here and put four more colours on
            a screen that is supposed to run on four. */}
        {upcomingBills.length > 0 && (
          <div className="mb-4 lg:mb-6 p-4 lg:p-5 rounded-card bg-[var(--background-secondary)] border border-[var(--border-color)]">
            <div className="flex items-center gap-2 mb-3">
              <AlertCircle className="w-4 h-4 text-[var(--accent-warning)] flex-shrink-0" />
              <h2 className="font-semibold text-[var(--foreground)]">Card payments due</h2>
            </div>
            <ul>
              {upcomingBills.slice(0, 3).map((bill) => (
                <li
                  key={bill.id}
                  className="flex items-center justify-between gap-3 py-3 border-b border-[var(--border-color)] last:border-0"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-[var(--foreground)] truncate">{bill.name}</p>
                    <p className="text-xs text-[var(--foreground-muted)] tnum">
                      {format(bill.dueDate, 'MMM d')} · in {bill.daysUntilDue} day{bill.daysUntilDue === 1 ? '' : 's'}
                    </p>
                  </div>
                  <p className="text-sm font-semibold text-[var(--money-out)] tnum flex-shrink-0">
                    {formatMoney(bill.balanceDue, profile?.currency, 2)}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Recent Transactions */}
        <div className="p-4 lg:p-5 rounded-card bg-[var(--background-secondary)] border border-[var(--border-color)]">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-3">
            <h2 className="font-semibold text-[var(--foreground)]">Recent activity</h2>
            {/* UI-102: 3 choices = 3 visible segments (a select is two taps and
                hides the active state; audit wrongControl). Plain words: no
                'Projected' jargon. */}
            <div className="flex items-center gap-1 p-1 rounded-control bg-[var(--background-tertiary)]" role="group" aria-label="Filter transactions">
              {([['all', 'All'], ['past', 'Past'], ['future', 'Upcoming']] as const).map(([value, label]) => (
                <button
                  key={value}
                  onClick={() => setFilter(value)}
                  aria-pressed={filter === value}
                  className={`min-h-[44px] px-4 rounded-control text-sm font-semibold transition-all ${
                    filter === value
                      ? 'bg-[var(--accent-primary)] text-[var(--background)]'
                      : 'text-[var(--foreground-secondary)] hover:text-[var(--foreground)]'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <ul>
            {recentTransactions.length === 0 ? (
              // UI-102: the empty copy must tell the truth about WHICH filter is
              // empty — "No transactions yet" while hundreds exist was a lie.
              <li className="text-center py-10">
                <Calendar className="w-10 h-10 text-[var(--foreground-muted)] mx-auto mb-3" aria-hidden="true" />
                {transactions.length === 0 ? (
                  <>
                    <p className="font-medium text-[var(--foreground)] mb-1">No transactions yet</p>
                    <p className="text-sm text-[var(--foreground-secondary)] mb-4">Start tracking your spending</p>
                    <button onClick={() => setIsModalOpen(true)} className="btn-primary min-h-[44px] px-4">
                      Add your first transaction
                    </button>
                  </>
                ) : (
                  <p className="font-medium text-[var(--foreground)]">
                    {filter === 'future' ? 'Nothing scheduled ahead' : 'Nothing in this view'}
                  </p>
                )}
              </li>
            ) : (
              recentTransactions.map((txn) => {
                const category = EXPENSE_CATEGORIES.find((c) => c.value === txn.category);
                const paymentMethod = PAYMENT_METHODS.find((m) => m.value === txn.paymentMethod);
                // Not `type === 'expense'`: that renders a transfer green with a '+'
                // regardless of which way the money actually moved.
                const isExpense = !isPositive(txn, profile?.paymentAccounts);
                const isFuture = isAfter(parseISO(txn.date), today) || txn.isProjected;

                return (
                  // UI-112: a divided list, not eight nested cards. The old row wore
                  // a 48px tile holding the SAME 📋 fallback on every uncategorised
                  // row — decoration that carried no information and set the row
                  // height. A real category icon still earns its place.
                  <li
                    key={txn.id}
                    className="flex items-center justify-between gap-3 py-3 border-b border-[var(--border-color)] last:border-0"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        {/* Full string kept in `title` — the reference blob is the
                            only handle on a mystery charge, so it is never lost. */}
                        <p className="font-medium text-[var(--foreground)] truncate" title={txn.title}>
                          {displayName(txn.title)}
                        </p>
                        {isFuture && <span className="badge badge-projected flex-shrink-0">Upcoming</span>}
                        {/* Same reason as Upcoming: money the totals above do not count yet. */}
                        {txn.pending && <span className="badge badge-projected flex-shrink-0">Pending</span>}
                      </div>
                      {/* ONE qualifier, never two. "Aug 6 · Other · Bank Account"
                          was three fields where two said nothing: `other` is the
                          absence of a category, and the account is identical on
                          every row for most people. Activity owns the full detail. */}
                      <p className="text-xs text-[var(--foreground-muted)] truncate">
                        {format(parseISO(txn.date), 'MMM d')}
                        {category && txn.category !== 'other'
                          ? ` · ${category.label}`
                          : paymentMethod?.label
                            ? ` · ${paymentMethod.label}`
                            : ''}
                      </p>
                    </div>
                    <p className={`font-semibold tnum flex-shrink-0 ${txn.pending ? 'text-[var(--foreground-muted)]' : isExpense ? 'text-[var(--money-out)]' : 'text-[var(--money-in)]'}`}>
                      {isExpense ? '−' : '+'}{formatMoney(txn.amount, profile?.currency, 2)}
                    </p>
                  </li>
                );
              })
            )}
          </ul>

          {transactions.length > 8 && (
            // #30: the label promises the transactions list — send it there (and as a
            // real link, not a button pretending to be one).
            <Link
              href="/history"
              className="w-full mt-3 min-h-[44px] rounded-control bg-[var(--background-tertiary)] text-[var(--foreground-secondary)] hover:text-[var(--foreground)] transition-all flex items-center justify-center gap-1 text-sm font-medium"
            >
              See all activity
              <ChevronRight className="w-4 h-4" />
            </Link>
          )}
        </div>
      </main>

      <AddTransactionModal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} />
    </div>
  );
}
