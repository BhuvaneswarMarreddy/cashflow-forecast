import { POSTED_ONLY } from '@/lib/classify';
/**
 * Forecast Engine Unit Tests
 * Tests the core cash flow forecast calculations
 */

import { generateForecast, simulateSpending, deriveAccountBalance, withDerivedBalances } from '@/lib/forecast';
import { LIVING_COSTS_LABEL } from '@/lib/behavior';
import { PaymentAccount, IncomeSource, Transaction } from '@/types';
import { addDays, format } from 'date-fns';

// Frozen clock: fixtures below build dates as offsets from "now". An unmocked
// new Date() made this non-deterministic near local midnight / month or DST
// boundaries. Pinned to a fixed local instant so every run sees the same "today".
const FROZEN_NOW = new Date(2026, 7, 15, 12, 0, 0);
/** yyyy-MM-dd, LOCAL calendar day — the same convention forecast.ts itself uses
 *  (date-fns format() reads local getters), so fixtures can never disagree with
 *  the source about which day an event falls on. */
const D = (offsetDays: number) => format(addDays(FROZEN_NOW, offsetDays), 'yyyy-MM-dd');

describe('Forecast Engine', () => {
  beforeAll(() => {
    jest.useFakeTimers();
    jest.setSystemTime(FROZEN_NOW);
  });
  afterAll(() => {
    jest.useRealTimers();
  });

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

  /**
   * A fixture with a known dip-then-recover shape, used to PIN exact balances —
   * not just "the running total agrees with itself". Rent + Groceries dip the
   * balance to 2700 before a $300 transfer-in brings it back up to 3000. The
   * recovering leg is a transfer (not income) on purpose: it also pins that
   * transfers are excluded from totalIncome/totalExpenses (see the totals test).
   */
  const knownEventsTxns = (): Transaction[] => [
    { id: 'k1', title: 'Rent', amount: 1800, type: 'expense', category: 'other', paymentMethod: 'chase', accountId: 'checking-1', date: D(3) },
    { id: 'k2', title: 'Groceries', amount: 500, type: 'expense', category: 'other', paymentMethod: 'chase', accountId: 'checking-1', date: D(7) },
    { id: 'k3', title: 'Deposit refund', amount: 300, type: 'transfer', transferDirection: 'in', category: 'other', paymentMethod: 'chase', accountId: 'checking-1', date: D(10) },
  ];

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
      generateForecast(5000, mockAccounts, mockIncomeSources, transactions, POSTED_ONLY, 1000, 30);

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
      expect(deriveAccountBalance(chase, txns, POSTED_ONLY)).toBe(3000);
    });

    test('bank: +1000 transfer-in and -950 transfer-out => 50', () => {
      const bofa = acct('bofa-checking', 'bank_account');
      const txns = [
        row({ accountId: bofa.id, type: 'transfer', transferDirection: 'in', amount: 1000, title: 'Transfer from Chase' }),
        row({ accountId: bofa.id, type: 'transfer', transferDirection: 'out', amount: 950, title: 'Transfer to Amazon Card' }),
      ];
      expect(deriveAccountBalance(bofa, txns, POSTED_ONLY)).toBe(50);
    });

    test('credit card: 950 purchase and 950 transfer-in payment => debt 0', () => {
      const card = acct('amazon-card', 'credit_card');
      const txns = [
        row({ accountId: card.id, type: 'expense', amount: 950, title: 'Amazon order' }),
        row({ accountId: card.id, type: 'transfer', transferDirection: 'in', amount: 950, title: 'Transfer from BofA' }),
      ];
      expect(deriveAccountBalance(card, txns, POSTED_ONLY)).toBe(0);
    });

    test('a card with derived debt and a due date does NOT synthesize a payment', () => {
      // Regression: once balances are derived, a card with debt would otherwise fire a
      // synthetic full-balance bill on top of the recorded transfer that pays it —
      // double-counting. Card payments must come from recorded transactions only.
      const card = { ...acct('card', 'credit_card'), dueDate: 15 };
      const txns = [row({ accountId: card.id, type: 'expense', amount: 950, title: 'Purchase' })];
      const accounts = withDerivedBalances([card], txns, POSTED_ONLY); // card now derives 950 debt
      const f = generateForecast(1000, accounts, [], txns, POSTED_ONLY, 500, 90);
      expect(f.events.some(e => e.type === 'bill' || e.type === 'credit_card_payment')).toBe(false);
    });
  });

  describe('generateForecast', () => {
    test('should generate forecast with correct starting balance', () => {
      const forecast = generateForecast(
        5000, // starting cash
        mockAccounts,
        mockIncomeSources,
        mockTransactions, POSTED_ONLY,
        1000, // safety threshold
        30 // days
      );

      expect(forecast.startingBalance).toBe(5000);
      expect(forecast.events.length).toBeGreaterThan(0);
      expect(forecast.events[0].type).toBe('starting_balance');
      expect(forecast.events[0].balanceAfter).toBe(5000);
    });

    test('running balance matches hand-computed balances for a known event sequence', () => {
      // Expected balanceAfter for each event is computed by hand below, not
      // re-derived from the same running total the source produces — a wrong
      // amount anywhere in the chain fails this.
      const forecast = generateForecast(5000, mockAccounts, [], knownEventsTxns(), POSTED_ONLY, 100, 20);

      expect(forecast.events.map(e => ({ date: e.date, amount: e.amount, balanceAfter: e.balanceAfter }))).toEqual([
        { date: D(0), amount: 0, balanceAfter: 5000 },      // starting balance
        { date: D(3), amount: -1800, balanceAfter: 3200 },  // 5000 - 1800 (Rent)
        { date: D(7), amount: -500, balanceAfter: 2700 },   // 3200 - 500 (Groceries)
        { date: D(10), amount: 300, balanceAfter: 3000 },   // 2700 + 300 (transfer in)
      ]);
    });

    test('should identify the lowest balance point from a known dip, not just its own invariant', () => {
      const forecast = generateForecast(5000, mockAccounts, [], knownEventsTxns(), POSTED_ONLY, 100, 20);

      // Balance dips to 2700 on day 7 (after Rent + Groceries) then recovers to
      // 3000 on day 10 — the lowest point is the dip, not the ending balance.
      expect(forecast.lowestBalance).toBe(2700);
      expect(forecast.lowestBalanceDate).toBe(D(7));
    });

    test('should flag critical events below safety threshold', () => {
      const forecast = generateForecast(
        500, // Low starting cash - already below safety
        mockAccounts,
        [],
        mockTransactions, POSTED_ONLY,
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
        mockTransactions, POSTED_ONLY,
        1000,
        45 // Enough days to include monthly income
      );

      const incomeEvents = forecast.events.filter(e => e.type === 'income');
      expect(incomeEvents.length).toBeGreaterThanOrEqual(1);
    });

    test('should calculate total income and expenses from known events, not just their sign', () => {
      const forecast = generateForecast(5000, mockAccounts, [], knownEventsTxns(), POSTED_ONLY, 100, 20);
      // Rent (1800) + Groceries (500) = 2300 of expenses. The $300 transfer-in is
      // deliberately NOT counted as income — transfers are excluded from totals
      // (see forecast.ts: "counting a savings sweep here inflates the target").
      expect(forecast.totalIncome).toBe(0);
      expect(forecast.totalExpenses).toBe(2300);
    });
  });

  describe('simulateSpending', () => {
    // Empty accounts/income/transactions strips the forecast down to just the
    // starting-balance event. spendDate defaults to today, which never sorts
    // after that single event, so the simulated spend always lands last and
    // newLowestBalance is exactly startingCash - spendAmount — fully
    // hand-computable, which is what lets the assertions below be concrete
    // numbers instead of comparisons against the function's own output.
    const bare = (startingCash: number, safetyThreshold: number) =>
      generateForecast(startingCash, [], [], [], POSTED_ONLY, safetyThreshold, 30);

    test('newLowestBalance is the starting balance minus the simulated spend', () => {
      const forecast = bare(5000, 500);
      expect(simulateSpending(forecast, 1200).newLowestBalance).toBe(3800);
    });

    // Not tested: `simulation.amount === spendAmount`. That field is a direct,
    // untransformed copy of the input parameter (`amount: spendAmount` in
    // simulateSpending) — there is no logic to fail, so no assertion teaches
    // anything a compiler-level type check does not already guarantee.

    test('violatesSafety is true only when the simulated low sits below the threshold', () => {
      expect(simulateSpending(bare(1000, 1000), 500).violatesSafety).toBe(true); // low 500 < 1000
      expect(simulateSpending(bare(10000, 1000), 100).violatesSafety).toBe(false); // low 9900 >= 1000
      // Exactly AT the threshold does not violate it (violatesSafety is `<`, not `<=`).
      expect(simulateSpending(bare(10000, 1000), 9000).violatesSafety).toBe(false); // low 1000
    });

    test('riskLevel is pinned at both classification boundaries, not just checked against its own union', () => {
      // At/above the safety threshold: safe.
      const safe = bare(10000, 1000);
      expect(simulateSpending(safe, 100).riskLevel).toBe('safe');   // low 9900
      expect(simulateSpending(safe, 9000).riskLevel).toBe('safe');  // low 1000, exactly at threshold

      // Below the threshold but not negative: caution.
      const caution = bare(1000, 1000);
      expect(simulateSpending(caution, 500).riskLevel).toBe('caution');  // low 500
      expect(simulateSpending(caution, 1000).riskLevel).toBe('caution'); // low 0, exactly at zero

      // Negative: unsafe.
      expect(simulateSpending(bare(1000, 1000), 1500).riskLevel).toBe('unsafe'); // low -500
    });
  });

  describe('Edge Cases', () => {
    test('should handle empty income sources', () => {
      const forecast = generateForecast(
        5000,
        mockAccounts,
        [], // No income
        mockTransactions, POSTED_ONLY,
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
        mockTransactions, POSTED_ONLY,
        1000,
        30
      );

      // No accounts means no bank-derived cash, but the forecast still starts
      // from the given cash figure and still emits its starting event.
      expect(forecast.startingBalance).toBe(5000);
      expect(forecast.events[0]).toMatchObject({ type: 'starting_balance', balanceAfter: 5000 });
    });

    test('should handle zero starting balance', () => {
      const forecast = generateForecast(
        0,
        mockAccounts,
        mockIncomeSources,
        mockTransactions, POSTED_ONLY,
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
        mockTransactions, POSTED_ONLY,
        1000,
        30
      );

      expect(forecast.startingBalance).toBe(-500);
    });
  });

  describe('behavior drain (projection realism)', () => {
    const bank: PaymentAccount = {
      id: 'b', name: 'b', type: 'bank_account', provider: 'chase',
      openingBalance: 10000, openingDate: '2000-01-01', color: '#000', isActive: true,
    } as PaymentAccount;

    test('everyday spending history drains the projection as daily living costs', () => {
      // ~$3,000/mo of ordinary spending across the last 6 full months. Distinct
      // merchants so detectRecurring cannot claim it — this is the habitual residual.
      const now = new Date();
      const txns: Transaction[] = [];
      for (let back = 1; back <= 6; back++) {
        const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 12));
        txns.push({
          id: `e${back}`, title: `Grocery run ${back}X`, amount: 3000, type: 'expense',
          category: 'other', paymentMethod: 'chase',
          date: d.toISOString().slice(0, 10), accountId: 'b',
        } as Transaction);
      }
      const f = generateForecast(10000, [bank], [], txns, POSTED_ONLY, 500, 90);
      // ~$98.6/day projected out — the curve must come DOWN
      const living = f.events.filter(e => e.description === LIVING_COSTS_LABEL);
      expect(living.length).toBeGreaterThan(0);
      expect(living[0].amount).toBeCloseTo(-(3000 * 12) / 365, 0);
      expect(living[0].breakdown).toEqual([{ label: 'Other', amount: 3000 }]);
      expect(f.endingBalance).toBeLessThan(3000);
      expect(f.endingBalance).toBeGreaterThan(-500);
    });

    test('no double count: a detected bill twinned to a loan projects exactly once', () => {
      const loan: PaymentAccount = {
        id: 'l', name: 'loan', type: 'personal_loan', provider: 'other',
        openingBalance: 5000, openingDate: '2000-01-01', monthlyPayment: 3000, dueDate: 15,
        color: '#000', isActive: true,
      } as PaymentAccount;
      // History: the ONLY spending is the $3,000/mo loan payment itself
      const now = new Date();
      const txns: Transaction[] = [];
      for (let back = 1; back <= 6; back++) {
        const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 15));
        txns.push({
          id: `p${back}`, title: 'Loan payment', amount: 3000, type: 'expense',
          category: 'other', paymentMethod: 'chase',
          date: d.toISOString().slice(0, 10), accountId: 'b',
        } as Transaction);
      }
      const f = generateForecast(10000, [bank, loan], [], txns, POSTED_ONLY, 500, 90);
      // Detection classifies the history as a fixed bill (out of the baselines) and
      // the loan twin wins the event: no living-costs drain, no duplicate $3,000s —
      // every projected $3,000 outflow is the loan's own bill event.
      expect(f.events.filter(e => e.description === LIVING_COSTS_LABEL).length).toBe(0);
      const threeK = f.events.filter(e => e.amount === -3000);
      expect(threeK.length).toBeGreaterThan(0);
      expect(threeK.every(e => e.type === 'bill')).toBe(true);
    });
  });

});

