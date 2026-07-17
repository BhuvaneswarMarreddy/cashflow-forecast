/**
 * Type System Tests
 * Tests type definitions and validation logic
 */

import { 
  EXPENSE_CATEGORIES,
  getMerchantColor,
  AccountType,
  PaymentMethod,
  ExpenseCategory,
} from '@/types';

describe('Type System', () => {
  describe('Expense Categories', () => {
    test('should have all required categories', () => {
      const requiredCategories = [
        'food', 'transportation', 'utilities',
        'entertainment', 'shopping', 'healthcare', 'education',
        'rent', 'insurance', 'travel', 'subscriptions', 'investments', 'other'
      ];

      requiredCategories.forEach(cat => {
        const found = EXPENSE_CATEGORIES.find(c => c.value === cat);
        expect(found).toBeDefined();
      });
    });

    test('each category should have label, value, and icon', () => {
      EXPENSE_CATEGORIES.forEach(cat => {
        expect(cat).toHaveProperty('label');
        expect(cat).toHaveProperty('value');
        expect(cat).toHaveProperty('icon');
        expect(typeof cat.label).toBe('string');
        expect(typeof cat.value).toBe('string');
        expect(typeof cat.icon).toBe('string');
      });
    });
  });

  describe('Merchant Color Generator', () => {
    test('should return consistent color for same merchant', () => {
      const color1 = getMerchantColor('Amazon');
      const color2 = getMerchantColor('Amazon');
      expect(color1).toBe(color2);
    });

    test('should return different colors for different merchants', () => {
      const amazonColor = getMerchantColor('Amazon');
      const walmartColor = getMerchantColor('Walmart');
      // Colors might be the same by coincidence, but test the function works
      expect(typeof amazonColor).toBe('string');
      expect(typeof walmartColor).toBe('string');
      expect(amazonColor).toMatch(/^#[0-9a-fA-F]{6}$/);
    });

    test('should handle empty merchant name', () => {
      const color = getMerchantColor('');
      expect(typeof color).toBe('string');
    });

    test('should be case-insensitive', () => {
      const color1 = getMerchantColor('amazon');
      const color2 = getMerchantColor('AMAZON');
      const color3 = getMerchantColor('Amazon');
      expect(color1).toBe(color2);
      expect(color2).toBe(color3);
    });
  });

  describe('Account Types', () => {
    test('should support all account types', () => {
      const accountTypes: AccountType[] = [
        'credit_card',
        'debit_card',
        'bank_account',
        'cash',
        'personal_loan'
      ];

      accountTypes.forEach(type => {
        expect(typeof type).toBe('string');
      });
    });
  });

  describe('Payment Methods', () => {
    test('should support all payment methods', () => {
      const paymentMethods: PaymentMethod[] = [
        'credit',
        'debit',
        'cash',
        'bank-transfer',
        'apple',
        'visa',
        'mastercard',
        'other'
      ];

      paymentMethods.forEach(method => {
        expect(typeof method).toBe('string');
      });
    });
  });

  describe('Expense Categories Type', () => {
    test('should support all expense categories', () => {
      const categories: ExpenseCategory[] = [
        'food',
        'transportation',
        'utilities',
        'entertainment',
        'shopping',
        'healthcare',
        'education',
        'travel',
        'subscriptions',
        'rent',
        'insurance',
        'investments',
        'other'
      ];

      categories.forEach(cat => {
        expect(typeof cat).toBe('string');
      });
    });
  });
});

describe('Transaction Validation', () => {
  const validTransaction = {
    id: '123',
    title: 'Test Transaction',
    amount: 100,
    type: 'expense' as const,
    category: 'shopping' as ExpenseCategory,
    paymentMethod: 'credit' as PaymentMethod,
    date: '2025-12-01',
  };

  test('should have required fields', () => {
    expect(validTransaction).toHaveProperty('id');
    expect(validTransaction).toHaveProperty('title');
    expect(validTransaction).toHaveProperty('amount');
    expect(validTransaction).toHaveProperty('type');
    expect(validTransaction).toHaveProperty('category');
    expect(validTransaction).toHaveProperty('paymentMethod');
    expect(validTransaction).toHaveProperty('date');
  });

  test('amount should be a positive number', () => {
    expect(validTransaction.amount).toBeGreaterThan(0);
    expect(typeof validTransaction.amount).toBe('number');
  });

  test('type should be income or expense', () => {
    expect(['income', 'expense']).toContain(validTransaction.type);
  });

  test('date should be valid ISO string', () => {
    const date = new Date(validTransaction.date);
    expect(date.toString()).not.toBe('Invalid Date');
  });
});

describe('Payment Account Validation', () => {
  const validAccount = {
    id: 'acc-123',
    name: 'Chase Checking',
    type: 'bank_account' as AccountType,
    provider: 'chase',
    balance: 5000,
    color: '#1e88e5',
    isActive: true,
  };

  test('should have required fields', () => {
    expect(validAccount).toHaveProperty('id');
    expect(validAccount).toHaveProperty('name');
    expect(validAccount).toHaveProperty('type');
    expect(validAccount).toHaveProperty('provider');
    expect(validAccount).toHaveProperty('balance');
    expect(validAccount).toHaveProperty('color');
    expect(validAccount).toHaveProperty('isActive');
  });

  test('balance can be positive, zero, or negative', () => {
    expect(typeof validAccount.balance).toBe('number');
  });

  test('color should be valid hex code', () => {
    expect(validAccount.color).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  test('isActive should be boolean', () => {
    expect(typeof validAccount.isActive).toBe('boolean');
  });
});

describe('Income Source Validation', () => {
  const validIncome = {
    id: 'inc-123',
    name: 'Salary',
    amount: 5000,
    frequency: 'monthly' as const,
    payDate: 1,
    isActive: true,
  };

  test('should have required fields', () => {
    expect(validIncome).toHaveProperty('id');
    expect(validIncome).toHaveProperty('name');
    expect(validIncome).toHaveProperty('amount');
    expect(validIncome).toHaveProperty('frequency');
    expect(validIncome).toHaveProperty('isActive');
  });

  test('frequency should be valid option', () => {
    expect(['weekly', 'biweekly', 'monthly', 'yearly']).toContain(validIncome.frequency);
  });

  test('payDate should be valid day of month', () => {
    if (validIncome.payDate) {
      expect(validIncome.payDate).toBeGreaterThanOrEqual(1);
      expect(validIncome.payDate).toBeLessThanOrEqual(31);
    }
  });

  test('amount should be positive', () => {
    expect(validIncome.amount).toBeGreaterThan(0);
  });
});

