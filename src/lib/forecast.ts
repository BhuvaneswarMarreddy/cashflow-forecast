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
import { isPositive, classifyTransaction, interpretTransaction, isPosted, IncomeContext } from '@/lib/classify';
import { currentOf } from '@/lib/accounts';
import { buildAssumptions, behaviorEvents, AssumptionOverrides } from '@/lib/behavior';
import { normalizeMerchant } from '@/lib/flows';

const DEFAULT_SAFETY_THRESHOLD = 500;
const FORECAST_DAYS = 90;

/**
 * Calculate current available cash from all accounts
 */
/**
 * Average monthly EARNED income and spending over the last `months` FULL calendar
 * months (the current partial month is excluded). Transfers are ignored (classifier).
 *
 * FIN-INCOME-001 replaced the old rule here. It preferred rows whose `sourceCategory`
 * was the literal `'Paychecks'` (or whose text matched /payroll|paycheck/i) and
 * otherwise summed EVERY income-classified row — so a refund, a Zelle from a friend
 * or a one-off deposit inflated "Monthly Income". Now a row counts only when
 * interpretTransaction() resolves it to `earned_income`, i.e. it matched an active
 * approved source in `users/{uid}/income` or the owner confirmed it. No approved
 * sources configured means an income of 0, which is the honest answer rather than a
 * flattering one.
 */
export function monthlyAverages(
  transactions: Transaction[], accounts: PaymentAccount[], months = 6, income: IncomeContext
): { income: number; spending: number } {
  const now = new Date();
  const window = new Set<string>();
  for (let i = 1; i <= months; i++) {
    window.add(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)).toISOString().slice(0, 7));
  }
  let inc = 0, sp = 0;
  /**
   * Months inside the window that the user was actually present for. This is the
   * divisor, and it is NOT `months`.
   *
   * Dividing by the window understated burn for anyone whose history is shorter
   * than it: ten weeks of data over a 6-month window divided spending by six.
   * Runway is cash ÷ burn, so the same mistake overstated runway ~2.3× — the
   * direction that tells someone they have more cushion than they do. A
   * five-persona review caught it as "Monthly Expenses $1,060" on a household
   * paying $1,850 of rent.
   *
   * A month with no rows because nothing happened is a real zero and still
   * counts — it is spanned by the earliest observation. A month before the
   * user's history begins is not an observation of zero; it is missing data.
   */
  const observed = new Set<string>();
  for (const t of transactions) {
    const month = t.date.split('T')[0].slice(0, 7);
    if (!window.has(month)) continue;
    // PENDING: excluded — this is the settled-history baseline the forecast
    // projects forward, and a hold is not settled history.
    if (!isPosted(t)) continue;
    // Recorded before classification: a month containing only transfers is still
    // a month the user was here, and skipping it would restore the over-estimate
    // through a side door.
    observed.add(month);
    const i = interpretTransaction(t, accounts, income);
    if (i.income === 'counted') inc += t.amount;
    else if (i.expense === 'counted') sp += t.amount;
  }

  if (observed.size === 0) return { income: 0, spending: 0 };

  // Span from the earliest observed month to the most recent one in the window,
  // so quiet months inside a user's real history are counted and months before
  // it are not.
  const sorted = [...observed].sort();
  const first = sorted[0];
  const latest = [...window].sort().pop()!;
  const span = monthsBetweenInclusive(first, latest);
  const divisor = Math.min(Math.max(span, 1), months);

  return { income: Math.round(inc / divisor), spending: Math.round(sp / divisor) };
}

/** Inclusive count of calendar months from one `YYYY-MM` to another. */
function monthsBetweenInclusive(from: string, to: string): number {
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm) + 1;
}

export function calculateCurrentCash(accounts: PaymentAccount[]): number {
  return accounts
    .filter(a => a.type === 'bank_account' || a.type === 'debit_card' || a.type === 'cash')
    .reduce((sum, a) => sum + currentOf(a), 0);
}

/**
 * Derive an account's CURRENT balance from its own PAST transactions.
 * currentOf(account) is treated as an OPENING balance (0 for auto-created accounts,
 * which yields pure derivation). Future/projected rows are the forecast, not the
 * balance, so they are excluded here using the same today-boundary the forecast uses.
 */
export function deriveAccountBalance(
  account: PaymentAccount,
  transactions: Transaction[],
  policy: IncomeContext
): number {
  const includePending = policy?.includePending ?? false;
  const todayKey = format(new Date(), 'yyyy-MM-dd');
  const openingKey = account.openingDate || '0000-00-00';
  const isDebt = account.type === 'credit_card' || account.type === 'personal_loan';
  const net = transactions.reduce((sum, t) => {
    if (t.accountId !== account.id) return sum;
    // PENDING: excluded by DEFAULT. The anchor this is added to is the provider's POSTED
    // balance (simplefin.py re-anchors from `balance`, not available-balance), so
    // folding holds in here counts the same money twice and moves the hero number.
    // `includePending` is the owner's explicit "show me the balance once these clear"
    // view — opt-in only, and never the number any total or forecast reads.
    if (!isPosted(t) && !includePending) return sum;
    // Compare calendar days, not instants (IST timezone; see git history).
    const day = t.date.split('T')[0];
    if (day > todayKey) return sum;   // future = forecast, not current balance
    if (day < openingKey) return sum; // pre-anchor = already inside openingBalance
    return sum + (isPositive(t, [account]) ? t.amount : -t.amount);
  }, 0);
  const opening = account.openingBalance || 0;
  // Debt is stored as a positive amount owed: a purchase (signedEffect < 0) raises it,
  // a payment (signedEffect > 0) lowers it — the opposite sign to a cash account.
  return isDebt ? opening - net : opening + net;
}

/**
 * Attaches a DERIVED currentBalance to each account: openingBalance ± net of the
 * account's transactions dated on/after openingDate (the dated anchor set by reconcile).
 * currentBalance is the everyday hero number; openingBalance/openingDate are the stored
 * anchor. Callers showing "current" read currentBalance; callers showing/editing the
 * anchor read openingBalance. This is O(accounts × transactions) — CALLERS MUST MEMOIZE.
 */
export function withDerivedBalances(
  accounts: PaymentAccount[],
  transactions: Transaction[],
  policy: IncomeContext
): PaymentAccount[] {
  return accounts.map((a) => ({ ...a, currentBalance: deriveAccountBalance(a, transactions, policy) }));
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

  // NOTE: no synthetic credit-card payment here. Card payments are recorded as real
  // transfer transactions (bank -> card), which already move the forecast. Once account
  // balances are DERIVED from those transactions, a card with debt would otherwise fire
  // a synthetic full-balance payment on top of the recorded transfer — double-counting
  // the same money. To project a FUTURE card payment, record it as a (recurring) transfer.
  // ponytail: this assumes the user records card payments (the app's transfer-based model);
  // a smarter projection would be one recurring payment gated on "no real payment this cycle".

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
  endDate: Date,
  // Merchants the behavior engine already projects as fixed bills (normalized keys).
  // Their FUTURE recurring projections are suppressed here to avoid double-counting;
  // past real transactions keep flowing through unchanged.
  suppressRecurringFor?: Set<string>,
  income?: IncomeContext
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
    // The shared interpretation decides income/spending — not the stored type.
    // It already excludes a card-payment leg (either side) and any pending hold,
    // which is what the hand-rolled isCreditCardPayment test below used to approximate
    // for the card side only.
    // FIN-INCOME-001: `i.income` is now the EARNED-income gate, so an unknown inflow
    // dated in the future no longer becomes a projected income event.
    const i = interpretTransaction(t, accounts, income);
    const isActualIncome = i.income === 'counted' && !t.isProjected;
    // This forecast tracks the CASH pool (calculateCurrentCash excludes credit cards),
    // so a transfer is only invisible to it when both legs sit inside that pool. A
    // transfer out of checking — to a card, to savings the user has not set up, to an
    // external Zelle recipient — is real money leaving and must be counted.
    // A transfer sitting ON a card is not cash and is skipped by the same test.
    //
    // ponytail: no attempt to suppress a transfer that generateBillEvents also
    // synthesises. Only FUTURE-dated rows reach this branch (see the isAfter test
    // below) and imported statements are historical, so the overlap needs a
    // hand-entered future card payment to occur — and over-counting an outflow is the
    // safe direction for a runway. Suppress it here if that ever stops being true.
    const transferAccount = t.accountId ? accounts.find(a => a.id === t.accountId) : undefined;
    // POSTED ONLY, in both modes: this is the recurrence/behaviour baseline the forecast
    // projects FORWARD, and FIN-PENDING-001 stops at state. A hold projected as a repeating
    // obligation would keep firing long after the single charge behind it settled.
    const isCountableTransfer =
      i.type === 'transfer' &&
      isPosted(t) &&
      !!transferAccount &&
      transferAccount.type !== 'credit_card' &&
      transferAccount.type !== 'personal_loan';

    const shouldInclude = i.expense === 'counted' || isActualIncome || isCountableTransfer;

    if (shouldInclude && isAfter(txnDate, startDate) && isBefore(txnDate, endDate)) {
      // A transfer's direction decides its sign. isPositive() resolves it from the
      // title ("transfer from", deposits) when transferDirection is absent, which is
      // the same rule every UI surface uses — the forecast must not disagree.
      const signedAmount = isCountableTransfer
        ? (isPositive(t, accounts) ? t.amount : -t.amount)
        : (i.type === 'income' ? t.amount : -t.amount);

      events.push({
        date: t.date.split('T')[0],
        type: isCountableTransfer ? 'transfer' : signedAmount >= 0 ? 'income' : 'expense',
        description: t.title,
        amount: signedAmount,
        balanceAfter: 0,
        source: t.isRecurring ? 'recurring' : 'manual' as const,
        accountId: t.accountId,
      });
    }
    
    // Generate future recurring events for EXPENSES ONLY
    // Income recurring events come from incomeSources, not transactions
    // PENDING: excluded — a hold is not evidence of a recurring bill, and
    // i.expense already says so.
    if (t.isRecurring && t.recurringFrequency && i.expense === 'counted'
        && !suppressRecurringFor?.has(normalizeMerchant(t.merchant || t.title))) {
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
 *
 * Projection model (src/lib/behavior.ts): income at the detected pay cadence when the
 * ledger has paycheck rows (falls back to hand-entered incomeSources otherwise), fixed
 * bills on their real due dates, and a per-day "Projected living costs" drain built
 * from category baselines — replacing the old flat typical-daily-spending average.
 */
/**
 * STATE-001 (#105): `income` was the OPTIONAL 8th argument, so History called this with
 * six and got a policy-blind forecast. TypeScript forbids a required parameter after an
 * optional one, so the policy moves to slot 5 — positional and required, deliberately
 * NOT a key in an options bag: a bag key is exactly what Flow's `{}` silently omitted.
 */
export function generateForecast(
  startingCash: number,
  accounts: PaymentAccount[],
  incomeSources: IncomeSource[],
  transactions: Transaction[],
  income: IncomeContext,
  safetyThreshold: number = DEFAULT_SAFETY_THRESHOLD,
  days: number = FORECAST_DAYS,
  overrides?: AssumptionOverrides
): ForecastSummary {
  const today = startOfDay(new Date());
  const endDate = addDays(today, days);

  // The forecast's income is APPROVED-SOURCE income, both ways round: the observed
  // paycheck line is built only from rows that matched an approved source, and the
  // fallback projects the approved sources themselves. An unmatched credit — however
  // large, however regular — can reach neither.
  const ctx: IncomeContext = { sources: incomeSources, ...income };
  const assumptions = buildAssumptions(transactions, accounts, overrides, ctx);
  const billEvents = generateBillEvents(accounts, today, endDate);
  // An observed paycheck line replaces the configured income line — the ledger knows
  // the real cadence and amount better than the onboarding form does.
  const incomeEvents = assumptions.income ? [] : generateIncomeEvents(incomeSources, today, endDate);
  const txnEvents = transactionsToEvents(
    transactions, accounts, today, endDate,
    new Set(assumptions.fixedBills.map((b) => b.merchant)),
    ctx
  );
  const behaviorEvts = behaviorEvents(assumptions, accounts, format(today, 'yyyy-MM-dd'), days);

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
    ...behaviorEvts,
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
    
    // Track totals. A transfer moves the running balance above but is NOT spending:
    // totalExpenses feeds monthlyExpenses -> the emergency-fund target and runway, so
    // counting a savings sweep here inflates the target and shortens the runway.
    if (event.type !== 'transfer') {
      if (event.amount > 0) {
        totalIncome += event.amount;
      } else {
        totalExpenses += Math.abs(event.amount);
      }
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
 * Generate account-specific forecast
 * Shows how a specific account balance will change over time,
 * including credit card payments from checking accounts
 */
/**
 * STATE-001 (#105) deliberately does NOT take a policy, and the reason is worth stating
 * so nobody "fixes" it later: the opening balance is `currentOf(account)` — the account
 * the CALLER already derived, policy included — and the only rows classified here are
 * FUTURE-dated, where a pending hold cannot exist. Its remaining policy blindness is the
 * `classifyTransaction` calls below, which is #104's question, not this one.
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
    balanceAfter: currentOf(account),
    source: 'manual',
    accountId: account.id,
  });
  
  // For checking/bank accounts, include:
  // 1. Income deposits
  // 2. Credit card payments (expenses from this account)
  // 3. Transactions linked to this account
  // 4. Loan payments if paid from this account
  
  if (account.type === 'bank_account' || account.type === 'debit_card') {
    // Add income events. A source that names its deposit accounts is only projected
    // into those accounts — otherwise one salary appears in full on every bank card.
    incomeSources
      .filter(inc => inc.isActive)
      .filter(inc => !inc.depositAccountIds?.length || inc.depositAccountIds.includes(account.id))
      .forEach(income => {
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
    
    // No synthetic credit-card payment on the paying account either — same reason as
    // generateBillEvents: with derived balances it would double-count the recorded
    // transfer that actually pays the card. Recorded transfers are the source of truth.

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
    // Add transactions made on this credit card. Transfers are excluded because the
    // synthetic payment below already models them, and line 900's
    // `type === 'expense' ? +amount : -amount` would push an inbound payment the
    // wrong way against this card's balance.
    transactions
      .filter(t => t.accountId === account.id && classifyTransaction(t, allAccounts) !== 'transfer')
      .filter(t => {
        const txnDate = parseISO(t.date);
        return isAfter(txnDate, today) && isBefore(txnDate, endDate);
      })
      .forEach(t => {
        events.push({
          date: t.date.split('T')[0],
          type: 'expense',
          description: t.title,
          // Credit card: spending increases balance (positive). isPositive() is the
          // shared sign rule, so this cannot disagree with the row's own classification.
          amount: isPositive(t, [account]) ? -t.amount : t.amount,
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
            amount: -(currentOf(account) || 0), // Reduces balance
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
  
  // Add account-linked transactions. NOTE this branch uses the OPPOSITE sign
  // convention to the credit-card branch above (`type === 'income' ? +amount
  // : -amount`), so a transfer's sign must come from isPositive(), not from t.type.
  // Transfers ARE included here: this account really did gain or lose the money, and
  // excluding them made the per-account card read "safe" while the all-accounts chart
  // on the same screen dipped.
  transactions
    .filter(t => t.accountId === account.id && account.type !== 'credit_card')
    .filter(t => {
      const txnDate = parseISO(t.date);
      return isAfter(txnDate, today) && isBefore(txnDate, endDate);
    })
    .forEach(t => {
      // Sign and kind both come from the shared classifier, so a card-payment leg
      // sitting on this account is a transfer here exactly as it is on Flow.
      const kind = classifyTransaction(t, allAccounts);
      const inflow = isPositive(t, [account]);
      events.push({
        date: t.date.split('T')[0],
        type: kind === 'transfer' ? 'transfer' : inflow ? 'income' : 'expense',
        description: t.title,
        amount: inflow ? t.amount : -t.amount,
        balanceAfter: 0,
        source: 'manual',
        accountId: account.id,
      });
    });
  
  // Sort events by date
  events.sort((a, b) => a.date.localeCompare(b.date));
  
  // Calculate running balance
  let runningBalance = currentOf(account);
  let lowestBalance = currentOf(account);
  let lowestBalanceDate = format(today, 'yyyy-MM-dd');
  let totalIncome = 0;
  let totalExpenses = 0;
  let daysUntilUnsafe: number | null = null;
  
  events.forEach((event, index) => {
    if (index === 0) {
      event.balanceAfter = currentOf(account);
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
          amount: currentOf(card) || 0,
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
    currentBalance: currentOf(account),
    forecast: {
      startingBalance: currentOf(account),
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

