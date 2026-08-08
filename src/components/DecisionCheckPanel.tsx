'use client';

import React, { useState } from 'react';
import { DollarSign, AlertTriangle, CheckCircle, XCircle, Loader2, HelpCircle } from 'lucide-react';
import { ForecastSummary, SpendingSimulation } from '@/types';
import { simulateSpending, prepareForecastForAI } from '@/lib/forecast';
import { aiDecision } from '@/lib/callables';
import { financialContext } from '@/lib/ai-context';
import { useUserProfile } from '@/context/UserProfileContext';
import { useTransactions } from '@/context/TransactionContext';
import { format } from 'date-fns';

interface DecisionCheckPanelProps {
  forecast: ForecastSummary;
}

export default function DecisionCheckPanel({ forecast }: DecisionCheckPanelProps) {
  const { profile, incomeContext } = useUserProfile();
  const { transactions } = useTransactions();
  const [amount, setAmount] = useState('');
  const [cautionReasons, setCautionReasons] = useState<string[]>([]);
  const [simulation, setSimulation] = useState<SpendingSimulation | null>(null);
  const [aiExplanation, setAiExplanation] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSimulate = async () => {
    const spendAmount = parseFloat(amount);
    if (!spendAmount || spendAmount <= 0) return;

    setIsLoading(true);
    setError(null);

    // Run local simulation (source of truth), then let the wider picture
    // downgrade a green verdict: cash-safe is not the same as financially wise.
    const ctx = financialContext(profile, transactions, incomeContext);
    const cautions: string[] = [];
    if (ctx.budgetContext && ctx.budgetContext.remainingThisMonth < 0) {
      cautions.push(`You're over budget this month by $${Math.abs(ctx.budgetContext.remainingThisMonth).toLocaleString()}`);
    }
    for (const c of ctx.debtContext?.creditCards ?? []) {
      if ((c.utilizationPct ?? 0) >= 50) cautions.push(`${c.name} is at ${c.utilizationPct}% utilization`);
    }
    const rawSim = simulateSpending(forecast, spendAmount);
    const sim = rawSim.riskLevel === 'safe' && cautions.length > 0
      ? { ...rawSim, riskLevel: 'caution' as const }
      : rawSim;
    setSimulation(sim);
    setCautionReasons(cautions);

    // Get AI explanation (with fallback)
    try {
      const data = await aiDecision({
        type: 'decision_check',
        forecastData: prepareForecastForAI(forecast),
        amount: spendAmount,
        riskLevel: sim.riskLevel,
        newLowestBalance: sim.newLowestBalance,
        lowestDate: sim.newLowestDate,
        safetyThreshold: forecast.safetyThreshold,
        affectedBills: sim.affectedBills,
        // Full picture: debts, budget, goals — so "safe to spend" weighs card
        // utilization and loan obligations, not just the checking forecast.
        ...ctx,
      });

      if (data.explanation) {
        setAiExplanation(data.explanation);
      } else {
        // Use fallback explanation
        setAiExplanation(generateFallbackExplanation(sim, spendAmount, forecast));
      }
    } catch (err) {
      console.error('AI explanation failed:', err);
      // Fallback: Generate human-readable explanation from simulation data
      setAiExplanation(generateFallbackExplanation(sim, spendAmount, forecast));
    }

    setIsLoading(false);
  };

  // Generate clear explanation when AI is unavailable
  const generateFallbackExplanation = (
    sim: SpendingSimulation, 
    amount: number, 
    forecast: ForecastSummary
  ): string => {
    const formattedDate = format(new Date(sim.newLowestDate), 'MMMM d');
    
    if (sim.riskLevel === 'safe') {
      return `After this spending, your lowest balance will be $${sim.newLowestBalance.toLocaleString()} on ${formattedDate}. This remains above your safety threshold of $${forecast.safetyThreshold.toLocaleString()}.`;
    } else if (sim.riskLevel === 'caution') {
      return `This spending would bring your balance to $${sim.newLowestBalance.toLocaleString()} on ${formattedDate}, which is below your safety threshold of $${forecast.safetyThreshold.toLocaleString()}. You may want to wait until after your next income.`;
    } else {
      const billsWarning = sim.affectedBills.length > 0 
        ? ` This could affect: ${sim.affectedBills.join(', ')}.` 
        : '';
      return `This spending would bring your balance to $${sim.newLowestBalance.toLocaleString()} on ${formattedDate}.${billsWarning} Consider waiting for more funds.`;
    }
  };

  const getRiskIcon = (level: string) => {
    switch (level) {
      case 'safe':
        return <CheckCircle className="w-6 h-6 text-emerald-500" />;
      case 'caution':
        return <AlertTriangle className="w-6 h-6 text-amber-500" />;
      case 'unsafe':
        return <XCircle className="w-6 h-6 text-red-500" />;
      default:
        return <HelpCircle className="w-6 h-6 text-gray-500" />;
    }
  };

  const getRiskColor = (level: string) => {
    switch (level) {
      case 'safe':
        return 'border-emerald-500/30 bg-emerald-500/5';
      case 'caution':
        return 'border-amber-500/30 bg-amber-500/5';
      case 'unsafe':
        return 'border-red-500/30 bg-red-500/5';
      default:
        return 'border-gray-500/30 bg-gray-500/5';
    }
  };

  const getRiskLabel = (level: string) => {
    switch (level) {
      case 'safe':
        return 'Safe to proceed';
      case 'caution':
        return 'Proceed with awareness';
      case 'unsafe':
        return 'Reconsider this spending';
      default:
        return 'Unknown';
    }
  };

  const reset = () => {
    setAmount('');
    setSimulation(null);
    setAiExplanation(null);
    setError(null);
  };

  return (
    <div className="bg-[var(--background-secondary)] border border-[var(--border-color)] rounded-card p-6">
      <div className="flex items-center gap-3 mb-4">
        <div className="w-10 h-10 rounded-control bg-[var(--accent-primary)]/10 flex items-center justify-center">
          <HelpCircle className="w-5 h-5 text-[var(--accent-primary)]" />
        </div>
        <div>
          <h3 className="text-lg font-semibold text-[var(--foreground)]">Can I Afford This?</h3>
          <p className="text-sm text-[var(--foreground-muted)]">Check spending impact before you decide</p>
        </div>
      </div>

      {!simulation ? (
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
              Amount you want to spend
            </label>
            <div className="relative">
              <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-[var(--foreground-muted)]" />
              <input
                type="number"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                className="input-field pl-10 text-lg font-medium"
                onKeyDown={(e) => e.key === 'Enter' && handleSimulate()}
              />
            </div>
          </div>

          <button
            onClick={handleSimulate}
            disabled={!amount || parseFloat(amount) <= 0 || isLoading}
            className="w-full btn-primary flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {isLoading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Analyzing...
              </>
            ) : (
              'Check Impact'
            )}
          </button>

          <p className="text-xs text-[var(--foreground-muted)] text-center">
            Current balance: ${forecast.startingBalance.toLocaleString()} | 
            Safety threshold: ${forecast.safetyThreshold.toLocaleString()}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Risk Level Badge */}
          <div className={`flex items-center gap-3 p-4 rounded-control border ${getRiskColor(simulation.riskLevel)}`}>
            {getRiskIcon(simulation.riskLevel)}
            <div>
              <p className="font-semibold text-[var(--foreground)]">
                {getRiskLabel(simulation.riskLevel)}
              </p>
              <p className="text-sm text-[var(--foreground-secondary)]">
                Spending ${parseFloat(amount).toLocaleString()}
              </p>
              {cautionReasons.map((r) => (
                <p key={r} className="text-sm text-[var(--accent-warning)] mt-1">• {r}</p>
              ))}
            </div>
          </div>

          {/* Key Numbers */}
          <div className="grid grid-cols-2 gap-3">
            <div className="p-3 rounded-control bg-[var(--background-tertiary)]">
              <p className="text-xs text-[var(--foreground-muted)] mb-1">New Lowest Balance</p>
              <p className={`text-lg font-bold ${simulation.newLowestBalance < 0 ? 'text-red-500' : simulation.newLowestBalance < forecast.safetyThreshold ? 'text-amber-500' : 'text-[var(--foreground)]'}`}>
                ${simulation.newLowestBalance.toLocaleString()}
              </p>
            </div>
            <div className="p-3 rounded-control bg-[var(--background-tertiary)]">
              <p className="text-xs text-[var(--foreground-muted)] mb-1">Lowest Point Date</p>
              <p className="text-lg font-bold text-[var(--foreground)]">
                {format(new Date(simulation.newLowestDate), 'MMM d')}
              </p>
            </div>
          </div>

          {/* AI Explanation */}
          {aiExplanation && (
            <div className="p-4 rounded-control bg-[var(--background-tertiary)] border border-[var(--border-color)]">
              <p className="text-sm text-[var(--foreground-secondary)] leading-relaxed">
                {aiExplanation}
              </p>
            </div>
          )}

          {/* Affected Bills Warning */}
          {simulation.affectedBills.length > 0 && (
            <div className="p-3 rounded-control bg-red-500/10 border border-red-500/30">
              <p className="text-sm text-red-400">
                <strong>Bills at risk:</strong> {simulation.affectedBills.join(', ')}
              </p>
            </div>
          )}

          <button
            onClick={reset}
            className="w-full btn-secondary"
          >
            Check Another Amount
          </button>
        </div>
      )}
    </div>
  );
}

