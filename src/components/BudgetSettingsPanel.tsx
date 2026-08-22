'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { CategoryBudget, ExpenseCategory, resolveCategories, selectableCategories } from '@/types';
import { getSuggestedBudgets } from '@/lib/budgets';
import { useUserProfile } from '@/context/UserProfileContext';
import { DollarSign, Check, Lightbulb, ToggleLeft, ToggleRight } from 'lucide-react';

interface BudgetSettingsPanelProps {
  budgets: CategoryBudget[];
  monthlyIncome: number;
  onSave: (budgets: CategoryBudget[]) => void;
}

export default function BudgetSettingsPanel({
  budgets,
  monthlyIncome,
  onSave,
}: BudgetSettingsPanelProps) {
  const { profile } = useUserProfile();
  const [localBudgets, setLocalBudgets] = useState<CategoryBudget[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [showSuggested, setShowSuggested] = useState(false);

  // cashflow-mobile#24. Setting a budget on a category is a NEW selection (the
  // toggle creates a CategoryBudget row), so archived categories are excluded
  // outright — no currentValue to preserve the way a single-row `<select>` needs.
  const categoryOptions = useMemo(
    () => selectableCategories(resolveCategories(profile?.settings)),
    [profile?.settings]
  );

  useEffect(() => {
    // Initialize with existing budgets or defaults
    if (budgets.length > 0) {
      setLocalBudgets(budgets);
    } else {
      // Create default budgets for all categories
      const defaults = categoryOptions.map(cat => ({
        categoryId: cat.value as ExpenseCategory,
        monthlyLimit: 0,
        isEnabled: false,
      }));
      setLocalBudgets(defaults);
    }
  }, [budgets, categoryOptions]);
  
  const handleToggle = (categoryId: ExpenseCategory) => {
    setLocalBudgets(prev => 
      prev.map(b => 
        b.categoryId === categoryId 
          ? { ...b, isEnabled: !b.isEnabled }
          : b
      )
    );
  };
  
  const handleAmountChange = (categoryId: ExpenseCategory, amount: string) => {
    const value = parseFloat(amount) || 0;
    setLocalBudgets(prev =>
      prev.map(b =>
        b.categoryId === categoryId
          ? { ...b, monthlyLimit: value }
          : b
      )
    );
  };
  
  const applySuggested = () => {
    const suggested = getSuggestedBudgets(monthlyIncome);
    setLocalBudgets(prev =>
      prev.map(b => ({
        ...b,
        monthlyLimit: suggested[b.categoryId] || 0,
        isEnabled: suggested[b.categoryId] > 0,
      }))
    );
    setShowSuggested(false);
  };
  
  const handleSave = async () => {
    setIsSaving(true);
    try {
      // Only save enabled budgets with amounts
      const toSave = localBudgets.filter(b => b.isEnabled && b.monthlyLimit > 0);
      await onSave(toSave);
    } finally {
      setIsSaving(false);
    }
  };
  
  const totalBudgeted = localBudgets
    .filter(b => b.isEnabled)
    .reduce((sum, b) => sum + b.monthlyLimit, 0);
  
  const enabledCount = localBudgets.filter(b => b.isEnabled).length;
  
  return (
    <div>
      {/* Summary */}
      <div className="flex flex-wrap gap-4 mb-6">
        <div className="flex-1 min-w-[150px] p-4 rounded-card bg-[var(--background-tertiary)]">
          <p className="text-sm text-[var(--foreground-muted)]">Monthly Income</p>
          <p className="text-xl font-bold text-[var(--accent-success)]">
            ${monthlyIncome.toLocaleString()}
          </p>
        </div>
        <div className="flex-1 min-w-[150px] p-4 rounded-card bg-[var(--background-tertiary)]">
          <p className="text-sm text-[var(--foreground-muted)]">Total Budgeted</p>
          <p className="text-xl font-bold text-[var(--foreground)]">
            ${totalBudgeted.toLocaleString()}
          </p>
        </div>
        <div className="flex-1 min-w-[150px] p-4 rounded-card bg-[var(--background-tertiary)]">
          <p className="text-sm text-[var(--foreground-muted)]">Remaining</p>
          <p className={`text-xl font-bold ${monthlyIncome - totalBudgeted >= 0 ? 'text-[var(--accent-success)]' : 'text-amber-500'}`}>
            ${(monthlyIncome - totalBudgeted).toLocaleString()}
          </p>
        </div>
      </div>
      
      {/* Suggested Budgets */}
      {monthlyIncome > 0 && (
        <div className="mb-6 p-4 rounded-card bg-[var(--accent-primary)]/5 border border-[var(--accent-primary)]/20">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Lightbulb className="w-5 h-5 text-[var(--accent-primary)]" />
              <span className="text-sm text-[var(--foreground)]">
                Apply suggested budgets based on your income?
              </span>
            </div>
            <button
              onClick={applySuggested}
              className="text-sm px-3 py-2 rounded-control bg-[var(--accent-primary)] text-[#16181c] hover:opacity-90 transition-opacity"
            >
              Apply Suggestions
            </button>
          </div>
        </div>
      )}
      
      {/* Category List */}
      <div className="space-y-3 mb-6">
        {categoryOptions.map(category => {
          const budget = localBudgets.find(b => b.categoryId === category.value);
          const isEnabled = budget?.isEnabled || false;
          const amount = budget?.monthlyLimit || 0;
          
          return (
            <div
              key={category.value}
              className={`p-4 rounded-card border transition-all ${
                isEnabled 
                  ? 'bg-[var(--background-secondary)] border-[var(--accent-primary)]/30' 
                  : 'bg-[var(--background-tertiary)] border-transparent opacity-60'
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => handleToggle(category.value as ExpenseCategory)}
                    className="text-[var(--accent-primary)] transition-transform hover:scale-110"
                  >
                    {isEnabled ? (
                      <ToggleRight className="w-8 h-8" />
                    ) : (
                      <ToggleLeft className="w-8 h-8 opacity-50" />
                    )}
                  </button>
                  <div className="flex items-center gap-2">
                    <span className="text-xl">{category.icon}</span>
                    <span className={`font-medium ${isEnabled ? 'text-[var(--foreground)]' : 'text-[var(--foreground-muted)]'}`}>
                      {category.label}
                    </span>
                  </div>
                </div>
                
                <div className="relative">
                  <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--foreground-muted)]" />
                  <input
                    type="number"
                    value={amount || ''}
                    onChange={(e) => handleAmountChange(category.value as ExpenseCategory, e.target.value)}
                    placeholder="0"
                    disabled={!isEnabled}
                    className={`w-32 pl-8 pr-3 py-2 rounded-control border text-right font-medium ${
                      isEnabled
                        ? 'bg-[var(--background-primary)] border-[var(--border-color)] text-[var(--foreground)]'
                        : 'bg-transparent border-transparent text-[var(--foreground-muted)] cursor-not-allowed'
                    }`}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
      
      {/* Save Button */}
      <button
        onClick={handleSave}
        disabled={isSaving || enabledCount === 0}
        className="btn-primary w-full flex items-center justify-center gap-2 disabled:opacity-50"
      >
        {isSaving ? (
          <>
            <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-pill animate-spin" />
            Saving...
          </>
        ) : (
          <>
            <Check className="w-4 h-4" />
            Save Budgets ({enabledCount} categories)
          </>
        )}
      </button>
      
      {enabledCount === 0 && (
        <p className="text-center text-sm text-[var(--foreground-muted)] mt-3">
          Enable at least one category to set budgets
        </p>
      )}
    </div>
  );
}


