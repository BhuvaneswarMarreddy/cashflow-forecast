'use client';

import React, { useMemo } from 'react';
import { PaymentAccount, Transaction, Reminder, NotificationPreferences } from '@/types';
import { getAllUpcomingReminders, categorizeReminders } from '@/lib/reminders';
import { format, parseISO, isToday, isTomorrow } from 'date-fns';
import { 
  Bell, 
  CreditCard, 
  FileText, 
  Clock, 
  CheckCircle2, 
  AlertCircle,
  Calendar,
  DollarSign,
} from 'lucide-react';

interface UpcomingBillsPanelProps {
  accounts: PaymentAccount[];
  transactions: Transaction[];
  preferences?: NotificationPreferences;
  existingReminders?: Reminder[];
  onMarkPaid?: (reminderId: string) => void;
  onDismiss?: (reminderId: string) => void;
  compact?: boolean;
}

export default function UpcomingBillsPanel({
  accounts,
  transactions,
  preferences,
  existingReminders = [],
  onMarkPaid,
  onDismiss,
  compact = true,
}: UpcomingBillsPanelProps) {
  const reminders = useMemo(() => 
    getAllUpcomingReminders(accounts, transactions, preferences, existingReminders, 14),
    [accounts, transactions, preferences, existingReminders]
  );
  
  const categorized = useMemo(() => 
    categorizeReminders(reminders),
    [reminders]
  );
  
  const totalUpcoming = reminders.length;
  const urgentCount = categorized.today.length + categorized.overdue.length;
  
  const getTypeIcon = (type: Reminder['type']) => {
    switch (type) {
      case 'credit_card':
        return <CreditCard className="w-4 h-4" />;
      case 'loan':
        return <FileText className="w-4 h-4" />;
      case 'subscription':
        return <Clock className="w-4 h-4" />;
      default:
        return <DollarSign className="w-4 h-4" />;
    }
  };
  
  const formatDate = (dateStr: string) => {
    const date = parseISO(dateStr);
    if (isToday(date)) return 'Today';
    if (isTomorrow(date)) return 'Tomorrow';
    return format(date, 'MMM d');
  };
  
  if (totalUpcoming === 0) {
    return (
      <div className="p-4 rounded-card bg-emerald-500/10 border border-emerald-500/30">
        <div className="flex items-center gap-3">
          <CheckCircle2 className="w-5 h-5 text-emerald-500" />
          <div>
            <p className="font-medium text-emerald-500">No upcoming bills</p>
            <p className="text-sm text-[var(--foreground-muted)]">
              You're all caught up for the next 14 days
            </p>
          </div>
        </div>
      </div>
    );
  }
  
  if (compact) {
    // Compact view - show summary and next 3-5 items
    const displayItems = [...categorized.overdue, ...categorized.today, ...categorized.thisWeek].slice(0, 5);
    
    return (
      <div className={`p-4 rounded-card ${
        urgentCount > 0 
          ? 'bg-amber-500/10 border border-amber-500/30' 
          : 'bg-[var(--background-tertiary)] border border-[var(--border-color)]'
      }`}>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Bell className={`w-4 h-4 ${urgentCount > 0 ? 'text-amber-500' : 'text-[var(--foreground-muted)]'}`} />
            <span className="text-sm font-medium text-[var(--foreground)]">Upcoming Bills</span>
            {urgentCount > 0 && (
              <span className="px-2 py-1 text-xs font-medium rounded-pill bg-amber-500 text-white">
                {urgentCount}
              </span>
            )}
          </div>
          <span className="text-xs text-[var(--foreground-muted)]">{totalUpcoming} in 14 days</span>
        </div>
        
        <div className="space-y-2">
          {displayItems.map((reminder) => (
            <div
              key={reminder.id}
              className="flex items-center justify-between py-2"
            >
              <div className="flex items-center gap-2">
                <span className={`${
                  categorized.overdue.includes(reminder) ? 'text-red-500' :
                  categorized.today.includes(reminder) ? 'text-amber-500' :
                  'text-[var(--foreground-muted)]'
                }`}>
                  {getTypeIcon(reminder.type)}
                </span>
                <span className="text-sm text-[var(--foreground)] truncate max-w-[150px]">
                  {reminder.title.replace(/payment due in \d+ days?/, '').replace('payment due', '').trim() || reminder.title}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {reminder.amount && (
                  <span className="text-sm font-medium text-[var(--foreground)]">
                    ${reminder.amount.toLocaleString()}
                  </span>
                )}
                <span className={`text-xs ${
                  categorized.overdue.includes(reminder) ? 'text-red-500 font-medium' :
                  categorized.today.includes(reminder) ? 'text-amber-500 font-medium' :
                  'text-[var(--foreground-muted)]'
                }`}>
                  {formatDate(reminder.date)}
                </span>
              </div>
            </div>
          ))}
        </div>
        
        {totalUpcoming > 5 && (
          <p className="text-xs text-[var(--foreground-muted)] mt-2 text-center">
            +{totalUpcoming - 5} more bills coming up
          </p>
        )}
      </div>
    );
  }
  
  // Full view - grouped by urgency
  return (
    <div className="space-y-4">
      {/* Overdue */}
      {categorized.overdue.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-2">
            <AlertCircle className="w-4 h-4 text-red-500" />
            <span className="text-sm font-medium text-red-500">Overdue</span>
          </div>
          <div className="space-y-2">
            {categorized.overdue.map(reminder => (
              <ReminderCard
                key={reminder.id}
                reminder={reminder}
                isUrgent
                onMarkPaid={onMarkPaid}
                onDismiss={onDismiss}
              />
            ))}
          </div>
        </div>
      )}
      
      {/* Today */}
      {categorized.today.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Calendar className="w-4 h-4 text-amber-500" />
            <span className="text-sm font-medium text-amber-500">Due Today</span>
          </div>
          <div className="space-y-2">
            {categorized.today.map(reminder => (
              <ReminderCard
                key={reminder.id}
                reminder={reminder}
                isUrgent
                onMarkPaid={onMarkPaid}
                onDismiss={onDismiss}
              />
            ))}
          </div>
        </div>
      )}
      
      {/* This Week */}
      {categorized.thisWeek.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Clock className="w-4 h-4 text-[var(--foreground-muted)]" />
            <span className="text-sm font-medium text-[var(--foreground)]">This Week</span>
          </div>
          <div className="space-y-2">
            {categorized.thisWeek.map(reminder => (
              <ReminderCard
                key={reminder.id}
                reminder={reminder}
                onMarkPaid={onMarkPaid}
                onDismiss={onDismiss}
              />
            ))}
          </div>
        </div>
      )}
      
      {/* Later */}
      {categorized.later.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Calendar className="w-4 h-4 text-[var(--foreground-muted)]" />
            <span className="text-sm font-medium text-[var(--foreground-muted)]">Coming Up</span>
          </div>
          <div className="space-y-2">
            {categorized.later.map(reminder => (
              <ReminderCard
                key={reminder.id}
                reminder={reminder}
                onMarkPaid={onMarkPaid}
                onDismiss={onDismiss}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ReminderCard({
  reminder,
  isUrgent = false,
  onMarkPaid,
  onDismiss,
}: {
  reminder: Reminder;
  isUrgent?: boolean;
  onMarkPaid?: (id: string) => void;
  onDismiss?: (id: string) => void;
}) {
  const getTypeIcon = (type: Reminder['type']) => {
    switch (type) {
      case 'credit_card':
        return <CreditCard className="w-5 h-5" />;
      case 'loan':
        return <FileText className="w-5 h-5" />;
      case 'subscription':
        return <Clock className="w-5 h-5" />;
      default:
        return <DollarSign className="w-5 h-5" />;
    }
  };
  
  return (
    <div className={`p-3 rounded-card flex items-center justify-between ${
      isUrgent 
        ? 'bg-amber-500/10 border border-amber-500/20' 
        : 'bg-[var(--background-tertiary)]'
    }`}>
      <div className="flex items-center gap-3">
        <div className={`w-10 h-10 rounded-card flex items-center justify-center ${
          isUrgent ? 'bg-amber-500/20 text-amber-500' : 'bg-[var(--background-secondary)] text-[var(--foreground-muted)]'
        }`}>
          {getTypeIcon(reminder.type)}
        </div>
        <div>
          <p className="font-medium text-[var(--foreground)]">{reminder.title}</p>
          <p className="text-sm text-[var(--foreground-muted)]">
            {format(parseISO(reminder.date), 'MMM d, yyyy')}
          </p>
        </div>
      </div>
      
      <div className="flex items-center gap-3">
        {reminder.amount && (
          <span className="font-semibold text-[var(--foreground)]">
            ${reminder.amount.toLocaleString()}
          </span>
        )}
        
        {(onMarkPaid || onDismiss) && (
          <div className="flex gap-1">
            {onMarkPaid && (
              <button
                onClick={() => onMarkPaid(reminder.id)}
                className="p-2 rounded-control text-emerald-500 hover:bg-emerald-500/10 transition-colors"
                title="Mark as paid"
              >
                <CheckCircle2 className="w-4 h-4" />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}


