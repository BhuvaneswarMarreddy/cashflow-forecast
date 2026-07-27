'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { useTransactions } from '@/context/TransactionContext';
import { useUserProfile } from '@/context/UserProfileContext';
import Navbar from '@/components/Navbar';
import AddTransactionModal from '@/components/AddTransactionModal';
import { PAYMENT_METHODS, EXPENSE_CATEGORIES, Transaction } from '@/types';
import { isPositive } from '@/lib/classify';
import { formatMoney } from '@/lib/money';
import {
  TrendingUp,
  Plus,
  ChevronLeft,
  ChevronRight,
  X,
  Trash2,
  Edit3,
} from 'lucide-react';
import {
  format,
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  addMonths,
  subMonths,
  eachDayOfInterval,
  isSameMonth,
  isSameDay,
  parseISO,
  isToday,
} from 'date-fns';

export default function CalendarPage() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { transactions, isLoading: txnLoading, deleteTransaction, getTransactionsByDate } = useTransactions();
  const { profile } = useUserProfile();
  const router = useRouter();
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [showDayModal, setShowDayModal] = useState(false);

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      router.push('/login');
    }
  }, [isAuthenticated, authLoading, router]);

  if (authLoading || txnLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse-glow w-16 h-16 rounded-2xl bg-gradient-to-br from-[var(--accent-primary)] to-[var(--accent-secondary)] flex items-center justify-center">
          <TrendingUp className="w-8 h-8 text-white" />
        </div>
      </div>
    );
  }

  if (!isAuthenticated) return null;

  const monthStart = startOfMonth(currentMonth);
  const monthEnd = endOfMonth(currentMonth);
  const calendarStart = startOfWeek(monthStart);
  const calendarEnd = endOfWeek(monthEnd);
  
  const calendarDays = eachDayOfInterval({ start: calendarStart, end: calendarEnd });

  const getDayTransactions = (date: Date): Transaction[] => {
    return transactions.filter((t) => isSameDay(parseISO(t.date), date));
  };

  const getDayTotal = (date: Date): { income: number; expense: number } => {
    const dayTxns = getDayTransactions(date);
    return {
      income: dayTxns.filter((t) => t.type === 'income').reduce((sum, t) => sum + t.amount, 0),
      expense: dayTxns.filter((t) => t.type === 'expense').reduce((sum, t) => sum + t.amount, 0),
    };
  };

  const handleDayClick = (date: Date) => {
    setSelectedDate(date);
    setShowDayModal(true);
  };

  const handleAddTransaction = (date: Date) => {
    setSelectedDate(date);
    setShowDayModal(false);
    setIsModalOpen(true);
  };

  const selectedDateTransactions = selectedDate ? getDayTransactions(selectedDate) : [];

  const weekDays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // Calculate monthly summary
  const monthlyTransactions = transactions.filter((t) => {
    const txnDate = parseISO(t.date);
    return isSameMonth(txnDate, currentMonth);
  });

  const monthlyIncome = monthlyTransactions
    .filter((t) => t.type === 'income')
    .reduce((sum, t) => sum + t.amount, 0);

  const monthlyExpenses = monthlyTransactions
    .filter((t) => t.type === 'expense')
    .reduce((sum, t) => sum + t.amount, 0);

  return (
    <div className="min-h-screen relative">
      <div className="bg-pattern" />
      <Navbar />
      
      <main className="pt-24 pb-12 px-4 sm:px-6 lg:px-8 max-w-7xl mx-auto relative z-10">
        {/* Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-8">
          <div>
            <h1 className="text-3xl font-bold text-[var(--foreground)]">Calendar</h1>
            <p className="text-[var(--foreground-secondary)] mt-1">
              View and manage your transactions by date
            </p>
          </div>
          <button
            onClick={() => {
              setSelectedDate(new Date());
              setIsModalOpen(true);
            }}
            className="btn-primary flex items-center gap-2"
          >
            <Plus className="w-5 h-5" />
            Add Transaction
          </button>
        </div>

        {/* Monthly Summary Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
          <div className="stat-card">
            <p className="text-[var(--foreground-secondary)] text-sm font-medium mb-2">
              {format(currentMonth, 'MMMM')} Income
            </p>
            <p className="text-2xl font-bold text-[var(--accent-success)]">
              ${monthlyIncome.toLocaleString('en-US', { minimumFractionDigits: 2 })}
            </p>
          </div>
          <div className="stat-card">
            <p className="text-[var(--foreground-secondary)] text-sm font-medium mb-2">
              {format(currentMonth, 'MMMM')} Expenses
            </p>
            <p className="text-2xl font-bold text-[var(--accent-danger)]">
              ${monthlyExpenses.toLocaleString('en-US', { minimumFractionDigits: 2 })}
            </p>
          </div>
          <div className="stat-card">
            <p className="text-[var(--foreground-secondary)] text-sm font-medium mb-2">
              {format(currentMonth, 'MMMM')} Net
            </p>
            <p className={`text-2xl font-bold ${monthlyIncome - monthlyExpenses >= 0 ? 'text-[var(--accent-success)]' : 'text-[var(--accent-danger)]'}`}>
              ${Math.abs(monthlyIncome - monthlyExpenses).toLocaleString('en-US', { minimumFractionDigits: 2 })}
            </p>
          </div>
        </div>

        {/* Calendar */}
        <div className="glass-card p-3 sm:p-6">
          {/* Month Navigation */}
          <div className="flex items-center justify-between mb-6">
            <button
              onClick={() => setCurrentMonth(subMonths(currentMonth, 1))}
              aria-label="Previous month"
              className="p-2 rounded-xl text-[var(--foreground-secondary)] hover:bg-[var(--background-tertiary)] hover:text-[var(--foreground)] transition-all"
            >
              <ChevronLeft className="w-6 h-6" />
            </button>
            <h2 className="text-xl font-bold text-[var(--foreground)]">
              {format(currentMonth, 'MMMM yyyy')}
            </h2>
            <button
              onClick={() => setCurrentMonth(addMonths(currentMonth, 1))}
              aria-label="Next month"
              className="p-2 rounded-xl text-[var(--foreground-secondary)] hover:bg-[var(--background-tertiary)] hover:text-[var(--foreground)] transition-all"
            >
              <ChevronRight className="w-6 h-6" />
            </button>
          </div>

          {/* Week Days Header */}
          <div className="grid grid-cols-7 gap-1 sm:gap-2 mb-2">
            {weekDays.map((day) => (
              <div
                key={day}
                className="text-center text-sm font-medium text-[var(--foreground-secondary)] py-2"
              >
                {day}
              </div>
            ))}
          </div>

          {/* Calendar Grid */}
          <div className="grid grid-cols-7 gap-1 sm:gap-2">
            {calendarDays.map((day) => {
              const dayTxns = getDayTransactions(day);
              const { income, expense } = getDayTotal(day);
              const hasTransactions = dayTxns.length > 0;
              const hasExpense = expense > 0;
              const hasIncome = income > 0;
              const net = income - expense;

              return (
                <button
                  key={day.toISOString()}
                  onClick={() => handleDayClick(day)}
                  aria-label={`${format(day, 'MMMM d')}, ${dayTxns.length} transaction${dayTxns.length === 1 ? '' : 's'}${hasTransactions ? `, net ${formatMoney(net)}` : ''}`}
                  className={`calendar-day max-sm:p-1! max-sm:min-h-11! max-sm:aspect-auto! ${
                    !isSameMonth(day, currentMonth) ? 'opacity-30' : ''
                  } ${isToday(day) ? 'today' : ''} ${
                    hasTransactions ? 'has-expense' : ''
                  } ${hasIncome && !hasExpense ? 'has-income' : ''}`}
                >
                  <span className={`text-sm font-medium ${isToday(day) ? 'text-[var(--accent-secondary)]' : 'text-[var(--foreground)]'}`}>
                    {format(day, 'd')}
                  </span>
                  {hasTransactions && (
                    <div className="hidden sm:block mt-1 space-y-0.5 w-full overflow-hidden">
                      {hasExpense && (
                        <div className="text-[10px] text-[var(--accent-danger)] truncate">
                          -${expense > 999 ? (expense / 1000).toFixed(1) + 'k' : expense.toFixed(0)}
                        </div>
                      )}
                      {hasIncome && (
                        <div className="text-[10px] text-[var(--accent-success)] truncate">
                          +${income > 999 ? (income / 1000).toFixed(1) + 'k' : income.toFixed(0)}
                        </div>
                      )}
                    </div>
                  )}
                </button>
              );
            })}
          </div>

          {/* Legend */}
          <div className="flex items-center gap-6 mt-6 pt-4 border-t border-[var(--border-color)]">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-[var(--accent-danger)]" />
              <span className="text-sm text-[var(--foreground-secondary)]">Expense</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-[var(--accent-success)]" />
              <span className="text-sm text-[var(--foreground-secondary)]">Income</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full border-2 border-[var(--accent-secondary)]" />
              <span className="text-sm text-[var(--foreground-secondary)]">Today</span>
            </div>
          </div>
        </div>
      </main>

      {/* Day Detail Modal */}
      {showDayModal && selectedDate && (
        <div className="modal-overlay" onClick={() => setShowDayModal(false)}>
          <div className="modal-content max-w-lg" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-6">
              <div>
                <h2 className="text-2xl font-bold text-[var(--foreground)]">
                  {format(selectedDate, 'MMMM d, yyyy')}
                </h2>
                <p className="text-[var(--foreground-secondary)]">
                  {format(selectedDate, 'EEEE')}
                </p>
              </div>
              <button
                onClick={() => setShowDayModal(false)}
                className="p-2 rounded-xl text-[var(--foreground-secondary)] hover:bg-[var(--background-tertiary)] transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Day Summary */}
            {selectedDateTransactions.length > 0 && (
              <div className="grid grid-cols-2 gap-4 mb-6">
                <div className="p-4 rounded-xl bg-[var(--accent-success)]/10">
                  <p className="text-sm text-[var(--foreground-secondary)] mb-1">Income</p>
                  <p className="text-xl font-bold text-[var(--accent-success)]">
                    ${getDayTotal(selectedDate).income.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                  </p>
                </div>
                <div className="p-4 rounded-xl bg-[var(--accent-danger)]/10">
                  <p className="text-sm text-[var(--foreground-secondary)] mb-1">Expenses</p>
                  <p className="text-xl font-bold text-[var(--accent-danger)]">
                    ${getDayTotal(selectedDate).expense.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                  </p>
                </div>
              </div>
            )}

            {/* Transactions List */}
            <div className="space-y-3 max-h-[300px] overflow-y-auto mb-6">
              {selectedDateTransactions.length === 0 ? (
                <p className="text-center text-[var(--foreground-muted)] py-8">
                  No transactions on this day
                </p>
              ) : (
                selectedDateTransactions.map((txn) => {
                  const category = EXPENSE_CATEGORIES.find((c) => c.value === txn.category);
                  const paymentMethod = PAYMENT_METHODS.find((m) => m.value === txn.paymentMethod);
                  const isExpense = !isPositive(txn, profile?.paymentAccounts);

                  return (
                    <div
                      key={txn.id}
                      className={`flex items-center justify-between p-4 rounded-xl bg-[var(--background-tertiary)] border border-[var(--border-color)] payment-${txn.paymentMethod}`}
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-[var(--background-secondary)] flex items-center justify-center text-xl">
                          {category?.icon || '📋'}
                        </div>
                        <div>
                          <p className="font-medium text-[var(--foreground)]">{txn.title}</p>
                          <p className="text-xs text-[var(--foreground-secondary)]" style={{ color: paymentMethod?.color }}>
                            {paymentMethod?.label}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <p className={`font-semibold ${isExpense ? 'text-[var(--accent-danger)]' : 'text-[var(--accent-success)]'}`}>
                          {isExpense ? '-' : '+'}${txn.amount.toFixed(2)}
                        </p>
                        <button
                          onClick={() => { if (window.confirm(`Delete "${txn.title}" (${txn.amount.toFixed(2)})? This can't be undone.`)) deleteTransaction(txn.id); }}
                          aria-label={`Delete ${txn.title}`}
                          className="p-2 rounded-lg text-[var(--foreground-muted)] hover:text-[var(--accent-danger)] hover:bg-[var(--accent-danger)]/10 transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            <button
              onClick={() => handleAddTransaction(selectedDate)}
              className="btn-primary w-full flex items-center justify-center gap-2"
            >
              <Plus className="w-5 h-5" />
              Add Transaction for This Day
            </button>
          </div>
        </div>
      )}

      <AddTransactionModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        defaultDate={selectedDate || undefined}
      />
    </div>
  );
}

