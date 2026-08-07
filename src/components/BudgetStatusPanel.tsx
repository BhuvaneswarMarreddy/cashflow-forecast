'use client';

import React, { useMemo } from 'react';
import { CategoryBudget, CategoryBudgetStatus, PaymentAccount, Transaction, EXPENSE_CATEGORIES } from '@/types';
import { calculateBudgetStatuses, getTopBudgetRisks } from '@/lib/budgets';
import { PieChart, AlertTriangle, CheckCircle2, TrendingUp } from 'lucide-react';

interface BudgetStatusPanelProps {
  budgets: CategoryBudget[];
  transactions: Transaction[];
  // Needed so a credit-card payment leg is recognised as a transfer rather than
  // charged to a category budget — classification needs the account types.
  accounts?: PaymentAccount[];
  compact?: boolean; // For forecast page (show only risks)
}

export default function BudgetStatusPanel({
  budgets,
  transactions,
  accounts,
  compact = true,
}: BudgetStatusPanelProps) {
  const statuses = useMemo(() =>
    calculateBudgetStatuses(budgets, transactions, new Date(), accounts),
    [budgets, transactions, accounts]
  );

  const risks = useMemo(() =>
    getTopBudgetRisks(budgets, transactions, 3, new Date(), accounts),
    [budgets, transactions, accounts]
  );
  
  if (budgets.length === 0 || statuses.length === 0) {
    return null;
  }
  
  // Get overall budget health
  const totalBudgeted = statuses.reduce((sum, s) => sum + s.monthlyLimit, 0);
  const totalSpent = statuses.reduce((sum, s) => sum + s.spent, 0);
  const overallPercent = totalBudgeted > 0 ? (totalSpent / totalBudgeted) * 100 : 0;
  const overBudgetCount = statuses.filter(s => s.isOverBudget).length;
  
  // Status color and message
  const getHealthStatus = () => {
    if (overBudgetCount > 0) {
      return {
        color: 'text-amber-500',
        bgColor: 'bg-amber-500/10',
        borderColor: 'border-amber-500/30',
        icon: AlertTriangle,
        message: `${overBudgetCount} ${overBudgetCount === 1 ? 'category' : 'categories'} over budget`,
      };
    }
    if (overallPercent >= 80) {
      return {
        color: 'text-amber-500',
        bgColor: 'bg-amber-500/10',
        borderColor: 'border-amber-500/30',
        icon: TrendingUp,
        message: 'Approaching budget limits',
      };
    }
    return {
      color: 'text-emerald-500',
      bgColor: 'bg-emerald-500/10',
      borderColor: 'border-emerald-500/30',
      icon: CheckCircle2,
      message: 'On track',
    };
  };
  
  const health = getHealthStatus();
  const HealthIcon = health.icon;
  
  if (compact) {
    // Compact view for Forecast page - only show if there are risks
    if (risks.length === 0) {
      return (
        <div className={`p-4 rounded-card ${health.bgColor} border ${health.borderColor}`}>
          <div className="flex items-center gap-3">
            <HealthIcon className={`w-5 h-5 ${health.color}`} />
            <div>
              <p className={`font-medium ${health.color}`}>Budgets: {health.message}</p>
              <p className="text-sm text-[var(--foreground-muted)]">
                ${totalSpent.toLocaleString()} of ${totalBudgeted.toLocaleString()} used
              </p>
            </div>
          </div>
        </div>
      );
    }
    
    return (
      <div className={`p-4 rounded-card ${health.bgColor} border ${health.borderColor}`}>
        <div className="flex items-center gap-2 mb-3">
          <PieChart className="w-4 h-4 text-[var(--foreground-muted)]" />
          <span className="text-sm font-medium text-[var(--foreground)]">Budget Status</span>
          <span className={`ml-auto text-xs ${health.color}`}>{health.message}</span>
        </div>
        
        <div className="space-y-2">
          {risks.map(status => {
            const categoryInfo = EXPENSE_CATEGORIES.find(c => c.value === status.categoryId);
            
            return (
              <div key={status.categoryId} className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sm">{categoryInfo?.icon}</span>
                  <span className="text-sm text-[var(--foreground)]">{status.categoryLabel}</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-20 h-1.5 rounded-pill bg-[var(--background-tertiary)] overflow-hidden">
                    <div
                      className={`h-full rounded-pill transition-all ${
                        status.isOverBudget ? 'bg-amber-500' : 
                        status.percentUsed >= 80 ? 'bg-amber-400' : 
                        'bg-emerald-500'
                      }`}
                      style={{ width: `${Math.min(status.percentUsed, 100)}%` }}
                    />
                  </div>
                  <span className={`text-xs font-medium min-w-[40px] text-right ${
                    status.isOverBudget ? 'text-amber-500' : 'text-[var(--foreground-muted)]'
                  }`}>
                    {Math.round(status.percentUsed)}%
                  </span>
                </div>
              </div>
            );
          })}
        </div>
        
        {risks.length > 0 && (
          <p className="text-xs text-[var(--foreground-muted)] mt-3">
            ${(totalBudgeted - totalSpent).toLocaleString()} remaining across all budgets
          </p>
        )}
      </div>
    );
  }
  
  // Full view for Settings/Analytics page
  return (
    <div className="space-y-4">
      {/* Overall Summary */}
      <div className={`p-4 rounded-card ${health.bgColor} border ${health.borderColor}`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <HealthIcon className={`w-6 h-6 ${health.color}`} />
            <div>
              <p className={`font-medium ${health.color}`}>{health.message}</p>
              <p className="text-sm text-[var(--foreground-muted)]">
                ${totalSpent.toLocaleString()} of ${totalBudgeted.toLocaleString()} budgeted
              </p>
            </div>
          </div>
          <div className="text-right">
            <p className={`text-2xl font-bold ${health.color}`}>{Math.round(overallPercent)}%</p>
            <p className="text-xs text-[var(--foreground-muted)]">used</p>
          </div>
        </div>
      </div>
      
      {/* Category Breakdown */}
      <div className="space-y-3">
        {statuses.map(status => {
          const categoryInfo = EXPENSE_CATEGORIES.find(c => c.value === status.categoryId);
          const progressColor = status.isOverBudget 
            ? 'bg-amber-500' 
            : status.percentUsed >= 80 
              ? 'bg-amber-400' 
              : 'bg-emerald-500';
          
          return (
            <div
              key={status.categoryId}
              className="p-4 rounded-card bg-[var(--background-tertiary)]"
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-lg">{categoryInfo?.icon}</span>
                  <span className="font-medium text-[var(--foreground)]">{status.categoryLabel}</span>
                </div>
                <div className="text-right">
                  <span className={`font-medium ${status.isOverBudget ? 'text-amber-500' : 'text-[var(--foreground)]'}`}>
                    ${status.spent.toLocaleString()}
                  </span>
                  <span className="text-[var(--foreground-muted)]"> / ${status.monthlyLimit.toLocaleString()}</span>
                </div>
              </div>
              
              {/* Progress bar */}
              <div className="w-full h-2 rounded-pill bg-[var(--background-primary)] overflow-hidden">
                <div
                  className={`h-full rounded-pill transition-all ${progressColor}`}
                  style={{ width: `${Math.min(status.percentUsed, 100)}%` }}
                />
              </div>
              
              <div className="flex justify-between mt-2 text-xs text-[var(--foreground-muted)]">
                <span>
                  {status.isOverBudget ? (
                    <span className="text-amber-500">
                      ${Math.abs(status.remaining).toLocaleString()} over
                    </span>
                  ) : (
                    `$${status.remaining.toLocaleString()} remaining`
                  )}
                </span>
                <span>Projected: ${status.projectedMonthEnd.toLocaleString()}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}


