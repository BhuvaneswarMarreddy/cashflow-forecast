/**
 * Reminders Generation Tests
 */

import {
  generateAccountReminders,
  generateTransactionReminders,
  getAllUpcomingReminders,
  categorizeReminders,
  getPendingReminderCount,
} from '../lib/reminders';
import { PaymentAccount, Transaction, Reminder, NotificationPreferences } from '../types';
import { addDays, format, subDays } from 'date-fns';

// Helper to create mock credit card with due date
const mockCreditCard = (
  dueDate: number,
  balance: number,
  name: string = 'Credit Card'
): PaymentAccount => ({
  id: `card_${Math.random().toString(36).substr(2, 9)}`,
  name,
  type: 'credit_card',
  provider: 'visa',
  balance,
  creditLimit: 5000,
  dueDate,
  color: '#1a1f71',
  isActive: true,
});

// Helper to create mock recurring transaction
const mockRecurringTransaction = (
  title: string,
  amount: number,
  category: 'subscriptions' | 'utilities' | 'insurance' | 'rent',
  daysFromNow: number = 0
): Transaction => {
  const date = addDays(new Date(), daysFromNow);
  return {
    id: `txn_${Math.random().toString(36).substr(2, 9)}`,
    title,
    amount,
    type: 'expense',
    category,
    paymentMethod: 'chase',
    date: format(date, 'yyyy-MM-dd'),
    isRecurring: true,
    recurringFrequency: 'monthly',
  };
};

describe('Reminders', () => {
  describe('generateAccountReminders', () => {
    it('should generate reminders for credit cards with balance', () => {
      // Create card with due date in the next 14 days
      const today = new Date();
      const futureDueDate = (today.getDate() + 7) % 28 + 1; // Due in ~7 days
      
      const accounts = [
        mockCreditCard(futureDueDate, 500, 'Chase Card'),
      ];
      
      const reminders = generateAccountReminders(accounts, undefined, [], 14);
      
      expect(reminders.length).toBeGreaterThan(0);
      expect(reminders.some(r => r.type === 'credit_card')).toBe(true);
    });
    
    it('should not generate reminders for zero-balance cards', () => {
      const accounts = [
        mockCreditCard(15, 0, 'Empty Card'),
      ];
      
      const reminders = generateAccountReminders(accounts, undefined, [], 14);
      
      expect(reminders.length).toBe(0);
    });
    
    it('should respect reminder day preferences', () => {
      const today = new Date();
      const futureDueDate = (today.getDate() + 10) % 28 + 1;
      
      const accounts = [mockCreditCard(futureDueDate, 500)];
      const prefs: NotificationPreferences = {
        remindDaysBefore: [1, 3], // Only remind 1 and 3 days before
        channels: ['in_app'],
        billRemindersEnabled: true,
      };
      
      const reminders = generateAccountReminders(accounts, prefs, [], 14);
      
      // Should have reminders at due date plus advance notices
      expect(reminders.some(r => r.title.includes('1 day'))).toBe(true);
      expect(reminders.some(r => r.title.includes('3 days'))).toBe(true);
    });
    
    it('should not create duplicate reminders', () => {
      const today = new Date();
      const futureDueDate = (today.getDate() + 7) % 28 + 1;
      
      const accounts = [mockCreditCard(futureDueDate, 500, 'Card')];
      
      // First generation
      const reminders1 = generateAccountReminders(accounts, undefined, [], 14);
      
      // Second generation with existing reminders
      const reminders2 = generateAccountReminders(accounts, undefined, reminders1, 14);
      
      // Should not generate duplicates
      expect(reminders2.length).toBe(0);
    });
  });
  
  describe('generateTransactionReminders', () => {
    it('should generate reminders for recurring subscriptions', () => {
      const transactions = [
        mockRecurringTransaction('Netflix', 15.99, 'subscriptions', 5),
      ];
      
      const reminders = generateTransactionReminders(transactions, undefined, [], 14);
      
      expect(reminders.length).toBeGreaterThan(0);
      expect(reminders.some(r => r.type === 'subscription')).toBe(true);
    });
    
    it('should generate reminders for utility bills', () => {
      const transactions = [
        mockRecurringTransaction('Electric Bill', 150, 'utilities', 3),
      ];
      
      const reminders = generateTransactionReminders(transactions, undefined, [], 14);
      
      expect(reminders.some(r => r.type === 'bill')).toBe(true);
    });
    
    it('should skip non-recurring transactions', () => {
      const transactions: Transaction[] = [
        {
          id: 'one-time',
          title: 'One-time purchase',
          amount: 50,
          type: 'expense',
          category: 'shopping',
          paymentMethod: 'visa',
          date: new Date().toISOString(),
          isRecurring: false,
        },
      ];
      
      const reminders = generateTransactionReminders(transactions, undefined, [], 14);
      
      expect(reminders.length).toBe(0);
    });
  });
  
  describe('categorizeReminders', () => {
    it('should categorize reminders by urgency', () => {
      const today = format(new Date(), 'yyyy-MM-dd');
      const tomorrow = format(addDays(new Date(), 1), 'yyyy-MM-dd');
      const nextWeek = format(addDays(new Date(), 5), 'yyyy-MM-dd');
      const later = format(addDays(new Date(), 10), 'yyyy-MM-dd');
      const yesterday = format(subDays(new Date(), 1), 'yyyy-MM-dd');
      
      const reminders: Reminder[] = [
        { id: '1', date: today, title: 'Today Bill', type: 'bill', status: 'upcoming', createdAt: today },
        { id: '2', date: tomorrow, title: 'Tomorrow Bill', type: 'bill', status: 'upcoming', createdAt: today },
        { id: '3', date: nextWeek, title: 'This Week', type: 'bill', status: 'upcoming', createdAt: today },
        { id: '4', date: later, title: 'Later', type: 'bill', status: 'upcoming', createdAt: today },
        { id: '5', date: yesterday, title: 'Overdue', type: 'bill', status: 'upcoming', createdAt: yesterday },
      ];
      
      const categorized = categorizeReminders(reminders);
      
      expect(categorized.today.length).toBe(1);
      expect(categorized.thisWeek.length).toBe(2); // Tomorrow + 5 days from now
      expect(categorized.later.length).toBe(1);
      expect(categorized.overdue.length).toBe(1);
    });
    
    it('should skip non-upcoming reminders', () => {
      const today = format(new Date(), 'yyyy-MM-dd');
      
      const reminders: Reminder[] = [
        { id: '1', date: today, title: 'Paid', type: 'bill', status: 'paid', createdAt: today },
        { id: '2', date: today, title: 'Dismissed', type: 'bill', status: 'dismissed', createdAt: today },
        { id: '3', date: today, title: 'Upcoming', type: 'bill', status: 'upcoming', createdAt: today },
      ];
      
      const categorized = categorizeReminders(reminders);
      
      expect(categorized.today.length).toBe(1);
      expect(categorized.today[0].title).toBe('Upcoming');
    });
  });
  
  describe('getPendingReminderCount', () => {
    it('should count reminders in next 3 days', () => {
      const today = format(new Date(), 'yyyy-MM-dd');
      const in2Days = format(addDays(new Date(), 2), 'yyyy-MM-dd');
      const in5Days = format(addDays(new Date(), 5), 'yyyy-MM-dd');
      
      const reminders: Reminder[] = [
        { id: '1', date: today, title: 'Today', type: 'bill', status: 'upcoming', createdAt: today },
        { id: '2', date: in2Days, title: 'Soon', type: 'bill', status: 'upcoming', createdAt: today },
        { id: '3', date: in5Days, title: 'Later', type: 'bill', status: 'upcoming', createdAt: today },
      ];
      
      const count = getPendingReminderCount(reminders);
      
      expect(count).toBe(2); // Today + in2Days
    });
    
    it('should not count paid or dismissed reminders', () => {
      const today = format(new Date(), 'yyyy-MM-dd');
      
      const reminders: Reminder[] = [
        { id: '1', date: today, title: 'Paid', type: 'bill', status: 'paid', createdAt: today },
        { id: '2', date: today, title: 'Upcoming', type: 'bill', status: 'upcoming', createdAt: today },
      ];
      
      const count = getPendingReminderCount(reminders);
      
      expect(count).toBe(1);
    });
  });
  
  describe('getAllUpcomingReminders', () => {
    it('should combine account and transaction reminders', () => {
      const today = new Date();
      const futureDueDate = (today.getDate() + 7) % 28 + 1;
      
      const accounts = [mockCreditCard(futureDueDate, 500)];
      const transactions = [
        mockRecurringTransaction('Netflix', 15.99, 'subscriptions', 5),
      ];
      
      const reminders = getAllUpcomingReminders(accounts, transactions, undefined, [], 14);
      
      expect(reminders.some(r => r.type === 'credit_card')).toBe(true);
      expect(reminders.some(r => r.type === 'subscription')).toBe(true);
    });
    
    it('should sort reminders by date', () => {
      const today = new Date();
      const accounts: PaymentAccount[] = [];
      const transactions = [
        mockRecurringTransaction('Late Bill', 100, 'utilities', 10),
        mockRecurringTransaction('Early Bill', 100, 'utilities', 3),
      ];
      
      const reminders = getAllUpcomingReminders(accounts, transactions, undefined, [], 14);
      
      // Should be sorted by date (earliest first)
      for (let i = 1; i < reminders.length; i++) {
        expect(reminders[i].date >= reminders[i - 1].date).toBe(true);
      }
    });
  });
});


