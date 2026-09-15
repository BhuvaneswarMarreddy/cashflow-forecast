'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
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
import RunwayCalculator from '@/components/RunwayCalculator';
import { UnanchoredNote } from '@/components/UnanchoredNote';
import { generateForecast, calculateCurrentCash, getAllAccountForecasts, withDerivedBalances, monthlyAverages } from '@/lib/forecast';
import CashflowTab from '@/components/CashflowTab';
import { buildAssumptions, AssumptionOverrides } from '@/lib/behavior';
import { accountsBehindFigure } from '@/lib/accounts';
import { homeSummary, runwayLabel } from '@/lib/home';
import { formatMoney, monthlyIncomeOf } from '@/lib/money';
import { sanitizeAssumedSpend } from '@/lib/profile-settings';
import { loadOverrides, saveOverrides } from '@/lib/assumption-overrides';
import * as firestoreService from '@/lib/firestore';
import { format } from 'date-fns';
import { CreditCard } from 'lucide-react';
import { SavingsGoal } from '@/types';
import LoadingScreen from '@/components/LoadingScreen';

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
  // #198: two tabs, Plan and Month. The Bills editor is no longer a tab but keeps its
  // address (?tab=bills — Home's "All bills" links there) behind Outflows' "Edit bills".
  // ?tab=cashflow is Month (/calendar and /cashflow redirect there). Read from location
  // instead of useSearchParams to avoid a Suspense boundary on a client-rendered page;
  // hydration-safe because the auth gate renders LoadingScreen on the first client pass.
  const [view, setView] = useState<'plan' | 'month' | 'bills'>(() => {
    if (typeof window === 'undefined') return 'plan';
    const t = new URLSearchParams(window.location.search).get('tab');
    return t === 'cashflow' ? 'month' : t === 'bills' ? 'bills' : 'plan';
  });
  const switchView = (next: 'plan' | 'month' | 'bills') => {
    setView(next);
    window.history.replaceState(null, '', next === 'plan' ? '/forecast' : `/forecast?tab=${next === 'month' ? 'cashflow' : 'bills'}`);
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
      <LoadingScreen />
    );
  }

  if (!isAuthenticated || !forecast) return null;

  const currentCash = calculateCurrentCash(derivedAccounts);

  // UI-103: the burn rate is the real 6-month average — the old figure divided
  // the CHART's display range into itself, so Runway changed when you changed
  // the range or picked an account. One basis, shared with Home (lib/home.ts).
  const averages = monthlyAverages(transactions, derivedAccounts, 6, incomeContext);
  // FIN-SPEND-001 (#133): same override resolution as Home and homeSnapshot —
  // the owner's own number, set from chat, wins over the derived average so
  // this screen's "steady burn" can never disagree with theirs.
  const avgMonthlyExpense = sanitizeAssumedSpend(profile?.settings?.assumedMonthlySpend) ?? averages.spending;
  const runway = homeSummary({
    currentCash,
    avgMonthlyExpense,
    cardsOwed: 0,
    lockedMonthly: 0,
    today: new Date(),
  });
  const monthlyExpenses = avgMonthlyExpense;
  // What-if (moved here from Activity, #205): ACTIVE approved sources first, else the
  // same 6-month average — the resolution Activity's Runway view used.
  const monthlyIncome = monthlyIncomeOf(profile?.incomeSources?.filter((i) => i.isActive) ?? []) || averages.income;
  const threshold = profile?.settings?.safetyThreshold || 500;
  const isCard = selectedAccountForecast?.accountType === 'credit_card';
  const periodLabel = forecastDays >= 365 ? 'year' : `${Math.round(forecastDays / 30)} month${Math.round(forecastDays / 30) === 1 ? '' : 's'}`;

  return (
    <div className="min-h-screen relative">
      <div className="bg-pattern" />
      <Navbar />

      <main className="pt-24 pb-24 md:pb-16 px-4 lg:px-8 max-w-content mx-auto relative z-10">
        <div className="mb-4">
          <h1 className="text-3xl font-[family-name:var(--font-display)] text-[var(--foreground)]">Forecast</h1>
          <p className="text-[var(--foreground-secondary)] mt-1">
            {view === 'month'
              ? 'Where your money went, month by month'
              : view === 'bills'
                ? 'Your recurring bills'
                : `Will you be OK? Your cash over the next ${periodLabel}.`}
          </p>
        </div>

        {/* #198: two underline tabs only. Bills is an address, not a tab. */}
        {view === 'bills' ? (
          <button
            onClick={() => switchView('plan')}
            className="tap-target mb-6 text-sm font-medium text-[var(--accent-primary)] hover:text-[var(--accent-secondary)]"
          >
            ← Back to plan
          </button>
        ) : (
          <div role="tablist" aria-label="Forecast views" className="mb-6 flex gap-6 border-b border-[var(--border-color)]">
            {([['plan', 'Plan'], ['month', 'Month']] as const).map(([key, label]) => (
              <button
                key={key}
                role="tab"
                aria-selected={view === key}
                onClick={() => switchView(key)}
                className={`min-h-[44px] -mb-px border-b-2 px-1 text-sm font-semibold transition-colors ${
                  view === key
                    ? 'border-[var(--accent-primary)] text-[var(--foreground)]'
                    : 'border-transparent text-[var(--foreground-secondary)] hover:text-[var(--foreground)]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        {view === 'bills' && user?.id && <BillsTab userId={user.id} />}

        {/* Month: the existing CashflowTab until #188's grid lands. No day-totals here. */}
        {view === 'month' && <CashflowTab />}

        {view === 'plan' && (
          <div className="space-y-6">
            {/* Period + account scope. Chips scroll sideways on a phone instead of wrapping. */}
            <div className="flex flex-col sm:flex-row sm:items-center gap-3">
              <div className="-mx-4 px-4 sm:mx-0 sm:px-0 overflow-x-auto">
                <div role="group" aria-label="Forecast period" className="flex gap-2 w-max">
                  {TIME_PERIODS.map((period) => (
                    <button
                      key={period.days}
                      onClick={() => setForecastDays(period.days)}
                      aria-pressed={forecastDays === period.days}
                      aria-label={period.label}
                      className={`min-h-[44px] px-4 rounded-pill text-sm font-semibold whitespace-nowrap transition-colors ${
                        forecastDays === period.days
                          ? 'bg-[var(--accent-primary)] text-[#16181c]'
                          : 'bg-[var(--background-tertiary)] text-[var(--foreground-secondary)] hover:text-[var(--foreground)]'
                      }`}
                    >
                      {period.short}
                    </button>
                  ))}
                </div>
              </div>
              {/* UI-103: one dropdown, one line — the chip-per-account row wrapped to 3 lines. */}
              {forecastableAccounts.length > 0 && (
                <div className="flex items-center gap-2 min-w-0 sm:ml-auto">
                  <label htmlFor="account-select" className="text-sm text-[var(--foreground-secondary)] shrink-0">
                    Forecast for
                  </label>
                  <select
                    id="account-select"
                    value={selectedAccountId}
                    onChange={(e) => setSelectedAccountId(e.target.value)}
                    className="select-field min-h-[44px] px-3 text-sm min-w-0 flex-1 sm:flex-none sm:max-w-xs"
                  >
                    <option value="all">All accounts</option>
                    {forecastableAccounts.map(account => (
                      <option key={account.id} value={account.id}>
                        {account.name}{account.lastFourDigits ? ` ···${account.lastFourDigits}` : ''}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            {/* The one number + the one runway sentence. */}
            <section className="p-4 lg:p-5 rounded-card bg-[var(--background-secondary)] border border-[var(--border-color)]">
              <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--accent-primary)]">
                {selectedAccountId === 'all' ? 'Cash now' : `${selectedAccountForecast?.accountName || 'Account'} balance`}
              </p>
              <p className={`hero-number tnum mt-1 ${isCard ? 'text-[var(--money-out)]' : 'text-[var(--foreground)]'}`}>
                {formatMoney(
                  selectedAccountId === 'all'
                    ? currentCash
                    : (isCard ? -1 : 1) * Math.abs(selectedAccountForecast?.currentBalance || 0),
                  profile?.currency, 2
                )}
              </p>
              {isCard && <p className="text-xs text-[var(--foreground-muted)] mt-1">Balance owed</p>}
              {/* #83 Finding 1: the note counts only the account(s) behind THIS figure. */}
              <UnanchoredNote accounts={accountsBehindFigure(selectedAccountId, derivedAccounts)} />
              <p className="mt-3 text-sm text-[var(--foreground-secondary)]">
                {runway.hasBurn ? (
                  <>
                    Your cash lasts <span className="font-semibold text-[var(--foreground)] tnum">{runwayLabel(runway)}</span> at
                    your usual spending, to {format(runway.runwayDate, 'MMM d, yyyy')}.{' '}
                  </>
                ) : (
                  // Unknown is a sentence and a link, never "0 mo" (the old card printed runwayMonths regardless).
                  <>
                    Runway isn&apos;t measured yet —{' '}
                    <Link href="/accounts" className="font-medium text-[var(--accent-primary)] underline underline-offset-2">connect an account</Link>.{' '}
                  </>
                )}
                {forecast.daysUntilUnsafe !== null ? (
                  <span className="tnum">
                    {selectedAccountId === 'all' ? 'Cash' : 'This account'} dips below {formatMoney(threshold, profile?.currency, 0)} in {forecast.daysUntilUnsafe} days
                    ({formatMoney(forecast.lowestBalance, profile?.currency, 2)} on {format(new Date(forecast.lowestBalanceDate), 'MMM d')}).
                  </span>
                ) : (
                  <span className="tnum">
                    {selectedAccountId === 'all' ? 'Cash stays' : 'This account stays'} above {formatMoney(threshold, profile?.currency, 0)} for the whole period.
                  </span>
                )}
              </p>
              {selectedAccountForecast?.creditCardPayments && selectedAccountForecast.creditCardPayments.length > 0 && (
                <div className="mt-4 pt-4 border-t border-[var(--border-color)]">
                  <p className="text-xs font-medium text-[var(--foreground-muted)] mb-2">Card payments from this account</p>
                  <ul className="flex flex-wrap gap-2">
                    {selectedAccountForecast.creditCardPayments.map(payment => (
                      <li key={payment.cardId} className="px-3 py-2 rounded-control bg-[var(--background-tertiary)] text-sm">
                        <span className="flex items-center gap-2 font-medium text-[var(--foreground)]">
                          <CreditCard className="w-4 h-4 text-[var(--foreground-muted)]" aria-hidden="true" />
                          {payment.cardName}
                        </span>
                        <span className="text-xs text-[var(--foreground-muted)] tnum">
                          <span className="font-semibold text-[var(--money-out)]">−{formatMoney(payment.amount, profile?.currency, 2)}</span>
                          {' '}due {format(new Date(payment.dueDate), 'MMM d')}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>

            <ForecastChart forecast={forecast} />

            {/* "Can I afford this?" sits directly under the chart it reads. */}
            <DecisionCheckPanel forecast={forecast} />

            {/* One Outflows group: what is due + what is planned. The editor is a link, not a tab. */}
            <section aria-labelledby="outflows-heading" className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h2 id="outflows-heading" className="font-semibold text-[var(--foreground)]">Outflows</h2>
                <button
                  onClick={() => switchView('bills')}
                  className="tap-target text-sm font-medium text-[var(--accent-primary)] hover:text-[var(--accent-secondary)]"
                >
                  Edit bills
                </button>
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
                <UpcomingBillsPanel
                  accounts={derivedAccounts}
                  transactions={transactions}
                  preferences={profile?.settings?.notificationPreferences}
                  compact={true}
                />
                <PlannedPaymentsPanel />
              </div>
            </section>

            {/* #198: everything else collapses into one Assumptions disclosure until #201
                gives the knobs a home in Settings. Reachable, never competing with the chart. */}
            <details className="rounded-card border border-[var(--border-color)] bg-[var(--background-secondary)] p-4 lg:p-5">
              <summary className="cursor-pointer list-none min-h-[44px] flex items-center justify-between gap-3 font-semibold text-[var(--foreground)]">
                <span>Assumptions</span>
                <span className="hidden sm:inline text-sm font-normal text-[var(--foreground-secondary)]">what-if · timeline · reserve · goals · budgets · insights</span>
              </summary>
              <div className="mt-4 grid grid-cols-1 gap-6">
                <AssumptionsPanel assumptions={assumptions} onOverridesChange={handleOverridesChange} />
                {runway.hasBurn && (
                  <RunwayCalculator
                    currentCash={currentCash}
                    monthlyExpenses={monthlyExpenses}
                    monthlyIncome={monthlyIncome}
                    forecast={forecast}
                  />
                )}
                <ForecastTimeline forecast={forecast} />
                <EmergencyFundPanel
                  forecast={forecast}
                  monthlyExpenses={monthlyExpenses}
                  currentCash={currentCash}
                />
                <SavingsGoalsPanel
                  goals={savingsGoals}
                  accounts={derivedAccounts}
                  forecast={forecast}
                  safetyThreshold={threshold}
                  onAddGoal={handleAddGoal}
                  onUpdateGoal={handleUpdateGoal}
                  onDeleteGoal={handleDeleteGoal}
                  compact={true}
                />
                {profile?.settings?.categoryBudgets && profile.settings.categoryBudgets.length > 0 && (
                  <BudgetStatusPanel
                    budgets={profile.settings.categoryBudgets}
                    transactions={transactions}
                    accounts={profile?.paymentAccounts}
                    compact={true}
                  />
                )}
                <AIInsightsPanel
                  transactions={transactions}
                  accounts={derivedAccounts}
                  incomeSources={profile?.incomeSources || []}
                  currentCash={currentCash}
                  safetyThreshold={threshold}
                  income={incomeContext}
                />
                <AIQuestionPanel forecast={forecast} />
              </div>
            </details>
          </div>
        )}
      </main>
    </div>
  );
}
