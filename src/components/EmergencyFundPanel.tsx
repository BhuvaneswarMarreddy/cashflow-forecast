'use client';

import React, { useState, useMemo } from 'react';
import { Shield, TrendingDown, Calendar, Loader2, Sparkles, AlertTriangle, CheckCircle, Settings, Target, DollarSign, Percent } from 'lucide-react';
import { ForecastSummary } from '@/types';
import { useUserProfile } from '@/context/UserProfileContext';
import { aiDecision } from '@/lib/callables';

interface EmergencyFundPanelProps {
  forecast: ForecastSummary;
  monthlyExpenses: number;
  currentCash: number;
}

export default function EmergencyFundPanel({ 
  forecast, 
  monthlyExpenses, 
  currentCash 
}: EmergencyFundPanelProps) {
  const { profile, updateProfile } = useUserProfile();
  const [isLoadingAI, setIsLoadingAI] = useState(false);
  const [aiInsight, setAiInsight] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [goalType, setGoalType] = useState<'months' | 'amount'>(
    profile?.settings?.emergencyFundAmount ? 'amount' : 'months'
  );
  const [goalMonths, setGoalMonths] = useState(
    profile?.settings?.emergencyFundGoal || 3
  );
  const [goalAmount, setGoalAmount] = useState(
    profile?.settings?.emergencyFundAmount || monthlyExpenses * 3
  );
  const [isSaving, setIsSaving] = useState(false);

  // Calculate emergency fund metrics
  const metrics = useMemo(() => {
    const dailyExpenses = monthlyExpenses / 30;
    const runwayDays = dailyExpenses > 0 ? Math.floor(currentCash / dailyExpenses) : 999;
    const runwayMonths = dailyExpenses > 0 ? currentCash / monthlyExpenses : 99;
    
    // Use user's goal or default to 3 months
    const userGoalMonths = profile?.settings?.emergencyFundGoal || 3;
    const userGoalAmount = profile?.settings?.emergencyFundAmount;
    
    // Calculate target based on user preference
    const targetAmount = userGoalAmount || (monthlyExpenses * userGoalMonths);
    const fundProgress = targetAmount > 0 ? Math.min((currentCash / targetAmount) * 100, 100) : 100;
    
    // Status determination based on user's goal
    let status: 'critical' | 'warning' | 'good' | 'excellent' = 'excellent';
    let statusColor = 'emerald';
    let statusMessage = '';
    
    const targetMonths = userGoalAmount ? userGoalAmount / monthlyExpenses : userGoalMonths;
    
    if (runwayMonths < 1) {
      status = 'critical';
      statusColor = 'red';
      statusMessage = 'Less than 1 month of expenses covered';
    } else if (runwayMonths < targetMonths * 0.5) {
      status = 'warning';
      statusColor = 'amber';
      statusMessage = `Building towards ${targetMonths}-month goal`;
    } else if (runwayMonths < targetMonths) {
      status = 'good';
      statusColor = 'emerald';
      statusMessage = `${Math.round(fundProgress)}% of goal reached`;
    } else {
      status = 'excellent';
      statusColor = 'emerald';
      statusMessage = `Goal reached! ${runwayMonths.toFixed(1)} months covered`;
    }
    
    return {
      runwayDays,
      runwayMonths,
      dailyExpenses,
      targetAmount,
      targetMonths,
      fundProgress,
      status,
      statusColor,
      statusMessage,
      amountToGoal: Math.max(0, targetAmount - currentCash),
      setAsideAmount: Math.min(currentCash, targetAmount), // Amount "set aside" for emergency
    };
  }, [currentCash, monthlyExpenses, profile?.settings?.emergencyFundGoal, profile?.settings?.emergencyFundAmount]);

  // Save emergency fund settings
  const handleSaveSettings = async () => {
    setIsSaving(true);
    try {
      await updateProfile({
        settings: {
          ...profile?.settings,
          emergencyFundGoal: goalType === 'months' ? goalMonths : undefined,
          emergencyFundAmount: goalType === 'amount' ? goalAmount : undefined,
        }
      });
      setShowSettings(false);
    } catch (err) {
      console.error('Failed to save settings:', err);
    } finally {
      setIsSaving(false);
    }
  };

  // Get AI insight about emergency fund
  const getAIInsight = async () => {
    setIsLoadingAI(true);
    try {
      const data = await aiDecision({
        type: 'emergency_fund',
        question: `Based on my financial situation, give me a brief, encouraging insight about my emergency fund. Current cash: $${currentCash.toLocaleString()}, Monthly expenses: $${monthlyExpenses.toLocaleString()}, Runway: ${metrics.runwayMonths.toFixed(1)} months (${metrics.runwayDays} days), Goal: ${metrics.targetMonths} months ($${metrics.targetAmount.toLocaleString()}). ${metrics.status === 'critical' ? 'I need help building this fund.' : metrics.status === 'warning' ? 'I\'m working on building this.' : 'I\'m doing well but want to improve.'} Keep it short (2-3 sentences), practical, and non-judgmental.`,
        forecast: {
          currentBalance: currentCash,
          lowestBalance: forecast.lowestBalance,
          lowestBalanceDate: forecast.lowestBalanceDate,
          totalIncome: forecast.totalIncome,
          totalExpenses: forecast.totalExpenses,
          daysUntilUnsafe: forecast.daysUntilUnsafe,
          safetyThreshold: forecast.safetyThreshold,
        },
      });

      if (data.explanation) {
        setAiInsight(data.explanation);
      } else {
        setAiInsight(getFallbackInsight());
      }
    } catch (error) {
      console.error('AI insight error:', error);
      setAiInsight(getFallbackInsight());
    } finally {
      setIsLoadingAI(false);
    }
  };

  const getFallbackInsight = () => {
    if (metrics.status === 'critical') {
      return `With ${metrics.runwayDays} days of runway, focusing on building a buffer is important. Even small, consistent savings can make a meaningful difference over time.`;
    } else if (metrics.status === 'warning') {
      return `You have ${metrics.runwayMonths.toFixed(1)} months of expenses covered. You're on the right track. Consider automating a small weekly transfer to continue building your safety net.`;
    } else {
      return `With ${metrics.runwayMonths.toFixed(1)} months covered, you have a solid foundation. This gives you flexibility for unexpected expenses or opportunities.`;
    }
  };

  return (
    <div className="bg-[var(--background-secondary)] border border-[var(--border-color)] rounded-card p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className={`w-10 h-10 rounded-control flex items-center justify-center ${
            metrics.status === 'critical' ? 'bg-red-500/10' :
            metrics.status === 'warning' ? 'bg-amber-500/10' : 'bg-emerald-500/10'
          }`}>
            <Shield className={`w-5 h-5 ${
              metrics.status === 'critical' ? 'text-red-500' :
              metrics.status === 'warning' ? 'text-amber-500' : 'text-emerald-500'
            }`} />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-[var(--foreground)]">Emergency Fund</h3>
            <p className="text-sm text-[var(--foreground-muted)]">Financial safety net</p>
          </div>
        </div>
        
        <button 
          onClick={() => setShowSettings(!showSettings)}
          className="p-2 rounded-control hover:bg-[var(--background-tertiary)] transition-colors"
        >
          <Settings className={`w-5 h-5 ${showSettings ? 'text-[var(--accent-primary)]' : 'text-[var(--foreground-muted)]'}`} />
        </button>
      </div>

      {/* Settings Panel */}
      {showSettings && (
        <div className="mb-6 p-4 rounded-control bg-[var(--background-tertiary)] border border-[var(--border-color)]">
          <div className="flex items-center gap-2 mb-4">
            <Target className="w-4 h-4 text-[var(--accent-primary)]" />
            <span className="font-medium text-[var(--foreground)]">Set Your Emergency Fund Goal</span>
          </div>
          
          {/* Goal Type Toggle */}
          <div className="flex gap-2 mb-4">
            <button
              onClick={() => setGoalType('months')}
              className={`flex-1 py-2 px-3 rounded-control text-sm font-medium transition-all flex items-center justify-center gap-2 ${
                goalType === 'months'
                  ? 'bg-[var(--accent-primary)] text-[#16181c]'
                  : 'bg-[var(--background-secondary)] text-[var(--foreground-secondary)] border border-[var(--border-color)]'
              }`}
            >
              <Calendar className="w-4 h-4" />
              Months of Expenses
            </button>
            <button
              onClick={() => setGoalType('amount')}
              className={`flex-1 py-2 px-3 rounded-control text-sm font-medium transition-all flex items-center justify-center gap-2 ${
                goalType === 'amount'
                  ? 'bg-[var(--accent-primary)] text-[#16181c]'
                  : 'bg-[var(--background-secondary)] text-[var(--foreground-secondary)] border border-[var(--border-color)]'
              }`}
            >
              <DollarSign className="w-4 h-4" />
              Fixed Amount
            </button>
          </div>
          
          {/* Goal Input */}
          {goalType === 'months' ? (
            <div className="mb-4">
              <label className="text-sm text-[var(--foreground-muted)] mb-2 block">
                How many months of expenses?
              </label>
              <div className="flex items-center gap-3">
                {[1, 2, 3, 6, 12].map((months) => (
                  <button
                    key={months}
                    onClick={() => setGoalMonths(months)}
                    className={`px-4 py-2 rounded-control text-sm font-medium transition-all ${
                      goalMonths === months
                        ? 'bg-[var(--accent-primary)] text-[#16181c]'
                        : 'bg-[var(--background-secondary)] text-[var(--foreground-secondary)] hover:bg-[var(--background-tertiary)]'
                    }`}
                  >
                    {months}mo
                  </button>
                ))}
              </div>
              <p className="text-xs text-[var(--foreground-muted)] mt-2">
                = ${(monthlyExpenses * goalMonths).toLocaleString()} based on your expenses
              </p>
            </div>
          ) : (
            <div className="mb-4">
              <label className="text-sm text-[var(--foreground-muted)] mb-2 block">
                Target amount
              </label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--foreground-muted)]">$</span>
                <input
                  type="number"
                  value={goalAmount}
                  onChange={(e) => setGoalAmount(Number(e.target.value))}
                  className="w-full py-2 pl-8 pr-4 rounded-control bg-[var(--background-secondary)] border border-[var(--border-color)] text-[var(--foreground)]"
                  placeholder="10000"
                />
              </div>
              <p className="text-xs text-[var(--foreground-muted)] mt-2">
                = {(goalAmount / monthlyExpenses).toFixed(1)} months of expenses
              </p>
            </div>
          )}
          
          <button
            onClick={handleSaveSettings}
            disabled={isSaving}
            className="w-full py-2 rounded-control bg-[var(--accent-primary)] text-[#16181c] font-medium text-sm hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {isSaving ? 'Saving...' : 'Save Goal'}
          </button>
        </div>
      )}

      {/* Set Aside Display */}
      <div className="p-4 rounded-control bg-gradient-to-r from-[var(--accent-primary)]/10 to-[var(--accent-secondary)]/10 border border-[var(--accent-primary)]/20 mb-6">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm text-[var(--foreground-muted)]">Set Aside for Emergencies</span>
          <span className={`text-xs px-2 py-1 rounded-pill ${
            metrics.fundProgress >= 100 
              ? 'bg-emerald-500/20 text-emerald-500' 
              : 'bg-amber-500/20 text-amber-500'
          }`}>
            {metrics.fundProgress >= 100 ? 'Goal Met!' : `${metrics.fundProgress.toFixed(0)}%`}
          </span>
        </div>
        <p className="text-2xl font-bold text-[var(--foreground)]">
          ${metrics.setAsideAmount.toLocaleString()}
          <span className="text-sm font-normal text-[var(--foreground-muted)] ml-2">
            of ${metrics.targetAmount.toLocaleString()} goal
          </span>
        </p>
      </div>

      {/* Runway Display */}
      <div className="grid grid-cols-2 gap-4 mb-6">
        <div className="p-4 rounded-control bg-[var(--background-tertiary)]">
          <div className="flex items-center gap-2 mb-1">
            <Calendar className="w-4 h-4 text-[var(--foreground-muted)]" />
            <span className="text-xs text-[var(--foreground-muted)]">Runway</span>
          </div>
          <p className={`text-2xl font-bold ${
            metrics.runwayDays < 30 ? 'text-red-500' :
            metrics.runwayDays < 90 ? 'text-amber-500' : 'text-emerald-500'
          }`}>
            {metrics.runwayDays > 365 ? '365+' : metrics.runwayDays} days
          </p>
        </div>
        
        <div className="p-4 rounded-control bg-[var(--background-tertiary)]">
          <div className="flex items-center gap-2 mb-1">
            <TrendingDown className="w-4 h-4 text-[var(--foreground-muted)]" />
            <span className="text-xs text-[var(--foreground-muted)]">Coverage</span>
          </div>
          <p className={`text-2xl font-bold ${
            metrics.runwayMonths < 1 ? 'text-red-500' :
            metrics.runwayMonths < 3 ? 'text-amber-500' : 'text-emerald-500'
          }`}>
            {metrics.runwayMonths > 12 ? '12+' : metrics.runwayMonths.toFixed(1)} mo
          </p>
        </div>
      </div>

      {/* Progress Bar */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm text-[var(--foreground-secondary)]">Progress to goal</span>
          <span className="text-sm font-medium text-[var(--foreground)]">
            {metrics.fundProgress.toFixed(0)}%
          </span>
        </div>
        <div className="h-3 bg-[var(--background-tertiary)] rounded-pill overflow-hidden">
          <div 
            className={`h-full rounded-pill transition-all duration-500 ${
              metrics.fundProgress < 33 ? 'bg-red-500' :
              metrics.fundProgress < 66 ? 'bg-amber-500' : 'bg-emerald-500'
            }`}
            style={{ width: `${Math.min(metrics.fundProgress, 100)}%` }}
          />
        </div>
        {metrics.amountToGoal > 0 && (
          <p className="text-xs text-[var(--foreground-muted)] mt-2 text-right">
            ${metrics.amountToGoal.toLocaleString()} more to reach goal
          </p>
        )}
      </div>

      {/* Status Message */}
      <div className={`p-3 rounded-control mb-4 flex items-start gap-2 ${
        metrics.status === 'critical' ? 'bg-red-500/10' :
        metrics.status === 'warning' ? 'bg-amber-500/10' : 'bg-emerald-500/10'
      }`}>
        {metrics.status === 'critical' || metrics.status === 'warning' ? (
          <AlertTriangle className={`w-4 h-4 mt-1 flex-shrink-0 ${
            metrics.status === 'critical' ? 'text-red-500' : 'text-amber-500'
          }`} />
        ) : (
          <CheckCircle className="w-4 h-4 mt-1 flex-shrink-0 text-emerald-500" />
        )}
        <p className={`text-sm ${
          metrics.status === 'critical' ? 'text-red-400' :
          metrics.status === 'warning' ? 'text-amber-400' : 'text-emerald-400'
        }`}>
          {metrics.statusMessage}
        </p>
      </div>

      {/* AI Insight */}
      {aiInsight ? (
        <div className="p-4 rounded-control bg-[var(--accent-primary)]/5 border border-[var(--accent-primary)]/20">
          <div className="flex items-center gap-2 mb-2">
            <Sparkles className="w-4 h-4 text-[var(--accent-primary)]" />
            <span className="text-xs font-medium text-[var(--accent-primary)]">AI Insight</span>
          </div>
          <p className="text-sm text-[var(--foreground-secondary)]">{aiInsight}</p>
        </div>
      ) : (
        <button
          onClick={getAIInsight}
          disabled={isLoadingAI}
          className="w-full py-2 px-4 rounded-control border border-[var(--border-color)] text-sm text-[var(--foreground-secondary)] hover:bg-[var(--background-tertiary)] transition-colors flex items-center justify-center gap-2"
        >
          {isLoadingAI ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Getting insight...
            </>
          ) : (
            <>
              <Sparkles className="w-4 h-4" />
              Get AI Insight
            </>
          )}
        </button>
      )}
    </div>
  );
}
