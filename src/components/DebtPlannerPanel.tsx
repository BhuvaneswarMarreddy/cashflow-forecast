'use client';

import React, { useState, useMemo } from 'react';
import { PaymentAccount, DebtPayoffStrategy, DebtPayoffPlan } from '@/types';
import { 
  accountsToDebts, 
  generateDebtPayoffPlan, 
  compareStrategies,
  getDebtFreeDate,
} from '@/lib/debt-planner';
import { format, parseISO } from 'date-fns';
import { 
  TrendingDown, 
  DollarSign, 
  Calendar, 
  Zap, 
  Target,
  CheckCircle2,
  Info,
  ArrowRight,
} from 'lucide-react';

interface DebtPlannerPanelProps {
  accounts: PaymentAccount[];
  currentCash?: number;
}

export default function DebtPlannerPanel({
  accounts,
  currentCash = 0,
}: DebtPlannerPanelProps) {
  const [extraPayment, setExtraPayment] = useState<string>('100');
  const [selectedStrategy, setSelectedStrategy] = useState<DebtPayoffStrategy>('avalanche');
  const [showComparison, setShowComparison] = useState(false);
  
  const debts = useMemo(() => accountsToDebts(accounts), [accounts]);
  
  const plan = useMemo(() => 
    generateDebtPayoffPlan(debts, selectedStrategy, parseFloat(extraPayment) || 0),
    [debts, selectedStrategy, extraPayment]
  );
  
  const comparison = useMemo(() => 
    compareStrategies(debts, parseFloat(extraPayment) || 0),
    [debts, extraPayment]
  );
  
  const totalDebt = debts.reduce((sum, d) => sum + d.balance, 0);
  const totalMinPayment = debts.reduce((sum, d) => sum + d.minimumPayment, 0);
  
  if (debts.length === 0) {
    return (
      <div className="text-center py-12">
        <CheckCircle2 className="w-16 h-16 text-emerald-500 mx-auto mb-4" />
        <h3 className="text-xl font-semibold text-[var(--foreground)] mb-2">
          No Debts to Pay Off
        </h3>
        <p className="text-[var(--foreground-muted)]">
          You have no credit card balances or loans. Keep it up!
        </p>
      </div>
    );
  }
  
  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="p-4 rounded-xl bg-[var(--background-tertiary)]">
          <p className="text-sm text-[var(--foreground-muted)]">Total Debt</p>
          <p className="text-xl font-bold text-[var(--accent-danger)]">
            ${totalDebt.toLocaleString()}
          </p>
        </div>
        <div className="p-4 rounded-xl bg-[var(--background-tertiary)]">
          <p className="text-sm text-[var(--foreground-muted)]">Min. Payments</p>
          <p className="text-xl font-bold text-[var(--foreground)]">
            ${Math.round(totalMinPayment).toLocaleString()}/mo
          </p>
        </div>
        <div className="p-4 rounded-xl bg-[var(--background-tertiary)]">
          <p className="text-sm text-[var(--foreground-muted)]">Debt-Free Date</p>
          <p className="text-xl font-bold text-[var(--accent-success)]">
            {getDebtFreeDate(plan)}
          </p>
        </div>
        <div className="p-4 rounded-xl bg-[var(--background-tertiary)]">
          <p className="text-sm text-[var(--foreground-muted)]">Interest Saved</p>
          <p className="text-xl font-bold text-emerald-500">
            ${plan.interestSaved.toLocaleString()}
          </p>
        </div>
      </div>
      
      {/* Strategy Selection */}
      <div className="p-6 rounded-xl bg-[var(--background-secondary)] border border-[var(--border-color)]">
        <h3 className="text-lg font-semibold text-[var(--foreground)] mb-4">
          Choose Your Strategy
        </h3>
        
        <div className="grid md:grid-cols-2 gap-4 mb-6">
          {/* Snowball */}
          <button
            onClick={() => setSelectedStrategy('snowball')}
            className={`p-4 rounded-xl text-left transition-all ${
              selectedStrategy === 'snowball'
                ? 'bg-[var(--accent-primary)]/10 border-2 border-[var(--accent-primary)]'
                : 'bg-[var(--background-tertiary)] border-2 border-transparent hover:border-[var(--border-color)]'
            }`}
          >
            <div className="flex items-center gap-3 mb-2">
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${
                selectedStrategy === 'snowball' ? 'bg-[var(--accent-primary)] text-[#16181c]' : 'bg-[var(--background-secondary)]'
              }`}>
                <Zap className="w-5 h-5" />
              </div>
              <div>
                <p className="font-medium text-[var(--foreground)]">Snowball</p>
                <p className="text-xs text-[var(--foreground-muted)]">Smallest balance first</p>
              </div>
            </div>
            <p className="text-sm text-[var(--foreground-secondary)]">
              Pay off small debts first for quick wins and motivation.
              Best for building momentum.
            </p>
            {comparison.snowball.debts.length > 0 && (
              <div className="mt-3 pt-3 border-t border-[var(--border-color)]">
                <p className="text-sm">
                  <span className="text-[var(--foreground-muted)]">Debt-free in: </span>
                  <span className="font-medium text-[var(--foreground)]">{comparison.snowball.totalMonths} months</span>
                </p>
                <p className="text-sm">
                  <span className="text-[var(--foreground-muted)]">Interest to pay: </span>
                  <span className="font-medium text-[var(--foreground)]">${comparison.snowball.totalInterestPaid.toLocaleString()}</span>
                </p>
              </div>
            )}
          </button>
          
          {/* Avalanche */}
          <button
            onClick={() => setSelectedStrategy('avalanche')}
            className={`p-4 rounded-xl text-left transition-all ${
              selectedStrategy === 'avalanche'
                ? 'bg-[var(--accent-primary)]/10 border-2 border-[var(--accent-primary)]'
                : 'bg-[var(--background-tertiary)] border-2 border-transparent hover:border-[var(--border-color)]'
            }`}
          >
            <div className="flex items-center gap-3 mb-2">
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${
                selectedStrategy === 'avalanche' ? 'bg-[var(--accent-primary)] text-[#16181c]' : 'bg-[var(--background-secondary)]'
              }`}>
                <TrendingDown className="w-5 h-5" />
              </div>
              <div>
                <p className="font-medium text-[var(--foreground)]">Avalanche</p>
                <p className="text-xs text-[var(--foreground-muted)]">Highest interest first</p>
              </div>
            </div>
            <p className="text-sm text-[var(--foreground-secondary)]">
              Pay off high-interest debts first to minimize total interest paid.
              Best for saving money.
            </p>
            {comparison.avalanche.debts.length > 0 && (
              <div className="mt-3 pt-3 border-t border-[var(--border-color)]">
                <p className="text-sm">
                  <span className="text-[var(--foreground-muted)]">Debt-free in: </span>
                  <span className="font-medium text-[var(--foreground)]">{comparison.avalanche.totalMonths} months</span>
                </p>
                <p className="text-sm">
                  <span className="text-[var(--foreground-muted)]">Interest to pay: </span>
                  <span className="font-medium text-[var(--foreground)]">${comparison.avalanche.totalInterestPaid.toLocaleString()}</span>
                </p>
              </div>
            )}
          </button>
        </div>
        
        {/* Recommendation */}
        {comparison.savingsDifference > 50 && (
          <div className="p-3 rounded-lg bg-[var(--accent-primary)]/10 border border-[var(--accent-primary)]/20">
            <div className="flex items-start gap-2">
              <Info className="w-4 h-4 text-[var(--accent-primary)] mt-0.5" />
              <div className="text-sm">
                <span className="text-[var(--foreground)]">
                  <strong>Avalanche</strong> saves you <strong>${comparison.savingsDifference.toLocaleString()}</strong> more in interest.
                </span>
                {comparison.monthsDifference !== 0 && (
                  <span className="text-[var(--foreground-muted)]">
                    {' '}Snowball gets you debt-free {Math.abs(comparison.monthsDifference)} month{Math.abs(comparison.monthsDifference) !== 1 ? 's' : ''} {comparison.monthsDifference > 0 ? 'sooner' : 'later'}.
                  </span>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
      
      {/* Extra Payment Input */}
      <div className="p-6 rounded-xl bg-[var(--background-secondary)] border border-[var(--border-color)]">
        <h3 className="text-lg font-semibold text-[var(--foreground)] mb-4">
          Extra Monthly Payment
        </h3>
        
        <div className="flex flex-wrap gap-4 items-end">
          <div className="flex-1 min-w-[200px]">
            <label className="block text-sm text-[var(--foreground-muted)] mb-2">
              Amount above minimums
            </label>
            <div className="relative">
              <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-[var(--foreground-muted)]" />
              <input
                type="number"
                value={extraPayment}
                onChange={(e) => setExtraPayment(e.target.value)}
                placeholder="100"
                className="input-field pl-10 text-lg font-semibold"
              />
            </div>
          </div>
          
          <div className="flex gap-2">
            {[50, 100, 200, 500].map(amount => (
              <button
                key={amount}
                onClick={() => setExtraPayment(amount.toString())}
                className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                  parseFloat(extraPayment) === amount
                    ? 'bg-[var(--accent-primary)] text-[#16181c]'
                    : 'bg-[var(--background-tertiary)] text-[var(--foreground)] hover:bg-[var(--background-primary)]'
                }`}
              >
                ${amount}
              </button>
            ))}
          </div>
        </div>
        
        <p className="text-sm text-[var(--foreground-muted)] mt-3">
          Total monthly payment: ${(totalMinPayment + (parseFloat(extraPayment) || 0)).toLocaleString()}
          {currentCash > 0 && (
            <span className="ml-2">
              ({Math.round(((totalMinPayment + (parseFloat(extraPayment) || 0)) / currentCash) * 100)}% of current cash)
            </span>
          )}
        </p>
      </div>
      
      {/* Payoff Timeline */}
      <div className="p-6 rounded-xl bg-[var(--background-secondary)] border border-[var(--border-color)]">
        <h3 className="text-lg font-semibold text-[var(--foreground)] mb-4">
          Payoff Order ({selectedStrategy === 'snowball' ? 'Smallest First' : 'Highest APR First'})
        </h3>
        
        <div className="space-y-3">
          {plan.debts.map((debt, index) => (
            <div
              key={debt.accountId}
              className="flex items-center gap-4 p-4 rounded-xl bg-[var(--background-tertiary)]"
            >
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${
                index === 0 
                  ? 'bg-[var(--accent-primary)] text-[#16181c]' 
                  : 'bg-[var(--background-secondary)] text-[var(--foreground-muted)]'
              }`}>
                {index + 1}
              </div>
              
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <p className="font-medium text-[var(--foreground)]">{debt.accountName}</p>
                  {index === 0 && (
                    <span className="px-2 py-0.5 text-xs rounded-full bg-[var(--accent-primary)]/10 text-[var(--accent-primary)]">
                      Focus
                    </span>
                  )}
                </div>
                <div className="flex gap-4 text-sm text-[var(--foreground-muted)]">
                  <span>${debt.originalBalance.toLocaleString()}</span>
                  <span>{debt.apr}% APR</span>
                </div>
              </div>
              
              <div className="text-right">
                <p className="font-medium text-[var(--foreground)]">
                  {format(parseISO(debt.payoffDate), 'MMM yyyy')}
                </p>
                <p className="text-sm text-[var(--foreground-muted)]">
                  {debt.monthsToPayoff} months
                </p>
              </div>
              
              {index < plan.debts.length - 1 && (
                <ArrowRight className="w-5 h-5 text-[var(--foreground-muted)] hidden md:block" />
              )}
            </div>
          ))}
        </div>
        
        {/* Summary */}
        <div className="mt-6 p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30">
          <div className="flex items-center gap-3">
            <Target className="w-6 h-6 text-emerald-500" />
            <div>
              <p className="font-medium text-emerald-600">
                Debt-free by {getDebtFreeDate(plan)}!
              </p>
              <p className="text-sm text-[var(--foreground-muted)]">
                Total interest: ${plan.totalInterestPaid.toLocaleString()} • 
                You'll save ${plan.interestSaved.toLocaleString()} vs minimum payments
              </p>
            </div>
          </div>
        </div>
      </div>
      
      {/* Strategy Explanation */}
      <div className="p-4 rounded-xl bg-[var(--background-tertiary)]">
        <h4 className="font-medium text-[var(--foreground)] mb-2">How This Works</h4>
        <ul className="space-y-1 text-sm text-[var(--foreground-muted)]">
          <li>• Pay minimum on all debts each month</li>
          <li>• Put extra ${parseFloat(extraPayment) || 0} toward #{1} ({plan.debts[0]?.accountName})</li>
          <li>• When #{1} is paid, roll its payment into #{2}</li>
          <li>• Continue until all debts are paid off</li>
        </ul>
      </div>
    </div>
  );
}


