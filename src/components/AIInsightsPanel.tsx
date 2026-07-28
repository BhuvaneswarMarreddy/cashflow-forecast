'use client';

import React, { useState, useMemo } from 'react';
import { Transaction, PaymentAccount, IncomeSource } from '@/types';
import { classifyTransaction } from '@/lib/classify';
import { aiDecision } from '@/lib/callables';
import { 
  TrendingUp, 
  TrendingDown, 
  Lightbulb, 
  Calendar,
  DollarSign,
  AlertTriangle,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  Sparkles,
  BarChart3,
  ArrowRight,
} from 'lucide-react';
import { format, parseISO, startOfMonth, endOfMonth, subMonths, isWithinInterval } from 'date-fns';

interface AIInsightsPanelProps {
  transactions: Transaction[];
  accounts: PaymentAccount[];
  incomeSources: IncomeSource[];
  currentCash: number;
  safetyThreshold: number;
}

interface MonthlyData {
  month: string;
  monthLabel: string;
  income: number;
  expenses: number;
  net: number;
  transactionCount: number;
  topCategories: { category: string; amount: number }[];
  topMerchants: { merchant: string; amount: number }[];
}

export default function AIInsightsPanel({ 
  transactions, 
  accounts, 
  incomeSources,
  currentCash,
  safetyThreshold 
}: AIInsightsPanelProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [aiInsight, setAiInsight] = useState<string | null>(null);
  const [expandedMonth, setExpandedMonth] = useState<string | null>(null);
  const [showAllMonths, setShowAllMonths] = useState(false);

  // Calculate monthly data for the last 6 months
  const monthlyData: MonthlyData[] = useMemo(() => {
    const months: MonthlyData[] = [];
    
    for (let i = 0; i < 6; i++) {
      const monthStart = startOfMonth(subMonths(new Date(), i));
      const monthEnd = endOfMonth(monthStart);
      
      const monthTxns = transactions.filter(t => {
        const txnDate = parseISO(t.date);
        return isWithinInterval(txnDate, { start: monthStart, end: monthEnd });
      });
      
      let income = 0;
      let expenses = 0;
      const categoryTotals: { [key: string]: number } = {};
      const merchantTotals: { [key: string]: number } = {};
      
      monthTxns.forEach(t => {
        const classification = classifyTransaction(t, accounts);
        
        if (classification === 'income') {
          income += t.amount;
        } else if (classification === 'expense') {
          expenses += t.amount;
          
          // Track categories
          categoryTotals[t.category] = (categoryTotals[t.category] || 0) + t.amount;
          
          // Track merchants
          if (t.merchant) {
            merchantTotals[t.merchant] = (merchantTotals[t.merchant] || 0) + t.amount;
          }
        }
      });
      
      const topCategories = Object.entries(categoryTotals)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([category, amount]) => ({ category, amount }));
      
      const topMerchants = Object.entries(merchantTotals)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([merchant, amount]) => ({ merchant, amount }));
      
      months.push({
        month: format(monthStart, 'yyyy-MM'),
        monthLabel: format(monthStart, 'MMMM yyyy'),
        income,
        expenses,
        net: income - expenses,
        transactionCount: monthTxns.length,
        topCategories,
        topMerchants,
      });
    }
    
    return months;
  }, [transactions, accounts]);

  // Calculate trends
  const trends = useMemo(() => {
    if (monthlyData.length < 2) return null;
    
    const currentMonth = monthlyData[0];
    const lastMonth = monthlyData[1];
    const threeMonthAvg = monthlyData.slice(0, 3).reduce((sum, m) => sum + m.expenses, 0) / 3;
    
    const expenseChange = lastMonth.expenses > 0 
      ? ((currentMonth.expenses - lastMonth.expenses) / lastMonth.expenses) * 100 
      : 0;
    
    const incomeChange = lastMonth.income > 0
      ? ((currentMonth.income - lastMonth.income) / lastMonth.income) * 100
      : 0;
    
    // Calculate savings rate
    const savingsRate = currentMonth.income > 0 
      ? ((currentMonth.income - currentMonth.expenses) / currentMonth.income) * 100
      : 0;
    
    // Find biggest spending category across all months
    const allCategoryTotals: { [key: string]: number } = {};
    monthlyData.forEach(m => {
      m.topCategories.forEach(c => {
        allCategoryTotals[c.category] = (allCategoryTotals[c.category] || 0) + c.amount;
      });
    });
    const biggestCategory = Object.entries(allCategoryTotals)
      .sort((a, b) => b[1] - a[1])[0];
    
    return {
      expenseChange,
      incomeChange,
      savingsRate,
      threeMonthAvgExpenses: threeMonthAvg,
      isOverspending: currentMonth.expenses > threeMonthAvg * 1.1,
      biggestCategory: biggestCategory ? biggestCategory[0] : null,
      biggestCategoryAmount: biggestCategory ? biggestCategory[1] : 0,
    };
  }, [monthlyData]);

  // Generate AI insight
  const generateAIInsight = async () => {
    setIsLoading(true);
    
    try {
      const summaryData = {
        currentCash,
        safetyThreshold,
        monthlyData: monthlyData.slice(0, 3),
        trends,
        totalAccounts: accounts.length,
        totalIncomeSources: incomeSources.length,
        monthlyIncomeProjection: incomeSources
          .filter(i => i.isActive)
          .reduce((sum, i) => {
            switch (i.frequency) {
              case 'weekly': return sum + i.amount * 4.33;
              case 'biweekly': return sum + i.amount * 2.17;
              case 'monthly': return sum + i.amount;
              case 'yearly': return sum + i.amount / 12;
              default: return sum;
            }
          }, 0),
      };

      const result = await aiDecision({
        type: 'insights',
        data: summaryData,
      });

      setAiInsight(result.explanation || result.insight || generateFallbackInsight());
    } catch (error) {
      setAiInsight(generateFallbackInsight());
    } finally {
      setIsLoading(false);
    }
  };

  const generateFallbackInsight = (): string => {
    if (!trends || monthlyData.length === 0) {
      return "Add more transactions to see personalized insights about your spending patterns.";
    }

    const parts: string[] = [];
    const currentMonth = monthlyData[0];

    // Spending trend
    if (trends.expenseChange > 10) {
      parts.push(`Your spending increased ${Math.abs(trends.expenseChange).toFixed(0)}% compared to last month.`);
    } else if (trends.expenseChange < -10) {
      parts.push(`Great job! Your spending decreased ${Math.abs(trends.expenseChange).toFixed(0)}% compared to last month.`);
    } else {
      parts.push(`Your spending is relatively stable compared to last month.`);
    }

    // Savings rate
    if (trends.savingsRate > 20) {
      parts.push(`You're saving ${trends.savingsRate.toFixed(0)}% of your income - excellent!`);
    } else if (trends.savingsRate > 0) {
      parts.push(`You're saving ${trends.savingsRate.toFixed(0)}% of your income.`);
    } else if (trends.savingsRate < 0) {
      parts.push(`You're spending more than you're earning this month.`);
    }

    // Top spending category
    if (trends.biggestCategory) {
      parts.push(`Your biggest spending category is ${trends.biggestCategory}.`);
    }

    // Safety threshold
    if (currentCash < safetyThreshold) {
      parts.push(`Your current balance is below your safety threshold of $${safetyThreshold.toLocaleString()}.`);
    }

    return parts.join(' ');
  };

  const displayMonths = showAllMonths ? monthlyData : monthlyData.slice(0, 3);

  return (
    <div className="bg-[var(--background-secondary)] rounded-xl border border-[var(--border-color)] overflow-hidden">
      {/* Header */}
      <div className="p-4 border-b border-[var(--border-color)]">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-[var(--accent-primary)]" />
            <h3 className="font-semibold text-[var(--foreground)]">AI Insights & Trends</h3>
          </div>
          <button
            onClick={generateAIInsight}
            disabled={isLoading}
            className="text-xs px-3 py-1.5 rounded-lg bg-[var(--accent-primary)] text-[#16181c] hover:opacity-90 disabled:opacity-50 flex items-center gap-1"
          >
            {isLoading ? (
              <span className="animate-pulse">Analyzing...</span>
            ) : (
              <>
                <Lightbulb className="w-3 h-3" />
                Get Insights
              </>
            )}
          </button>
        </div>
      </div>

      {/* AI Insight */}
      {aiInsight && (
        <div className="p-4 bg-[var(--accent-primary)]/5 border-b border-[var(--border-color)]">
          <div className="flex gap-3">
            <Lightbulb className="w-5 h-5 text-[var(--accent-primary)] flex-shrink-0 mt-0.5" />
            <p className="text-sm text-[var(--foreground-secondary)] leading-relaxed">{aiInsight}</p>
          </div>
        </div>
      )}

      {/* Trend Summary */}
      {trends && (
        <div className="p-4 border-b border-[var(--border-color)]">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {/* Expense Trend */}
            <div className="text-center">
              <div className={`flex items-center justify-center gap-1 ${
                trends.expenseChange > 0 ? 'text-red-400' : 'text-emerald-500'
              }`}>
                {trends.expenseChange > 0 ? (
                  <TrendingUp className="w-4 h-4" />
                ) : (
                  <TrendingDown className="w-4 h-4" />
                )}
                <span className="font-semibold">{Math.abs(trends.expenseChange).toFixed(0)}%</span>
              </div>
              <p className="text-xs text-[var(--foreground-muted)] mt-1">Spending</p>
            </div>

            {/* Income Trend */}
            <div className="text-center">
              <div className={`flex items-center justify-center gap-1 ${
                trends.incomeChange >= 0 ? 'text-emerald-500' : 'text-red-400'
              }`}>
                {trends.incomeChange >= 0 ? (
                  <TrendingUp className="w-4 h-4" />
                ) : (
                  <TrendingDown className="w-4 h-4" />
                )}
                <span className="font-semibold">{Math.abs(trends.incomeChange).toFixed(0)}%</span>
              </div>
              <p className="text-xs text-[var(--foreground-muted)] mt-1">Income</p>
            </div>

            {/* Savings Rate */}
            <div className="text-center">
              <div className={`flex items-center justify-center gap-1 ${
                trends.savingsRate >= 0 ? 'text-emerald-500' : 'text-red-400'
              }`}>
                <DollarSign className="w-4 h-4" />
                <span className="font-semibold">{trends.savingsRate.toFixed(0)}%</span>
              </div>
              <p className="text-xs text-[var(--foreground-muted)] mt-1">Savings Rate</p>
            </div>

            {/* Health Indicator */}
            <div className="text-center">
              <div className={`flex items-center justify-center gap-1 ${
                trends.isOverspending ? 'text-amber-500' : 'text-emerald-500'
              }`}>
                {trends.isOverspending ? (
                  <AlertTriangle className="w-4 h-4" />
                ) : (
                  <CheckCircle className="w-4 h-4" />
                )}
                <span className="font-semibold text-xs">
                  {trends.isOverspending ? 'Above Avg' : 'On Track'}
                </span>
              </div>
              <p className="text-xs text-[var(--foreground-muted)] mt-1">Health</p>
            </div>
          </div>
        </div>
      )}

      {/* Monthly Breakdown */}
      <div className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-sm font-medium text-[var(--foreground-muted)] flex items-center gap-2">
            <BarChart3 className="w-4 h-4" />
            Monthly Summary
          </h4>
        </div>

        <div className="space-y-2">
          {displayMonths.map((month) => (
            <div key={month.month} className="rounded-lg border border-[var(--border-color)] overflow-hidden">
              <button
                onClick={() => setExpandedMonth(expandedMonth === month.month ? null : month.month)}
                className="w-full p-3 flex items-center justify-between hover:bg-[var(--background-tertiary)] transition-colors"
              >
                <div className="flex items-center gap-3">
                  <Calendar className="w-4 h-4 text-[var(--foreground-muted)]" />
                  <span className="font-medium text-sm text-[var(--foreground)]">{month.monthLabel}</span>
                  <span className="text-xs text-[var(--foreground-muted)]">
                    {month.transactionCount} txns
                  </span>
                </div>
                <div className="flex items-center gap-4">
                  <span className="text-xs text-emerald-500">+${month.income.toLocaleString()}</span>
                  <span className="text-xs text-red-400">-${month.expenses.toLocaleString()}</span>
                  <span className={`text-xs font-medium ${month.net >= 0 ? 'text-emerald-500' : 'text-red-400'}`}>
                    {month.net >= 0 ? '+' : ''}${month.net.toLocaleString()}
                  </span>
                  {expandedMonth === month.month ? (
                    <ChevronUp className="w-4 h-4 text-[var(--foreground-muted)]" />
                  ) : (
                    <ChevronDown className="w-4 h-4 text-[var(--foreground-muted)]" />
                  )}
                </div>
              </button>

              {expandedMonth === month.month && (
                <div className="p-3 pt-0 border-t border-[var(--border-color)] bg-[var(--background)]">
                  <div className="grid grid-cols-2 gap-4 mt-3">
                    {/* Top Categories */}
                    <div>
                      <p className="text-xs text-[var(--foreground-muted)] mb-2">Top Categories</p>
                      <div className="space-y-1">
                        {month.topCategories.length > 0 ? (
                          month.topCategories.map((cat, idx) => (
                            <div key={idx} className="flex items-center justify-between text-xs">
                              <span className="text-[var(--foreground-secondary)] capitalize">{cat.category}</span>
                              <span className="text-[var(--foreground)]">${cat.amount.toLocaleString()}</span>
                            </div>
                          ))
                        ) : (
                          <span className="text-xs text-[var(--foreground-muted)]">No data</span>
                        )}
                      </div>
                    </div>

                    {/* Top Merchants */}
                    <div>
                      <p className="text-xs text-[var(--foreground-muted)] mb-2">Top Merchants</p>
                      <div className="space-y-1">
                        {month.topMerchants.length > 0 ? (
                          month.topMerchants.map((m, idx) => (
                            <div key={idx} className="flex items-center justify-between text-xs">
                              <span className="text-[var(--foreground-secondary)]">{m.merchant}</span>
                              <span className="text-[var(--foreground)]">${m.amount.toLocaleString()}</span>
                            </div>
                          ))
                        ) : (
                          <span className="text-xs text-[var(--foreground-muted)]">No data</span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>

        {monthlyData.length > 3 && (
          <button
            onClick={() => setShowAllMonths(!showAllMonths)}
            className="mt-3 w-full text-center text-xs text-[var(--accent-primary)] hover:underline flex items-center justify-center gap-1"
          >
            {showAllMonths ? 'Show Less' : `Show ${monthlyData.length - 3} More Months`}
            <ArrowRight className={`w-3 h-3 transition-transform ${showAllMonths ? 'rotate-90' : ''}`} />
          </button>
        )}
      </div>
    </div>
  );
}

