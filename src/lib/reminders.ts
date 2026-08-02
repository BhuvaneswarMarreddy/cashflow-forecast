/**
 * Bill Reminder Generator
 * 
 * Generates reminders from:
 * - Credit card due dates
 * - Loan due dates  
 * - Recurring transactions marked as bills
 * 
 * Idempotent: safe to call multiple times (on login, app open)
 */

import { 
  PaymentAccount, 
  Transaction, 
  Reminder, 
  NotificationPreferences 
} from '@/types';
import { currentOf } from '@/lib/accounts';
import { interpretTransaction } from '@/lib/classify';
import {
  addDays,
  format, 
  parseISO, 
  isBefore, 
  isAfter, 
  startOfDay 
} from 'date-fns';

const DEFAULT_REMINDER_DAYS = [1, 3, 7]; // Days before due date

/**
 * Generate unique reminder ID to prevent duplicates
 */
function generateReminderId(
  type: Reminder['type'],
  date: string,
  accountId?: string,
  transactionId?: string
): string {
  const parts = [type, date];
  if (accountId) parts.push(accountId);
  if (transactionId) parts.push(transactionId);
  return parts.join('_');
}

/**
 * Get upcoming reminders for credit cards and loans
 */
export function generateAccountReminders(
  accounts: PaymentAccount[],
  preferences: NotificationPreferences | undefined,
  existingReminders: Reminder[],
  daysAhead: number = 14
): Reminder[] {
  const reminders: Reminder[] = [];
  const today = startOfDay(new Date());
  const endDate = addDays(today, daysAhead);
  const remindDays = preferences?.remindDaysBefore || DEFAULT_REMINDER_DAYS;
  
  // Get existing reminder IDs to avoid duplicates
  const existingIds = new Set(existingReminders.map(r => r.id));
  
  // Credit cards
  accounts
    .filter(a => a.type === 'credit_card' && a.dueDate && currentOf(a) > 0)
    .forEach(card => {
      // Calculate next due date
      const now = new Date();
      let dueDate = new Date(now.getFullYear(), now.getMonth(), card.dueDate!);
      
      if (isBefore(dueDate, today)) {
        dueDate = new Date(now.getFullYear(), now.getMonth() + 1, card.dueDate!);
      }
      
      if (isAfter(dueDate, endDate)) return;
      
      // Generate reminder for due date
      const dueDateStr = format(dueDate, 'yyyy-MM-dd');
      const id = generateReminderId('credit_card', dueDateStr, card.id);
      
      if (!existingIds.has(id)) {
        reminders.push({
          id,
          date: dueDateStr,
          title: `${card.name} payment due`,
          amount: currentOf(card),
          relatedAccountId: card.id,
          type: 'credit_card',
          status: 'upcoming',
          createdAt: new Date().toISOString(),
        });
      }
      
      // Generate advance reminders
      remindDays.forEach(daysBefore => {
        const reminderDate = addDays(dueDate, -daysBefore);
        if (isBefore(reminderDate, today)) return;
        
        const reminderDateStr = format(reminderDate, 'yyyy-MM-dd');
        const reminderId = generateReminderId('credit_card', reminderDateStr, card.id, `remind_${daysBefore}`);
        
        if (!existingIds.has(reminderId)) {
          reminders.push({
            id: reminderId,
            date: reminderDateStr,
            title: `${card.name} payment due in ${daysBefore} day${daysBefore > 1 ? 's' : ''}`,
            amount: currentOf(card),
            relatedAccountId: card.id,
            type: 'credit_card',
            status: 'upcoming',
            createdAt: new Date().toISOString(),
          });
        }
      });
    });
  
  // Loans
  accounts
    .filter(a => a.type === 'personal_loan' && a.dueDate && a.monthlyPayment)
    .forEach(loan => {
      const now = new Date();
      let dueDate = new Date(now.getFullYear(), now.getMonth(), loan.dueDate!);
      
      if (isBefore(dueDate, today)) {
        dueDate = new Date(now.getFullYear(), now.getMonth() + 1, loan.dueDate!);
      }
      
      if (isAfter(dueDate, endDate)) return;
      
      const dueDateStr = format(dueDate, 'yyyy-MM-dd');
      const id = generateReminderId('loan', dueDateStr, loan.id);
      
      if (!existingIds.has(id)) {
        reminders.push({
          id,
          date: dueDateStr,
          title: `${loan.name} payment due`,
          amount: loan.monthlyPayment,
          relatedAccountId: loan.id,
          type: 'loan',
          status: 'upcoming',
          createdAt: new Date().toISOString(),
        });
      }
      
      // Generate advance reminders
      remindDays.forEach(daysBefore => {
        const reminderDate = addDays(dueDate, -daysBefore);
        if (isBefore(reminderDate, today)) return;
        
        const reminderDateStr = format(reminderDate, 'yyyy-MM-dd');
        const reminderId = generateReminderId('loan', reminderDateStr, loan.id, `remind_${daysBefore}`);
        
        if (!existingIds.has(reminderId)) {
          reminders.push({
            id: reminderId,
            date: reminderDateStr,
            title: `${loan.name} payment due in ${daysBefore} day${daysBefore > 1 ? 's' : ''}`,
            amount: loan.monthlyPayment,
            relatedAccountId: loan.id,
            type: 'loan',
            status: 'upcoming',
            createdAt: new Date().toISOString(),
          });
        }
      });
    });
  
  return reminders;
}

/**
 * Get upcoming reminders from recurring transactions (subscriptions, bills)
 */
export function generateTransactionReminders(
  transactions: Transaction[],
  preferences: NotificationPreferences | undefined,
  existingReminders: Reminder[],
  daysAhead: number = 14,
  accounts?: PaymentAccount[]
): Reminder[] {
  const reminders: Reminder[] = [];
  const today = startOfDay(new Date());
  const endDate = addDays(today, daysAhead);
  const remindDays = preferences?.remindDaysBefore || DEFAULT_REMINDER_DAYS;
  
  const existingIds = new Set(existingReminders.map(r => r.id));
  
  // Get recurring expense transactions
  // The shared interpretation decides what is a bill, not the stored type: a
  // recurring credit-card payment is a transfer and must not become a second
  // "bill due" next to the purchases that made it.
  //
  // PENDING: EXCLUDED. A hold is not evidence a bill exists — reminding on one
  // would fire a notification for a charge that may never post at that amount.
  transactions
    .filter(t =>
      t.isRecurring &&
      interpretTransaction(t, accounts).expense === 'counted' &&
      (t.category === 'subscriptions' || t.category === 'utilities' || t.category === 'insurance' || t.category === 'rent')
    )
    .forEach(txn => {
      const txnDate = parseISO(txn.date);
      let nextDueDate = new Date(txnDate);
      
      // Find next occurrence
      while (isBefore(nextDueDate, today)) {
        if (txn.recurringFrequency === 'weekly') {
          nextDueDate = addDays(nextDueDate, 7);
        } else if (txn.recurringFrequency === 'monthly') {
          nextDueDate = new Date(nextDueDate.getFullYear(), nextDueDate.getMonth() + 1, nextDueDate.getDate());
        } else if (txn.recurringFrequency === 'yearly') {
          nextDueDate = new Date(nextDueDate.getFullYear() + 1, nextDueDate.getMonth(), nextDueDate.getDate());
        } else {
          break;
        }
      }
      
      if (isAfter(nextDueDate, endDate)) return;
      
      const dueDateStr = format(nextDueDate, 'yyyy-MM-dd');
      const type: Reminder['type'] = txn.category === 'subscriptions' ? 'subscription' : 'bill';
      const id = generateReminderId(type, dueDateStr, undefined, txn.id);
      
      if (!existingIds.has(id)) {
        reminders.push({
          id,
          date: dueDateStr,
          title: `${txn.title} due`,
          amount: txn.amount,
          relatedTransactionId: txn.id,
          type,
          status: 'upcoming',
          createdAt: new Date().toISOString(),
        });
      }
      
      // Advance reminders
      remindDays.forEach(daysBefore => {
        const reminderDate = addDays(nextDueDate, -daysBefore);
        if (isBefore(reminderDate, today)) return;
        
        const reminderDateStr = format(reminderDate, 'yyyy-MM-dd');
        const reminderId = generateReminderId(type, reminderDateStr, undefined, `${txn.id}_remind_${daysBefore}`);
        
        if (!existingIds.has(reminderId)) {
          reminders.push({
            id: reminderId,
            date: reminderDateStr,
            title: `${txn.title} due in ${daysBefore} day${daysBefore > 1 ? 's' : ''}`,
            amount: txn.amount,
            relatedTransactionId: txn.id,
            type,
            status: 'upcoming',
            createdAt: new Date().toISOString(),
          });
        }
      });
    });
  
  return reminders;
}

/**
 * Get all upcoming reminders for the next N days
 * Combines account and transaction reminders
 */
export function getAllUpcomingReminders(
  accounts: PaymentAccount[],
  transactions: Transaction[],
  preferences: NotificationPreferences | undefined,
  existingReminders: Reminder[],
  daysAhead: number = 14
): Reminder[] {
  const accountReminders = generateAccountReminders(accounts, preferences, existingReminders, daysAhead);
  // Accounts are passed on so a recurring card-payment row is recognised as a
  // transfer rather than turned into a duplicate "bill due".
  const transactionReminders = generateTransactionReminders(transactions, preferences, existingReminders, daysAhead, accounts);
  
  // Combine and sort by date
  return [...accountReminders, ...transactionReminders]
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Get reminders for the next 14 days grouped by urgency
 */
export function categorizeReminders(reminders: Reminder[]): {
  today: Reminder[];
  thisWeek: Reminder[];
  later: Reminder[];
  overdue: Reminder[];
} {
  const today = startOfDay(new Date());
  const tomorrow = addDays(today, 1);
  const nextWeek = addDays(today, 7);
  
  const result = {
    today: [] as Reminder[],
    thisWeek: [] as Reminder[],
    later: [] as Reminder[],
    overdue: [] as Reminder[],
  };
  
  reminders.forEach(r => {
    if (r.status !== 'upcoming') return;
    
    const reminderDate = parseISO(r.date);
    
    if (isBefore(reminderDate, today)) {
      result.overdue.push(r);
    } else if (isBefore(reminderDate, tomorrow)) {
      result.today.push(r);
    } else if (isBefore(reminderDate, nextWeek)) {
      result.thisWeek.push(r);
    } else {
      result.later.push(r);
    }
  });
  
  return result;
}

/**
 * Get count of pending reminders (for badge)
 */
export function getPendingReminderCount(reminders: Reminder[]): number {
  const today = startOfDay(new Date());
  const in3Days = addDays(today, 3);
  
  return reminders.filter(r => 
    r.status === 'upcoming' && 
    isBefore(parseISO(r.date), in3Days)
  ).length;
}


