/**
 * Transaction Classification Tests
 * Tests the smart logic for classifying transactions as income, expense, or transfer
 */

import { Transaction, PaymentAccount } from '@/types';
// The real production classifier. These assertions are only worth anything because
// they run against the shipped code rather than a copy of it.
import { classifyTransaction, isPositive } from '@/lib/classify';

describe('Transaction Classification', () => {
  const mockAccounts: PaymentAccount[] = [
    {
      id: 'checking-1',
      name: 'Chase Checking',
      type: 'bank_account',
      provider: 'chase',
      balance: 5000,
      color: '#1e88e5',
      isActive: true,
    },
    {
      id: 'savings-1',
      name: 'Chase Savings',
      type: 'bank_account',
      provider: 'chase',
      balance: 10000,
      color: '#43a047',
      isActive: true,
    },
    {
      id: 'credit-1',
      name: 'AMEX Card',
      type: 'credit_card',
      provider: 'amex',
      balance: -1500,
      creditLimit: 10000,
      color: '#7c3aed',
      isActive: true,
    },
    {
      id: 'loan-1',
      name: 'Upstart Loan',
      type: 'personal_loan',
      provider: 'other',
      balance: -5000,
      color: '#ef4444',
      isActive: true,
    },
  ];

  describe('Transfer Detection', () => {
    test('should classify "Online Transfer from" as transfer', () => {
      const txn: Transaction = {
        id: '1',
        title: 'Online Transfer from Checking 7535',
        amount: 500,
        type: 'expense',
        category: 'other',
        paymentMethod: 'bank-transfer',
        accountId: 'savings-1',
        date: '2025-12-01',
      };

      expect(classifyTransaction(txn, mockAccounts)).toBe('transfer');
    });

    test('should classify "Online Transfer to" as transfer', () => {
      const txn: Transaction = {
        id: '2',
        title: 'Online Transfer to Checking 7535',
        amount: 500,
        type: 'expense',
        category: 'other',
        paymentMethod: 'bank-transfer',
        accountId: 'savings-1',
        date: '2025-12-01',
      };

      expect(classifyTransaction(txn, mockAccounts)).toBe('transfer');
    });

    test('should classify credit card payment as transfer', () => {
      const txn: Transaction = {
        id: '3',
        title: 'Payment Thank You',
        amount: 1500,
        type: 'income',
        category: 'other',
        paymentMethod: 'bank-transfer',
        accountId: 'credit-1', // On credit card
        date: '2025-12-01',
      };

      expect(classifyTransaction(txn, mockAccounts)).toBe('transfer');
    });

    test('should trust a stored transfer type over any title heuristic', () => {
      // Monarch's own Category column already said this is internal movement.
      // "Zelle J Smith" contains no transfer/payment keyword at all.
      const txn: Transaction = {
        id: 't1',
        title: 'Zelle J Smith',
        amount: 800,
        type: 'transfer',
        category: 'other',
        paymentMethod: 'bank-transfer',
        accountId: 'checking-1',
        date: '2025-12-01',
      };

      expect(classifyTransaction(txn, mockAccounts)).toBe('transfer');
    });

    test('should not throw on a missing account list or a dangling accountId', () => {
      const noAccount: Transaction = {
        id: 't2', title: 'Whole Foods', amount: 50, type: 'expense',
        category: 'food', paymentMethod: 'bank-transfer', date: '2025-12-01',
      };
      const dangling: Transaction = { ...noAccount, id: 't3', accountId: 'deleted-99' };

      expect(classifyTransaction(noAccount)).toBe('expense');
      expect(classifyTransaction(dangling, mockAccounts)).toBe('expense');
    });

    test('should classify autopay as transfer on credit card', () => {
      const txn: Transaction = {
        id: '4',
        title: 'AutoPay Payment',
        amount: 500,
        type: 'income',
        category: 'other',
        paymentMethod: 'bank-transfer',
        accountId: 'credit-1',
        date: '2025-12-01',
      };

      expect(classifyTransaction(txn, mockAccounts)).toBe('transfer');
    });
  });

  describe('Income Detection', () => {
    test('should classify direct deposit as income', () => {
      const txn: Transaction = {
        id: '5',
        title: 'Direct Deposit - ACME Corp',
        amount: 5000,
        type: 'income',
        category: 'other',
        paymentMethod: 'bank-transfer',
        accountId: 'checking-1',
        date: '2025-12-01',
      };

      expect(classifyTransaction(txn, mockAccounts)).toBe('income');
    });

    test('should classify payroll as income', () => {
      const txn: Transaction = {
        id: '6',
        title: 'Payroll Deposit',
        amount: 3000,
        type: 'income',
        category: 'other',
        paymentMethod: 'bank-transfer',
        accountId: 'checking-1',
        date: '2025-12-01',
      };

      expect(classifyTransaction(txn, mockAccounts)).toBe('income');
    });

    test('should classify salary as income', () => {
      const txn: Transaction = {
        id: '7',
        title: 'Salary Payment',
        amount: 4500,
        type: 'income',
        category: 'other',
        paymentMethod: 'bank-transfer',
        accountId: 'checking-1',
        date: '2025-12-01',
      };

      expect(classifyTransaction(txn, mockAccounts)).toBe('income');
    });
  });

  describe('Expense Detection', () => {
    test('should classify regular purchase as expense', () => {
      const txn: Transaction = {
        id: '8',
        title: 'Amazon Purchase',
        amount: 150,
        type: 'expense',
        category: 'shopping',
        paymentMethod: 'amex',
        accountId: 'credit-1',
        date: '2025-12-01',
        merchant: 'Amazon',
      };

      expect(classifyTransaction(txn, mockAccounts)).toBe('expense');
    });

    test('should classify restaurant charge as expense', () => {
      const txn: Transaction = {
        id: '9',
        title: 'Starbucks Coffee',
        amount: 6.50,
        type: 'expense',
        category: 'food',
        paymentMethod: 'bank-transfer',
        accountId: 'checking-1',
        date: '2025-12-01',
        merchant: 'Starbucks',
      };

      expect(classifyTransaction(txn, mockAccounts)).toBe('expense');
    });
  });

  describe('Display Sign Logic', () => {
    test('should show + for transfer FROM (money coming in)', () => {
      const txn: Transaction = {
        id: '10',
        title: 'Online Transfer from Checking 7535',
        amount: 500,
        type: 'expense',
        category: 'other',
        paymentMethod: 'bank-transfer',
        accountId: 'savings-1',
        date: '2025-12-01',
      };

      expect(isPositive(txn, mockAccounts)).toBe(true);
    });

    test('should show - for transfer TO (money going out)', () => {
      const txn: Transaction = {
        id: '11',
        title: 'Online Transfer to Checking 7535',
        amount: 500,
        type: 'expense',
        category: 'other',
        paymentMethod: 'bank-transfer',
        accountId: 'savings-1',
        date: '2025-12-01',
      };

      expect(isPositive(txn, mockAccounts)).toBe(false);
    });

    test('should show + for credit card payment (reduces debt)', () => {
      const txn: Transaction = {
        id: '12',
        title: 'Payment - Thank You',
        amount: 1500,
        type: 'income',
        category: 'other',
        paymentMethod: 'bank-transfer',
        accountId: 'credit-1',
        date: '2025-12-01',
      };

      expect(isPositive(txn, mockAccounts)).toBe(true);
    });

    test('should show + for deposits', () => {
      const txn: Transaction = {
        id: '13',
        title: 'Direct Deposit',
        amount: 5000,
        type: 'income',
        category: 'other',
        paymentMethod: 'bank-transfer',
        accountId: 'checking-1',
        date: '2025-12-01',
      };

      expect(isPositive(txn, mockAccounts)).toBe(true);
    });

    test('should use transferDirection when the title carries no direction word', () => {
      // Both legs of a USAA move are titled "...TRANSFER DB" / "...TRANSFER CR".
      // Without the stored direction they would both render as money leaving.
      const out: Transaction = {
        id: 's1', title: 'USAA FUNDS TRANSFER DB', amount: 5000, type: 'transfer',
        transferDirection: 'out', category: 'other', paymentMethod: 'bank-transfer',
        accountId: 'checking-1', date: '2025-12-01',
      };
      const incoming: Transaction = { ...out, id: 's2', title: 'USAA FUNDS TRANSFER CR', transferDirection: 'in' };

      expect(isPositive(out, mockAccounts)).toBe(false);
      expect(isPositive(incoming, mockAccounts)).toBe(true);
    });

    test('should show + for a loan payment (reduces debt)', () => {
      // The personal_loan half of isDebtAccount had no coverage at all.
      const txn: Transaction = {
        id: 's3', title: 'Upstart Loan Payment', amount: 450, type: 'expense',
        category: 'other', paymentMethod: 'bank-transfer',
        accountId: 'loan-1', date: '2025-12-01',
      };

      expect(isPositive(txn, mockAccounts)).toBe(true);
    });

    test('should show - for regular expenses', () => {
      const txn: Transaction = {
        id: '14',
        title: 'Grocery Store',
        amount: 150,
        type: 'expense',
        category: 'food',
        paymentMethod: 'bank-transfer',
        accountId: 'checking-1',
        date: '2025-12-01',
      };

      expect(isPositive(txn, mockAccounts)).toBe(false);
    });
  });

  describe('Totals Calculation', () => {
    test('transfers should not count in income or expense totals', () => {
      const transactions: Transaction[] = [
        {
          id: '15',
          title: 'Online Transfer from Checking',
          amount: 500,
          type: 'expense',
          category: 'other',
          paymentMethod: 'bank-transfer',
          accountId: 'savings-1',
          date: '2025-12-01',
        },
        {
          id: '16',
          title: 'Online Transfer to Checking',
          amount: 500,
          type: 'expense',
          category: 'other',
          paymentMethod: 'bank-transfer',
          accountId: 'savings-1',
          date: '2025-12-02',
        },
        {
          // Stored transfer with no keyword in the title — the Monarch case.
          id: '16b',
          title: 'Zelle J Smith',
          amount: 800,
          type: 'transfer',
          category: 'other',
          paymentMethod: 'bank-transfer',
          accountId: 'savings-1',
          date: '2025-12-03',
        },
      ];

      let income = 0;
      let expenses = 0;

      transactions.forEach(txn => {
        const classification = classifyTransaction(txn, mockAccounts);
        if (classification === 'income') {
          income += txn.amount;
        } else if (classification === 'expense') {
          expenses += txn.amount;
        }
        // 'transfer' transactions don't count
      });

      expect(income).toBe(0);
      expect(expenses).toBe(0);
    });

    test('real income and expenses should count in totals', () => {
      const transactions: Transaction[] = [
        {
          id: '17',
          title: 'Direct Deposit',
          amount: 5000,
          type: 'income',
          category: 'other',
          paymentMethod: 'bank-transfer',
          accountId: 'checking-1',
          date: '2025-12-01',
        },
        {
          id: '18',
          title: 'Grocery Store',
          amount: 150,
          type: 'expense',
          category: 'food',
          paymentMethod: 'bank-transfer',
          accountId: 'checking-1',
          date: '2025-12-02',
        },
      ];

      let income = 0;
      let expenses = 0;

      transactions.forEach(txn => {
        const classification = classifyTransaction(txn, mockAccounts);
        if (classification === 'income') {
          income += txn.amount;
        } else if (classification === 'expense') {
          expenses += txn.amount;
        }
      });

      expect(income).toBe(5000);
      expect(expenses).toBe(150);
    });
  });
});


describe('Real statement shapes on a credit card (phantom-income fix)', () => {
  const accts: PaymentAccount[] = [
    { id: 'card-1', name: 'Visa', type: 'credit_card', provider: 'visa', balance: 0, color: '#000', isActive: true },
    { id: 'bank-1', name: 'Checking', type: 'bank_account', provider: 'chase', balance: 0, color: '#000', isActive: true },
  ];
  const cardTxn = (title: string): Transaction => ({
    id: 't', title, amount: 500, type: 'income', category: 'other',
    paymentMethod: 'bank-transfer', accountId: 'card-1', date: '2026-06-01',
  });

  test.each(['CHASE CREDIT CRD EPAY', 'AMZ_STORECRD_PMT DES:ID', 'ONLINE PYMT THANK YOU'])(
    '"%s" on a card is a transfer, not income', (title) => {
      expect(classifyTransaction(cardTxn(title), accts)).toBe('transfer');
    });

  test('a refund on a card STAYS income (it cancels an expense)', () => {
    expect(classifyTransaction(cardTxn('CREDIT VOUCHER TARGET RETURN'), accts)).toBe('income');
  });

  test('payroll on a BANK account is untouched by the wider regex', () => {
    const t: Transaction = { ...cardTxn('Payroll Deposit'), accountId: 'bank-1' };
    expect(classifyTransaction(t, accts)).toBe('income');
  });
});
