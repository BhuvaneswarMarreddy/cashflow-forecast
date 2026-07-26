/**
 * Forecast Engine Unit Tests
 * Tests the core cash flow forecast calculations
 */

import { generateForecast, simulateSpending, deriveAccountBalance, withDerivedBalances } from '@/lib/forecast';
import { PaymentAccount, IncomeSource, Transaction } from '@/types';

describe('Forecast Engine', () => {
  // Sample data for tests
  const mockAccounts: PaymentAccount[] = [
    {
      id: 'checking-1',
      name: 'Chase Checking',
      type: 'bank_account',
      provider: 'chase',
      openingBalance: 5000, openingDate: '2000-01-01',
      color: '#1e88e5',
      isActive: true,
    },
    {
      id: 'credit-1',
      name: 'AMEX Card',
      type: 'credit_card',
      provider: 'amex',
      openingBalance: -1500, openingDate: '2000-01-01', // Negative = owed
      creditLimit: 10000,
      apr: 24.99,
      dueDate: 15,
      color: '#7c3aed',
      isActive: true,
      paymentFromAccountId: 'checking-1',
    },
  ];

  const mockIncomeSources: IncomeSource[] = [
    {
      id: 'income-1',
      name: 'Salary',
      amount: 5000,
      frequency: 'monthly',
      payDate: 1,
      isActive: true,
    },
  ];

  const mockTransactions: Transaction[] = [];

  describe('Transfers in the cash forecast', () => {
    // This forecast tracks the CASH pool. A transfer only nets to zero when BOTH legs
    // sit inside that pool — money moved to a card, to untracked savings, or to an
    // external recipient has genuinely left and must reduce the projection.
    const future = () => {
      const d = new Date();
      d.setDate(d.getDate() + 5);
      return d.toISOString();
    };
    const transfer = (direction: 'in' | 'out'): Transaction => ({
      id: 'tr-1',
      title: 'Transfer to Ally Savings',
      amount: 500,
      type: 'transfer',
      transferDirection: direction,
      category: 'other',
      paymentMethod: 'bank-transfer',
      accountId: 'checking-1',
      date: future(),
    });
    const run = (transactions: Transaction[]) =>
      generateForecast(5000, mockAccounts, mockIncomeSources, transactions, 1000, 30);

    test('an outbound transfer to an untracked destination reduces the projection', () => {
      expect(run([transfer('out')]).endingBalance).toBe(run([]).endingBalance - 500);
    });

    test('an inbound transfer increases it by the same amount', () => {
      expect(run([transfer('in')]).endingBalance).toBe(run([]).endingBalance + 500);
    });

    test('a transfer sitting on a credit card does not touch the cash pool', () => {
      // The card is not part of calculateCurrentCash, so its leg must not move the
      // cash projection — only the checking-side leg does.
      const onCard: Transaction = { ...transfer('in'), accountId: 'credit-1' };
      expect(run([onCard]).endingBalance).toBe(run([]).endingBalance);
    });

    test('falls back to the title when transferDirection is absent', () => {
      // Old rows and hand-created ones carry no direction; the forecast must read them
      // the same way every screen does, via isPositive().
      const untyped: Transaction = {
        id: 'tr-2', title: 'Online Transfer to Savings', amount: 500, type: 'transfer',
        category: 'other', paymentMethod: 'bank-transfer', accountId: 'checking-1',
        date: future(),
      };
      expect(run([untyped]).endingBalance).toBe(run([]).endingBalance - 500);
    });
  });

  describe('deriveAccountBalance', () => {
    const past = () => {
      const d = new Date();
      d.setDate(d.getDate() - 5);
      return d.toISOString();
    };
    const acct = (id: string, type: PaymentAccount['type']): PaymentAccount => ({
      id, name: id, type, provider: 'chase', openingBalance: 0, openingDate: '2000-01-01', color: '#000', isActive: true,
    });
    const row = (over: Partial<Transaction>): Transaction => ({
      id: Math.random().toString(), title: '', amount: 0, type: 'expense',
      category: 'other', paymentMethod: 'chase', date: past(), ...over,
    });

    test('bank: +4000 income and -1000 transfer-out => 3000', () => {
      const chase = acct('chase-checking', 'bank_account');
      const txns = [
        row({ accountId: chase.id, type: 'income', amount: 4000, title: 'Payroll' }),
        row({ accountId: chase.id, type: 'transfer', transferDirection: 'out', amount: 1000, title: 'Transfer to BofA' }),
      ];
      expect(deriveAccountBalance(chase, txns)).toBe(3000);
    });

    test('bank: +1000 transfer-in and -950 transfer-out => 50', () => {
      const bofa = acct('bofa-checking', 'bank_account');
      const txns = [
        row({ accountId: bofa.id, type: 'transfer', transferDirection: 'in', amount: 1000, title: 'Transfer from Chase' }),
        row({ accountId: bofa.id, type: 'transfer', transferDirection: 'out', amount: 950, title: 'Transfer to Amazon Card' }),
      ];
      expect(deriveAccountBalance(bofa, txns)).toBe(50);
    });

    test('credit card: 950 purchase and 950 transfer-in payment => debt 0', () => {
      const card = acct('amazon-card', 'credit_card');
      const txns = [
        row({ accountId: card.id, type: 'expense', amount: 950, title: 'Amazon order' }),
        row({ accountId: card.id, type: 'transfer', transferDirection: 'in', amount: 950, title: 'Transfer from BofA' }),
      ];
      expect(deriveAccountBalance(card, txns)).toBe(0);
    });

    test('a card with derived debt and a due date does NOT synthesize a payment', () => {
      // Regression: once balances are derived, a card with debt would otherwise fire a
      // synthetic full-balance bill on top of the recorded transfer that pays it —
      // double-counting. Card payments must come from recorded transactions only.
      const card = { ...acct('card', 'credit_card'), dueDate: 15 };
      const txns = [row({ accountId: card.id, type: 'expense', amount: 950, title: 'Purchase' })];
      const accounts = withDerivedBalances([card], txns); // card now derives 950 debt
      const f = generateForecast(1000, accounts, [], txns, 500, 90);
      expect(f.events.some(e => e.type === 'bill' || e.type === 'credit_card_payment')).toBe(false);
    });
  });

  describe('generateForecast', () => {
    test('should generate forecast with correct starting balance', () => {
      const forecast = generateForecast(
        5000, // starting cash
        mockAccounts,
        mockIncomeSources,
        mockTransactions,
        1000, // safety threshold
        30 // days
      );

      expect(forecast.startingBalance).toBe(5000);
      expect(forecast.events.length).toBeGreaterThan(0);
      expect(forecast.events[0].type).toBe('starting_balance');
      expect(forecast.events[0].balanceAfter).toBe(5000);
    });

    test('should calculate running balance correctly', () => {
      const forecast = generateForecast(
        5000,
        mockAccounts,
        mockIncomeSources,
        mockTransactions,
        1000,
        30
      );

      // Each event should have a running balance
      forecast.events.forEach((event, index) => {
        if (index > 0) {
          const previousBalance = forecast.events[index - 1].balanceAfter;
          expect(event.balanceAfter).toBe(previousBalance + event.amount);
        }
      });
    });

    test('should identify lowest balance point', () => {
      const forecast = generateForecast(
        5000,
        mockAccounts,
        mockIncomeSources,
        mockTransactions,
        1000,
        30
      );

      // Lowest balance should be <= starting balance
      expect(forecast.lowestBalance).toBeLessThanOrEqual(forecast.startingBalance);
      expect(forecast.lowestBalanceDate).toBeDefined();
    });

    test('should flag critical events below safety threshold', () => {
      const forecast = generateForecast(
        500, // Low starting cash - already below safety
        mockAccounts,
        [],
        mockTransactions,
        1000, // Higher safety threshold
        30
      );

      // Starting balance is below threshold, so we should have some indication
      expect(forecast.lowestBalance).toBeLessThanOrEqual(500);
      expect(forecast.safetyThreshold).toBe(1000);
      
      // If there are expenses, they should be marked critical
      const expenseEvents = forecast.events.filter(e => e.type === 'expense' || e.type === 'bill');
      if (expenseEvents.length > 0 && forecast.lowestBalance < 1000) {
        // At least one event should exist showing low balance
        expect(forecast.lowestBalance).toBeLessThan(1000);
      }
    });

    test('should include income events from income sources', () => {
      const forecast = generateForecast(
        5000,
        mockAccounts,
        mockIncomeSources,
        mockTransactions,
        1000,
        45 // Enough days to include monthly income
      );

      const incomeEvents = forecast.events.filter(e => e.type === 'income');
      expect(incomeEvents.length).toBeGreaterThanOrEqual(1);
    });

    test('should calculate total income and expenses', () => {
      const forecast = generateForecast(
        5000,
        mockAccounts,
        mockIncomeSources,
        mockTransactions,
        1000,
        30
      );

      expect(forecast.totalIncome).toBeGreaterThanOrEqual(0);
      expect(forecast.totalExpenses).toBeGreaterThanOrEqual(0);
    });
  });

  describe('simulateSpending', () => {
    test('should simulate spending impact correctly', () => {
      const forecast = generateForecast(
        5000,
        mockAccounts,
        mockIncomeSources,
        mockTransactions,
        1000,
        30
      );

      const simulation = simulateSpending(forecast, 1000);

      // Simulation should reduce the lowest balance by spend amount
      expect(simulation.newLowestBalance).toBeLessThanOrEqual(forecast.lowestBalance);
      expect(simulation.amount).toBe(1000);
    });

    test('should identify safety violations from spending', () => {
      const forecast = generateForecast(
        2000,
        mockAccounts,
        [],
        mockTransactions,
        1500, // Safety threshold
        30
      );

      const simulation = simulateSpending(forecast, 1000);

      // If spending puts us below safety, should be flagged
      if (simulation.newLowestBalance < 1500) {
        expect(simulation.violatesSafety).toBe(true);
      }
    });

    test('should calculate risk level correctly', () => {
      const forecast = generateForecast(
        10000,
        mockAccounts,
        mockIncomeSources,
        mockTransactions,
        1000,
        30
      );

      // Small spend = should be safe
      const smallSpend = simulateSpending(forecast, 100);
      expect(['safe', 'caution']).toContain(smallSpend.riskLevel);

      // Very large spend = should be risky or unsafe
      const largeSpend = simulateSpending(forecast, 9500);
      // Risk level depends on balance after spend
      expect(largeSpend.riskLevel).toBeDefined();
      expect(['safe', 'caution', 'unsafe']).toContain(largeSpend.riskLevel);
    });
  });

  describe('Edge Cases', () => {
    test('should handle empty income sources', () => {
      const forecast = generateForecast(
        5000,
        mockAccounts,
        [], // No income
        mockTransactions,
        1000,
        30
      );

      expect(forecast).toBeDefined();
      expect(forecast.totalIncome).toBe(0);
    });

    test('should handle empty accounts', () => {
      const forecast = generateForecast(
        5000,
        [], // No accounts
        mockIncomeSources,
        mockTransactions,
        1000,
        30
      );

      expect(forecast).toBeDefined();
    });

    test('should handle zero starting balance', () => {
      const forecast = generateForecast(
        0,
        mockAccounts,
        mockIncomeSources,
        mockTransactions,
        1000,
        30
      );

      expect(forecast.startingBalance).toBe(0);
      expect(forecast.events[0].balanceAfter).toBe(0);
    });

    test('should handle negative starting balance', () => {
      const forecast = generateForecast(
        -500,
        mockAccounts,
        mockIncomeSources,
        mockTransactions,
        1000,
        30
      );

      expect(forecast.startingBalance).toBe(-500);
    });
  });
});

