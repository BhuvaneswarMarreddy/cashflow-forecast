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
import { generateForecast, calculateCurrentCash, generateAccountForecast, getAllAccountForecasts } from '@/lib/forecast';
import * as firestoreService from '@/lib/firestore';
import { format } from 'date-fns';
import { TrendingUp, AlertTriangle, ArrowRight, Shield, CreditCard, ChevronDown, Wallet, Landmark, Building } from 'lucide-react';
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
  const { profile, isLoading: profileLoading, isOnboarded, updateProfile } = useUserProfile();
  const router = useRouter();
  const [forecastDays, setForecastDays] = useState(90);
  const [selectedAccountId, setSelectedAccountId] = useState<string>('all'); // 'all' for combined view
  const [savingsGoals, setSavingsGoals] = useState<SavingsGoal[]>([]);
  
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

  // Generate all account forecasts
  const accountForecasts = useMemo(() => {
    if (!profile?.paymentAccounts) return [];
    return getAllAccountForecasts(
      profile.paymentAccounts,
      profile.incomeSources || [],
      transactions,
      profile.settings?.safetyThreshold || 500,
      forecastDays
    );
  }, [profile, transactions, forecastDays]);

  // Get selected account forecast or combined
  const selectedAccountForecast = useMemo(() => {
    if (selectedAccountId === 'all') return null;
    return accountForecasts.find(af => af.accountId === selectedAccountId) || null;
  }, [accountForecasts, selectedAccountId]);

  // Generate combined forecast (all cash accounts)
  const combinedForecast = useMemo(() => {
    if (!profile) return null;
    
    const currentCash = calculateCurrentCash(profile.paymentAccounts || []);
    const threshold = profile.settings?.safetyThreshold || 500;
    
    return generateForecast(
      currentCash,
      profile.paymentAccounts || [],
      profile.incomeSources || [],
      transactions,
      threshold,
      forecastDays
    );
  }, [profile, transactions, forecastDays]);

  // Use selected forecast or combined
  const forecast = selectedAccountForecast?.forecast || combinedForecast;

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

  if (!isAuthenticated || !forecast) return null;

  const currentCash = calculateCurrentCash(profile?.paymentAccounts || []);
  const hasSetup = (profile?.paymentAccounts?.length || 0) > 0 || (profile?.incomeSources?.length || 0) > 0;
  
  // Calculate monthly expenses for emergency fund calculation
  const monthlyExpenses = forecast.totalExpenses / (forecastDays / 30);

  return (
    <div className="min-h-screen relative">
      <div className="bg-pattern" />
      <Navbar />
      
      <main className="pt-24 pb-12 px-4 sm:px-6 lg:px-8 max-w-7xl mx-auto relative z-10">
        {/* Header with Time Period Selector */}
        <div className="mb-8 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-6">
          <div>
            <h1 className="text-3xl sm:text-4xl font-bold text-[var(--foreground)] mb-2">
              Cash Flow Forecast
            </h1>
            <p className="text-base text-[var(--foreground-secondary)]">
              Project your balance for the next {forecastDays >= 365 ? 'year' : forecastDays >= 30 ? `${Math.round(forecastDays / 30)} months` : `${forecastDays} days`}
            </p>
          </div>

          {/* Time Period Selector */}
          <div className="flex items-center gap-1.5 p-1.5 bg-[var(--background-secondary)] rounded-lg border border-[var(--border-color)] shadow-sm">
            {TIME_PERIODS.map((period) => (
              <button
                key={period.days}
                onClick={() => setForecastDays(period.days)}
                className={`px-4 py-2.5 text-sm font-semibold rounded-md transition-all ${
                  forecastDays === period.days
                    ? 'bg-[var(--accent-primary)] text-white shadow-sm'
                    : 'text-[var(--foreground-secondary)] hover:text-[var(--foreground)] hover:bg-[var(--background-tertiary)]'
                }`}
              >
                <span className="hidden sm:inline">{period.label}</span>
                <span className="sm:hidden">{period.short}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Account Selector */}
        {forecastableAccounts.length > 0 && (
          <div className="mb-6 bg-[var(--background-secondary)] border border-[var(--border-color)] rounded-xl p-4">
            <div className="flex flex-col sm:flex-row sm:items-center gap-4">
              <div className="flex items-center gap-2">
                <Wallet className="w-5 h-5 text-[var(--foreground-muted)]" />
                <span className="text-sm font-medium text-[var(--foreground)]">View forecast for:</span>
              </div>
              
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => setSelectedAccountId('all')}
                  className={`px-3 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2 ${
                    selectedAccountId === 'all'
                      ? 'bg-[var(--accent-primary)] text-white'
                      : 'bg-[var(--background-tertiary)] text-[var(--foreground-secondary)] hover:bg-[var(--background-primary)] border border-[var(--border-color)]'
                  }`}
                >
                  <TrendingUp className="w-4 h-4" />
                  All Accounts
                </button>
                
                {forecastableAccounts.map(account => {
                  const acctForecast = accountForecasts.find(af => af.accountId === account.id);
                  const Icon = account.type === 'credit_card' ? CreditCard : 
                               account.type === 'bank_account' ? Landmark : Building;
                  
                  return (
                    <button
                      key={account.id}
                      onClick={() => setSelectedAccountId(account.id)}
                      className={`px-3 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2 ${
                        selectedAccountId === account.id
                          ? 'bg-[var(--accent-primary)] text-white'
                          : 'bg-[var(--background-tertiary)] text-[var(--foreground-secondary)] hover:bg-[var(--background-primary)] border border-[var(--border-color)]'
                      }`}
                      style={{
                        borderColor: selectedAccountId === account.id ? undefined : account.color + '40'
                      }}
                    >
                      <Icon className="w-4 h-4" style={{ color: selectedAccountId !== account.id ? account.color : undefined }} />
                      <span>{account.name}</span>
                      {account.lastFourDigits && (
                        <span className="text-xs opacity-60">•{account.lastFourDigits}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
            
            {/* Credit Card Payment Preview for Checking Accounts */}
            {selectedAccountForecast?.creditCardPayments && selectedAccountForecast.creditCardPayments.length > 0 && (
              <div className="mt-4 pt-4 border-t border-[var(--border-color)]">
                <p className="text-xs font-medium text-[var(--foreground-muted)] mb-2">
                  Upcoming Credit Card Payments from this Account:
                </p>
                <div className="flex flex-wrap gap-2">
                  {selectedAccountForecast.creditCardPayments.map(payment => (
                    <div
                      key={payment.cardId}
                      className="px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-sm"
                    >
                      <div className="flex items-center gap-2">
                        <CreditCard className="w-4 h-4 text-red-400" />
                        <span className="font-medium text-[var(--foreground)]">{payment.cardName}</span>
                      </div>
                      <div className="flex items-center gap-2 mt-1 text-xs text-[var(--foreground-muted)]">
                        <span className="text-red-400 font-semibold">-${payment.amount.toLocaleString()}</span>
                        <span>due {format(new Date(payment.dueDate), 'MMM d')}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Setup Required Banner */}
        {!hasSetup && (
          <div className="mb-8 p-6 bg-[var(--accent-primary)]/10 border-2 border-[var(--accent-primary)]/40 rounded-xl shadow-sm">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 rounded-xl bg-[var(--accent-primary)]/20 flex items-center justify-center flex-shrink-0">
                  <AlertTriangle className="w-6 h-6 text-[var(--accent-primary)]" />
                </div>
                <div>
                  <p className="font-bold text-lg text-[var(--foreground)] mb-1">Setup Required</p>
                  <p className="text-sm text-[var(--foreground-secondary)]">
                    Add your bank accounts, income sources, and bills to see your forecast.
                  </p>
                </div>
              </div>
              <button
                onClick={() => router.push('/onboarding?continue=true')}
                className="btn-primary flex items-center gap-2 whitespace-nowrap px-5 py-3 shadow-sm"
              >
                Complete Setup
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {/* Essential Numbers - Only what matters for decisions */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          {/* Current Position */}
          <div className="p-5 bg-[var(--background-secondary)] border border-[var(--border-color)] rounded-xl shadow-sm hover:shadow-md transition-shadow">
            <p className="text-xs font-semibold text-[var(--foreground-muted)] uppercase tracking-wide mb-2">
              {selectedAccountId === 'all' ? 'Total Cash Available' : `${selectedAccountForecast?.accountName || 'Account'} Balance`}
            </p>
            <p className={`text-3xl font-bold ${
              selectedAccountForecast?.accountType === 'credit_card' ? 'text-red-500' : 'text-emerald-500'
            }`}>
              {selectedAccountForecast?.accountType === 'credit_card' ? '-' : ''}${(
                selectedAccountId === 'all'
                  ? currentCash
                  : Math.abs(selectedAccountForecast?.currentBalance || 0)
              ).toLocaleString()}
            </p>
            {selectedAccountForecast?.accountType === 'credit_card' && (
              <p className="text-xs text-[var(--foreground-muted)] mt-1">Balance owed</p>
            )}
          </div>

          {/* Emergency Runway - Days */}
          <div className="p-5 bg-[var(--background-secondary)] border border-[var(--border-color)] rounded-xl shadow-sm hover:shadow-md transition-shadow">
            <div className="flex items-center gap-2 mb-2">
              <Shield className="w-4 h-4 text-[var(--foreground-muted)]" />
              <p className="text-xs font-semibold text-[var(--foreground-muted)] uppercase tracking-wide">Runway (Days)</p>
            </div>
            {(() => {
              const dailyExpense = monthlyExpenses / 30;
              const days = dailyExpense > 0 ? Math.floor(currentCash / dailyExpense) : 999;
              return (
                <p className={`text-3xl font-bold ${
                  days < 30 ? 'text-red-500' : days < 90 ? 'text-amber-500' : 'text-emerald-500'
                }`}>
                  {days > 365 ? '365+' : days}
                </p>
              );
            })()}
          </div>

          {/* Emergency Runway - Months */}
          <div className="p-5 bg-[var(--background-secondary)] border border-[var(--border-color)] rounded-xl shadow-sm hover:shadow-md transition-shadow">
            <div className="flex items-center gap-2 mb-2">
              <Shield className="w-4 h-4 text-[var(--foreground-muted)]" />
              <p className="text-xs font-semibold text-[var(--foreground-muted)] uppercase tracking-wide">Runway (Months)</p>
            </div>
            {(() => {
              const months = monthlyExpenses > 0 ? currentCash / monthlyExpenses : 99;
              return (
                <>
                  <p className={`text-3xl font-bold ${
                    months < 1 ? 'text-red-500' : months < 3 ? 'text-amber-500' : 'text-emerald-500'
                  }`}>
                    {months > 12 ? '12+' : months.toFixed(1)}
                  </p>
                  <p className="text-xs text-[var(--foreground-muted)] mt-1 font-medium">Goal: 3-6 months</p>
                </>
              );
            })()}
          </div>

          {/* Critical Warning or All Clear */}
          <div className={`p-5 rounded-xl border shadow-sm hover:shadow-md transition-shadow ${
            forecast.daysUntilUnsafe !== null
              ? 'bg-amber-500/10 border-amber-500/40'
              : 'bg-emerald-500/10 border-emerald-500/40'
          }`}>
            <p className="text-xs font-semibold text-[var(--foreground-muted)] uppercase tracking-wide mb-2">
              {forecast.daysUntilUnsafe !== null ? 'Attention' : 'Status'}
            </p>
            {forecast.daysUntilUnsafe !== null ? (
              <div>
                <p className="text-3xl font-bold text-amber-500">
                  {forecast.daysUntilUnsafe}d
                </p>
                <p className="text-xs text-[var(--foreground-muted)] mt-1">
                  ${forecast.lowestBalance.toLocaleString()} on {format(new Date(forecast.lowestBalanceDate), 'MMM d')}
                </p>
              </div>
            ) : (
              <p className="text-3xl font-bold text-emerald-500">
                All Clear
              </p>
            )}
          </div>
        </div>

        {/* Main Content Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left Column - Chart, Timeline, and AI Insights */}
          <div className="lg:col-span-2 space-y-6">
            <ForecastChart forecast={forecast} />
            <ForecastTimeline forecast={forecast} />
            <AIInsightsPanel 
              transactions={transactions}
              accounts={profile?.paymentAccounts || []}
              incomeSources={profile?.incomeSources || []}
              currentCash={currentCash}
              safetyThreshold={profile?.settings?.safetyThreshold || 500}
            />
          </div>

          {/* Right Column - Decision Tools */}
          <div className="space-y-6">
            {/* Decision Check */}
            <DecisionCheckPanel forecast={forecast} />
            
            {/* Budget Status (only if budgets are set) */}
            {profile?.settings?.categoryBudgets && profile.settings.categoryBudgets.length > 0 && (
              <BudgetStatusPanel
                budgets={profile.settings.categoryBudgets}
                transactions={transactions}
                compact={true}
              />
            )}
            
            {/* Upcoming Bills */}
            <UpcomingBillsPanel
              accounts={profile?.paymentAccounts || []}
              transactions={transactions}
              preferences={profile?.settings?.notificationPreferences}
              compact={true}
            />
            
            {/* Savings Goals */}
            <SavingsGoalsPanel
              goals={savingsGoals}
              accounts={profile?.paymentAccounts || []}
              forecast={forecast}
              safetyThreshold={profile?.settings?.safetyThreshold || 500}
              onAddGoal={handleAddGoal}
              onUpdateGoal={handleUpdateGoal}
              onDeleteGoal={handleDeleteGoal}
              compact={true}
            />
            
            {/* Planned Payments (Financial Todos) */}
            <PlannedPaymentsPanel />
            
            {/* Emergency Fund */}
            <EmergencyFundPanel 
              forecast={forecast} 
              monthlyExpenses={monthlyExpenses} 
              currentCash={currentCash} 
            />
            
            {/* AI Q&A */}
            <AIQuestionPanel forecast={forecast} />
          </div>
        </div>
      </main>
    </div>
  );
}

