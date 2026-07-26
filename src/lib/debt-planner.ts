/**
 * Debt Payoff Planner
 * 
 * Implements snowball and avalanche debt payoff strategies.
 * All calculations are deterministic - AI only explains results.
 */

import { 
  PaymentAccount, 
  DebtPayoffStrategy, 
  DebtPayoffPlan, 
  DebtPayoffItem,
  DebtAccount 
} from '@/types';
import { addMonths, format } from 'date-fns';
import { currentOf } from '@/lib/accounts';

/**
 * Convert PaymentAccount to DebtAccount (for planning)
 */
export function accountsToDebts(accounts: PaymentAccount[]): DebtAccount[] {
  return accounts
    .filter(a => 
      (a.type === 'credit_card' || a.type === 'personal_loan') && 
      currentOf(a) > 0
    )
    .map(a => ({
      id: a.id,
      name: a.name,
      balance: currentOf(a),
      apr: a.apr || 0,
      minimumPayment: a.type === 'credit_card' 
        ? Math.max(25, currentOf(a) * 0.02) // 2% or $25 minimum for cards
        : (a.monthlyPayment || Math.max(50, currentOf(a) * 0.03)), // Loan payment or estimate
      dueDate: a.dueDate || 1,
    }));
}

/**
 * Calculate monthly interest for a debt
 */
function calculateMonthlyInterest(balance: number, apr: number): number {
  return balance * (apr / 100 / 12);
}

/**
 * Simulate minimum payments only (baseline for comparison)
 */
export function simulateMinimumPayments(debts: DebtAccount[]): {
  totalMonths: number;
  totalInterest: number;
} {
  const balances = debts.map(d => d.balance);
  let totalInterest = 0;
  let months = 0;
  const maxMonths = 360; // 30 years cap
  
  while (balances.some(b => b > 0) && months < maxMonths) {
    months++;
    
    debts.forEach((debt, i) => {
      if (balances[i] <= 0) return;
      
      // Add interest
      const interest = calculateMonthlyInterest(balances[i], debt.apr);
      totalInterest += interest;
      balances[i] += interest;
      
      // Apply minimum payment
      const payment = Math.min(debt.minimumPayment, balances[i]);
      balances[i] -= payment;
      
      if (balances[i] < 0.01) balances[i] = 0;
    });
  }
  
  return { totalMonths: months, totalInterest };
}

/**
 * Generate debt payoff plan using specified strategy
 */
export function generateDebtPayoffPlan(
  debts: DebtAccount[],
  strategy: DebtPayoffStrategy,
  extraMonthlyPayment: number
): DebtPayoffPlan {
  if (debts.length === 0) {
    return {
      strategy,
      extraMonthlyPayment,
      debts: [],
      totalInterestPaid: 0,
      totalMonths: 0,
      interestSaved: 0,
    };
  }
  
  // Sort debts based on strategy
  const sortedDebts = [...debts].sort((a, b) => {
    if (strategy === 'snowball') {
      // Smallest balance first
      return a.balance - b.balance;
    } else {
      // Highest APR first (avalanche)
      return b.apr - a.apr;
    }
  });
  
  // Track balances and results
  const balances = sortedDebts.map(d => d.balance);
  const interestPaid = sortedDebts.map(() => 0);
  const payoffMonths = sortedDebts.map(() => 0);
  const today = new Date();
  
  let currentMonth = 0;
  const maxMonths = 360;
  let extraAvailable = extraMonthlyPayment;
  
  while (balances.some(b => b > 0) && currentMonth < maxMonths) {
    currentMonth++;
    let monthlyExtra = extraAvailable;
    
    // Process each debt
    sortedDebts.forEach((debt, i) => {
      if (balances[i] <= 0) return;
      
      // Add interest
      const interest = calculateMonthlyInterest(balances[i], debt.apr);
      interestPaid[i] += interest;
      balances[i] += interest;
      
      // Apply minimum payment
      let payment = Math.min(debt.minimumPayment, balances[i]);
      balances[i] -= payment;
      
      // If this is the focus debt (first with balance), apply extra
      const focusDebtIndex = balances.findIndex(b => b > 0);
      if (i === focusDebtIndex && monthlyExtra > 0) {
        const extraApplied = Math.min(monthlyExtra, balances[i]);
        balances[i] -= extraApplied;
        monthlyExtra -= extraApplied;
      }
      
      if (balances[i] < 0.01) {
        balances[i] = 0;
        if (payoffMonths[i] === 0) {
          payoffMonths[i] = currentMonth;
          // Freed up minimum payment becomes extra for next debt
          extraAvailable += debt.minimumPayment;
        }
      }
    });
  }
  
  // Build result
  const payoffItems: DebtPayoffItem[] = sortedDebts.map((debt, i) => ({
    accountId: debt.id,
    accountName: debt.name,
    originalBalance: debt.balance,
    apr: debt.apr,
    payoffOrder: i + 1,
    payoffDate: format(addMonths(today, payoffMonths[i] || currentMonth), 'yyyy-MM-dd'),
    totalInterestPaid: Math.round(interestPaid[i] * 100) / 100,
    monthsToPayoff: payoffMonths[i] || currentMonth,
  }));
  
  const totalInterestPaid = interestPaid.reduce((sum, i) => sum + i, 0);
  
  // Calculate interest saved vs minimum payments
  const baseline = simulateMinimumPayments(debts);
  const interestSaved = Math.max(0, baseline.totalInterest - totalInterestPaid);
  
  return {
    strategy,
    extraMonthlyPayment,
    debts: payoffItems,
    totalInterestPaid: Math.round(totalInterestPaid * 100) / 100,
    totalMonths: currentMonth,
    interestSaved: Math.round(interestSaved * 100) / 100,
  };
}

/**
 * Compare both strategies
 */
export function compareStrategies(
  debts: DebtAccount[],
  extraMonthlyPayment: number
): {
  snowball: DebtPayoffPlan;
  avalanche: DebtPayoffPlan;
  recommendation: DebtPayoffStrategy;
  savingsDifference: number;
  monthsDifference: number;
} {
  const snowball = generateDebtPayoffPlan(debts, 'snowball', extraMonthlyPayment);
  const avalanche = generateDebtPayoffPlan(debts, 'avalanche', extraMonthlyPayment);
  
  const savingsDifference = avalanche.interestSaved - snowball.interestSaved;
  const monthsDifference = snowball.totalMonths - avalanche.totalMonths;
  
  // Recommend avalanche if it saves significant money, otherwise snowball for motivation
  const recommendation: DebtPayoffStrategy = 
    savingsDifference > 100 ? 'avalanche' : 'snowball';
  
  return {
    snowball,
    avalanche,
    recommendation,
    savingsDifference,
    monthsDifference,
  };
}

/**
 * Get debt-free date
 */
export function getDebtFreeDate(plan: DebtPayoffPlan): string {
  if (plan.debts.length === 0) return format(new Date(), 'yyyy-MM-dd');
  
  const lastPayoff = plan.debts.reduce((latest, d) => 
    d.monthsToPayoff > latest ? d.monthsToPayoff : latest, 0
  );
  
  return format(addMonths(new Date(), lastPayoff), 'MMMM yyyy');
}

/**
 * Calculate impact of extra payment on forecast
 */
export function simulateExtraPaymentImpact(
  currentCash: number,
  extraPayment: number,
  plan: DebtPayoffPlan
): {
  monthlyImpact: number;
  safetyImpact: boolean;
  yearlyImpact: number;
  benefitRatio: number; // Interest saved per dollar spent
} {
  const monthlyImpact = -extraPayment;
  const safetyImpact = currentCash - extraPayment < 500; // Below typical safety
  const yearlyImpact = extraPayment * 12;
  
  // Calculate benefit ratio
  const benefitRatio = plan.totalMonths > 0 
    ? plan.interestSaved / (extraPayment * plan.totalMonths)
    : 0;
  
  return {
    monthlyImpact,
    safetyImpact,
    yearlyImpact,
    benefitRatio: Math.round(benefitRatio * 100) / 100,
  };
}

/**
 * Get summary for AI explanation
 */
export function getPlanSummaryForAI(plan: DebtPayoffPlan): string {
  if (plan.debts.length === 0) {
    return 'No debts to pay off.';
  }
  
  return JSON.stringify({
    strategy: plan.strategy,
    extraMonthlyPayment: plan.extraMonthlyPayment,
    numberOfDebts: plan.debts.length,
    totalDebt: plan.debts.reduce((sum, d) => sum + d.originalBalance, 0),
    totalInterestToPay: plan.totalInterestPaid,
    interestSaved: plan.interestSaved,
    debtFreeIn: `${plan.totalMonths} months`,
    debtFreeDate: getDebtFreeDate(plan),
    payoffOrder: plan.debts.map(d => ({
      name: d.accountName,
      balance: d.originalBalance,
      apr: d.apr,
      payoffMonth: d.monthsToPayoff,
    })),
  }, null, 2);
}


