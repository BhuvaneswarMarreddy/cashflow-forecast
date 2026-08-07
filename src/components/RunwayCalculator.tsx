'use client';

import React, { useState, useMemo } from 'react';
import { 
  Calculator, 
  TrendingUp, 
  TrendingDown, 
  Calendar, 
  DollarSign, 
  Sparkles,
  Target,
  Clock,
  ArrowRight,
  Plus,
  Minus,
  RefreshCw,
  Lightbulb
} from 'lucide-react';
import { ForecastSummary } from '@/types';
import { format, addDays, addMonths, differenceInDays } from 'date-fns';
import ChartSrTable from '@/components/ChartSrTable';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';

interface RunwayCalculatorProps {
  currentCash: number;
  monthlyExpenses: number;
  monthlyIncome: number;
  forecast: ForecastSummary;
}

interface Scenario {
  name: string;
  adjustedMonthlyExpenses: number;
  additionalIncome: number;
  runwayDays: number;
  runwayMonths: number;
  projectedData: { date: string; balance: number }[];
  message: string;
  isPositive: boolean;
}

export default function RunwayCalculator({ 
  currentCash, 
  monthlyExpenses, 
  monthlyIncome,
  forecast 
}: RunwayCalculatorProps) {
  const [expenseReduction, setExpenseReduction] = useState(0); // percentage
  const [additionalIncome, setAdditionalIncome] = useState(0); // monthly amount
  const [showScenarios, setShowScenarios] = useState(false);

  // Calculate net monthly flow
  const netMonthlyFlow = monthlyIncome - monthlyExpenses;

  // Calculate runway (how long money will last)
  const calculateRunway = (cash: number, expenses: number, income: number): { days: number; months: number } => {
    const netFlow = income - expenses;
    
    if (netFlow >= 0) {
      // Money is growing or stable
      return { days: Infinity, months: Infinity };
    }
    
    // Money is shrinking
    const monthsUntilZero = cash / Math.abs(netFlow);
    const daysUntilZero = monthsUntilZero * 30;
    
    return { 
      days: Math.floor(daysUntilZero), 
      months: parseFloat(monthsUntilZero.toFixed(1)) 
    };
  };

  // Current runway
  const currentRunway = useMemo(() => 
    calculateRunway(currentCash, monthlyExpenses, monthlyIncome),
    [currentCash, monthlyExpenses, monthlyIncome]
  );

  // Generate projection data for chart
  const generateProjection = (
    startCash: number, 
    expenses: number, 
    income: number, 
    months: number = 12
  ): { date: string; balance: number }[] => {
    const data = [];
    let balance = startCash;
    const netMonthly = income - expenses;
    
    for (let i = 0; i <= months; i++) {
      const date = addMonths(new Date(), i);
      data.push({
        date: format(date, 'MMM yyyy'),
        balance: Math.max(0, balance),
      });
      balance += netMonthly;
    }
    
    return data;
  };

  // Current projection
  const currentProjection = useMemo(() => 
    generateProjection(currentCash, monthlyExpenses, monthlyIncome),
    [currentCash, monthlyExpenses, monthlyIncome]
  );

  // What-if scenario projection
  const adjustedExpenses = monthlyExpenses * (1 - expenseReduction / 100);
  const adjustedIncome = monthlyIncome + additionalIncome;
  const scenarioProjection = useMemo(() => 
    generateProjection(currentCash, adjustedExpenses, adjustedIncome),
    [currentCash, adjustedExpenses, adjustedIncome]
  );

  const scenarioRunway = useMemo(() => 
    calculateRunway(currentCash, adjustedExpenses, adjustedIncome),
    [currentCash, adjustedExpenses, adjustedIncome]
  );

  // Pre-built scenarios for inspiration
  const inspirationalScenarios: Scenario[] = useMemo(() => {
    const scenarios: Scenario[] = [];
    
    // Scenario 1: Cut 10% expenses
    const cut10 = monthlyExpenses * 0.9;
    const run10 = calculateRunway(currentCash, cut10, monthlyIncome);
    scenarios.push({
      name: 'Cut 10% Expenses',
      adjustedMonthlyExpenses: cut10,
      additionalIncome: 0,
      runwayDays: run10.days,
      runwayMonths: run10.months,
      projectedData: generateProjection(currentCash, cut10, monthlyIncome),
      message: run10.months === Infinity 
        ? 'Your money grows indefinitely.' 
        : `Extends runway by ${Math.round((run10.days - currentRunway.days) / 30)} months.`,
      isPositive: run10.days > currentRunway.days,
    });

    // Scenario 2: Cut 20% expenses
    const cut20 = monthlyExpenses * 0.8;
    const run20 = calculateRunway(currentCash, cut20, monthlyIncome);
    scenarios.push({
      name: 'Cut 20% Expenses',
      adjustedMonthlyExpenses: cut20,
      additionalIncome: 0,
      runwayDays: run20.days,
      runwayMonths: run20.months,
      projectedData: generateProjection(currentCash, cut20, monthlyIncome),
      message: run20.months === Infinity 
        ? 'Your money grows indefinitely.' 
        : `Extends runway by ${Math.round((run20.days - currentRunway.days) / 30)} months.`,
      isPositive: run20.days > currentRunway.days,
    });

    // Scenario 3: Add $500 side income
    const add500 = monthlyIncome + 500;
    const runAdd500 = calculateRunway(currentCash, monthlyExpenses, add500);
    scenarios.push({
      name: 'Add $500/mo Side Income',
      adjustedMonthlyExpenses: monthlyExpenses,
      additionalIncome: 500,
      runwayDays: runAdd500.days,
      runwayMonths: runAdd500.months,
      projectedData: generateProjection(currentCash, monthlyExpenses, add500),
      message: runAdd500.months === Infinity 
        ? 'Your money grows indefinitely.' 
        : `Extends runway by ${Math.round((runAdd500.days - currentRunway.days) / 30)} months.`,
      isPositive: runAdd500.days > currentRunway.days,
    });

    // Scenario 4: Add $1000 side income
    const add1000 = monthlyIncome + 1000;
    const runAdd1000 = calculateRunway(currentCash, monthlyExpenses, add1000);
    scenarios.push({
      name: 'Add $1,000/mo Side Income',
      adjustedMonthlyExpenses: monthlyExpenses,
      additionalIncome: 1000,
      runwayDays: runAdd1000.days,
      runwayMonths: runAdd1000.months,
      projectedData: generateProjection(currentCash, monthlyExpenses, add1000),
      message: runAdd1000.months === Infinity 
        ? 'Your money grows indefinitely.' 
        : `Extends runway by ${Math.round((runAdd1000.days - currentRunway.days) / 30)} months.`,
      isPositive: runAdd1000.days > currentRunway.days,
    });

    // Scenario 5: Survival Mode (30% cut + side income)
    const survivalExpenses = monthlyExpenses * 0.7;
    const survivalIncome = monthlyIncome + 500;
    const runSurvival = calculateRunway(currentCash, survivalExpenses, survivalIncome);
    scenarios.push({
      name: 'Survival Mode',
      adjustedMonthlyExpenses: survivalExpenses,
      additionalIncome: 500,
      runwayDays: runSurvival.days,
      runwayMonths: runSurvival.months,
      projectedData: generateProjection(currentCash, survivalExpenses, survivalIncome),
      message: runSurvival.months === Infinity 
        ? 'Not just surviving - thriving!' 
        : `Maximum safety: ${Math.round(runSurvival.months)} months runway.`,
      isPositive: true,
    });

    return scenarios;
  }, [currentCash, monthlyExpenses, monthlyIncome, currentRunway.days]);

  // Format runway display
  const formatRunway = (days: number, months: number) => {
    if (days === Infinity) {
      return { text: 'Growing', subtext: 'Your wealth is increasing', color: 'text-emerald-500' };
    }
    if (months <= 1) {
      return { text: `${days} days`, subtext: 'Critical - act now', color: 'text-red-500' };
    }
    if (months <= 3) {
      return { text: `${months} months`, subtext: 'Caution - plan ahead', color: 'text-amber-500' };
    }
    if (months <= 6) {
      return { text: `${months} months`, subtext: 'Moderate runway', color: 'text-yellow-500' };
    }
    return { text: `${months} months`, subtext: 'Comfortable runway', color: 'text-emerald-500' };
  };

  const runwayDisplay = formatRunway(currentRunway.days, currentRunway.months);
  const scenarioDisplay = formatRunway(scenarioRunway.days, scenarioRunway.months);

  // Which projection the chart is showing (base vs. what-if adjustments)
  const hasWhatIf = expenseReduction > 0 || additionalIncome > 0;
  const activeProjection = hasWhatIf ? scenarioProjection : currentProjection;
  const activeDisplay = hasWhatIf ? scenarioDisplay : runwayDisplay;

  return (
    <div className="space-y-6">
      {/* Main Runway Card */}
      <div className="bg-[var(--background-secondary)] border border-[var(--border-color)] rounded-card p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-12 h-12 rounded-card bg-gradient-to-br from-[var(--accent-primary)] to-[var(--accent-secondary)] flex items-center justify-center">
            <Clock className="w-6 h-6 text-white" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-[var(--foreground)]">Wealth Runway</h2>
            <p className="text-sm text-[var(--foreground-muted)]">How long will your money last?</p>
          </div>
        </div>

        {/* Current Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <div className="p-4 rounded-control bg-[var(--background-tertiary)]">
            <p className="text-xs text-[var(--foreground-muted)] mb-1">Current Cash</p>
            <p className="text-xl font-bold text-emerald-500">${currentCash.toLocaleString()}</p>
          </div>
          <div className="p-4 rounded-control bg-[var(--background-tertiary)]">
            <p className="text-xs text-[var(--foreground-muted)] mb-1">Monthly Expenses</p>
            <p className="text-xl font-bold text-red-400">${monthlyExpenses.toLocaleString()}</p>
          </div>
          <div className="p-4 rounded-control bg-[var(--background-tertiary)]">
            <p className="text-xs text-[var(--foreground-muted)] mb-1">Monthly Income</p>
            <p className="text-xl font-bold text-emerald-500">${monthlyIncome.toLocaleString()}</p>
          </div>
          <div className="p-4 rounded-control bg-[var(--background-tertiary)]">
            <p className="text-xs text-[var(--foreground-muted)] mb-1">Net Flow</p>
            <p className={`text-xl font-bold ${netMonthlyFlow >= 0 ? 'text-emerald-500' : 'text-red-400'}`}>
              {netMonthlyFlow >= 0 ? '+' : ''}${netMonthlyFlow.toLocaleString()}/mo
            </p>
          </div>
        </div>

        {/* Runway Display */}
        <div className="text-center py-6 px-4 rounded-card bg-gradient-to-r from-[var(--background-tertiary)] to-[var(--background-secondary)] border border-[var(--border-color)]">
          <p className="text-sm text-[var(--foreground-muted)] mb-2">Your money will last</p>
          <p className={`text-5xl font-bold ${runwayDisplay.color} mb-2`}>
            {runwayDisplay.text}
          </p>
          <p className={`text-sm ${runwayDisplay.color}`}>{runwayDisplay.subtext}</p>
          
          {currentRunway.days !== Infinity && (
            <p className="mt-4 text-sm text-[var(--foreground-secondary)]">
              Until approximately {format(addDays(new Date(), currentRunway.days), 'MMMM d, yyyy')}
            </p>
          )}
        </div>
      </div>

      {/* What-If Scenario Builder */}
      <div className="bg-[var(--background-secondary)] border border-[var(--border-color)] rounded-card p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-control bg-[var(--accent-secondary)]/20 flex items-center justify-center">
            <Sparkles className="w-5 h-5 text-[var(--accent-secondary)]" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-[var(--foreground)]">What-If Scenarios</h3>
            <p className="text-sm text-[var(--foreground-muted)]">See how changes affect your runway</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Expense Reduction Slider */}
          <div>
            <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-3">
              <Minus className="w-4 h-4 inline mr-2" />
              Reduce Monthly Expenses
            </label>
            <div className="space-y-3">
              <input
                type="range"
                min="0"
                max="50"
                step="5"
                value={expenseReduction}
                onChange={(e) => setExpenseReduction(parseInt(e.target.value))}
                className="w-full h-2 bg-[var(--background-tertiary)] rounded-control appearance-none cursor-pointer accent-[var(--accent-primary)]"
              />
              <div className="flex justify-between text-sm">
                <span className="text-[var(--foreground-muted)]">0%</span>
                <span className="font-medium text-[var(--foreground)]">{expenseReduction}%</span>
                <span className="text-[var(--foreground-muted)]">50%</span>
              </div>
              {expenseReduction > 0 && (
                <p className="text-sm text-emerald-500">
                  Save ${Math.round(monthlyExpenses * expenseReduction / 100).toLocaleString()}/mo
                </p>
              )}
            </div>
          </div>

          {/* Additional Income Input */}
          <div>
            <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-3">
              <Plus className="w-4 h-4 inline mr-2" />
              Add Monthly Income
            </label>
            <div className="relative">
              <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-[var(--foreground-muted)]" />
              <input
                type="number"
                value={additionalIncome}
                onChange={(e) => setAdditionalIncome(parseFloat(e.target.value) || 0)}
                placeholder="0"
                className="input-field pl-10"
              />
            </div>
            <p className="text-xs text-[var(--foreground-muted)] mt-2">
              Side gig, freelance, part-time work, etc.
            </p>
          </div>
        </div>

        {/* Scenario Result */}
        {(expenseReduction > 0 || additionalIncome > 0) && (
          <div className="mt-6 p-4 rounded-card bg-[var(--background-tertiary)] border border-[var(--border-color)]">
            <div className="flex items-center justify-between mb-4">
              <span className="text-sm text-[var(--foreground-muted)]">With your changes:</span>
              <button
                onClick={() => {
                  setExpenseReduction(0);
                  setAdditionalIncome(0);
                }}
                className="text-sm text-[var(--accent-primary)] hover:underline flex items-center gap-1"
              >
                <RefreshCw className="w-3 h-3" />
                Reset
              </button>
            </div>
            
            <div className="flex items-center gap-4">
              <div className="flex-1">
                <p className="text-xs text-[var(--foreground-muted)]">New Runway</p>
                <p className={`text-2xl font-bold ${scenarioDisplay.color}`}>
                  {scenarioDisplay.text}
                </p>
              </div>
              <ArrowRight className="w-5 h-5 text-[var(--foreground-muted)]" />
              <div className="flex-1">
                <p className="text-xs text-[var(--foreground-muted)]">Improvement</p>
                <p className="text-2xl font-bold text-emerald-500">
                  {scenarioRunway.months === Infinity ? (
                    'Infinite'
                  ) : currentRunway.months === Infinity ? (
                    'Still growing'
                  ) : (
                    `+${Math.round(scenarioRunway.months - currentRunway.months)} months`
                  )}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Projection Chart */}
      <div className="bg-[var(--background-secondary)] border border-[var(--border-color)] rounded-card p-6">
        <h3 className="text-lg font-semibold text-[var(--foreground)] mb-4">12-Month Projection</h3>
        
        <div
          className="h-[240px] sm:h-[300px]"
          role="img"
          aria-label={`Area chart of ${hasWhatIf ? 'what-if' : 'projected'} balance over 12 months, from $${currentCash.toLocaleString()} today to $${activeProjection[activeProjection.length - 1].balance.toLocaleString()}; runway: ${activeDisplay.text}.`}
        >
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={activeProjection}
              margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
            >
              <defs>
                <linearGradient id="projectionGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#c9a24e" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#c9a24e" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" vertical={false} />
              <XAxis 
                dataKey="date" 
                stroke="var(--foreground-muted)" 
                fontSize={12}
                tickLine={false}
              />
              <YAxis 
                stroke="var(--foreground-muted)" 
                fontSize={12}
                tickLine={false}
                tickFormatter={(value) => `$${(value / 1000).toFixed(0)}k`}
              />
              <Tooltip 
                formatter={(value) => [`$${(value as number)?.toLocaleString() || 0}`, 'Balance']}
                contentStyle={{
                  backgroundColor: 'var(--background-tertiary)',
                  border: '1px solid var(--border-color)',
                  borderRadius: '8px',
                }}
              />
              <ReferenceLine y={0} stroke="#ef4444" strokeWidth={2} />
              <Area isAnimationActive={false}
                type="monotone"
                dataKey="balance"
                stroke="#c9a24e"
                strokeWidth={2}
                fill="url(#projectionGradient)"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <ChartSrTable
          caption={hasWhatIf ? 'What-if 12-month balance projection' : '12-month balance projection'}
          columns={['Month', 'Balance']}
          rows={activeProjection.map((d) => [d.date, `$${d.balance.toLocaleString()}`])}
        />

        <div className="flex items-center gap-4 mt-4 text-sm">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-pill bg-[#c9a24e]" />
            <span className="text-[var(--foreground-secondary)]">
              {hasWhatIf ? 'Scenario Balance' : 'Projected Balance'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-8 h-0.5 bg-red-500" />
            <span className="text-[var(--foreground-secondary)]">Zero Line</span>
          </div>
        </div>
      </div>

      {/* Inspirational Scenarios */}
      <div className="bg-[var(--background-secondary)] border border-[var(--border-color)] rounded-card p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-control bg-amber-500/20 flex items-center justify-center">
              <Lightbulb className="w-5 h-5 text-amber-500" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-[var(--foreground)]">Scenario Ideas</h3>
              <p className="text-sm text-[var(--foreground-muted)]">Small changes, big impact</p>
            </div>
          </div>
          <button
            onClick={() => setShowScenarios(!showScenarios)}
            className="text-sm text-[var(--accent-primary)] hover:underline"
          >
            {showScenarios ? 'Hide' : 'Show all'}
          </button>
        </div>

        <div className={`grid grid-cols-1 md:grid-cols-2 gap-3 ${!showScenarios ? 'max-h-[200px] overflow-hidden' : ''}`}>
          {inspirationalScenarios.map((scenario, i) => (
            <div 
              key={i}
              className="p-4 rounded-control bg-[var(--background-tertiary)] border border-[var(--border-color)] hover:border-[var(--border-glow)] transition-all cursor-pointer"
              onClick={() => {
                setExpenseReduction(Math.round((1 - scenario.adjustedMonthlyExpenses / monthlyExpenses) * 100));
                setAdditionalIncome(scenario.additionalIncome);
              }}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="font-medium text-[var(--foreground)]">{scenario.name}</span>
                <span className={`text-sm font-bold ${scenario.runwayMonths === Infinity ? 'text-emerald-500' : 'text-[var(--foreground)]'}`}>
                  {scenario.runwayMonths === Infinity ? 'Growing' : `${scenario.runwayMonths}mo`}
                </span>
              </div>
              <p className="text-sm text-[var(--foreground-muted)]">{scenario.message}</p>
            </div>
          ))}
        </div>

        {/* Motivational Message */}
        <div className="mt-6 p-4 rounded-card bg-gradient-to-r from-emerald-500/10 to-[var(--accent-primary)]/10 border border-emerald-500/30">
          <div className="flex items-start gap-3">
            <Target className="w-5 h-5 text-emerald-500 mt-0.5 flex-shrink-0" />
            <div>
              <p className="font-medium text-[var(--foreground)] mb-1">You have options</p>
              <p className="text-sm text-[var(--foreground-secondary)]">
                Every small change adds up. Even cutting $100/month or adding a side income can 
                significantly extend your runway. Focus on what you can control, take it one step at a time, 
                and remember: this is a journey, not a sprint.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

