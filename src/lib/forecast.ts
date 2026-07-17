/**
 * Forecast Engine
 * 
 * Core logic for calculating cash flow predictions.
 * This is the SOURCE OF TRUTH for all balance calculations.
 * AI only interprets these results - it never calculates.
 */

import { 
  PaymentAccount, 
  IncomeSource, 
  Transaction,
  ForecastEvent, 
  ForecastSummary,
  SpendingSimulation,
  AccountForecast 
} from '@/types';
import { addDays, format, parseISO, startOfDay, isBefore, isAfter, isSameDay } from 'date-fns';

const DEFAULT_SAFETY_THRESHOLD = 500;
const FORECAST_DAYS = 90;

/**
 * Calculate current available cash from all accounts
 */
export function calculateCurrentCash(accounts: PaymentAccount[]): number {
  return accounts
    .filter(a => a.type === 'bank_account' || a.type === 'debit_card' || a.type === 'cash')
    .reduce((sum, a) => sum + a.balance, 0);
}

/**
 * Generate recurring bill events for the forecast period
 */
function generateBillEvents(
  accounts: PaymentAccount[],
  startDate: Date,
  endDate: Date
): ForecastEvent[] {
  const events: ForecastEvent[] = [];
  
  // Credit card payments (based on due dates)
  accounts
    .filter(a => a.type === 'credit_card' && a.dueDate && a.balance > 0)
    .forEach(card => {
      let currentDate = new Date(startDate);
      
      while (isBefore(currentDate, endDate)) {
        const month = currentDate.getMonth();
        const year = currentDate.getFullYear();
        const dueDate = new Date(year, month, card.dueDate!);
        
        // If due date hasn't passed this month, add it
        if (isAfter(dueDate, startDate) && isBefore(dueDate, endDate)) {
          events.push({
            date: format(dueDate, 'yyyy-MM-dd'),
            type: 'bill',
            description: `${card.name} Payment`,
            amount: -card.balance, // Full balance as minimum
            balanceAfter: 0, // Will be calculated later
            source: 'recurring',
          });
        }
        
        // Move to next month
        currentDate = new Date(year, month + 1, 1);
      }
    });
  
  // Loan payments
  accounts
    .filter(a => a.type === 'personal_loan' && a.monthlyPayment && a.dueDate)
    .forEach(loan => {
      let currentDate = new Date(startDate);
      
      while (isBefore(currentDate, endDate)) {
        const month = currentDate.getMonth();
        const year = currentDate.getFullYear();
        const dueDate = new Date(year, month, loan.dueDate!);
        
        if (isAfter(dueDate, startDate) && isBefore(dueDate, endDate)) {
          events.push({
            date: format(dueDate, 'yyyy-MM-dd'),
            type: 'bill',
            description: `${loan.name} Payment`,
            amount: -(loan.monthlyPayment || 0),
            balanceAfter: 0,
            source: 'recurring',
          });
        }
        
        currentDate = new Date(year, month + 1, 1);
      }
    });
  
  return events;
}

/**
 * Generate income events for the forecast period
 * Respects end dates and remaining payment counts
 */
function generateIncomeEvents(
  incomeSources: IncomeSource[],
  startDate: Date,
  endDate: Date
): ForecastEvent[] {
  const events: ForecastEvent[] = [];
  
  incomeSources.filter(inc => inc.isActive).forEach(income => {
    let currentDate = new Date(startDate);
    let paymentCount = 0;
    const maxPayments = income.remainingPayments || Infinity;
    const incomeEndDate = income.endDate ? parseISO(income.endDate) : null;
    
    // Check if income has already ended
    if (incomeEndDate && isBefore(incomeEndDate, startDate)) {
      return; // Skip this income source entirely
    }
    
    while (isBefore(currentDate, endDate)) {
      let payDate: Date | null = null;
      
      if (income.frequency === 'monthly' && income.payDate) {
        const month = currentDate.getMonth();
        const year = currentDate.getFullYear();
        payDate = new Date(year, month, income.payDate);
        
        if (isBefore(payDate, startDate)) {
          payDate = new Date(year, month + 1, income.payDate);
        }
        
        // Check if this payment is within bounds
        const withinEndDate = !incomeEndDate || isBefore(payDate, incomeEndDate) || isSameDay(payDate, incomeEndDate);
        const withinPaymentCount = paymentCount < maxPayments;
        
        if (isAfter(payDate, startDate) && isBefore(payDate, endDate) && withinEndDate && withinPaymentCount) {
          const isLastPayment = 
            (incomeEndDate && isSameDay(payDate, incomeEndDate)) ||
            (paymentCount + 1 === maxPayments);
          
          events.push({
            date: format(payDate, 'yyyy-MM-dd'),
            type: 'income',
            description: isLastPayment ? `${income.name} (Final)` : income.name,
            amount: income.amount,
            balanceAfter: 0,
            source: 'recurring',
            isLastPayment,
            endsOn: isLastPayment ? format(payDate, 'yyyy-MM-dd') : undefined,
          });
          
          paymentCount++;
          
          // Add "income ends" marker event after last payment
          if (isLastPayment) {
            events.push({
              date: format(addDays(payDate, 1), 'yyyy-MM-dd'),
              type: 'income_ends',
              description: `${income.name} ends - no more payments`,
              amount: 0,
              balanceAfter: 0,
              source: 'projected',
            });
            return; // Stop generating events for this income
          }
        }
        
        currentDate = new Date(payDate.getFullYear(), payDate.getMonth() + 1, 1);
      } else if (income.frequency === 'biweekly') {
        const baseDay = income.payDate || 15;
        let payDay = new Date(startDate.getFullYear(), startDate.getMonth(), baseDay);
        
        if (isBefore(payDay, startDate)) {
          payDay = addDays(payDay, 14);
        }
        
        while (isBefore(payDay, endDate) && paymentCount < maxPayments) {
          const withinEndDate = !incomeEndDate || isBefore(payDay, incomeEndDate) || isSameDay(payDay, incomeEndDate);
          
          if (isAfter(payDay, startDate) && withinEndDate) {
            const isLastPayment = 
              (incomeEndDate && isSameDay(payDay, incomeEndDate)) ||
              (paymentCount + 1 === maxPayments);
            
            events.push({
              date: format(payDay, 'yyyy-MM-dd'),
              type: 'income',
              description: isLastPayment ? `${income.name} (Final)` : income.name,
              amount: income.amount,
              balanceAfter: 0,
              source: 'recurring',
              isLastPayment,
            });
            paymentCount++;
            
            if (isLastPayment) break;
          }
          payDay = addDays(payDay, 14);
        }
        break;
      } else if (income.frequency === 'weekly') {
        const baseDay = income.payDate || 1;
        let payDay = new Date(startDate.getFullYear(), startDate.getMonth(), baseDay);
        
        if (isBefore(payDay, startDate)) {
          payDay = addDays(payDay, 7);
        }
        
        while (isBefore(payDay, endDate) && paymentCount < maxPayments) {
          const withinEndDate = !incomeEndDate || isBefore(payDay, incomeEndDate) || isSameDay(payDay, incomeEndDate);
          
          if (isAfter(payDay, startDate) && withinEndDate) {
            const isLastPayment = 
              (incomeEndDate && isSameDay(payDay, incomeEndDate)) ||
              (paymentCount + 1 === maxPayments);
            
            events.push({
              date: format(payDay, 'yyyy-MM-dd'),
              type: 'income',
              description: isLastPayment ? `${income.name} (Final)` : income.name,
              amount: income.amount,
              balanceAfter: 0,
              source: 'recurring',
              isLastPayment,
            });
            paymentCount++;
            
            if (isLastPayment) break;
          }
          payDay = addDays(payDay, 7);
        }
        break;
      } else {
        break;
      }
    }
  });
  
  return events;
}

/**
 * Convert existing transactions to forecast events
 * Also generates future recurring transaction events (expenses only - income uses incomeSources)
 * Note: Credit card payments (type=income on credit card account) are NOT real income
 */
function transactionsToEvents(
  transactions: Transaction[],
  accounts: PaymentAccount[],
  startDate: Date,
  endDate: Date
): ForecastEvent[] {
  const events: ForecastEvent[] = [];
  
  // Helper to check if a transaction is on a credit card
  const isCreditCardAccount = (accountId?: string) => {
    if (!accountId) return false;
    const account = accounts.find(a => a.id === accountId);
    return account?.type === 'credit_card';
  };
  
  transactions.forEach(t => {
    const txnDate = parseISO(t.date);
    
    // Add the original transaction if it's in range
    // For income: only add if it's NOT projected (actual received income) AND not a credit card payment
    // Credit card "income" = payment to card (reduces balance), NOT real income
    // For expenses: add all
    const isCreditCardPayment = t.type === 'income' && isCreditCardAccount(t.accountId);
    const isActualIncome = t.type === 'income' && !t.isProjected && !isCreditCardPayment;
    const shouldInclude = t.type === 'expense' || isActualIncome;
    
    if (shouldInclude && isAfter(txnDate, startDate) && isBefore(txnDate, endDate)) {
      events.push({
        date: t.date.split('T')[0],
        type: t.type === 'income' ? 'income' : 'expense' as const,
        description: t.title,
        amount: t.type === 'income' ? t.amount : -t.amount,
        balanceAfter: 0,
        source: t.isRecurring ? 'recurring' : 'manual' as const,
        accountId: t.accountId,
      });
    }
    
    // Generate future recurring events for EXPENSES ONLY
    // Income recurring events come from incomeSources, not transactions
    if (t.isRecurring && t.recurringFrequency && t.type === 'expense') {
      const recurringEndDate = t.recurringEndDate ? parseISO(t.recurringEndDate) : null;
      let paymentCount = 0;
      const maxPayments = t.recurringCount || Infinity;
      
      // Skip if already ended
      if (recurringEndDate && isBefore(recurringEndDate, startDate)) {
        return;
      }
      
      // Calculate interval based on frequency
      let interval = 30; // Default monthly
      if (t.recurringFrequency === 'weekly') interval = 7;
      else if (t.recurringFrequency === 'monthly') interval = 30;
      else if (t.recurringFrequency === 'yearly') interval = 365;
      
      // Start from the transaction date or today, whichever is later
      let nextDate = isBefore(txnDate, startDate) 
        ? new Date(startDate) 
        : addDays(txnDate, interval);
      
      // Align to the same day of month for monthly
      if (t.recurringFrequency === 'monthly') {
        const dayOfMonth = txnDate.getDate();
        nextDate = new Date(nextDate.getFullYear(), nextDate.getMonth(), dayOfMonth);
        if (isBefore(nextDate, startDate)) {
          nextDate = new Date(nextDate.getFullYear(), nextDate.getMonth() + 1, dayOfMonth);
        }
      }
      
      while (isBefore(nextDate, endDate) && paymentCount < maxPayments) {
        const withinEndDate = !recurringEndDate || isBefore(nextDate, recurringEndDate) || isSameDay(nextDate, recurringEndDate);
        
        if (withinEndDate) {
          const isLastPayment = 
            (recurringEndDate && isSameDay(nextDate, recurringEndDate)) ||
            (paymentCount + 1 === maxPayments);
          
          events.push({
            date: format(nextDate, 'yyyy-MM-dd'),
            type: 'expense' as const,
            description: isLastPayment ? `${t.title} (Final)` : t.title,
            amount: -t.amount,
            balanceAfter: 0,
            source: 'recurring',
            accountId: t.accountId,
            isLastPayment,
            endsOn: isLastPayment ? format(nextDate, 'yyyy-MM-dd') : undefined,
          });
          
          paymentCount++;
          
          // Add marker when payments end
          if (isLastPayment) {
            events.push({
              date: format(addDays(nextDate, 1), 'yyyy-MM-dd'),
              type: 'payment_ends',
              description: `${t.title} ends - no more payments`,
              amount: 0,
              balanceAfter: 0,
              source: 'projected',
            });
            break;
          }
        } else {
          break;
        }
        
        // Move to next occurrence
        if (t.recurringFrequency === 'weekly') {
          nextDate = addDays(nextDate, 7);
        } else if (t.recurringFrequency === 'monthly') {
          nextDate = new Date(nextDate.getFullYear(), nextDate.getMonth() + 1, txnDate.getDate());
        } else if (t.recurringFrequency === 'yearly') {
          nextDate = new Date(nextDate.getFullYear() + 1, txnDate.getMonth(), txnDate.getDate());
        }
      }
    }
  });
  
  return events;
}

/**
 * MAIN FORECAST FUNCTION
 * Generates complete cash flow forecast for the next N days
 */
export function generateForecast(
  startingCash: number,
  accounts: PaymentAccount[],
  incomeSources: IncomeSource[],
  transactions: Transaction[],
  safetyThreshold: number = DEFAULT_SAFETY_THRESHOLD,
  days: number = FORECAST_DAYS
): ForecastSummary {
  const today = startOfDay(new Date());
  const endDate = addDays(today, days);
  
  // Gather all events
  const billEvents = generateBillEvents(accounts, today, endDate);
  const incomeEvents = generateIncomeEvents(incomeSources, today, endDate);
  const txnEvents = transactionsToEvents(transactions, accounts, today, endDate);
  
  // Combine and sort by date
  const startingEvent: ForecastEvent = {
    date: format(today, 'yyyy-MM-dd'),
    type: 'starting_balance',
    description: 'Starting Balance',
    amount: 0,
    balanceAfter: startingCash,
    source: 'manual',
  };
  
  const allEvents: ForecastEvent[] = [
    startingEvent,
    ...billEvents,
    ...incomeEvents,
    ...txnEvents,
  ].sort((a, b) => a.date.localeCompare(b.date));
  
  // Calculate running balance
  let runningBalance = startingCash;
  let lowestBalance = startingCash;
  let lowestBalanceDate = format(today, 'yyyy-MM-dd');
  let totalIncome = 0;
  let totalExpenses = 0;
  let daysUntilUnsafe: number | null = null;
  
  allEvents.forEach((event, index) => {
    if (index === 0) {
      // Starting balance event
      event.balanceAfter = startingCash;
      return;
    }
    
    runningBalance += event.amount;
    event.balanceAfter = runningBalance;
    
    // Track lowest point
    if (runningBalance < lowestBalance) {
      lowestBalance = runningBalance;
      lowestBalanceDate = event.date;
    }
    
    // Track safety violations
    if (runningBalance < safetyThreshold) {
      event.isCritical = true;
      if (daysUntilUnsafe === null) {
        const eventDate = parseISO(event.date);
        daysUntilUnsafe = Math.ceil((eventDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
      }
    }
    
    // Track totals
    if (event.amount > 0) {
      totalIncome += event.amount;
    } else {
      totalExpenses += Math.abs(event.amount);
    }
  });
  
  return {
    startingBalance: startingCash,
    endingBalance: runningBalance,
    lowestBalance,
    lowestBalanceDate,
    safetyThreshold,
    daysUntilUnsafe,
    totalIncome,
    totalExpenses,
    events: allEvents,
  };
}

/**
 * Simulate spending impact
 * Returns what happens if user spends X amount today
 */
export function simulateSpending(
  forecast: ForecastSummary,
  spendAmount: number,
  spendDate: string = format(new Date(), 'yyyy-MM-dd')
): SpendingSimulation {
  // Create a new events array with the simulated spend
  const newEvents = [...forecast.events];
  
  // Find where to insert the new spend
  const insertIndex = newEvents.findIndex(e => e.date > spendDate);
  const simulatedEvent: ForecastEvent = {
    date: spendDate,
    type: 'expense',
    description: 'Simulated Spending',
    amount: -spendAmount,
    balanceAfter: 0,
    source: 'manual',
  };
  
  if (insertIndex === -1) {
    newEvents.push(simulatedEvent);
  } else {
    newEvents.splice(insertIndex, 0, simulatedEvent);
  }
  
  // Recalculate balances
  let runningBalance = forecast.startingBalance;
  let newLowestBalance = forecast.startingBalance;
  let newLowestDate = format(new Date(), 'yyyy-MM-dd');
  const affectedBills: string[] = [];
  
  newEvents.forEach((event, index) => {
    if (index === 0) {
      event.balanceAfter = runningBalance;
      return;
    }
    
    runningBalance += event.amount;
    event.balanceAfter = runningBalance;
    
    if (runningBalance < newLowestBalance) {
      newLowestBalance = runningBalance;
      newLowestDate = event.date;
    }
    
    // Check if this spend affects any bills
    if (event.type === 'bill' && runningBalance < 0) {
      affectedBills.push(event.description);
    }
  });
  
  // Determine risk level
  let riskLevel: 'safe' | 'caution' | 'unsafe' = 'safe';
  let daysUntilUnsafe: number | null = null;
  
  if (newLowestBalance < 0) {
    riskLevel = 'unsafe';
    // Find when it goes negative
    const unsafeEvent = newEvents.find(e => e.balanceAfter < 0);
    if (unsafeEvent) {
      const unsafeDate = parseISO(unsafeEvent.date);
      daysUntilUnsafe = Math.ceil((unsafeDate.getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24));
    }
  } else if (newLowestBalance < forecast.safetyThreshold) {
    riskLevel = 'caution';
    const cautionEvent = newEvents.find(e => e.balanceAfter < forecast.safetyThreshold);
    if (cautionEvent) {
      const cautionDate = parseISO(cautionEvent.date);
      daysUntilUnsafe = Math.ceil((cautionDate.getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24));
    }
  }
  
  return {
    amount: spendAmount,
    newLowestBalance,
    newLowestDate,
    violatesSafety: newLowestBalance < forecast.safetyThreshold,
    daysUntilUnsafe,
    riskLevel,
    affectedBills,
  };
}

/**
 * Prepare forecast data for AI interpretation
 * Structured summary that AI can explain
 */
export function prepareForecastForAI(forecast: ForecastSummary): string {
  const criticalEvents = forecast.events.filter(e => e.isCritical);
  const upcomingBills = forecast.events
    .filter(e => e.type === 'bill')
    .slice(0, 5);
  const upcomingIncome = forecast.events
    .filter(e => e.type === 'income')
    .slice(0, 3);
  
  return JSON.stringify({
    currentBalance: forecast.startingBalance,
    lowestBalance: forecast.lowestBalance,
    lowestBalanceDate: forecast.lowestBalanceDate,
    safetyThreshold: forecast.safetyThreshold,
    isBelowSafety: forecast.lowestBalance < forecast.safetyThreshold,
    daysUntilUnsafe: forecast.daysUntilUnsafe,
    totalUpcomingExpenses: forecast.totalExpenses,
    totalUpcomingIncome: forecast.totalIncome,
    netChange: forecast.totalIncome - forecast.totalExpenses,
    criticalDates: criticalEvents.map(e => ({
      date: e.date,
      description: e.description,
      balanceAfter: e.balanceAfter,
    })),
    upcomingBills: upcomingBills.map(e => ({
      date: e.date,
      description: e.description,
      amount: Math.abs(e.amount),
    })),
    upcomingIncome: upcomingIncome.map(e => ({
      date: e.date,
      description: e.description,
      amount: e.amount,
    })),
  }, null, 2);
}

/**
 * Prepare comprehensive user context for AI
 * Includes budgets, goals, debts, and all financial data
 */
export interface AIUserContext {
  forecast: ForecastSummary;
  budgets?: {
    categoryId: string;
    monthlyLimit: number;
    spent: number;
    remaining: number;
    percentUsed: number;
    isOverBudget: boolean;
  }[];
  savingsGoals?: {
    name: string;
    targetAmount: number;
    currentAmount: number;
    percentComplete: number;
    targetDate?: string;
  }[];
  debts?: {
    name: string;
    balance: number;
    apr: number;
    minimumPayment: number;
  }[];
  accounts?: {
    name: string;
    type: string;
    balance: number;
  }[];
  incomeSources?: {
    name: string;
    amount: number;
    frequency: string;
  }[];
  emergencyFund?: {
    monthsOfRunway: number;
    goal: number;
    current: number;
  };
}

export function prepareFullContextForAI(context: AIUserContext): string {
  const { forecast, budgets, savingsGoals, debts, accounts, incomeSources, emergencyFund } = context;
  
  const criticalEvents = forecast.events.filter(e => e.isCritical);
  const upcomingBills = forecast.events.filter(e => e.type === 'bill').slice(0, 5);
  const upcomingIncome = forecast.events.filter(e => e.type === 'income').slice(0, 3);
  
  return JSON.stringify({
    // Core Forecast
    forecast: {
      currentBalance: forecast.startingBalance,
      endingBalance: forecast.endingBalance,
      lowestBalance: forecast.lowestBalance,
      lowestBalanceDate: forecast.lowestBalanceDate,
      safetyThreshold: forecast.safetyThreshold,
      isBelowSafety: forecast.lowestBalance < forecast.safetyThreshold,
      daysUntilUnsafe: forecast.daysUntilUnsafe,
      totalUpcomingExpenses: forecast.totalExpenses,
      totalUpcomingIncome: forecast.totalIncome,
      netChange: forecast.totalIncome - forecast.totalExpenses,
    },
    
    // Critical Dates
    criticalDates: criticalEvents.slice(0, 5).map(e => ({
      date: e.date,
      description: e.description,
      balanceAfter: e.balanceAfter,
    })),
    
    // Upcoming Events
    upcomingBills: upcomingBills.map(e => ({
      date: e.date,
      description: e.description,
      amount: Math.abs(e.amount),
    })),
    upcomingIncome: upcomingIncome.map(e => ({
      date: e.date,
      description: e.description,
      amount: e.amount,
    })),
    
    // Budgets (if set)
    budgets: budgets && budgets.length > 0 ? {
      totalBudgeted: budgets.reduce((sum, b) => sum + b.monthlyLimit, 0),
      totalSpent: budgets.reduce((sum, b) => sum + b.spent, 0),
      categoriesOverBudget: budgets.filter(b => b.isOverBudget).map(b => b.categoryId),
      atRiskCategories: budgets.filter(b => b.percentUsed >= 80 && !b.isOverBudget).map(b => b.categoryId),
      details: budgets.slice(0, 5),
    } : null,
    
    // Savings Goals (if any)
    savingsGoals: savingsGoals && savingsGoals.length > 0 ? {
      totalTargetAmount: savingsGoals.reduce((sum, g) => sum + g.targetAmount, 0),
      totalCurrentAmount: savingsGoals.reduce((sum, g) => sum + g.currentAmount, 0),
      overallProgress: savingsGoals.length > 0 
        ? (savingsGoals.reduce((sum, g) => sum + g.currentAmount, 0) / savingsGoals.reduce((sum, g) => sum + g.targetAmount, 0)) * 100
        : 0,
      goals: savingsGoals.slice(0, 3),
    } : null,
    
    // Debts (if any)
    debts: debts && debts.length > 0 ? {
      totalDebt: debts.reduce((sum, d) => sum + d.balance, 0),
      totalMinimumPayments: debts.reduce((sum, d) => sum + d.minimumPayment, 0),
      highestAPR: Math.max(...debts.map(d => d.apr)),
      numberOfDebts: debts.length,
      details: debts,
    } : null,
    
    // Accounts Summary
    accounts: accounts && accounts.length > 0 ? {
      cashAccounts: accounts.filter(a => a.type === 'bank_account' || a.type === 'debit_card' || a.type === 'cash').length,
      creditAccounts: accounts.filter(a => a.type === 'credit_card').length,
      loanAccounts: accounts.filter(a => a.type === 'personal_loan').length,
      totalCash: accounts.filter(a => a.type === 'bank_account' || a.type === 'debit_card' || a.type === 'cash').reduce((sum, a) => sum + a.balance, 0),
      totalCreditUsed: accounts.filter(a => a.type === 'credit_card').reduce((sum, a) => sum + a.balance, 0),
    } : null,
    
    // Income Summary
    income: incomeSources && incomeSources.length > 0 ? {
      numberOfSources: incomeSources.length,
      estimatedMonthlyIncome: incomeSources.reduce((sum, i) => {
        if (i.frequency === 'monthly') return sum + i.amount;
        if (i.frequency === 'biweekly') return sum + (i.amount * 2);
        if (i.frequency === 'weekly') return sum + (i.amount * 4);
        if (i.frequency === 'yearly') return sum + (i.amount / 12);
        return sum;
      }, 0),
      sources: incomeSources,
    } : null,
    
    // Emergency Fund Status
    emergencyFund: emergencyFund || null,
    
  }, null, 2);
}

/**
 * Generate account-specific forecast
 * Shows how a specific account balance will change over time,
 * including credit card payments from checking accounts
 */
export function generateAccountForecast(
  account: PaymentAccount,
  allAccounts: PaymentAccount[],
  incomeSources: IncomeSource[],
  transactions: Transaction[],
  safetyThreshold: number = DEFAULT_SAFETY_THRESHOLD,
  days: number = FORECAST_DAYS
): AccountForecast {
  const today = startOfDay(new Date());
  const endDate = addDays(today, days);
  const events: ForecastEvent[] = [];
  
  // Starting balance event
  events.push({
    date: format(today, 'yyyy-MM-dd'),
    type: 'starting_balance',
    description: `${account.name} Starting Balance`,
    amount: 0,
    balanceAfter: account.balance,
    source: 'manual',
    accountId: account.id,
  });
  
  // For checking/bank accounts, include:
  // 1. Income deposits
  // 2. Credit card payments (expenses from this account)
  // 3. Transactions linked to this account
  // 4. Loan payments if paid from this account
  
  if (account.type === 'bank_account' || account.type === 'debit_card') {
    // Add income events
    incomeSources.filter(inc => inc.isActive).forEach(income => {
      let currentDate = new Date(today);
      
      while (isBefore(currentDate, endDate)) {
        let payDate: Date | null = null;
        
        if (income.frequency === 'monthly' && income.payDate) {
          const month = currentDate.getMonth();
          const year = currentDate.getFullYear();
          payDate = new Date(year, month, income.payDate);
          
          if (isBefore(payDate, today)) {
            payDate = new Date(year, month + 1, income.payDate);
          }
          
          if (isAfter(payDate, today) && isBefore(payDate, endDate)) {
            events.push({
              date: format(payDate, 'yyyy-MM-dd'),
              type: 'income',
              description: income.name,
              amount: income.amount,
              balanceAfter: 0,
              source: 'recurring',
              accountId: account.id,
            });
          }
          
          currentDate = new Date(payDate.getFullYear(), payDate.getMonth() + 1, 1);
        } else if (income.frequency === 'biweekly') {
          const baseDay = income.payDate || 15;
          let payDay = new Date(today.getFullYear(), today.getMonth(), baseDay);
          
          if (isBefore(payDay, today)) {
            payDay = addDays(payDay, 14);
          }
          
          while (isBefore(payDay, endDate)) {
            if (isAfter(payDay, today)) {
              events.push({
                date: format(payDay, 'yyyy-MM-dd'),
                type: 'income',
                description: income.name,
                amount: income.amount,
                balanceAfter: 0,
                source: 'recurring',
                accountId: account.id,
              });
            }
            payDay = addDays(payDay, 14);
          }
          break;
        } else {
          break;
        }
      }
    });
    
    // Add credit card payment events (money going OUT of checking to pay credit cards)
    allAccounts
      .filter(a => a.type === 'credit_card' && a.dueDate && a.paymentFromAccountId === account.id)
      .forEach(card => {
        let currentDate = new Date(today);
        
        while (isBefore(currentDate, endDate)) {
          const month = currentDate.getMonth();
          const year = currentDate.getFullYear();
          const dueDate = new Date(year, month, card.dueDate!);
          
          if (isAfter(dueDate, today) && isBefore(dueDate, endDate)) {
            // Calculate expected payment (current balance + estimated spending)
            const estimatedPayment = card.balance || 0;
            
            events.push({
              date: format(dueDate, 'yyyy-MM-dd'),
              type: 'credit_card_payment',
              description: `Pay ${card.name}`,
              amount: -estimatedPayment,
              balanceAfter: 0,
              source: 'recurring',
              accountId: account.id,
              relatedAccountId: card.id,
              relatedAccountName: card.name,
            });
          }
          
          currentDate = new Date(year, month + 1, 1);
        }
      });
    
    // Add loan payments if paid from this account
    allAccounts
      .filter(a => a.type === 'personal_loan' && a.monthlyPayment && a.dueDate && a.paymentFromAccountId === account.id)
      .forEach(loan => {
        let currentDate = new Date(today);
        
        while (isBefore(currentDate, endDate)) {
          const month = currentDate.getMonth();
          const year = currentDate.getFullYear();
          const dueDate = new Date(year, month, loan.dueDate!);
          
          if (isAfter(dueDate, today) && isBefore(dueDate, endDate)) {
            events.push({
              date: format(dueDate, 'yyyy-MM-dd'),
              type: 'bill',
              description: `${loan.name} Payment`,
              amount: -(loan.monthlyPayment || 0),
              balanceAfter: 0,
              source: 'recurring',
              accountId: account.id,
              relatedAccountId: loan.id,
              relatedAccountName: loan.name,
            });
          }
          
          currentDate = new Date(year, month + 1, 1);
        }
      });
  }
  
  // For credit cards, show spending and incoming payments
  if (account.type === 'credit_card') {
    // Add transactions made on this credit card
    transactions
      .filter(t => t.accountId === account.id)
      .filter(t => {
        const txnDate = parseISO(t.date);
        return isAfter(txnDate, today) && isBefore(txnDate, endDate);
      })
      .forEach(t => {
        events.push({
          date: t.date.split('T')[0],
          type: 'expense',
          description: t.title,
          amount: t.type === 'expense' ? t.amount : -t.amount, // Credit card: spending increases balance (positive)
          balanceAfter: 0,
          source: 'manual',
          accountId: account.id,
        });
      });
    
    // Show when payment is due
    if (account.dueDate) {
      let currentDate = new Date(today);
      
      while (isBefore(currentDate, endDate)) {
        const month = currentDate.getMonth();
        const year = currentDate.getFullYear();
        const dueDate = new Date(year, month, account.dueDate!);
        
        if (isAfter(dueDate, today) && isBefore(dueDate, endDate)) {
          const payingAccount = allAccounts.find(a => a.id === account.paymentFromAccountId);
          
          events.push({
            date: format(dueDate, 'yyyy-MM-dd'),
            type: 'income', // Payment reduces credit card balance (like income)
            description: `Payment from ${payingAccount?.name || 'Bank Account'}`,
            amount: -(account.balance || 0), // Reduces balance
            balanceAfter: 0,
            source: 'recurring',
            accountId: account.id,
            relatedAccountId: account.paymentFromAccountId,
            relatedAccountName: payingAccount?.name,
          });
        }
        
        currentDate = new Date(year, month + 1, 1);
      }
    }
  }
  
  // Add account-linked transactions
  transactions
    .filter(t => t.accountId === account.id && account.type !== 'credit_card')
    .filter(t => {
      const txnDate = parseISO(t.date);
      return isAfter(txnDate, today) && isBefore(txnDate, endDate);
    })
    .forEach(t => {
      events.push({
        date: t.date.split('T')[0],
        type: t.type === 'income' ? 'income' : 'expense',
        description: t.title,
        amount: t.type === 'income' ? t.amount : -t.amount,
        balanceAfter: 0,
        source: 'manual',
        accountId: account.id,
      });
    });
  
  // Sort events by date
  events.sort((a, b) => a.date.localeCompare(b.date));
  
  // Calculate running balance
  let runningBalance = account.balance;
  let lowestBalance = account.balance;
  let lowestBalanceDate = format(today, 'yyyy-MM-dd');
  let totalIncome = 0;
  let totalExpenses = 0;
  let daysUntilUnsafe: number | null = null;
  
  events.forEach((event, index) => {
    if (index === 0) {
      event.balanceAfter = account.balance;
      return;
    }
    
    runningBalance += event.amount;
    event.balanceAfter = runningBalance;
    
    if (event.amount > 0) {
      totalIncome += event.amount;
    } else {
      totalExpenses += Math.abs(event.amount);
    }
    
    if (runningBalance < lowestBalance) {
      lowestBalance = runningBalance;
      lowestBalanceDate = event.date;
    }
    
    // Check safety threshold (only for checking/bank accounts)
    if ((account.type === 'bank_account' || account.type === 'debit_card') && 
        runningBalance < safetyThreshold && daysUntilUnsafe === null) {
      const eventDate = parseISO(event.date);
      daysUntilUnsafe = Math.ceil((eventDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
    }
    
    event.isCritical = (account.type === 'bank_account' || account.type === 'debit_card') && 
                       runningBalance < safetyThreshold;
  });
  
  // Get credit card payments for this account (if it's a checking account)
  const creditCardPayments = (account.type === 'bank_account' || account.type === 'debit_card')
    ? allAccounts
        .filter(a => a.type === 'credit_card' && a.paymentFromAccountId === account.id && a.dueDate)
        .map(card => ({
          cardId: card.id,
          cardName: card.name,
          amount: card.balance || 0,
          dueDate: (() => {
            const today = new Date();
            const dueDay = card.dueDate!;
            let dueDate = new Date(today.getFullYear(), today.getMonth(), dueDay);
            if (isBefore(dueDate, today)) {
              dueDate = new Date(today.getFullYear(), today.getMonth() + 1, dueDay);
            }
            return format(dueDate, 'yyyy-MM-dd');
          })(),
        }))
    : undefined;
  
  return {
    accountId: account.id,
    accountName: account.name,
    accountType: account.type,
    currentBalance: account.balance,
    forecast: {
      startingBalance: account.balance,
      endingBalance: runningBalance,
      lowestBalance,
      lowestBalanceDate,
      safetyThreshold,
      daysUntilUnsafe,
      totalIncome,
      totalExpenses,
      events,
      accountId: account.id,
      accountName: account.name,
    },
    creditCardPayments,
  };
}

/**
 * Get all account forecasts for dropdown selection
 */
export function getAllAccountForecasts(
  accounts: PaymentAccount[],
  incomeSources: IncomeSource[],
  transactions: Transaction[],
  safetyThreshold: number = DEFAULT_SAFETY_THRESHOLD,
  days: number = FORECAST_DAYS
): AccountForecast[] {
  // Only generate forecasts for checking/savings/debit accounts (and credit cards for their own view)
  return accounts
    .filter(a => a.type === 'bank_account' || a.type === 'debit_card' || a.type === 'credit_card')
    .map(account => generateAccountForecast(
      account,
      accounts,
      incomeSources,
      transactions,
      safetyThreshold,
      days
    ));
}

