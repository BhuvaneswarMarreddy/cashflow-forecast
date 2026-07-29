/**
 * AI Decision API Route
 * 
 * Server-side OpenAI integration for financial decision explanations.
 * This endpoint ONLY interprets pre-calculated forecast data.
 * It NEVER performs balance calculations.
 * 
 * Receives complete user context including:
 * - Cash flow forecast
 * - Budget status
 * - Savings goals
 * - Debt information
 * - Account summaries
 * - Emergency fund status
 */

import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import { AI_CONFIG, SYSTEM_PROMPT, DECISION_CHECK_PROMPT, QUESTION_PROMPT, COMPREHENSIVE_ANALYSIS_PROMPT } from '@/lib/ai-config';

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { 
      type, 
      forecastData,  // Full context JSON from prepareFullContextForAI
      amount, 
      riskLevel, 
      newLowestBalance, 
      lowestDate, 
      safetyThreshold, 
      affectedBills, 
      question, 
      data,
      // New: Additional context that can be passed
      budgetContext,
      goalsContext,
      debtContext,
    } = body;

    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json(
        { error: 'AI service not configured' },
        { status: 503 }
      );
    }

    // Build enhanced context if additional data is provided
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

    let userPrompt = '';

    if (type === 'decision_check') {
      // Spending decision check with full context
      userPrompt = DECISION_CHECK_PROMPT
        .replace('{forecastData}', enhancedForecastData)
        .replace('{amount}', amount?.toString() || '0')
        .replace('{riskLevel}', riskLevel || 'unknown')
        .replace('{newLowestBalance}', newLowestBalance?.toString() || '0')
        .replace('{lowestDate}', lowestDate || 'unknown')
        .replace('{safetyThreshold}', safetyThreshold?.toString() || '500')
        .replace('{affectedBills}', affectedBills?.join(', ') || 'none');
        
    } else if (type === 'question') {
      // General financial question with full context
      userPrompt = QUESTION_PROMPT
        .replace('{forecastData}', enhancedForecastData)
        .replace('{question}', question || '');
        
    } else if (type === 'comprehensive') {
      // Full financial analysis
      userPrompt = COMPREHENSIVE_ANALYSIS_PROMPT
        .replace('{forecastData}', enhancedForecastData);
        
    } else if (type === 'insights') {
      // Monthly trends and insights
      const insightData = data || {};
      userPrompt = `Analyze this complete financial data and provide actionable insights:

CURRENT POSITION:
- Current Cash: $${insightData.currentCash?.toLocaleString() || '0'}
- Safety Threshold: $${insightData.safetyThreshold?.toLocaleString() || '500'}
- Monthly Income Projection: $${insightData.monthlyIncomeProjection?.toLocaleString() || '0'}
- Total Accounts: ${insightData.totalAccounts || 0}

MONTHLY SUMMARY (Last 3 months):
${insightData.monthlyData?.map((m: { monthLabel?: string; income?: number; expenses?: number; net?: number }) => 
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
${insightData.budgets.map((b: { categoryId?: string; percentUsed?: number; isOverBudget?: boolean }) => 
  `- ${b.categoryId}: ${b.percentUsed?.toFixed(0) || 0}% used${b.isOverBudget ? ' (OVER BUDGET)' : ''}`
).join('\n')}` : ''}

${insightData.goals ? `SAVINGS GOALS:
${insightData.goals.map((g: { name?: string; percentComplete?: number }) => 
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
    } else {
      return NextResponse.json(
        { error: 'Invalid request type' },
        { status: 400 }
      );
    }

    const completion = await openai.chat.completions.create({
      model: AI_CONFIG.model,
      temperature: AI_CONFIG.temperature,
      max_tokens: AI_CONFIG.maxTokens,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    });

    const explanation = completion.choices[0]?.message?.content || 'Unable to generate explanation.';

    return NextResponse.json({
      success: true,
      explanation,
      riskLevel: riskLevel || null,
    });

  } catch (error: unknown) {
    const err = error as { code?: string; status?: number; message?: string };
    console.error('AI API Error:', error);

    // Graceful fallback
    if (err?.code === 'insufficient_quota' || err?.status === 429) {
      return NextResponse.json({
        success: true,
        explanation: 'AI explanation temporarily unavailable. Please check the forecast numbers directly.',
        fallback: true,
      });
    }

    return NextResponse.json(
      { error: 'Failed to process request', details: err?.message },
      { status: 500 }
    );
  }
}

