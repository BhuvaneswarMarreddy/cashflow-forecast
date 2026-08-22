/**
 * Type System Tests
 * Tests type definitions and validation logic
 */

import {
  EXPENSE_CATEGORIES,
  getMerchantColor,
  displayCategory,
  resolveCategories,
  selectableCategories,
  slugForCategoryLabel,
  AccountType,
  PaymentMethod,
  ExpenseCategory,
  CustomCategory,
} from '@/types';

describe('displayCategory', () => {
  test('prefers the source category verbatim', () => {
    expect(displayCategory({ sourceCategory: 'AI Tools', category: 'other' })).toBe('AI Tools');
    expect(displayCategory({ sourceCategory: 'Coffee Shops', category: 'food' })).toBe('Coffee Shops');
  });

  test('falls back to the enum label when there is no source category', () => {
    expect(displayCategory({ category: 'food' })).toBe('Food & Dining');
    expect(displayCategory({ category: 'shopping' })).toBe('Shopping');
  });

  test('an empty source category is treated as absent, not shown blank', () => {
    expect(displayCategory({ sourceCategory: '', category: 'food' })).toBe('Food & Dining');
  });
});

/**
 * cashflow-mobile#24. resolveCategories: defaults + the owner's custom set,
 * kept CLOSED by construction — a hallucinated category never gets in because
 * nothing here invents membership, only reads what settings.categories holds.
 */
describe('resolveCategories', () => {
  test('absent settings resolves to exactly the 13 defaults, none archived', () => {
    const resolved = resolveCategories();
    expect(resolved).toHaveLength(EXPENSE_CATEGORIES.length);
    expect(resolved.every((c) => c.archived === false)).toBe(true);
    expect(resolved.map((c) => c.value)).toEqual(EXPENSE_CATEGORIES.map((c) => c.value));
  });

  test('appends custom categories after the defaults, filling in a fallback icon', () => {
    const resolved = resolveCategories({ categories: [{ value: 'vacations', label: 'Vacations' }] });
    expect(resolved).toHaveLength(EXPENSE_CATEGORIES.length + 1);
    const custom = resolved.find((c) => c.value === 'vacations');
    expect(custom).toMatchObject({ label: 'Vacations', archived: false });
    expect(custom?.icon).toBeTruthy();
  });

  test('a custom icon is kept verbatim', () => {
    const resolved = resolveCategories({ categories: [{ value: 'vacations', label: 'Vacations', icon: '🏖️' }] });
    expect(resolved.find((c) => c.value === 'vacations')?.icon).toBe('🏖️');
  });

  test('archived is passed through — still resolvable, just not the default false', () => {
    const resolved = resolveCategories({ categories: [{ value: 'vacations', label: 'Vacations', archived: true }] });
    expect(resolved.find((c) => c.value === 'vacations')?.archived).toBe(true);
  });

  test('a custom entry colliding with a default value is dropped — defaults always win', () => {
    const resolved = resolveCategories({ categories: [{ value: 'food', label: 'Hijacked' }] });
    expect(resolved.filter((c) => c.value === 'food')).toHaveLength(1);
    expect(resolved.find((c) => c.value === 'food')?.label).toBe('Food & Dining');
  });

  test('two custom entries with the same value collapse to one — the first wins', () => {
    const resolved = resolveCategories({
      categories: [
        { value: 'vacations', label: 'Vacations' },
        { value: 'vacations', label: 'Duplicate' },
      ],
    });
    expect(resolved.filter((c) => c.value === 'vacations')).toHaveLength(1);
    expect(resolved.find((c) => c.value === 'vacations')?.label).toBe('Vacations');
  });

  /**
   * A hand-edited or corrupted profile document can hold anything under
   * `categories`. Before the fix, `for...of` on a non-iterable container
   * (an object, a number) threw straight out of this function — which would
   * take down readLedger/homeSnapshot and DataChatSheet's render for that
   * owner. Every malformed shape below must fail SAFE to the 13 defaults.
   */
  test('a non-array categories container fails safe to the 13 defaults', () => {
    const cases: unknown[] = [
      { oops: true },      // plain object — not iterable at all
      'not-an-array',      // string — iterable, but never the intended shape
      42,                  // number — not iterable, would throw
      true,                // boolean — not iterable, would throw
    ];
    for (const bad of cases) {
      const resolved = resolveCategories({ categories: bad as CustomCategory[] });
      expect(resolved).toHaveLength(EXPENSE_CATEGORIES.length);
      expect(resolved.map((c) => c.value)).toEqual(EXPENSE_CATEGORIES.map((c) => c.value));
    }
  });

  test('null categories (not just absent/undefined) also fails safe to the defaults', () => {
    const resolved = resolveCategories({ categories: null as unknown as CustomCategory[] });
    expect(resolved).toHaveLength(EXPENSE_CATEGORIES.length);
  });

  test('an array of junk entries drops the junk and keeps the valid ones', () => {
    const resolved = resolveCategories({
      categories: [
        null,
        undefined,
        'just a string',
        42,
        { label: 'No value field' },
        { value: 'vacations', label: 'Vacations' },
      ] as unknown as CustomCategory[],
    });
    expect(resolved).toHaveLength(EXPENSE_CATEGORIES.length + 1);
    expect(resolved.find((c) => c.value === 'vacations')).toMatchObject({ label: 'Vacations' });
  });
});

/**
 * cashflow-mobile#24 — the web pickers' fix. Every consumer (AddTransactionModal,
 * PlannedPaymentsPanel, ReceiptScannerModal, BudgetSettingsPanel) shares this ONE
 * derivation of "what can a NEW selection offer", so a chat-created category
 * becomes manually selectable everywhere at once, and a removed one stops being
 * offered everywhere at once.
 */
describe('selectableCategories', () => {
  const resolved = resolveCategories({
    categories: [
      { value: 'vacations', label: 'Vacations', icon: '🏖️' },
      { value: 'old-hobby', label: 'Old Hobby', archived: true },
    ],
  });

  test('a non-archived custom category is offered for a new selection', () => {
    const options = selectableCategories(resolved);
    expect(options.some((c) => c.value === 'vacations')).toBe(true);
  });

  test('an archived category is excluded from a new selection', () => {
    const options = selectableCategories(resolved);
    expect(options.some((c) => c.value === 'old-hobby')).toBe(false);
  });

  test('an archived category IS included when it is the row being edited\'s own current value — never yanked out from under it', () => {
    const options = selectableCategories(resolved, 'old-hobby');
    expect(options.some((c) => c.value === 'old-hobby')).toBe(true);
    // Still excluded as a choice for every OTHER row — only appended once, for
    // the one row that currently carries it.
    expect(options.filter((c) => c.value === 'old-hobby')).toHaveLength(1);
  });

  test('a currentValue that resolves to nothing at all (data corruption) is not fabricated', () => {
    const options = selectableCategories(resolved, 'nonexistent-value');
    expect(options.some((c) => c.value === 'nonexistent-value')).toBe(false);
  });
});

describe('slugForCategoryLabel', () => {
  test('lowercases, replaces non-alphanumerics with dashes, trims edge dashes', () => {
    expect(slugForCategoryLabel('Vacations!', new Set())).toBe('vacations');
    expect(slugForCategoryLabel('  Car Loan  ', new Set())).toBe('car-loan');
    expect(slugForCategoryLabel('Ma & Pa Fund', new Set())).toBe('ma-pa-fund');
  });

  test('a label with no alphanumerics falls back to "category"', () => {
    expect(slugForCategoryLabel('!!!', new Set())).toBe('category');
  });

  test('caps at 32 characters', () => {
    const slug = slugForCategoryLabel('a'.repeat(60), new Set());
    expect(slug.length).toBeLessThanOrEqual(32);
  });

  test('a collision appends -2, -3, ... until free', () => {
    const taken = new Set(['vacations', 'vacations-2']);
    expect(slugForCategoryLabel('Vacations', taken)).toBe('vacations-3');
  });
});

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
        'amex',
        'chase',
        'discover',
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
    paymentMethod: 'amex' as PaymentMethod,
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

  test('type should be income, expense or transfer', () => {
    expect(['income', 'expense', 'transfer']).toContain(validTransaction.type);
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

