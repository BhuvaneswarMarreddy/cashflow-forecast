'use client';

import React, { useEffect, useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { useTransactions } from '@/context/TransactionContext';
import { useUserProfile } from '@/context/UserProfileContext';
import Navbar from '@/components/Navbar';
import { EXPENSE_CATEGORIES, Transaction, getMerchantColor, displayCategory } from '@/types';
import { classifyTransaction } from '@/lib/classify';
import {
  TrendingUp,
  TrendingDown,
  Calendar,
  BarChart3,
  PieChart as PieChartIcon,
  ArrowUpRight,
  ArrowDownRight,
  ChevronLeft,
  ChevronRight,
  Target,
  Zap,
  AlertTriangle,
  Store,
  ShoppingBag,
} from 'lucide-react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  ReferenceLine,
  ComposedChart,
  Line,
} from 'recharts';
import { 
  format, 
  parseISO, 
  startOfWeek, 
  endOfWeek, 
  startOfMonth, 
  endOfMonth,
  eachDayOfInterval,
  eachWeekOfInterval,
  subWeeks,
  subMonths,
  addWeeks,
  addMonths,
  isWithinInterval,
  isSameDay,
  differenceInDays,
} from 'date-fns';

type ViewMode = 'weekly' | 'monthly';
type ChartType = 'area' | 'bar' | 'composed';

const CHART_COLORS = [
  '#7c3aed', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', 
  '#ec4899', '#8b5cf6', '#14b8a6', '#f97316', '#6366f1'
];

export default function AnalyticsPage() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { transactions } = useTransactions();
  const { profile, isLoading: profileLoading, isOnboarded } = useUserProfile();
  const router = useRouter();

  const [viewMode, setViewMode] = useState<ViewMode>('weekly');
  const [chartType, setChartType] = useState<ChartType>('area');
  const [currentDate, setCurrentDate] = useState(new Date());
  const [showProjection, setShowProjection] = useState(true);

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

  // The one classifier — this screen used to carry its own copy, so the same month
  // could report three different Income/Expense figures across three pages.
  const isRealIncome = (t: Transaction) =>
    classifyTransaction(t, profile?.paymentAccounts) === 'income';
  const isRealExpense = (t: Transaction) =>
    classifyTransaction(t, profile?.paymentAccounts) === 'expense';

  // Calculate date range based on view mode
  const dateRange = useMemo(() => {
    if (viewMode === 'weekly') {
      return {
        start: startOfWeek(currentDate, { weekStartsOn: 0 }),
        end: endOfWeek(currentDate, { weekStartsOn: 0 }),
      };
    } else {
      return {
        start: startOfMonth(currentDate),
        end: endOfMonth(currentDate),
      };
    }
  }, [viewMode, currentDate]);

  // Filter transactions for current period
  const periodTransactions = useMemo(() => {
    return transactions.filter(t => {
      const txnDate = parseISO(t.date);
      return isWithinInterval(txnDate, dateRange);
    });
  }, [transactions, dateRange]);

  // Calculate daily spending data for charts
  const dailyData = useMemo(() => {
    const days = eachDayOfInterval(dateRange);
    const today = new Date();
    
    return days.map(day => {
      const dayTransactions = transactions.filter(t => 
        isSameDay(parseISO(t.date), day)
      );
      
      const expenses = dayTransactions
        .filter(isRealExpense)
        .reduce((sum, t) => sum + t.amount, 0);
      
      const income = dayTransactions
        .filter(isRealIncome)
        .reduce((sum, t) => sum + t.amount, 0);

      const isPast = day <= today;
      const isProjected = day > today;

      return {
        date: format(day, 'MMM d'),
        fullDate: format(day, 'yyyy-MM-dd'),
        dayOfWeek: format(day, 'EEE'),
        expenses: isPast ? expenses : null,
        income: isPast ? income : null,
        projectedExpenses: isProjected ? (profile?.monthlyBudget || 3000) / 30 : null,
        net: isPast ? income - expenses : null,
        isPast,
        isProjected,
      };
    });
  }, [transactions, dateRange, profile?.monthlyBudget]);

  // Calculate weekly comparison data
  const weeklyComparison = useMemo(() => {
    const weeks = [];
    for (let i = 11; i >= 0; i--) {
      const weekStart = startOfWeek(subWeeks(new Date(), i), { weekStartsOn: 0 });
      const weekEnd = endOfWeek(weekStart, { weekStartsOn: 0 });
      
      const weekTxns = transactions.filter(t => {
        const txnDate = parseISO(t.date);
        return isWithinInterval(txnDate, { start: weekStart, end: weekEnd });
      });
      
      const expenses = weekTxns.filter(isRealExpense).reduce((sum, t) => sum + t.amount, 0);
      const income = weekTxns.filter(isRealIncome).reduce((sum, t) => sum + t.amount, 0);
      
      weeks.push({
        week: format(weekStart, 'MMM d'),
        expenses,
        income,
        net: income - expenses,
        budget: (profile?.monthlyBudget || 3000) / 4,
      });
    }
    return weeks;
  }, [transactions, profile?.monthlyBudget]);

  // Calculate monthly comparison data
  const monthlyComparison = useMemo(() => {
    const months = [];
    for (let i = 11; i >= 0; i--) {
      const monthStart = startOfMonth(subMonths(new Date(), i));
      const monthEnd = endOfMonth(monthStart);
      
      const monthTxns = transactions.filter(t => {
        const txnDate = parseISO(t.date);
        return isWithinInterval(txnDate, { start: monthStart, end: monthEnd });
      });
      
      const expenses = monthTxns.filter(isRealExpense).reduce((sum, t) => sum + t.amount, 0);
      const income = monthTxns.filter(isRealIncome).reduce((sum, t) => sum + t.amount, 0);
      
      months.push({
        month: format(monthStart, 'MMM yy'),
        expenses,
        income,
        net: income - expenses,
        budget: profile?.monthlyBudget || 3000,
      });
    }
    return months;
  }, [transactions, profile?.monthlyBudget]);

  // Calculate category breakdown — grouped by the user's own label (Monarch's real
  // category when present) so the pie stops collapsing a third of spend into "Other".
  const categoryBreakdown = useMemo(() => {
    const categories: { [key: string]: { amount: number; icon: string } } = {};

    periodTransactions
      .filter(isRealExpense)
      .forEach(t => {
        const name = displayCategory(t);
        const icon = EXPENSE_CATEGORIES.find(c => c.value === t.category)?.icon || '📋';
        categories[name] ??= { amount: 0, icon };
        categories[name].amount += t.amount;
      });

    return Object.entries(categories)
      .map(([name, { amount, icon }], index) => ({
        name,
        value: amount,
        icon,
        color: CHART_COLORS[index % CHART_COLORS.length],
      }))
      .sort((a, b) => b.value - a.value);
  }, [periodTransactions]);

  // Calculate merchant breakdown
  const merchantBreakdown = useMemo(() => {
    const merchants: { [key: string]: { amount: number; count: number } } = {};
    
    periodTransactions
      .filter(t => isRealExpense(t) && t.merchant)
      .forEach(t => {
        const merchantName = t.merchant!;
        if (!merchants[merchantName]) {
          merchants[merchantName] = { amount: 0, count: 0 };
        }
        merchants[merchantName].amount += t.amount;
        merchants[merchantName].count += 1;
      });
    
    return Object.entries(merchants)
      .map(([merchant, data]) => ({
        name: merchant,
        value: data.amount,
        count: data.count,
        color: getMerchantColor(merchant),
      }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10);
  }, [periodTransactions]);

  // Calculate top merchants for pie chart
  const topMerchantsPieData = useMemo(() => {
    const top5 = merchantBreakdown.slice(0, 5);
    const otherTotal = merchantBreakdown.slice(5).reduce((sum, m) => sum + m.value, 0);
    
    if (otherTotal > 0) {
      return [...top5, { name: 'Other', value: otherTotal, count: 0, color: '#6b7280' }];
    }
    return top5;
  }, [merchantBreakdown]);

  // Calculate totals
  // Only count real income (not credit card payments)
  const totals = useMemo(() => {
    const expenses = periodTransactions.filter(isRealExpense).reduce((sum, t) => sum + t.amount, 0);
    const income = periodTransactions.filter(isRealIncome).reduce((sum, t) => sum + t.amount, 0);
    const budget = viewMode === 'weekly' 
      ? (profile?.monthlyBudget || 3000) / 4 
      : (profile?.monthlyBudget || 3000);
    
    return {
      expenses,
      income,
      net: income - expenses,
      budget,
      budgetUsed: (expenses / budget) * 100,
      remaining: budget - expenses,
    };
  }, [periodTransactions, viewMode, profile?.monthlyBudget]);

  // Calculate projections
  const projections = useMemo(() => {
    const daysInPeriod = differenceInDays(dateRange.end, dateRange.start) + 1;
    const daysPassed = Math.min(differenceInDays(new Date(), dateRange.start) + 1, daysInPeriod);
    const daysRemaining = daysInPeriod - daysPassed;
    
    const avgDailySpend = daysPassed > 0 ? totals.expenses / daysPassed : 0;
    const projectedTotal = totals.expenses + (avgDailySpend * daysRemaining);
    
    // Trend calculation (compare to previous period)
    const prevStart = viewMode === 'weekly' ? subWeeks(dateRange.start, 1) : subMonths(dateRange.start, 1);
    const prevEnd = viewMode === 'weekly' ? subWeeks(dateRange.end, 1) : subMonths(dateRange.end, 1);
    
    const prevExpenses = transactions
      .filter(t => {
        const txnDate = parseISO(t.date);
        return isWithinInterval(txnDate, { start: prevStart, end: prevEnd }) && isRealExpense(t);
      })
      .reduce((sum, t) => sum + t.amount, 0);
    
    const trend = prevExpenses > 0 ? ((totals.expenses - prevExpenses) / prevExpenses) * 100 : 0;
    
    return {
      avgDailySpend,
      projectedTotal,
      daysRemaining,
      trend,
      willExceedBudget: projectedTotal > totals.budget,
      projectedOverage: Math.max(0, projectedTotal - totals.budget),
    };
  }, [dateRange, totals, transactions, viewMode]);

  // Navigation handlers
  const goToPrevious = () => {
    if (viewMode === 'weekly') {
      setCurrentDate(subWeeks(currentDate, 1));
    } else {
      setCurrentDate(subMonths(currentDate, 1));
    }
  };

  const goToNext = () => {
    if (viewMode === 'weekly') {
      setCurrentDate(addWeeks(currentDate, 1));
    } else {
      setCurrentDate(addMonths(currentDate, 1));
    }
  };

  const goToToday = () => {
    setCurrentDate(new Date());
  };

  // Custom tooltip
  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-[var(--background-secondary)] border border-[var(--border-color)] rounded-lg p-3 shadow-lg">
          <p className="text-sm font-medium text-[var(--foreground)] mb-2">{label}</p>
          {payload.map((entry: any, index: number) => (
            <p key={index} className="text-sm" style={{ color: entry.color }}>
              {entry.name}: ${entry.value?.toLocaleString() || 0}
            </p>
          ))}
        </div>
      );
    }
    return null;
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

  return (
    <div className="min-h-screen relative">
      <div className="bg-pattern" />
      <Navbar />

      <main className="pt-24 pb-12 px-4 sm:px-6 lg:px-8 max-w-7xl mx-auto relative z-10">
        {/* Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-[var(--foreground)]">Spending Analytics</h1>
            <p className="text-[var(--foreground-secondary)] mt-1">
              Track your spending patterns like a stock portfolio
            </p>
          </div>
          
          {/* View Toggle */}
          <div className="flex items-center gap-2">
            <div className="flex bg-[var(--background-tertiary)] rounded-lg p-1">
              <button
                onClick={() => setViewMode('weekly')}
                className={`px-4 py-2 rounded-md text-sm font-medium transition-all ${
                  viewMode === 'weekly'
                    ? 'bg-[var(--accent-primary)] text-white'
                    : 'text-[var(--foreground-secondary)] hover:text-[var(--foreground)]'
                }`}
              >
                Weekly
              </button>
              <button
                onClick={() => setViewMode('monthly')}
                className={`px-4 py-2 rounded-md text-sm font-medium transition-all ${
                  viewMode === 'monthly'
                    ? 'bg-[var(--accent-primary)] text-white'
                    : 'text-[var(--foreground-secondary)] hover:text-[var(--foreground)]'
                }`}
              >
                Monthly
              </button>
            </div>
          </div>
        </div>

        {/* Period Navigation */}
        <div className="flex items-center justify-between mb-6 p-4 bg-[var(--background-secondary)] rounded-xl border border-[var(--border-color)]">
          <button 
            onClick={goToPrevious}
            className="p-2 rounded-lg hover:bg-[var(--background-tertiary)] transition-colors"
          >
            <ChevronLeft className="w-5 h-5 text-[var(--foreground-secondary)]" />
          </button>
          
          <div className="text-center">
            <p className="text-lg font-semibold text-[var(--foreground)]">
              {viewMode === 'weekly' 
                ? `${format(dateRange.start, 'MMM d')} - ${format(dateRange.end, 'MMM d, yyyy')}`
                : format(dateRange.start, 'MMMM yyyy')
              }
            </p>
            <button 
              onClick={goToToday}
              className="text-sm text-[var(--accent-primary)] hover:underline"
            >
              Go to today
            </button>
          </div>
          
          <button 
            onClick={goToNext}
            className="p-2 rounded-lg hover:bg-[var(--background-tertiary)] transition-colors"
          >
            <ChevronRight className="w-5 h-5 text-[var(--foreground-secondary)]" />
          </button>
        </div>

        {/* Summary Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4 mb-6">
          <div className="p-4 rounded-xl bg-[var(--background-secondary)] border border-[var(--border-color)]">
            <div className="flex items-center gap-2 mb-2">
              <ArrowDownRight className="w-4 h-4 text-red-400" />
              <span className="text-xs sm:text-sm text-[var(--foreground-muted)]">Spent</span>
            </div>
            <p className="text-xl sm:text-2xl font-bold text-red-400">
              ${totals.expenses.toLocaleString()}
            </p>
            <div className="mt-2 h-1.5 bg-[var(--background-tertiary)] rounded-full overflow-hidden">
              <div 
                className={`h-full rounded-full ${totals.budgetUsed > 100 ? 'bg-red-500' : totals.budgetUsed > 80 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                style={{ width: `${Math.min(totals.budgetUsed, 100)}%` }}
              />
            </div>
            <p className="text-xs text-[var(--foreground-muted)] mt-1">
              {totals.budgetUsed.toFixed(0)}% of budget
            </p>
          </div>

          <div className="p-4 rounded-xl bg-[var(--background-secondary)] border border-[var(--border-color)]">
            <div className="flex items-center gap-2 mb-2">
              <ArrowUpRight className="w-4 h-4 text-emerald-500" />
              <span className="text-xs sm:text-sm text-[var(--foreground-muted)]">Income</span>
            </div>
            <p className="text-xl sm:text-2xl font-bold text-emerald-500">
              ${totals.income.toLocaleString()}
            </p>
          </div>

          <div className="p-4 rounded-xl bg-[var(--background-secondary)] border border-[var(--border-color)]">
            <div className="flex items-center gap-2 mb-2">
              <Target className="w-4 h-4 text-[var(--accent-primary)]" />
              <span className="text-xs sm:text-sm text-[var(--foreground-muted)]">Remaining</span>
            </div>
            <p className={`text-xl sm:text-2xl font-bold ${totals.remaining >= 0 ? 'text-emerald-500' : 'text-red-400'}`}>
              ${Math.abs(totals.remaining).toLocaleString()}
            </p>
            {totals.remaining < 0 && (
              <p className="text-xs text-red-400">Over budget</p>
            )}
          </div>

          <div className="p-4 rounded-xl bg-[var(--background-secondary)] border border-[var(--border-color)]">
            <div className="flex items-center gap-2 mb-2">
              {projections.trend >= 0 ? (
                <TrendingUp className="w-4 h-4 text-red-400" />
              ) : (
                <TrendingDown className="w-4 h-4 text-emerald-500" />
              )}
              <span className="text-xs sm:text-sm text-[var(--foreground-muted)]">vs Last {viewMode === 'weekly' ? 'Week' : 'Month'}</span>
            </div>
            <p className={`text-xl sm:text-2xl font-bold ${projections.trend >= 0 ? 'text-red-400' : 'text-emerald-500'}`}>
              {projections.trend >= 0 ? '+' : ''}{projections.trend.toFixed(1)}%
            </p>
          </div>
        </div>

        {/* Projection Alert */}
        {projections.willExceedBudget && projections.daysRemaining > 0 && (
          <div className="mb-6 p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-[var(--foreground)]">Projected to exceed budget</p>
              <p className="text-sm text-[var(--foreground-secondary)]">
                At your current pace (${projections.avgDailySpend.toFixed(0)}/day), you&apos;ll spend about ${projections.projectedTotal.toLocaleString()} this {viewMode === 'weekly' ? 'week' : 'month'}, which is ${projections.projectedOverage.toLocaleString()} over budget.
              </p>
            </div>
          </div>
        )}

        {/* Main Chart */}
        <div className="bg-[var(--background-secondary)] border border-[var(--border-color)] rounded-xl p-4 sm:p-6 mb-6">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
            <h3 className="text-lg font-semibold text-[var(--foreground)]">
              {viewMode === 'weekly' ? 'Daily' : 'Daily'} Spending
            </h3>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-2 text-sm text-[var(--foreground-secondary)]">
                <input
                  type="checkbox"
                  checked={showProjection}
                  onChange={(e) => setShowProjection(e.target.checked)}
                  className="w-4 h-4 rounded border-[var(--border-color)] bg-[var(--background-tertiary)] text-[var(--accent-primary)]"
                />
                Show projection
              </label>
              <div className="flex bg-[var(--background-tertiary)] rounded-lg p-1">
                {(['area', 'bar', 'composed'] as ChartType[]).map((type) => (
                  <button
                    key={type}
                    onClick={() => setChartType(type)}
                    className={`px-3 py-1 rounded text-xs font-medium transition-all ${
                      chartType === type
                        ? 'bg-[var(--accent-primary)] text-white'
                        : 'text-[var(--foreground-secondary)]'
                    }`}
                  >
                    {type.charAt(0).toUpperCase() + type.slice(1)}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="h-[300px] sm:h-[350px]">
            <ResponsiveContainer width="100%" height="100%">
              {chartType === 'area' ? (
                <AreaChart data={dailyData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="expenseGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#ef4444" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="projectedGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" vertical={false} />
                  <XAxis dataKey="date" stroke="var(--foreground-muted)" fontSize={12} tickLine={false} />
                  <YAxis stroke="var(--foreground-muted)" fontSize={12} tickLine={false} tickFormatter={(v) => `$${v}`} />
                  <Tooltip content={<CustomTooltip />} />
                  <Area type="monotone" dataKey="expenses" stroke="#ef4444" strokeWidth={2} fill="url(#expenseGradient)" name="Expenses" />
                  {showProjection && (
                    <Area type="monotone" dataKey="projectedExpenses" stroke="#f59e0b" strokeWidth={2} strokeDasharray="5 5" fill="url(#projectedGradient)" name="Projected" />
                  )}
                  <ReferenceLine y={totals.budget / (viewMode === 'weekly' ? 7 : 30)} stroke="#10b981" strokeDasharray="5 5" label={{ value: 'Daily Budget', position: 'right', fill: '#10b981', fontSize: 10 }} />
                </AreaChart>
              ) : chartType === 'bar' ? (
                <BarChart data={dailyData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" vertical={false} />
                  <XAxis dataKey="date" stroke="var(--foreground-muted)" fontSize={12} tickLine={false} />
                  <YAxis stroke="var(--foreground-muted)" fontSize={12} tickLine={false} tickFormatter={(v) => `$${v}`} />
                  <Tooltip content={<CustomTooltip />} />
                  <Bar dataKey="expenses" fill="#ef4444" radius={[4, 4, 0, 0]} name="Expenses" />
                  {showProjection && (
                    <Bar dataKey="projectedExpenses" fill="#f59e0b" opacity={0.5} radius={[4, 4, 0, 0]} name="Projected" />
                  )}
                  <ReferenceLine y={totals.budget / (viewMode === 'weekly' ? 7 : 30)} stroke="#10b981" strokeDasharray="5 5" />
                </BarChart>
              ) : (
                <ComposedChart data={dailyData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" vertical={false} />
                  <XAxis dataKey="date" stroke="var(--foreground-muted)" fontSize={12} tickLine={false} />
                  <YAxis stroke="var(--foreground-muted)" fontSize={12} tickLine={false} tickFormatter={(v) => `$${v}`} />
                  <Tooltip content={<CustomTooltip />} />
                  <Bar dataKey="expenses" fill="#ef4444" opacity={0.8} radius={[4, 4, 0, 0]} name="Expenses" />
                  {showProjection && (
                    <Line type="monotone" dataKey="projectedExpenses" stroke="#f59e0b" strokeWidth={2} strokeDasharray="5 5" dot={false} name="Projected" />
                  )}
                  <ReferenceLine y={totals.budget / (viewMode === 'weekly' ? 7 : 30)} stroke="#10b981" strokeDasharray="5 5" />
                </ComposedChart>
              )}
            </ResponsiveContainer>
          </div>

          {/* Legend */}
          <div className="flex flex-wrap items-center justify-center gap-4 mt-4 text-sm">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-red-400" />
              <span className="text-[var(--foreground-secondary)]">Actual Spending</span>
            </div>
            {showProjection && (
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-amber-500" />
                <span className="text-[var(--foreground-secondary)]">Projected</span>
              </div>
            )}
            <div className="flex items-center gap-2">
              <div className="w-8 h-0.5 bg-emerald-500 border-dashed border-t-2 border-emerald-500" />
              <span className="text-[var(--foreground-secondary)]">Daily Budget</span>
            </div>
          </div>
        </div>

        {/* Historical Comparison */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
          {/* Trend Chart */}
          <div className="bg-[var(--background-secondary)] border border-[var(--border-color)] rounded-xl p-4 sm:p-6">
            <h3 className="text-lg font-semibold text-[var(--foreground)] mb-4">
              {viewMode === 'weekly' ? '12-Week' : '12-Month'} Trend
            </h3>
            <div className="h-[250px]">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={viewMode === 'weekly' ? weeklyComparison : monthlyComparison}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" vertical={false} />
                  <XAxis dataKey={viewMode === 'weekly' ? 'week' : 'month'} stroke="var(--foreground-muted)" fontSize={10} tickLine={false} />
                  <YAxis stroke="var(--foreground-muted)" fontSize={10} tickLine={false} tickFormatter={(v) => `$${(v/1000).toFixed(0)}k`} />
                  <Tooltip content={<CustomTooltip />} />
                  <Bar dataKey="expenses" fill="#ef4444" opacity={0.8} radius={[2, 2, 0, 0]} name="Expenses" />
                  <Line type="monotone" dataKey="budget" stroke="#10b981" strokeWidth={2} strokeDasharray="5 5" dot={false} name="Budget" />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Category Breakdown */}
          <div className="bg-[var(--background-secondary)] border border-[var(--border-color)] rounded-xl p-4 sm:p-6">
            <h3 className="text-lg font-semibold text-[var(--foreground)] mb-4">Category Breakdown</h3>
            {categoryBreakdown.length > 0 ? (
              <div className="flex flex-col sm:flex-row items-center gap-4">
                <div className="w-[180px] h-[180px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={categoryBreakdown}
                        cx="50%"
                        cy="50%"
                        innerRadius={50}
                        outerRadius={80}
                        paddingAngle={2}
                        dataKey="value"
                      >
                        {categoryBreakdown.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={entry.color} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(value) => [`$${(value as number)?.toLocaleString() || 0}`, '']} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="flex-1 space-y-2 max-h-[200px] overflow-y-auto">
                  {categoryBreakdown.slice(0, 6).map((cat, i) => (
                    <div key={i} className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className="w-3 h-3 rounded-full" style={{ backgroundColor: cat.color }} />
                        <span className="text-sm text-[var(--foreground-secondary)]">
                          {cat.icon} {cat.name}
                        </span>
                      </div>
                      <span className="text-sm font-medium text-[var(--foreground)]">
                        ${cat.value.toLocaleString()}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="text-center py-8 text-[var(--foreground-muted)]">
                <PieChartIcon className="w-12 h-12 mx-auto mb-3 opacity-50" />
                <p>No spending data for this period</p>
              </div>
            )}
          </div>
        </div>

        {/* Merchant Breakdown Section */}
        <div className="bg-[var(--background-secondary)] border border-[var(--border-color)] rounded-xl p-4 sm:p-6 mb-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center">
              <Store className="w-5 h-5 text-white" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-[var(--foreground)]">Where You Spend</h3>
              <p className="text-sm text-[var(--foreground-muted)]">Top merchants this {viewMode === 'weekly' ? 'week' : 'month'}</p>
            </div>
          </div>

          {merchantBreakdown.length > 0 ? (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Merchant Pie Chart */}
              <div className="flex flex-col items-center">
                <div className="w-[220px] h-[220px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={topMerchantsPieData}
                        cx="50%"
                        cy="50%"
                        innerRadius={60}
                        outerRadius={100}
                        paddingAngle={3}
                        dataKey="value"
                      >
                        {topMerchantsPieData.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={entry.color} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(value) => [`$${(value as number)?.toLocaleString() || 0}`, '']} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <p className="text-sm text-[var(--foreground-muted)] mt-2">
                  {merchantBreakdown.length} merchants this period
                </p>
              </div>

              {/* Merchant List */}
              <div className="space-y-3 max-h-[300px] overflow-y-auto">
                {merchantBreakdown.map((merchant, index) => (
                  <div
                    key={merchant.name}
                    className="flex items-center gap-3 p-3 rounded-lg bg-[var(--background-tertiary)] hover:bg-[var(--background-tertiary)]/80 transition-colors"
                  >
                    <div className="flex items-center justify-center w-10 h-10 rounded-lg text-white font-bold text-sm" style={{ backgroundColor: merchant.color }}>
                      {index + 1}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-medium text-[var(--foreground)] truncate">{merchant.name}</p>
                      </div>
                      <p className="text-sm text-[var(--foreground-muted)]">
                        {merchant.count} transaction{merchant.count > 1 ? 's' : ''}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="font-bold text-[var(--foreground)]">${merchant.value.toLocaleString()}</p>
                      <p className="text-xs text-[var(--foreground-muted)]">
                        {((merchant.value / totals.expenses) * 100).toFixed(1)}%
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="text-center py-12">
              <ShoppingBag className="w-12 h-12 mx-auto mb-3 text-[var(--foreground-muted)] opacity-50" />
              <p className="text-[var(--foreground-secondary)]">No merchant data yet</p>
              <p className="text-sm text-[var(--foreground-muted)] mt-1">
                Add a merchant when recording transactions to see spending by store
              </p>
            </div>
          )}
        </div>

        {/* Quick Stats Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
          <div className="p-4 rounded-xl bg-[var(--background-secondary)] border border-[var(--border-color)]">
            <p className="text-xs text-[var(--foreground-muted)] mb-1">Daily Average</p>
            <p className="text-xl font-bold text-[var(--foreground)]">
              ${projections.avgDailySpend.toFixed(0)}
            </p>
          </div>
          <div className="p-4 rounded-xl bg-[var(--background-secondary)] border border-[var(--border-color)]">
            <p className="text-xs text-[var(--foreground-muted)] mb-1">Days Left</p>
            <p className="text-xl font-bold text-[var(--foreground)]">
              {projections.daysRemaining}
            </p>
          </div>
          <div className="p-4 rounded-xl bg-[var(--background-secondary)] border border-[var(--border-color)]">
            <p className="text-xs text-[var(--foreground-muted)] mb-1">Projected Total</p>
            <p className={`text-xl font-bold ${projections.willExceedBudget ? 'text-red-400' : 'text-[var(--foreground)]'}`}>
              ${projections.projectedTotal.toLocaleString()}
            </p>
          </div>
          <div className="p-4 rounded-xl bg-[var(--background-secondary)] border border-[var(--border-color)]">
            <p className="text-xs text-[var(--foreground-muted)] mb-1">Can Spend/Day</p>
            <p className={`text-xl font-bold ${totals.remaining > 0 ? 'text-emerald-500' : 'text-red-400'}`}>
              ${projections.daysRemaining > 0 ? Math.max(0, totals.remaining / projections.daysRemaining).toFixed(0) : 0}
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}

