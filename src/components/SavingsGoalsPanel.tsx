'use client';

import React, { useState, useMemo } from 'react';
import { SavingsGoal, GoalProgress, PaymentAccount, ForecastSummary } from '@/types';
import { format, parseISO, differenceInDays } from 'date-fns';
import { 
  Target, 
  Plus, 
  Edit3, 
  Trash2, 
  X,
  TrendingUp,
  Calendar,
  Wallet,
  CheckCircle2,
  AlertCircle,
  Sparkles,
} from 'lucide-react';

interface SavingsGoalsPanelProps {
  goals: SavingsGoal[];
  accounts: PaymentAccount[];
  forecast?: ForecastSummary;
  safetyThreshold?: number;
  onAddGoal: (goal: Omit<SavingsGoal, 'id' | 'createdAt' | 'updatedAt'>) => Promise<void>;
  onUpdateGoal: (id: string, updates: Partial<SavingsGoal>) => Promise<void>;
  onDeleteGoal: (id: string) => Promise<void>;
  compact?: boolean;
}

const GOAL_COLORS = [
  '#c9a24e', // gold (brand)
  '#10b981', // emerald
  '#0d9488', // teal
  '#7c3aed', // violet
  '#e11d48', // rose
  '#f59e0b', // amber
  '#06b6d4', // cyan
  '#84cc16', // lime
];

export default function SavingsGoalsPanel({
  goals,
  accounts,
  forecast,
  safetyThreshold = 0,
  onAddGoal,
  onUpdateGoal,
  onDeleteGoal,
  compact = true,
}: SavingsGoalsPanelProps) {
  const [showModal, setShowModal] = useState(false);
  const [editingGoal, setEditingGoal] = useState<SavingsGoal | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  
  const [formData, setFormData] = useState({
    name: '',
    targetAmount: '',
    currentAmount: '',
    targetDate: '',
    linkedAccountId: '',
    priority: 3 as 1 | 2 | 3 | 4 | 5,
    color: GOAL_COLORS[0],
  });
  
  // Calculate progress for each goal
  const goalProgress: GoalProgress[] = useMemo(() => {
    return goals.map(goal => {
      const percentComplete = goal.targetAmount > 0 
        ? Math.min((goal.currentAmount / goal.targetAmount) * 100, 100)
        : 0;
      const amountRemaining = goal.targetAmount - goal.currentAmount;
      
      let daysRemaining: number | undefined;
      let requiredMonthlySavings: number | undefined;
      let isOnTrack: boolean | undefined;
      
      if (goal.targetDate) {
        const targetDate = parseISO(goal.targetDate);
        daysRemaining = Math.max(0, differenceInDays(targetDate, new Date()));
        const monthsRemaining = daysRemaining / 30;
        
        if (monthsRemaining > 0 && amountRemaining > 0) {
          requiredMonthlySavings = amountRemaining / monthsRemaining;
          // Consider on track if we're saving at least the required rate
          // (simplified - in reality would need to check actual savings rate)
          isOnTrack = percentComplete >= ((1 - (daysRemaining / differenceInDays(targetDate, parseISO(goal.createdAt)))) * 100);
        }
      }
      
      return {
        goal,
        percentComplete,
        amountRemaining,
        daysRemaining,
        requiredMonthlySavings,
        isOnTrack,
      };
    }).sort((a, b) => a.goal.priority - b.goal.priority);
  }, [goals]);
  
  // Calculate suggested allocation from surplus
  const suggestedAllocation = useMemo(() => {
    if (!forecast) return 0;
    const surplus = forecast.endingBalance - safetyThreshold;
    return Math.max(0, surplus);
  }, [forecast, safetyThreshold]);
  
  const openEditModal = (goal: SavingsGoal) => {
    setEditingGoal(goal);
    setFormData({
      name: goal.name,
      targetAmount: goal.targetAmount.toString(),
      currentAmount: goal.currentAmount.toString(),
      targetDate: goal.targetDate?.split('T')[0] || '',
      linkedAccountId: goal.linkedAccountId || '',
      priority: goal.priority,
      color: goal.color,
    });
    setShowModal(true);
  };
  
  const resetForm = () => {
    setFormData({
      name: '',
      targetAmount: '',
      currentAmount: '',
      targetDate: '',
      linkedAccountId: '',
      priority: 3,
      color: GOAL_COLORS[Math.floor(Math.random() * GOAL_COLORS.length)],
    });
    setEditingGoal(null);
    setShowModal(false);
  };
  
  const handleSubmit = async () => {
    if (!formData.name || !formData.targetAmount) return;
    
    setIsSubmitting(true);
    try {
      const goalData = {
        name: formData.name,
        targetAmount: parseFloat(formData.targetAmount) || 0,
        currentAmount: parseFloat(formData.currentAmount) || 0,
        targetDate: formData.targetDate || undefined,
        linkedAccountId: formData.linkedAccountId || undefined,
        priority: formData.priority,
        color: formData.color,
        isActive: true,
      };
      
      if (editingGoal) {
        await onUpdateGoal(editingGoal.id, goalData);
      } else {
        await onAddGoal(goalData);
      }
      
      resetForm();
    } finally {
      setIsSubmitting(false);
    }
  };
  
  const handleQuickAdd = async (goalId: string, amount: number) => {
    const goal = goals.find(g => g.id === goalId);
    if (!goal) return;
    
    await onUpdateGoal(goalId, {
      currentAmount: goal.currentAmount + amount,
    });
  };
  
  if (compact) {
    // Compact view for Forecast page - show top 3 goals
    const topGoals = goalProgress.slice(0, 3);
    
    if (topGoals.length === 0) {
      return (
        <div className="p-4 rounded-xl bg-[var(--background-tertiary)] border border-[var(--border-color)]">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Target className="w-4 h-4 text-[var(--foreground-muted)]" />
              <span className="text-sm font-medium text-[var(--foreground)]">Savings Goals</span>
            </div>
            <button
              onClick={() => setShowModal(true)}
              className="text-xs px-2 py-1 rounded-lg bg-[var(--accent-primary)]/10 text-[var(--accent-primary)] hover:bg-[var(--accent-primary)]/20 transition-colors"
            >
              Add Goal
            </button>
          </div>
          <p className="text-sm text-[var(--foreground-muted)]">
            Set savings goals to track progress toward your financial targets
          </p>
        </div>
      );
    }
    
    return (
      <>
        <div className="p-4 rounded-xl bg-[var(--background-tertiary)] border border-[var(--border-color)]">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Target className="w-4 h-4 text-[var(--foreground-muted)]" />
              <span className="text-sm font-medium text-[var(--foreground)]">Savings Goals</span>
            </div>
            <button
              onClick={() => setShowModal(true)}
              className="p-1 rounded-lg hover:bg-[var(--background-secondary)] transition-colors"
            >
              <Plus className="w-4 h-4 text-[var(--foreground-muted)]" />
            </button>
          </div>
          
          <div className="space-y-3">
            {topGoals.map(({ goal, percentComplete, amountRemaining }) => (
              <div key={goal.id}>
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <div 
                      className="w-2 h-2 rounded-full"
                      style={{ backgroundColor: goal.color }}
                    />
                    <span className="text-sm text-[var(--foreground)]">{goal.name}</span>
                  </div>
                  <span className="text-xs text-[var(--foreground-muted)]">
                    ${goal.currentAmount.toLocaleString()} / ${goal.targetAmount.toLocaleString()}
                  </span>
                </div>
                <div className="w-full h-1.5 rounded-full bg-[var(--background-secondary)] overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{ 
                      width: `${percentComplete}%`,
                      backgroundColor: goal.color,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
          
          {suggestedAllocation > 0 && (
            <div className="mt-3 pt-3 border-t border-[var(--border-color)]">
              <div className="flex items-center gap-2 text-xs text-[var(--foreground-muted)]">
                <Sparkles className="w-3 h-3 text-[var(--accent-primary)]" />
                <span>
                  ${suggestedAllocation.toLocaleString()} available to allocate
                </span>
              </div>
            </div>
          )}
        </div>
        
        {/* Modal */}
        {showModal && (
          <GoalModal
            formData={formData}
            setFormData={setFormData}
            accounts={accounts}
            isEditing={!!editingGoal}
            isSubmitting={isSubmitting}
            onSubmit={handleSubmit}
            onClose={resetForm}
          />
        )}
      </>
    );
  }
  
  // Full view
  return (
    <>
      <div className="space-y-4">
        <div className="flex justify-between items-center">
          <h3 className="text-lg font-semibold text-[var(--foreground)]">
            Savings Goals ({goals.length})
          </h3>
          <button
            onClick={() => setShowModal(true)}
            className="btn-primary flex items-center gap-2 text-sm"
          >
            <Plus className="w-4 h-4" />
            Add Goal
          </button>
        </div>
        
        {goalProgress.length === 0 ? (
          <div className="text-center py-8">
            <Target className="w-12 h-12 text-[var(--foreground-muted)] mx-auto mb-3" />
            <p className="text-[var(--foreground)]">No savings goals yet</p>
            <p className="text-sm text-[var(--foreground-muted)]">
              Create goals to track progress toward your financial dreams
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {goalProgress.map(({ goal, percentComplete, amountRemaining, daysRemaining, requiredMonthlySavings, isOnTrack }) => (
              <div
                key={goal.id}
                className="p-4 rounded-xl bg-[var(--background-tertiary)] border-l-4"
                style={{ borderLeftColor: goal.color }}
              >
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <h4 className="font-medium text-[var(--foreground)]">{goal.name}</h4>
                    <p className="text-sm text-[var(--foreground-muted)]">
                      Priority: {goal.priority} of 5
                      {goal.targetDate && ` • Due ${format(parseISO(goal.targetDate), 'MMM d, yyyy')}`}
                    </p>
                  </div>
                  <div className="flex gap-1">
                    <button
                      onClick={() => openEditModal(goal)}
                      className="p-2 rounded-lg text-[var(--foreground-muted)] hover:text-[var(--accent-primary)] hover:bg-[var(--accent-primary)]/10 transition-colors"
                    >
                      <Edit3 className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => onDeleteGoal(goal.id)}
                      className="p-2 rounded-lg text-[var(--foreground-muted)] hover:text-[var(--accent-danger)] hover:bg-[var(--accent-danger)]/10 transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
                
                {/* Progress bar */}
                <div className="mb-3">
                  <div className="flex justify-between text-sm mb-1">
                    <span className="text-[var(--foreground)]">
                      ${goal.currentAmount.toLocaleString()}
                    </span>
                    <span className="text-[var(--foreground-muted)]">
                      ${goal.targetAmount.toLocaleString()}
                    </span>
                  </div>
                  <div className="w-full h-3 rounded-full bg-[var(--background-secondary)] overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all"
                      style={{ 
                        width: `${percentComplete}%`,
                        backgroundColor: goal.color,
                      }}
                    />
                  </div>
                  <div className="flex justify-between items-center mt-1">
                    <span className="text-xs text-[var(--foreground-muted)]">
                      {Math.round(percentComplete)}% complete
                    </span>
                    {amountRemaining > 0 && (
                      <span className="text-xs text-[var(--foreground-muted)]">
                        ${amountRemaining.toLocaleString()} to go
                      </span>
                    )}
                  </div>
                </div>
                
                {/* Status indicators */}
                <div className="flex flex-wrap gap-2">
                  {percentComplete >= 100 && (
                    <span className="flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-emerald-500/10 text-emerald-500">
                      <CheckCircle2 className="w-3 h-3" />
                      Goal reached!
                    </span>
                  )}
                  {daysRemaining !== undefined && daysRemaining <= 30 && percentComplete < 100 && (
                    <span className="flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-amber-500/10 text-amber-500">
                      <Calendar className="w-3 h-3" />
                      {daysRemaining} days left
                    </span>
                  )}
                  {requiredMonthlySavings !== undefined && (
                    <span className="flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-[var(--accent-primary)]/10 text-[var(--accent-primary)]">
                      <TrendingUp className="w-3 h-3" />
                      ${Math.round(requiredMonthlySavings).toLocaleString()}/mo needed
                    </span>
                  )}
                </div>
                
                {/* Quick add */}
                <div className="mt-3 pt-3 border-t border-[var(--border-color)]">
                  <div className="flex gap-2">
                    <span className="text-xs text-[var(--foreground-muted)]">Quick add:</span>
                    {[50, 100, 250, 500].map(amount => (
                      <button
                        key={amount}
                        onClick={() => handleQuickAdd(goal.id, amount)}
                        className="text-xs px-2 py-1 rounded bg-[var(--background-secondary)] text-[var(--foreground)] hover:bg-[var(--accent-primary)]/10 transition-colors"
                      >
                        +${amount}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      
      {/* Modal */}
      {showModal && (
        <GoalModal
          formData={formData}
          setFormData={setFormData}
          accounts={accounts}
          isEditing={!!editingGoal}
          isSubmitting={isSubmitting}
          onSubmit={handleSubmit}
          onClose={resetForm}
        />
      )}
    </>
  );
}

function GoalModal({
  formData,
  setFormData,
  accounts,
  isEditing,
  isSubmitting,
  onSubmit,
  onClose,
}: {
  formData: {
    name: string;
    targetAmount: string;
    currentAmount: string;
    targetDate: string;
    linkedAccountId: string;
    priority: 1 | 2 | 3 | 4 | 5;
    color: string;
  };
  setFormData: React.Dispatch<React.SetStateAction<typeof formData>>;
  accounts: PaymentAccount[];
  isEditing: boolean;
  isSubmitting: boolean;
  onSubmit: () => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-xl font-bold text-[var(--foreground)]">
            {isEditing ? 'Edit Goal' : 'New Savings Goal'}
          </h2>
          <button onClick={onClose} className="p-2 rounded-lg text-[var(--foreground-muted)] hover:bg-[var(--background-tertiary)]">
            <X className="w-5 h-5" />
          </button>
        </div>
        
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
              Goal Name
            </label>
            <input
              type="text"
              value={formData.name}
              onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
              placeholder="e.g., Emergency Fund, Vacation, New Car"
              className="input-field"
            />
          </div>
          
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
                Target Amount
              </label>
              <input
                type="number"
                value={formData.targetAmount}
                onChange={(e) => setFormData(prev => ({ ...prev, targetAmount: e.target.value }))}
                placeholder="10000"
                className="input-field"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
                Current Amount
              </label>
              <input
                type="number"
                value={formData.currentAmount}
                onChange={(e) => setFormData(prev => ({ ...prev, currentAmount: e.target.value }))}
                placeholder="0"
                className="input-field"
              />
            </div>
          </div>
          
          <div>
            <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
              Target Date (optional)
            </label>
            <input
              type="date"
              value={formData.targetDate}
              onChange={(e) => setFormData(prev => ({ ...prev, targetDate: e.target.value }))}
              className="input-field"
            />
          </div>
          
          <div>
            <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
              Priority (1 = highest)
            </label>
            <div className="flex gap-2">
              {[1, 2, 3, 4, 5].map(p => (
                <button
                  key={p}
                  onClick={() => setFormData(prev => ({ ...prev, priority: p as any }))}
                  className={`flex-1 py-2 rounded-lg font-medium transition-colors ${
                    formData.priority === p
                      ? 'bg-[var(--accent-primary)] text-[#16181c]'
                      : 'bg-[var(--background-tertiary)] text-[var(--foreground-secondary)] hover:bg-[var(--background-secondary)]'
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
          
          <div>
            <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
              Color
            </label>
            <div className="flex gap-2">
              {GOAL_COLORS.map(color => (
                <button
                  key={color}
                  onClick={() => setFormData(prev => ({ ...prev, color }))}
                  className={`w-8 h-8 rounded-full transition-transform ${
                    formData.color === color ? 'ring-2 ring-offset-2 ring-[var(--accent-primary)] scale-110' : ''
                  }`}
                  style={{ backgroundColor: color }}
                />
              ))}
            </div>
          </div>
          
          <button
            onClick={onSubmit}
            disabled={isSubmitting || !formData.name || !formData.targetAmount}
            className="btn-primary w-full disabled:opacity-50"
          >
            {isSubmitting ? 'Saving...' : isEditing ? 'Update Goal' : 'Create Goal'}
          </button>
        </div>
      </div>
    </div>
  );
}


