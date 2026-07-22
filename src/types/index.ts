export type PaymentMethod = 
  | 'amex'
  | 'chase'
  | 'discover'
  | 'apple'
  | 'visa'
  | 'mastercard'
  | 'cash'
  | 'bank-transfer'
  | 'other';

export type ExpenseCategory =
  | 'food'
  | 'transportation'
  | 'utilities'
  | 'entertainment'
  | 'shopping'
  | 'healthcare'
  | 'education'
  | 'travel'
  | 'subscriptions'
  | 'rent'
  | 'insurance'
  | 'investments'
  | 'other';

// 'transfer' = movement between the user's own accounts. It is NOT income and NOT
// spending, so it must be excluded from every income/expense total. Set at import time
// from the source data (e.g. Monarch's own "Transfer" / "Credit Card Payment" category)
// rather than re-guessed from the title on every render. See src/lib/classify.ts.
export type TransactionType = 'expense' | 'income' | 'transfer';

// A transfer's amount is stored unsigned like every other transaction, so the leg
// direction has nowhere else to live: without this, both legs of a $5,000 move render
// identically and the receiving side looks like money leaving.
export type TransferDirection = 'in' | 'out';

export type AccountType = 'credit_card' | 'debit_card' | 'bank_account' | 'cash' | 'personal_loan';

// ============================================
// Planned Transaction Types (Financial Todo)
// ============================================
export type PlannedTransactionStatus = 'pending' | 'completed' | 'skipped';

export interface PlannedTransaction {
  id: string;
  title: string;
  amount: number;
  // A planned *transfer* is not a thing this panel offers, so it stays two-valued.
  type: Exclude<TransactionType, 'transfer'>;
  category: ExpenseCategory;
  accountId?: string;
  dueDate: string; // ISO date - when this payment is expected
  notes?: string;
  status: PlannedTransactionStatus;
  priority: 'high' | 'medium' | 'low';
  isRecurring?: boolean;
  recurringFrequency?: 'weekly' | 'monthly' | 'yearly';
  completedDate?: string; // When marked as completed
  linkedTransactionId?: string; // Links to actual transaction when completed
  createdAt: string;
  updatedAt: string;
}

// ============================================
// Category Budget Types
// ============================================
export interface CategoryBudget {
  categoryId: ExpenseCategory;
  monthlyLimit: number;
  isEnabled: boolean;
}

export interface CategoryBudgetStatus {
  categoryId: ExpenseCategory;
  categoryLabel: string;
  monthlyLimit: number;
  spent: number;
  remaining: number;
  percentUsed: number;
  projectedMonthEnd: number; // Estimated total by month end based on trend
  isOverBudget: boolean;
  isAtRisk: boolean; // Will likely exceed by month end
}

// ============================================
// Bill Reminder Types
// ============================================
export type ReminderStatus = 'upcoming' | 'dismissed' | 'paid';

export interface Reminder {
  id: string;
  date: string; // ISO date
  title: string;
  amount?: number;
  relatedAccountId?: string;
  relatedTransactionId?: string;
  type: 'bill' | 'credit_card' | 'loan' | 'subscription';
  status: ReminderStatus;
  createdAt: string;
}

export interface NotificationPreferences {
  remindDaysBefore: number[]; // e.g., [1, 3, 7]
  channels: ('in_app' | 'email' | 'push')[];
  billRemindersEnabled: boolean;
}

// ============================================
// Savings Goal Types
// ============================================
export interface SavingsGoal {
  id: string;
  name: string;
  targetAmount: number;
  currentAmount: number;
  targetDate?: string; // ISO date, optional
  linkedAccountId?: string; // Optional funding account
  priority: 1 | 2 | 3 | 4 | 5; // 1 = highest
  color: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface GoalProgress {
  goal: SavingsGoal;
  percentComplete: number;
  amountRemaining: number;
  daysRemaining?: number;
  requiredMonthlySavings?: number; // If target date set
  isOnTrack?: boolean;
}

// ============================================
// Debt Payoff Planner Types
// ============================================
export type DebtPayoffStrategy = 'snowball' | 'avalanche';

export interface DebtAccount {
  id: string;
  name: string;
  balance: number;
  apr: number;
  minimumPayment: number;
  dueDate: number;
}

export interface DebtPayoffPlan {
  strategy: DebtPayoffStrategy;
  extraMonthlyPayment: number;
  debts: DebtPayoffItem[];
  totalInterestPaid: number;
  totalMonths: number;
  interestSaved: number; // Compared to minimum payments only
}

export interface DebtPayoffItem {
  accountId: string;
  accountName: string;
  originalBalance: number;
  apr: number;
  payoffOrder: number;
  payoffDate: string; // ISO date
  totalInterestPaid: number;
  monthsToPayoff: number;
}

export interface PaymentAccount {
  id: string;
  name: string;
  type: AccountType;
  provider: PaymentMethod;
  balance: number;
  creditLimit?: number; // For credit cards
  apr?: number; // Annual Percentage Rate for credit cards and loans
  statementDate?: number; // Day of month (1-31)
  dueDate?: number; // Day of month (1-31)
  color: string;
  lastFourDigits?: string;
  isActive: boolean;
  // Payment linking - which account pays this card/loan
  paymentFromAccountId?: string; // ID of the account that pays this credit card or loan
  // Loan specific fields
  originalAmount?: number; // Original loan amount
  monthlyPayment?: number; // Monthly payment amount
  loanTerm?: number; // Loan term in months
  loanStartDate?: string; // When the loan started
}

export interface IncomeSource {
  id: string;
  name: string;
  amount: number;
  frequency: 'weekly' | 'biweekly' | 'monthly' | 'yearly';
  payDate?: number; // Day of month for monthly, or specific date
  nextPayDate?: string; // ISO date string
  isActive: boolean;
  endDate?: string; // When this income ends (ISO date) - e.g., contract ending
  remainingPayments?: number; // Number of remaining payments - e.g., 12 months left
}

export interface UserProfile {
  id: string;
  email: string;
  name: string;
  createdAt: string;
  isOnboarded: boolean;
  monthlyBudget: number;
  currency: string;
  paymentAccounts: PaymentAccount[];
  incomeSources: IncomeSource[];
  savingsGoals?: SavingsGoal[];
  settings?: {
    timezone?: string;
    notifications?: boolean;
    safetyThreshold?: number; // Minimum safe balance
    emergencyFundGoal?: number; // Target emergency fund (in months of expenses)
    emergencyFundAmount?: number; // Fixed amount goal (alternative to months)
    categoryBudgets?: CategoryBudget[]; // Per-category spending limits
    notificationPreferences?: NotificationPreferences; // Reminder settings
  };
}

// Forecast types for cash flow prediction
export interface ForecastEvent {
  date: string;
  type: 'income' | 'bill' | 'expense' | 'transfer' | 'starting_balance' | 'credit_card_payment' | 'income_ends' | 'payment_ends';
  description: string;
  amount: number; // Positive for income, negative for expenses
  balanceAfter: number;
  isCritical?: boolean; // Below safety threshold
  source?: 'recurring' | 'manual' | 'projected';
  accountId?: string; // Which account this event belongs to
  relatedAccountId?: string; // For credit card payments, which card is being paid
  relatedAccountName?: string; // Name of related account for display
  isLastPayment?: boolean; // Marks the final payment of a recurring series
  endsOn?: string; // Date when this recurring item ends
}

export interface ForecastSummary {
  startingBalance: number;
  endingBalance: number;
  lowestBalance: number;
  lowestBalanceDate: string;
  safetyThreshold: number;
  daysUntilUnsafe: number | null;
  totalIncome: number;
  totalExpenses: number;
  events: ForecastEvent[];
  accountId?: string; // Which account this forecast is for (null = all accounts)
  accountName?: string;
}

// Account-specific forecast for dropdown
export interface AccountForecast {
  accountId: string;
  accountName: string;
  accountType: AccountType;
  currentBalance: number;
  forecast: ForecastSummary;
  creditCardPayments?: { // For checking accounts, upcoming credit card payments
    cardId: string;
    cardName: string;
    amount: number;
    dueDate: string;
  }[];
}

export interface SpendingSimulation {
  amount: number;
  newLowestBalance: number;
  newLowestDate: string;
  violatesSafety: boolean;
  daysUntilUnsafe: number | null;
  riskLevel: 'safe' | 'caution' | 'unsafe';
  affectedBills: string[];
}

export type AIDecisionResponse = {
  riskLevel: 'safe' | 'caution' | 'unsafe';
  explanation: string;
  recommendation: string;
};

export interface Transaction {
  id: string;
  title: string;
  amount: number;
  type: TransactionType;
  category: ExpenseCategory;
  paymentMethod: PaymentMethod;
  accountId?: string; // Reference to PaymentAccount
  date: string; // ISO date string
  description?: string;
  merchant?: string; // Store/merchant name (Amazon, Walmart, Starbucks, etc.)
  // The category exactly as the source (Monarch, etc.) labelled it — "AI Tools",
  // "Coffee Shops", "Send to India". `category` above stays a coarse 13-value bucket
  // that budgets/forecasts need a closed set for; this is the user's own fine-grained
  // label for display, grouping and filtering. Absent on manually-added rows.
  sourceCategory?: string;
  transferDirection?: TransferDirection; // Only meaningful when type === 'transfer'
  isRecurring?: boolean;
  recurringFrequency?: 'weekly' | 'monthly' | 'yearly';
  recurringEndDate?: string; // When recurring payments end (ISO date)
  recurringCount?: number; // Number of remaining payments (e.g., 39 months left)
  isProjected?: boolean; // For future/projected expenses
}

export interface User {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

export interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
}

export const PAYMENT_METHODS: { value: PaymentMethod; label: string; color: string }[] = [
  { value: 'amex', label: 'American Express', color: '#006fcf' },
  { value: 'chase', label: 'Chase', color: '#117aca' },
  { value: 'discover', label: 'Discover', color: '#ff6000' },
  { value: 'apple', label: 'Apple Card', color: '#a2aaad' },
  { value: 'visa', label: 'Visa', color: '#1a1f71' },
  { value: 'mastercard', label: 'Mastercard', color: '#eb001b' },
  { value: 'cash', label: 'Cash', color: '#10b981' },
  { value: 'bank-transfer', label: 'Bank Account', color: '#3b82f6' },
  { value: 'other', label: 'Other', color: '#8b949e' },
];

export const ACCOUNT_TYPES: { value: AccountType; label: string }[] = [
  { value: 'credit_card', label: 'Credit Card' },
  { value: 'debit_card', label: 'Debit Card' },
  { value: 'bank_account', label: 'Bank Account' },
  { value: 'cash', label: 'Cash' },
  { value: 'personal_loan', label: 'Personal Loan' },
];

export const EXPENSE_CATEGORIES: { value: ExpenseCategory; label: string; icon: string }[] = [
  { value: 'food', label: 'Food & Dining', icon: '🍽️' },
  { value: 'transportation', label: 'Transportation', icon: '🚗' },
  { value: 'utilities', label: 'Utilities', icon: '💡' },
  { value: 'entertainment', label: 'Entertainment', icon: '🎬' },
  { value: 'shopping', label: 'Shopping', icon: '🛍️' },
  { value: 'healthcare', label: 'Healthcare', icon: '🏥' },
  { value: 'education', label: 'Education', icon: '📚' },
  { value: 'travel', label: 'Travel', icon: '✈️' },
  { value: 'subscriptions', label: 'Subscriptions', icon: '📱' },
  { value: 'rent', label: 'Rent & Housing', icon: '🏠' },
  { value: 'insurance', label: 'Insurance', icon: '🛡️' },
  { value: 'investments', label: 'Investments', icon: '📈' },
  { value: 'other', label: 'Other', icon: '📋' },
];

// Common merchants grouped by category
export const COMMON_MERCHANTS: { name: string; category: ExpenseCategory; color: string }[] = [
  // Shopping
  { name: 'Amazon', category: 'shopping', color: '#FF9900' },
  { name: 'Walmart', category: 'shopping', color: '#0071CE' },
  { name: 'Target', category: 'shopping', color: '#CC0000' },
  { name: 'Costco', category: 'shopping', color: '#E31837' },
  { name: 'Home Depot', category: 'shopping', color: '#F96302' },
  { name: "Lowe's", category: 'shopping', color: '#004990' },
  { name: 'Best Buy', category: 'shopping', color: '#0046BE' },
  { name: 'Apple Store', category: 'shopping', color: '#A2AAAD' },
  { name: 'IKEA', category: 'shopping', color: '#0058A3' },
  { name: 'TJ Maxx', category: 'shopping', color: '#E21A38' },
  { name: 'Ross', category: 'shopping', color: '#003DA5' },
  { name: 'Dollar Tree', category: 'shopping', color: '#00A650' },
  
  // Food & Dining
  { name: 'Starbucks', category: 'food', color: '#00704A' },
  { name: "McDonald's", category: 'food', color: '#FFC72C' },
  { name: 'Chipotle', category: 'food', color: '#A81612' },
  { name: 'Chick-fil-A', category: 'food', color: '#E51636' },
  { name: 'Whataburger', category: 'food', color: '#F15A22' },
  { name: 'Taco Bell', category: 'food', color: '#702082' },
  { name: "Wendy's", category: 'food', color: '#E2203D' },
  { name: 'Subway', category: 'food', color: '#009743' },
  { name: 'Panera Bread', category: 'food', color: '#4E7C41' },
  { name: "Dunkin'", category: 'food', color: '#FF671F' },
  { name: 'Pizza Hut', category: 'food', color: '#EE3A24' },
  { name: "Domino's", category: 'food', color: '#006491' },
  { name: 'DoorDash', category: 'food', color: '#FF3008' },
  { name: 'Uber Eats', category: 'food', color: '#06C167' },
  { name: 'Grubhub', category: 'food', color: '#F63440' },
  
  // Grocery
  { name: 'Whole Foods', category: 'food', color: '#00674B' },
  { name: 'Trader Joes', category: 'food', color: '#C0362C' },
  { name: 'Kroger', category: 'food', color: '#0068B5' },
  { name: 'Safeway', category: 'food', color: '#E7312A' },
  { name: 'Publix', category: 'food', color: '#5B8F22' },
  { name: 'Aldi', category: 'food', color: '#00447B' },
  { name: 'HEB', category: 'food', color: '#E31837' },
  
  // Gas & Transportation
  { name: 'Shell', category: 'transportation', color: '#FBCE07' },
  { name: 'Chevron', category: 'transportation', color: '#0056A4' },
  { name: 'Exxon', category: 'transportation', color: '#D71920' },
  { name: 'BP', category: 'transportation', color: '#009A4E' },
  { name: 'Uber', category: 'transportation', color: '#000000' },
  { name: 'Lyft', category: 'transportation', color: '#FF00BF' },
  
  // Subscriptions
  { name: 'Netflix', category: 'subscriptions', color: '#E50914' },
  { name: 'Spotify', category: 'subscriptions', color: '#1DB954' },
  { name: 'Disney+', category: 'subscriptions', color: '#113CCF' },
  { name: 'YouTube Premium', category: 'subscriptions', color: '#FF0000' },
  { name: 'Amazon Prime', category: 'subscriptions', color: '#00A8E1' },
  { name: 'HBO Max', category: 'subscriptions', color: '#5822B4' },
  { name: 'Hulu', category: 'subscriptions', color: '#1CE783' },
  { name: 'Apple TV+', category: 'subscriptions', color: '#000000' },
  { name: 'Adobe', category: 'subscriptions', color: '#FF0000' },
  { name: 'Microsoft 365', category: 'subscriptions', color: '#D83B01' },
  { name: 'ChatGPT Plus', category: 'subscriptions', color: '#10A37F' },
  { name: 'Gym Membership', category: 'subscriptions', color: '#FF4136' },
  
  // Healthcare
  { name: 'CVS', category: 'healthcare', color: '#CC0000' },
  { name: 'Walgreens', category: 'healthcare', color: '#E31837' },
  { name: 'Pharmacy', category: 'healthcare', color: '#1E88E5' },
  
  // Utilities
  { name: 'Electric Bill', category: 'utilities', color: '#FFC107' },
  { name: 'Water Bill', category: 'utilities', color: '#2196F3' },
  { name: 'Gas Bill', category: 'utilities', color: '#FF5722' },
  { name: 'Internet', category: 'utilities', color: '#9C27B0' },
  { name: 'Phone Bill', category: 'utilities', color: '#4CAF50' },
  
  // Entertainment
  { name: 'AMC Theaters', category: 'entertainment', color: '#F71735' },
  { name: 'Regal Cinemas', category: 'entertainment', color: '#7B1FA2' },
  { name: 'Steam', category: 'entertainment', color: '#1B2838' },
  { name: 'PlayStation', category: 'entertainment', color: '#003087' },
  { name: 'Xbox', category: 'entertainment', color: '#107C10' },
  { name: 'Nintendo', category: 'entertainment', color: '#E60012' },
];

// Get merchant color or generate consistent color from name
export function getMerchantColor(merchantName: string): string {
  const merchant = COMMON_MERCHANTS.find(
    m => m.name.toLowerCase() === merchantName.toLowerCase()
  );
  if (merchant) return merchant.color;
  
  // Generate consistent color from name
  let hash = 0;
  for (let i = 0; i < merchantName.length; i++) {
    hash = merchantName.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash % 360);
  return `hsl(${hue}, 65%, 45%)`;
}

// The label to show/group/filter a transaction by: the source's own category if it
// carried one, otherwise the coarse enum's label. One place so every screen agrees.
export function displayCategory(t: { sourceCategory?: string; category: ExpenseCategory }): string {
  if (t.sourceCategory) return t.sourceCategory;
  return EXPENSE_CATEGORIES.find(c => c.value === t.category)?.label || t.category;
}

// Suggest category based on merchant
export function suggestCategoryFromMerchant(merchantName: string): ExpenseCategory | null {
  const merchant = COMMON_MERCHANTS.find(
    m => m.name.toLowerCase() === merchantName.toLowerCase()
  );
  return merchant?.category || null;
}
