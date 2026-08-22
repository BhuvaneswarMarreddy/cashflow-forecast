'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { useTransactions } from '@/context/TransactionContext';
import { useUserProfile } from '@/context/UserProfileContext';
import Navbar from '@/components/Navbar';
import ForecastChart from '@/components/ForecastChart';
import ForecastTimeline from '@/components/ForecastTimeline';
import DecisionCheckPanel from '@/components/DecisionCheckPanel';
import AIQuestionPanel from '@/components/AIQuestionPanel';
import EmergencyFundPanel from '@/components/EmergencyFundPanel';
import AIInsightsPanel from '@/components/AIInsightsPanel';
import BudgetStatusPanel from '@/components/BudgetStatusPanel';
import UpcomingBillsPanel from '@/components/UpcomingBillsPanel';
import SavingsGoalsPanel from '@/components/SavingsGoalsPanel';
import PlannedPaymentsPanel from '@/components/PlannedPaymentsPanel';
import AssumptionsPanel from '@/components/AssumptionsPanel';
import BillsTab from '@/components/BillsTab';
import { UnanchoredNote } from '@/components/UnanchoredNote';
import { generateForecast, calculateCurrentCash, getAllAccountForecasts, withDerivedBalances, monthlyAverages } from '@/lib/forecast';
import CashflowTab from '@/components/CashflowTab';
import { buildAssumptions, AssumptionOverrides } from '@/lib/behavior';
import { accountsBehindFigure } from '@/lib/accounts';
import { homeSummary, RESERVE_TARGET_MONTHS } from '@/lib/home';
import { formatMoney } from '@/lib/money';
import { sanitizeAssumedSpend } from '@/lib/profile-settings';
import { loadOverrides, saveOverrides } from '@/lib/assumption-overrides';
import * as firestoreService from '@/lib/firestore';
import { format } from 'date-fns';
import { TrendingUp, Shield, CreditCard, Wallet } from 'lucide-react';
import { SavingsGoal } from '@/types';

// Time period options
const TIME_PERIODS = [
  { label: '1 Month', days: 30, short: '1M' },
  { label: '3 Months', days: 90, short: '3M' },
  { label: '6 Months', days: 180, short: '6M' },
  { label: '1 Year', days: 365, short: '1Y' },
];

export default function ForecastPage() {
  const { isAuthenticated, isLoading: authLoading, user } = useAuth();
  const { transactions } = useTransactions();
  const { profile, isLoading: profileLoading, isOnboarded, incomeContext } = useUserProfile();
  const router = useRouter();
  const [forecastDays, setForecastDays] = useState(90);
  const [selectedAccountId, setSelectedAccountId] = useState<string>('all'); // 'all' for combined view
  const [savingsGoals, setSavingsGoals] = useState<SavingsGoal[]>([]);
  // User corrections to the behavior engine's assumptions (localStorage-backed).
  const [overrides, setOverrides] = useState<AssumptionOverrides>(() => loadOverrides());
  // Bills register (BILLS-001) lives on a second tab; deep-linkable via ?tab=bills.
  // Read from location instead of useSearchParams to avoid the Suspense boundary
  // requirement on a fully client-rendered page.
  // Lazy init is hydration-safe here: the auth-loading gate renders a spinner on
  // the first client pass, so the tab bar never hydrates against server markup.
  const [activeTab, setActiveTab] = useState<'timeline' | 'bills' | 'cashflow'>(() =>
    (() => {
      if (typeof window === 'undefined') return 'timeline' as const;
      const t = new URLSearchParams(window.location.search).get('tab');
      return t === 'bills' || t === 'cashflow' ? t : 'timeline';
    })()
  );
  const switchTab = (tab: 'timeline' | 'bills' | 'cashflow') => {
    setActiveTab(tab);
    window.history.replaceState(null, '', tab === 'timeline' ? '/forecast' : `/forecast?tab=${tab}`);
  };
  
  // Load savings goals from Firestore
  useEffect(() => {
    const loadGoals = async () => {
      if (!user?.id) return;
      try {
        const goals = await firestoreService.getSavingsGoals(user.id);
        setSavingsGoals(goals);
      } catch (err) {
        console.warn('Could not load savings goals:', err);
      }
    };
    loadGoals();
  }, [user?.id]);
  
  // Savings goal handlers
  const handleAddGoal = async (goal: Omit<SavingsGoal, 'id' | 'createdAt' | 'updatedAt'>) => {
    if (!user?.id) return;
    try {
      const id = await firestoreService.addSavingsGoal(user.id, goal);
      const newGoal: SavingsGoal = {
        ...goal,
        id,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      setSavingsGoals(prev => [...prev, newGoal]);
    } catch (err) {
      console.error('Failed to add goal:', err);
    }
  };
  
  const handleUpdateGoal = async (id: string, updates: Partial<SavingsGoal>) => {
    if (!user?.id) return;
    try {
      await firestoreService.updateSavingsGoal(user.id, id, updates);
      setSavingsGoals(prev => prev.map(g => g.id === id ? { ...g, ...updates } : g));
    } catch (err) {
      console.error('Failed to update goal:', err);
    }
  };
  
  const handleDeleteGoal = async (id: string) => {
    if (!user?.id) return;
    try {
      await firestoreService.deleteSavingsGoal(user.id, id);
      setSavingsGoals(prev => prev.filter(g => g.id !== id));
    } catch (err) {
      console.error('Failed to delete goal:', err);
    }
  };

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

  // Get accounts that can have forecasts (checking, savings, credit cards)
  const forecastableAccounts = useMemo(() => {
    if (!profile?.paymentAccounts) return [];
    return profile.paymentAccounts.filter(
      a => a.type === 'bank_account' || a.type === 'debit_card' || a.type === 'credit_card'
    );
  }, [profile?.paymentAccounts]);

  // Balances derived from linked transactions, so forecasts start from the real
  // current balance rather than the stored opening figure.
  const derivedAccounts = useMemo(
    () => withDerivedBalances(profile?.paymentAccounts || [], transactions, incomeContext),
    [profile?.paymentAccounts, transactions]
  );

  // What the forecast believes — regenerated whenever the user corrects an assumption.
  const assumptions = useMemo(
    () => buildAssumptions(transactions, derivedAccounts, overrides, incomeContext),
    [transactions, derivedAccounts, overrides, incomeContext]
  );

  // Generate all account forecasts
  const accountForecasts = useMemo(() => {
    if (!profile?.paymentAccounts) return [];
    return getAllAccountForecasts(
      derivedAccounts,
      profile.incomeSources || [],
      transactions,
      profile.settings?.safetyThreshold || 500,
      forecastDays
    );
  }, [profile, derivedAccounts, transactions, forecastDays]);

  // Get selected account forecast or combined
  const selectedAccountForecast = useMemo(() => {
    if (selectedAccountId === 'all') return null;
    return accountForecasts.find(af => af.accountId === selectedAccountId) || null;
  }, [accountForecasts, selectedAccountId]);

  // Generate combined forecast (all cash accounts)
  const combinedForecast = useMemo(() => {
    if (!profile) return null;
    
    const currentCash = calculateCurrentCash(derivedAccounts);
    const threshold = profile.settings?.safetyThreshold || 500;

    return generateForecast(
      currentCash,
      derivedAccounts,
      profile.incomeSources || [],
      transactions,
      incomeContext,
      threshold,
      forecastDays,
      overrides
    );
  }, [profile, derivedAccounts, transactions, forecastDays, overrides, incomeContext]);

  const handleOverridesChange = (o: AssumptionOverrides) => {
    setOverrides(o);
    saveOverrides(o);
  };

  // Use selected forecast or combined
  const forecast = selectedAccountForecast?.forecast || combinedForecast;

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

  if (!isAuthenticated || !forecast) return null;

  const currentCash = calculateCurrentCash(derivedAccounts);
  
  // Calculate monthly expenses for emergency fund calculation
  // UI-103: the burn rate is the real 6-month average — the old figure divided
  // the CHART's display range into itself, so Runway changed when you changed
  // the range or picked an account. One basis, shared with Home (lib/home.ts).
  const steadyBurn = monthlyAverages(transactions, derivedAccounts, 6, incomeContext).spending;
  // FIN-SPEND-001 (#133): same override resolution as Home and homeSnapshot —
  // the owner's own number, set from chat, wins over the derived average so
  // this screen's "steady burn" can never disagree with theirs.
  const avgMonthlyExpense = sanitizeAssumedSpend(profile?.settings?.assumedMonthlySpend) ?? steadyBurn;
  const runway = homeSummary({
    currentCash,
    avgMonthlyExpense,
    cardsOwed: 0,
    lockedMonthly: 0,
    today: new Date(),
  });
  const monthlyExpenses = avgMonthlyExpense;

  return (
    <div className="min-h-screen relative">
      <div className="bg-pattern" />
      <Navbar />
      
      <main className="pt-24 pb-40 md:pb-16 px-4 sm:px-6 lg:px-8 max-w-7xl mx-auto relative z-10">
        {/* Header with Time Period Selector */}
        <div className="mb-8 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-6">
          <div>
            <h1 className="text-3xl sm:text-4xl font-bold text-[var(--foreground)] mb-2">
              Cash Flow Forecast
            </h1>
            <p className="text-base text-[var(--foreground-secondary)]">
              {activeTab === 'bills'
                ? 'Your recurring bills and targets'
                : activeTab === 'cashflow'
                  ? 'Where your income goes, month by month'
                  : `Project your balance for the next ${forecastDays >= 365 ? 'year' : forecastDays >= 30 ? `${Math.round(forecastDays / 30)} months` : `${forecastDays} days`}`}
            </p>
          </div>

          {/* Time Period Selector */}
          {activeTab === 'timeline' && (
          <div className="flex items-center gap-2 p-2 bg-[var(--background-secondary)] rounded-control border border-[var(--border-color)] shadow-sm">
            {TIME_PERIODS.map((period) => (
              <button
                key={period.days}
                onClick={() => setForecastDays(period.days)}
                className={`px-4 min-h-[44px] text-sm font-semibold rounded-control transition-all ${
                  forecastDays === period.days
                    ? 'bg-[var(--accent-primary)] text-[#16181c] shadow-sm'
                    : 'text-[var(--foreground-secondary)] hover:text-[var(--foreground)] hover:bg-[var(--background-tertiary)]'
                }`}
              >
                <span className="hidden sm:inline">{period.label}</span>
                <span className="sm:hidden">{period.short}</span>
              </button>
            ))}
          </div>
          )}
        </div>

        {/* Tab bar: Timeline | Bills (BILLS-001) */}
        <div className="mb-6 flex items-center gap-2 p-2 bg-[var(--background-secondary)] rounded-control border border-[var(--border-color)] w-fit">
          {(['timeline', 'bills', 'cashflow'] as const).map(tab => (
            <button
              key={tab}
              onClick={() => switchTab(tab)}
              className={`px-4 min-h-[44px] text-sm font-semibold rounded-control transition-all ${
                activeTab === tab
                  ? 'bg-[var(--accent-primary)] text-[#16181c] shadow-sm'
                  : 'text-[var(--foreground-secondary)] hover:text-[var(--foreground)] hover:bg-[var(--background-tertiary)]'
              }`}
            >
              {tab === 'timeline' ? 'Timeline' : tab === 'bills' ? 'Bills' : 'Cashflow'}
            </button>
          ))}
        </div>

        {activeTab === 'bills' && user?.id && <BillsTab userId={user.id} />}

        {activeTab === 'cashflow' && <CashflowTab />}

        {activeTab === 'timeline' && (<>
        {/* UI-103: the chip-per-account row wrapped to 3 lines on a phone —
            one dropdown, one line (audit wrongControl). */}
        {forecastableAccounts.length > 0 && (
          <div className="mb-6 bg-[var(--background-secondary)] border border-[var(--border-color)] rounded-card p-4">
            <div className="flex items-center gap-3">
              <label htmlFor="account-select" className="text-sm font-medium text-[var(--foreground)] flex items-center gap-2 shrink-0">
                <Wallet className="w-5 h-5 text-[var(--foreground-muted)]" aria-hidden="true" />
                Forecast for
              </label>
              <select
                id="account-select"
                value={selectedAccountId}
                onChange={(e) => setSelectedAccountId(e.target.value)}
                className="select-field min-h-[44px] px-3 text-sm flex-1 max-w-xs"
              >
                <option value="all">All accounts</option>
                {forecastableAccounts.map(account => (
                  <option key={account.id} value={account.id}>
                    {account.name}{account.lastFourDigits ? ` ···${account.lastFourDigits}` : ''}
                  </option>
                ))}
              </select>
            </div>
            {selectedAccountForecast?.creditCardPayments && selectedAccountForecast.creditCardPayments.length > 0 && (
              <div className="mt-4 pt-4 border-t border-[var(--border-color)]">
                <p className="text-xs font-medium text-[var(--foreground-muted)] mb-2">
                  Upcoming Credit Card Payments from this Account:
                </p>
                <div className="flex flex-wrap gap-2">
                  {selectedAccountForecast.creditCardPayments.map(payment => (
                    <div
                      key={payment.cardId}
                      className="px-3 py-2 rounded-control bg-red-500/10 border border-red-500/20 text-sm"
                    >
                      <div className="flex items-center gap-2">
                        <CreditCard className="w-4 h-4 text-red-400" />
                        <span className="font-medium text-[var(--foreground)]">{payment.cardName}</span>
                      </div>
                      <div className="flex items-center gap-2 mt-1 text-xs text-[var(--foreground-muted)]">
                        <span className="text-red-400 font-semibold tabular-nums">-{formatMoney(payment.amount, profile?.currency, 2)}</span>
                        <span>due {format(new Date(payment.dueDate), 'MMM d')}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* UI-103: 4 cards → 3. The Runway pair was ONE number as two cards;
            "Attention: 45d" never said what happens in 45 days. */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
          <div className="p-5 bg-[var(--background-secondary)] border border-[var(--border-color)] rounded-card">
            <p className="text-xs font-semibold text-[var(--foreground-muted)] uppercase tracking-wide mb-2">
              {selectedAccountId === 'all' ? 'Total Cash Available' : `${selectedAccountForecast?.accountName || 'Account'} Balance`}
            </p>
            <p className={`text-3xl font-bold tnum ${
              selectedAccountForecast?.accountType === 'credit_card' ? 'text-[var(--money-out)]' : 'text-[var(--money-in)]'
            }`}>
              {formatMoney(
                selectedAccountId === 'all'
                  ? currentCash
                  : (selectedAccountForecast?.accountType === 'credit_card' ? -1 : 1) * Math.abs(selectedAccountForecast?.currentBalance || 0),
                profile?.currency, 2
              )}
            </p>
            {selectedAccountForecast?.accountType === 'credit_card' && (
              <p className="text-xs text-[var(--foreground-muted)] mt-1">Balance owed</p>
            )}
            {/* #83 Finding 1: this card shows the combined total OR one selected
                account's balance — the note must count only the account(s) behind
                THAT figure, not every account, or a correctly-anchored single
                account would show a stale "unanchored" claim borrowed from an
                account not even in the number above it. */}
            <UnanchoredNote accounts={accountsBehindFigure(selectedAccountId, derivedAccounts)} />
          </div>

          <div className="p-5 bg-[var(--background-secondary)] border border-[var(--border-color)] rounded-card">
            <div className="flex items-center gap-2 mb-2">
              <Shield className="w-4 h-4 text-[var(--foreground-muted)]" aria-hidden="true" />
              <p className="text-xs font-semibold text-[var(--foreground-muted)] uppercase tracking-wide">Money lasts</p>
            </div>
            <p className="text-3xl font-bold tnum text-[var(--foreground)]">
              {runway.runwayMonths} mo
            </p>
            <p className="text-xs text-[var(--foreground-muted)] mt-1 tnum">
              to {format(runway.runwayDate, 'MMM d, yyyy')} · goal {RESERVE_TARGET_MONTHS} months
            </p>
          </div>

          <div className={`p-5 rounded-card border ${
            forecast.daysUntilUnsafe !== null
              ? 'bg-[var(--progress)]/10 border-[var(--progress)]/40'
              : 'bg-[var(--money-in)]/10 border-[var(--money-in)]/40'
          }`}>
            <p className="text-xs font-semibold text-[var(--foreground-muted)] uppercase tracking-wide mb-2">Heads-up</p>
            {forecast.daysUntilUnsafe !== null ? (
              <div>
                <p className="text-xl font-bold text-[var(--foreground)] tnum">
                  Cash dips below {formatMoney(profile?.settings?.safetyThreshold || 500, profile?.currency, 0)} in {forecast.daysUntilUnsafe} days
                </p>
                <p className="text-xs text-[var(--foreground-muted)] mt-1 tnum">
                  {formatMoney(forecast.lowestBalance, profile?.currency, 2)} on {format(new Date(forecast.lowestBalanceDate), 'MMM d')}
                </p>
              </div>
            ) : (
              <p className="text-3xl font-bold text-[var(--money-in)]">All clear</p>
            )}
          </div>
        </div>

        {/* UI-103: the chart and timeline ARE the screen; the nine helper
            panels collapse into one disclosure — reachable, never shouting.
            (They stacked 13 deep on a phone before.) */}
        <div className="space-y-6">
          <ForecastChart forecast={forecast} />
          <ForecastTimeline forecast={forecast} />

          <details className="glass-card p-5">
            <summary className="cursor-pointer list-none font-semibold text-[var(--foreground)] flex items-center justify-between min-h-[44px]">
              <span>More tools</span>
              <span className="text-sm font-normal text-[var(--foreground-secondary)]">assumptions · insights · budgets · goals · plans</span>
            </summary>
            <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
              <AssumptionsPanel assumptions={assumptions} onOverridesChange={handleOverridesChange} />
              <DecisionCheckPanel forecast={forecast} />
              <AIInsightsPanel
                transactions={transactions}
                accounts={derivedAccounts}
                incomeSources={profile?.incomeSources || []}
                currentCash={currentCash}
                safetyThreshold={profile?.settings?.safetyThreshold || 500}
                income={incomeContext}
              />
              {profile?.settings?.categoryBudgets && profile.settings.categoryBudgets.length > 0 && (
                <BudgetStatusPanel
                  budgets={profile.settings.categoryBudgets}
                  transactions={transactions}
                  accounts={profile?.paymentAccounts}
                  compact={true}
                />
              )}
              <UpcomingBillsPanel
                accounts={derivedAccounts}
                transactions={transactions}
                preferences={profile?.settings?.notificationPreferences}
                compact={true}
              />
              <SavingsGoalsPanel
                goals={savingsGoals}
                accounts={derivedAccounts}
                forecast={forecast}
                safetyThreshold={profile?.settings?.safetyThreshold || 500}
                onAddGoal={handleAddGoal}
                onUpdateGoal={handleUpdateGoal}
                onDeleteGoal={handleDeleteGoal}
                compact={true}
              />
              <PlannedPaymentsPanel />
              <EmergencyFundPanel
                forecast={forecast}
                monthlyExpenses={monthlyExpenses}
                currentCash={currentCash}
              />
              <AIQuestionPanel forecast={forecast} />
            </div>
          </details>
        </div>

        </>)}
      </main>
    </div>
  );
}

