import { Transaction } from '@/types';

const STORAGE_KEYS = {
  TRANSACTIONS: 'cashflow_transactions',
};

// Transaction storage functions
export function getTransactions(): Transaction[] {
  if (typeof window === 'undefined') return [];
  const data = localStorage.getItem(STORAGE_KEYS.TRANSACTIONS);
  return data ? JSON.parse(data) : [];
}

export function saveTransactions(transactions: Transaction[]): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEYS.TRANSACTIONS, JSON.stringify(transactions));
}

export function addTransaction(transaction: Transaction): void {
  const transactions = getTransactions();
  transactions.push(transaction);
  saveTransactions(transactions);
}

export function updateTransaction(id: string, updates: Partial<Transaction>): void {
  const transactions = getTransactions();
  const index = transactions.findIndex((t) => t.id === id);
  if (index !== -1) {
    transactions[index] = { ...transactions[index], ...updates };
    saveTransactions(transactions);
  }
}

export function deleteTransaction(id: string): void {
  const transactions = getTransactions();
  const filtered = transactions.filter((t) => t.id !== id);
  saveTransactions(filtered);
}

// Generate sample data for demo
export function generateSampleData(): Transaction[] {
  const today = new Date();
  const transactions: Transaction[] = [];

  // Past expenses
  const pastExpenses = [
    { title: 'Grocery Shopping', amount: 125.50, category: 'food' as const, paymentMethod: 'chase' as const, daysAgo: 1 },
    { title: 'Netflix Subscription', amount: 15.99, category: 'subscriptions' as const, paymentMethod: 'apple' as const, daysAgo: 3 },
    { title: 'Gas Station', amount: 45.00, category: 'transportation' as const, paymentMethod: 'discover' as const, daysAgo: 5 },
    { title: 'Restaurant Dinner', amount: 85.75, category: 'food' as const, paymentMethod: 'amex' as const, daysAgo: 7 },
    { title: 'Electric Bill', amount: 142.30, category: 'utilities' as const, paymentMethod: 'bank-transfer' as const, daysAgo: 10 },
    { title: 'Online Shopping', amount: 234.99, category: 'shopping' as const, paymentMethod: 'amex' as const, daysAgo: 12 },
    { title: 'Gym Membership', amount: 49.99, category: 'healthcare' as const, paymentMethod: 'chase' as const, daysAgo: 15 },
    { title: 'Coffee Shop', amount: 28.50, category: 'food' as const, paymentMethod: 'apple' as const, daysAgo: 2 },
    { title: 'Uber Ride', amount: 22.45, category: 'transportation' as const, paymentMethod: 'visa' as const, daysAgo: 4 },
    { title: 'Movie Tickets', amount: 35.00, category: 'entertainment' as const, paymentMethod: 'discover' as const, daysAgo: 8 },
    { title: 'Phone Bill', amount: 85.00, category: 'utilities' as const, paymentMethod: 'bank-transfer' as const, daysAgo: 20 },
    { title: 'Rent Payment', amount: 1500.00, category: 'rent' as const, paymentMethod: 'bank-transfer' as const, daysAgo: 25 },
    { title: 'Car Insurance', amount: 125.00, category: 'insurance' as const, paymentMethod: 'chase' as const, daysAgo: 28 },
    { title: 'Spotify Premium', amount: 9.99, category: 'subscriptions' as const, paymentMethod: 'mastercard' as const, daysAgo: 18 },
    { title: 'Pharmacy', amount: 45.67, category: 'healthcare' as const, paymentMethod: 'visa' as const, daysAgo: 22 },
  ];

  pastExpenses.forEach((expense) => {
    const date = new Date(today);
    date.setDate(date.getDate() - expense.daysAgo);
    transactions.push({
      id: `past-${expense.daysAgo}-${Date.now()}-${Math.random()}`,
      title: expense.title,
      amount: expense.amount,
      type: 'expense',
      category: expense.category,
      paymentMethod: expense.paymentMethod,
      date: date.toISOString(),
      isProjected: false,
    });
  });

  // Past income
  const pastIncome = [
    { title: 'Salary', amount: 5500.00, daysAgo: 15 },
    { title: 'Freelance Work', amount: 750.00, daysAgo: 8 },
    { title: 'Investment Dividend', amount: 125.00, daysAgo: 20 },
  ];

  pastIncome.forEach((income) => {
    const date = new Date(today);
    date.setDate(date.getDate() - income.daysAgo);
    transactions.push({
      id: `income-${income.daysAgo}-${Date.now()}-${Math.random()}`,
      title: income.title,
      amount: income.amount,
      type: 'income',
      category: 'other',
      paymentMethod: 'bank-transfer',
      date: date.toISOString(),
      isProjected: false,
    });
  });

  // Future/Projected expenses
  const futureExpenses = [
    { title: 'Rent (Upcoming)', amount: 1500.00, category: 'rent' as const, paymentMethod: 'bank-transfer' as const, daysAhead: 5 },
    { title: 'Netflix (Auto-renewal)', amount: 15.99, category: 'subscriptions' as const, paymentMethod: 'apple' as const, daysAhead: 10 },
    { title: 'Car Insurance (Due)', amount: 125.00, category: 'insurance' as const, paymentMethod: 'chase' as const, daysAhead: 15 },
    { title: 'Electric Bill (Estimated)', amount: 150.00, category: 'utilities' as const, paymentMethod: 'bank-transfer' as const, daysAhead: 20 },
    { title: 'Gym Membership', amount: 49.99, category: 'healthcare' as const, paymentMethod: 'chase' as const, daysAhead: 25 },
    { title: 'Phone Bill (Estimated)', amount: 85.00, category: 'utilities' as const, paymentMethod: 'bank-transfer' as const, daysAhead: 12 },
    { title: 'Spotify (Auto-renewal)', amount: 9.99, category: 'subscriptions' as const, paymentMethod: 'mastercard' as const, daysAhead: 18 },
  ];

  futureExpenses.forEach((expense) => {
    const date = new Date(today);
    date.setDate(date.getDate() + expense.daysAhead);
    transactions.push({
      id: `future-${expense.daysAhead}-${Date.now()}-${Math.random()}`,
      title: expense.title,
      amount: expense.amount,
      type: 'expense',
      category: expense.category,
      paymentMethod: expense.paymentMethod,
      date: date.toISOString(),
      isProjected: true,
    });
  });

  // Future income
  const futureIncome = [
    { title: 'Salary (Expected)', amount: 5500.00, daysAhead: 15 },
    { title: 'Expected Bonus', amount: 1000.00, daysAhead: 30 },
  ];

  futureIncome.forEach((income) => {
    const date = new Date(today);
    date.setDate(date.getDate() + income.daysAhead);
    transactions.push({
      id: `future-income-${income.daysAhead}-${Date.now()}-${Math.random()}`,
      title: income.title,
      amount: income.amount,
      type: 'income',
      category: 'other',
      paymentMethod: 'bank-transfer',
      date: date.toISOString(),
      isProjected: true,
    });
  });

  return transactions;
}
