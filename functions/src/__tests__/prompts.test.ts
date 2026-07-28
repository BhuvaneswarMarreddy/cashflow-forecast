import { buildPrompt } from '../prompts';

describe('buildPrompt', () => {
  it('decision_check: substitutes all placeholders', () => {
    const prompt = buildPrompt('decision_check', {
      forecastData: '{"startingBalance":1200}',
      amount: 250,
      riskLevel: 'caution',
      newLowestBalance: 310,
      lowestDate: '2026-08-04',
      safetyThreshold: 500,
      affectedBills: ['Rent', 'Car payment'],
    });
    expect(prompt).toContain('{"startingBalance":1200}');
    expect(prompt).toContain('Amount user wants to spend: 250');
    expect(prompt).toContain('Risk level: caution');
    expect(prompt).toContain('New lowest balance would be: 310');
    expect(prompt).toContain('2026-08-04');
    expect(prompt).toContain('Safety threshold: 500');
    expect(prompt).toContain('Rent, Car payment');
    expect(prompt).not.toContain('{amount}');
    expect(prompt).not.toContain('{forecastData}');
  });

  it('decision_check: applies route defaults when fields are missing', () => {
    const prompt = buildPrompt('decision_check', {})!;
    expect(prompt).toContain('Amount user wants to spend: 0');
    expect(prompt).toContain('Risk level: unknown');
    expect(prompt).toContain('Safety threshold: 500');
    expect(prompt).toContain('Bills that could be affected: none');
  });

  it('question: includes forecast data and the question', () => {
    const prompt = buildPrompt('question', {
      forecastData: '{"lowestBalance":42}',
      question: 'Why is my balance low next month?',
    })!;
    expect(prompt).toContain('{"lowestBalance":42}');
    expect(prompt).toContain('Why is my balance low next month?');
  });

  it('comprehensive: includes forecast data', () => {
    const prompt = buildPrompt('comprehensive', { forecastData: 'FULL-CONTEXT' })!;
    expect(prompt).toContain('FULL-CONTEXT');
    expect(prompt).toContain('comprehensive but concise analysis');
  });

  it('insights: formats current position, monthly summary, and optional sections', () => {
    const prompt = buildPrompt('insights', {
      data: {
        currentCash: 5400,
        safetyThreshold: 500,
        monthlyIncomeProjection: 8000,
        totalAccounts: 3,
        monthlyData: [
          { monthLabel: 'July 2026', income: 8000, expenses: 6000, net: 2000 },
          { monthLabel: 'June 2026', income: 8000, expenses: 8500, net: -500 },
        ],
        trends: {
          expenseChange: -29.4,
          incomeChange: 0,
          savingsRate: 25,
          threeMonthAvgExpenses: 7000,
          isOverspending: false,
          biggestCategory: 'housing',
        },
        budgets: [{ categoryId: 'food', percentUsed: 110, isOverBudget: true }],
        goals: [{ name: 'Vacation', percentComplete: 40 }],
        debts: { totalDebt: 12000, totalMinimumPayments: 350, count: 2 },
      },
    })!;
    expect(prompt).toContain('Current Cash: $5,400');
    expect(prompt).toContain('July 2026: Income $8,000, Expenses $6,000, Net +$2,000');
    expect(prompt).toContain('June 2026: Income $8,000, Expenses $8,500, Net $-500');
    expect(prompt).toContain('Spending change: -29.4% from last month');
    expect(prompt).toContain('- food: 110% used (OVER BUDGET)');
    expect(prompt).toContain('- Vacation: 40% complete');
    expect(prompt).toContain('Total Debt: $12,000');
  });

  it('insights: handles an empty payload with defaults', () => {
    const prompt = buildPrompt('insights', {})!;
    expect(prompt).toContain('Current Cash: $0');
    expect(prompt).toContain('No data available');
    expect(prompt).not.toContain('BUDGET STATUS');
    expect(prompt).not.toContain('DEBT SUMMARY');
  });

  it('emergency_fund: includes the panel question and forecast context', () => {
    const prompt = buildPrompt('emergency_fund', {
      question: 'Current cash: $5,000, Runway: 2.5 months. Keep it short.',
      forecast: { currentBalance: 5000, safetyThreshold: 500 },
    })!;
    expect(prompt).toContain('emergency fund');
    expect(prompt).toContain('Current cash: $5,000, Runway: 2.5 months.');
    expect(prompt).toContain('"currentBalance": 5000');
    expect(prompt).toContain('"safetyThreshold": 500');
  });

  it('emergency_fund: works without question or forecast', () => {
    const prompt = buildPrompt('emergency_fund', {})!;
    expect(prompt).toContain('Provide a brief, encouraging insight about my emergency fund.');
  });

  it('merges budget/goals/debt context into forecastData', () => {
    const prompt = buildPrompt('question', {
      forecastData: '{"startingBalance":100}',
      question: 'Am I ok?',
      budgetContext: [{ categoryId: 'food' }],
      goalsContext: [{ name: 'Car' }],
      debtContext: { totalDebt: 900 },
    })!;
    expect(prompt).toContain('"budgets"');
    expect(prompt).toContain('"savingsGoals"');
    expect(prompt).toContain('"debts"');
    expect(prompt).toContain('"startingBalance": 100');
  });

  it('keeps original forecastData when it is not valid JSON', () => {
    const prompt = buildPrompt('question', {
      forecastData: 'not-json',
      question: 'q',
      budgetContext: [{}],
    })!;
    expect(prompt).toContain('not-json');
  });

  it('returns null for unknown types (route returned 400)', () => {
    expect(buildPrompt('tight_period', {})).toBeNull();
    expect(buildPrompt(undefined, {})).toBeNull();
    expect(buildPrompt('', {})).toBeNull();
  });
});
