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
      // #77: undefined means the owner never entered a rate — null keeps that
      // distinguishable from an explicitly-entered 0% (e.g. a promo card) all
      // the way to render. Never fabricate an unset rate as 0.
      apr: a.apr ?? null,
      minimumPayment: a.type === 'credit_card'
        ? Math.max(25, currentOf(a) * 0.02) // 2% or $25 minimum for cards
        : (a.monthlyPayment || Math.max(50, currentOf(a) * 0.03)), // Loan payment or estimate
      dueDate: a.dueDate || 1,
    }));
}

/**
 * Calculate monthly interest for a debt.
 *
 * ponytail: apr === null is treated as 0 ONLY to advance the simulation clock
 * (a balance has to move forward somehow to produce an order/schedule) — it is
 * never surfaced as a fact. Every caller that displays a number derived from
 * this must gate on DebtPayoffPlan.hasUnknownApr / DebtPayoffItem.apr first.
 */
function calculateMonthlyInterest(balance: number, apr: number | null): number {
  return balance * ((apr ?? 0) / 100 / 12);
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
      hasUnknownApr: false,
    };
  }

  // #77: any debt with no entered rate taints every interest-derived figure
  // this plan produces — Total Interest, Interest Saved, Debt-Free Date must
  // all refuse to compute (see the return below and getDebtFreeDate).
  const hasUnknownApr = debts.some(d => d.apr === null);

  // Sort debts based on strategy
  const sortedDebts = [...debts].sort((a, b) => {
    if (strategy === 'snowball') {
      // Smallest balance first
      return a.balance - b.balance;
    } else {
      // Highest APR first (avalanche). Ordering-only heuristic when apr is
      // unknown — never displayed as the rate itself (see hasUnknownApr).
      return (b.apr ?? 0) - (a.apr ?? 0);
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
    // #77: this debt's OWN interest figure is fabricated if its OWN rate is
    // unknown, regardless of whether siblings have a rate.
    totalInterestPaid: debt.apr === null ? null : Math.round(interestPaid[i] * 100) / 100,
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
    totalInterestPaid: hasUnknownApr ? null : Math.round(totalInterestPaid * 100) / 100,
    totalMonths: currentMonth,
    interestSaved: hasUnknownApr ? null : Math.round(interestSaved * 100) / 100,
    hasUnknownApr,
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
  recommendation: DebtPayoffStrategy | null;
  savingsDifference: number | null;
  monthsDifference: number;
} {
  const snowball = generateDebtPayoffPlan(debts, 'snowball', extraMonthlyPayment);
  const avalanche = generateDebtPayoffPlan(debts, 'avalanche', extraMonthlyPayment);

  // #77: avalanche vs snowball is a choice made BY interest savings — if that
  // figure can't be computed (any debt's rate is unknown), the choice can't
  // be recommended either. Never fall back to "snowball" as if that were a
  // real comparison result.
  const savingsDifference = (avalanche.interestSaved === null || snowball.interestSaved === null)
    ? null
    : avalanche.interestSaved - snowball.interestSaved;
  const monthsDifference = snowball.totalMonths - avalanche.totalMonths;

  const recommendation: DebtPayoffStrategy | null =
    savingsDifference === null ? null : (savingsDifference > 100 ? 'avalanche' : 'snowball');

  return {
    snowball,
    avalanche,
    recommendation,
    savingsDifference,
    monthsDifference,
  };
}

/**
 * Get debt-free date. Returns null when the plan cannot honestly claim one —
 * #77: any included debt with no entered rate makes the payoff date a guess,
 * not a fact.
 */
export function getDebtFreeDate(plan: DebtPayoffPlan): string | null {
  if (plan.debts.length === 0) return format(new Date(), 'yyyy-MM-dd');
  if (plan.hasUnknownApr) return null;

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
  
  // ponytail: this function has no caller in the app today (verified via grep) —
  // 0 when interestSaved is unknown is a placeholder, not a claim of "no
  // benefit". If this gets a UI consumer, gate on plan.hasUnknownApr the same
  // way DebtPlannerPanel does instead of trusting benefitRatio at face value.
  const benefitRatio = plan.totalMonths > 0 && plan.interestSaved !== null
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


