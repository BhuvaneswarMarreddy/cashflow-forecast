/**
 * Prompt building for the aiDecision callable.
 *
 * Ported verbatim from src/app/api/ai/decision/route.ts, plus the
 * 'emergency_fund' type the route never handled (EmergencyFundPanel sends it).
 * Pure function: no Firebase, no OpenAI — unit-testable as-is.
 */

import {
  DECISION_CHECK_PROMPT,
  QUESTION_PROMPT,
  COMPREHENSIVE_ANALYSIS_PROMPT,
} from './ai-config';

/** Request body shape shared by all aiDecision types (superset). */
export interface AiDecisionRequest {
  type?: string;
  forecastData?: string;
  amount?: number;
  riskLevel?: string;
  newLowestBalance?: number;
  lowestDate?: string;
  safetyThreshold?: number;
  affectedBills?: string[];
  question?: string;
  data?: Record<string, unknown>;
  budgetContext?: unknown;
  goalsContext?: unknown;
  debtContext?: unknown;
  /** emergency_fund only: pre-computed forecast context from the panel */
  forecast?: Record<string, unknown>;
}

/**
 * Build the user prompt for a given request type.
 * Returns null for unknown types (caller maps to invalid-argument).
 */
export function buildPrompt(
  type: string | undefined,
  body: AiDecisionRequest
): string | null {
  const {
    forecastData,
    amount,
    riskLevel,
    newLowestBalance,
    lowestDate,
    safetyThreshold,
    affectedBills,
    question,
    data,
    budgetContext,
    goalsContext,
    debtContext,
  } = body;

  // Build enhanced context if additional data is provided (verbatim from route)
  let enhancedForecastData = forecastData || '';

  if (budgetContext || goalsContext || debtContext) {
    try {
      const parsed = forecastData ? JSON.parse(forecastData) : {};
      if (budgetContext) parsed.budgets = budgetContext;
      if (goalsContext) parsed.savingsGoals = goalsContext;
      if (debtContext) parsed.debts = debtContext;
      enhancedForecastData = JSON.stringify(parsed, null, 2);
    } catch {
      // Keep original if parsing fails
    }
  }

  if (type === 'decision_check') {
    return DECISION_CHECK_PROMPT
      .replace('{forecastData}', enhancedForecastData)
      .replace('{amount}', amount?.toString() || '0')
      .replace('{riskLevel}', riskLevel || 'unknown')
      .replace('{newLowestBalance}', newLowestBalance?.toString() || '0')
      .replace('{lowestDate}', lowestDate || 'unknown')
      .replace('{safetyThreshold}', safetyThreshold?.toString() || '500')
      .replace('{affectedBills}', affectedBills?.join(', ') || 'none');
  }

  if (type === 'question') {
    return QUESTION_PROMPT
      .replace('{forecastData}', enhancedForecastData)
      .replace('{question}', question || '');
  }

  if (type === 'comprehensive') {
    return COMPREHENSIVE_ANALYSIS_PROMPT.replace('{forecastData}', enhancedForecastData);
  }

  if (type === 'insights') {
    const insightData = (data || {}) as {
      currentCash?: number;
      safetyThreshold?: number;
      monthlyIncomeProjection?: number;
      totalAccounts?: number;
      monthlyData?: { monthLabel?: string; income?: number; expenses?: number; net?: number }[];
      trends?: {
        expenseChange?: number;
        incomeChange?: number;
        savingsRate?: number;
        threeMonthAvgExpenses?: number;
        isOverspending?: boolean;
        biggestCategory?: string;
      };
      budgets?: { categoryId?: string; percentUsed?: number; isOverBudget?: boolean }[];
      goals?: { name?: string; percentComplete?: number }[];
      debts?: { totalDebt?: number; totalMinimumPayments?: number; count?: number };
    };
    return `Analyze this complete financial data and provide actionable insights:

CURRENT POSITION:
- Current Cash: $${insightData.currentCash?.toLocaleString() || '0'}
- Safety Threshold: $${insightData.safetyThreshold?.toLocaleString() || '500'}
- Monthly Income Projection: $${insightData.monthlyIncomeProjection?.toLocaleString() || '0'}
- Total Accounts: ${insightData.totalAccounts || 0}

MONTHLY SUMMARY (Last 3 months):
${insightData.monthlyData?.map((m) =>
  `- ${m.monthLabel || 'Unknown'}: Income $${m.income?.toLocaleString() || '0'}, Expenses $${m.expenses?.toLocaleString() || '0'}, Net ${(m.net || 0) >= 0 ? '+' : ''}$${m.net?.toLocaleString() || '0'}`
).join('\n') || 'No data available'}

TRENDS:
- Spending change: ${insightData.trends?.expenseChange?.toFixed(1) || '0'}% from last month
- Income change: ${insightData.trends?.incomeChange?.toFixed(1) || '0'}% from last month
- Current savings rate: ${insightData.trends?.savingsRate?.toFixed(1) || '0'}%
- 3-month average expenses: $${insightData.trends?.threeMonthAvgExpenses?.toLocaleString() || '0'}
- Is overspending: ${insightData.trends?.isOverspending ? 'Yes' : 'No'}
- Biggest category: ${insightData.trends?.biggestCategory || 'Unknown'}

${insightData.budgets ? `BUDGET STATUS:
${insightData.budgets.map((b) =>
  `- ${b.categoryId}: ${b.percentUsed?.toFixed(0) || 0}% used${b.isOverBudget ? ' (OVER BUDGET)' : ''}`
).join('\n')}` : ''}

${insightData.goals ? `SAVINGS GOALS:
${insightData.goals.map((g) =>
  `- ${g.name}: ${g.percentComplete?.toFixed(0) || 0}% complete`
).join('\n')}` : ''}

${insightData.debts ? `DEBT SUMMARY:
- Total Debt: $${insightData.debts.totalDebt?.toLocaleString() || '0'}
- Monthly Minimum Payments: $${insightData.debts.totalMinimumPayments?.toLocaleString() || '0'}
- Number of Debts: ${insightData.debts.count || 0}` : ''}

Provide a brief, helpful summary (3-4 sentences) that covers:
1. Overall financial health observation
2. Most important trend or concern
3. One encouraging observation about progress

Be encouraging and non-judgmental. Focus on facts.`;
  }

  if (type === 'emergency_fund') {
    // New branch: EmergencyFundPanel sends { question, forecast } — the old
    // route 400'd this type. Short prompt over the provided context.
    return `A user is asking about their emergency fund.

FORECAST CONTEXT:
${JSON.stringify(body.forecast || {}, null, 2)}

USER REQUEST:
${question || 'Provide a brief, encouraging insight about my emergency fund.'}

Respond in 2-3 sentences. Be practical, encouraging, and non-judgmental. Use only the numbers provided. Do not give directives - explain what the numbers show.`;
  }

  return null;
}
