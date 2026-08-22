import { buildPrompt, validateImageBase64 } from '../prompts';
import { HttpsError } from 'firebase-functions/v2/https';

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

  // #83: financialContext() (src/lib/ai-context.ts) now names WHICH accounts are
  // unanchored so the model can say which figure is soft instead of hedging every
  // number. If dataCaveats is dropped here like the previous attempt, the disclosure
  // chain is decorative — the UI shows it, the model never sees it.
  it('merges dataCaveats into forecastData, naming the unanchored account', () => {
    const prompt = buildPrompt('question', {
      forecastData: '{"startingBalance":100}',
      question: 'Can I afford this?',
      dataCaveats: {
        unanchoredAccounts: ['Venmo'],
        reason: 'balance is net movement over imported history, not a confirmed bank balance',
      },
    })!;
    expect(prompt).toContain('"dataCaveats"');
    expect(prompt).toContain('Venmo');
  });

  it('omits dataCaveats from forecastData when not provided', () => {
    const prompt = buildPrompt('question', {
      forecastData: '{"startingBalance":100}',
      question: 'Can I afford this?',
    })!;
    expect(prompt).not.toContain('dataCaveats');
    expect(prompt).not.toContain('Venmo');
  });

  // #83: the JSON key alone doesn't bind the model to anything — a prompt author reading
  // `parsed.dataCaveats = dataCaveats` sees plumbing, not an instruction. Without prose
  // telling the model what the key means and what it must do, the model is free to ignore
  // it or hedge everything instead of naming what's actually soft. Covers every type that
  // receives enhancedForecastData (decision_check, question, comprehensive) since those are
  // the only ones dataCaveats reaches; 'insights' and 'emergency_fund' never see the field.
  describe('dataCaveats instruction (must bind, must name accounts, must not refuse, must be conditional)', () => {
    const caveats = {
      unanchoredAccounts: ['Venmo'],
      reason: 'balance is net movement over imported history, not a confirmed bank balance',
    };

    it.each(['decision_check', 'question', 'comprehensive'])(
      '%s: instructs the model to name the unanchored account when dataCaveats is present',
      (type) => {
        const prompt = buildPrompt(type, {
          forecastData: '{"startingBalance":100}',
          question: 'Can I afford this?',
          dataCaveats: caveats,
        })!;
        // Names the specific account — not a vague hedge.
        expect(prompt).toMatch(/Venmo/);
        // Binding language, not a suggestion.
        expect(prompt).toMatch(/\bMUST\b/);
        // Must not tell the model to withhold the figure.
        expect(prompt).not.toMatch(/do not (state|give|provide|share) (a|the) (figure|number|balance)/i);
        expect(prompt).not.toMatch(/cannot (tell|answer|provide)/i);
      }
    );

    it.each(['decision_check', 'question', 'comprehensive'])(
      '%s: adds no caveat instruction when dataCaveats is absent',
      (type) => {
        const prompt = buildPrompt(type, {
          forecastData: '{"startingBalance":100}',
          question: 'Can I afford this?',
        })!;
        expect(prompt).not.toMatch(/Venmo/);
        expect(prompt).not.toMatch(/unanchored/i);
        expect(prompt).not.toMatch(/DATA CAVEAT/);
      }
    );
  });

  it('returns null for unknown types (route returned 400)', () => {
    expect(buildPrompt('tight_period', {})).toBeNull();
    expect(buildPrompt(undefined, {})).toBeNull();
    expect(buildPrompt('', {})).toBeNull();
  });
});

describe('validateImageBase64', () => {
  // Default caps for chat images
  const defaultMimes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  const defaultSize = 10 * 1024 * 1024; // 10MB

  it('(a) rejects wide-character emoji string under naive byteLength cap but over real byte size', () => {
    // Emoji string: each emoji is ~4 bytes in UTF-8 but byteLength on the string gives wrong count
    // Create a string of emojis that under naive counting looks small but in real bytes is large
    const emojiString = '😀'.repeat(2700000); // ~2.7M chars * ~4 bytes each = ~10.8MB
    // byteLength of the emoji string when counted as 'base64' would underestimate
    expect(() => {
      validateImageBase64(emojiString, 'image/jpeg', defaultMimes, defaultSize);
    }).toThrow(HttpsError);
    // Should throw 'invalid-argument', not 'internal'
    try {
      validateImageBase64(emojiString, 'image/jpeg', defaultMimes, defaultSize);
    } catch (e) {
      if (e instanceof HttpsError) {
        expect(e.code).toBe('invalid-argument');
      }
    }
  });

  it('(b) rejects non-string imageBase64 with invalid-argument, not internal', () => {
    expect(() => {
      validateImageBase64(12345 as any, 'image/jpeg', defaultMimes, defaultSize);
    }).toThrow(HttpsError);
    try {
      validateImageBase64(12345 as any, 'image/jpeg', defaultMimes, defaultSize);
    } catch (e) {
      if (e instanceof HttpsError) {
        expect(e.code).toBe('invalid-argument');
      }
    }
  });

  it('(c) rejects invalid base64 alphabet characters', () => {
    // Invalid base64: contains characters outside [A-Za-z0-9+/=]
    const invalidBase64 = 'SGVsbG8gV29ybGQ=!!!invalid';
    expect(() => {
      validateImageBase64(invalidBase64, 'image/jpeg', defaultMimes, defaultSize);
    }).toThrow(HttpsError);
    try {
      validateImageBase64(invalidBase64, 'image/jpeg', defaultMimes, defaultSize);
    } catch (e) {
      if (e instanceof HttpsError) {
        expect(e.code).toBe('invalid-argument');
      }
    }
  });

  it('accepts valid base64 string with correct mime type', () => {
    // Valid base64: "Hello World"
    const validBase64 = 'SGVsbG8gV29ybGQ=';
    const mime = validateImageBase64(validBase64, 'image/jpeg', defaultMimes, defaultSize);
    expect(mime).toBe('image/jpeg');
  });

  it('accepts valid base64 without padding', () => {
    // Valid base64 without padding: "Hi"
    const validBase64 = 'SGk';
    const mime = validateImageBase64(validBase64, 'image/png', defaultMimes, defaultSize);
    expect(mime).toBe('image/png');
  });

  it('rejects oversized images', () => {
    // Create a valid base64 string that exceeds size limit
    // Buffer.byteLength('A', 'base64') for a string of A's
    // 4 base64 chars = 3 bytes when decoded, so we need more base64 to exceed the limit
    // To exceed 10MB decoded, we need base64 string of size ~13.3MB (10MB * 4/3)
    const sizeToExceed = Math.floor((defaultSize * 4) / 3) + 1000;
    const oversizedBase64 = 'A'.repeat(sizeToExceed);
    expect(() => {
      validateImageBase64(oversizedBase64, 'image/jpeg', defaultMimes, defaultSize);
    }).toThrow(HttpsError);
    try {
      validateImageBase64(oversizedBase64, 'image/jpeg', defaultMimes, defaultSize);
    } catch (e) {
      if (e instanceof HttpsError) {
        expect(e.code).toBe('invalid-argument');
      }
    }
  });

  it('rejects unsupported mime types', () => {
    const validBase64 = 'SGVsbG8gV29ybGQ=';
    expect(() => {
      validateImageBase64(validBase64, 'application/pdf', defaultMimes, defaultSize);
    }).toThrow(HttpsError);
    try {
      validateImageBase64(validBase64, 'application/pdf', defaultMimes, defaultSize);
    } catch (e) {
      if (e instanceof HttpsError) {
        expect(e.code).toBe('invalid-argument');
      }
    }
  });

  it('uses default mime type when not provided', () => {
    const validBase64 = 'SGVsbG8gV29ybGQ=';
    const mime = validateImageBase64(validBase64, undefined, defaultMimes, defaultSize);
    expect(mime).toBe('image/jpeg'); // default
  });
});
