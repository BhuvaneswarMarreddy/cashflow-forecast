'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { useTransactions } from '@/context/TransactionContext';
import Navbar from '@/components/Navbar';
import AddTransactionModal from '@/components/AddTransactionModal';
import { PAYMENT_METHODS, EXPENSE_CATEGORIES, PaymentMethod, Transaction } from '@/types';
import {
  TrendingUp,
  Plus,
  CreditCard,
  ChevronDown,
  ChevronUp,
  ArrowUpRight,
  ArrowDownRight,
  Wallet,
  Building2,
  Trash2,
} from 'lucide-react';
import { format, parseISO } from 'date-fns';

export default function PaymentMethodsPage() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { transactions, isLoading: txnLoading, deleteTransaction, getTransactionsByPaymentMethod } = useTransactions();
  const router = useRouter();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [expandedMethod, setExpandedMethod] = useState<PaymentMethod | null>(null);
  const [filter, setFilter] = useState<'all' | 'past' | 'future'>('all');

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

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const getMethodIcon = (method: PaymentMethod) => {
    switch (method) {
      case 'cash':
        return <Wallet className="w-6 h-6" />;
      case 'bank-transfer':
        return <Building2 className="w-6 h-6" />;
      default:
        return <CreditCard className="w-6 h-6" />;
    }
  };

  const getMethodStats = (method: PaymentMethod) => {
    let methodTransactions = getTransactionsByPaymentMethod(method);
    
    if (filter === 'past') {
      methodTransactions = methodTransactions.filter((t) => new Date(t.date) < today && !t.isProjected);
    } else if (filter === 'future') {
      methodTransactions = methodTransactions.filter((t) => new Date(t.date) >= today || t.isProjected);
    }

    const totalExpenses = methodTransactions
      .filter((t) => t.type === 'expense')
      .reduce((sum, t) => sum + t.amount, 0);

    const totalIncome = methodTransactions
      .filter((t) => t.type === 'income')
      .reduce((sum, t) => sum + t.amount, 0);

    const transactionCount = methodTransactions.length;

    return {
      transactions: methodTransactions.sort((a, b) => 
        new Date(b.date).getTime() - new Date(a.date).getTime()
      ),
      totalExpenses,
      totalIncome,
      transactionCount,
    };
  };

  // Get all methods that have transactions
  const methodsWithData = PAYMENT_METHODS.filter((pm) => {
    const stats = getMethodStats(pm.value);
    return stats.transactionCount > 0;
  });

  // Calculate totals by method
  const methodTotals = PAYMENT_METHODS.map((pm) => ({
    ...pm,
    stats: getMethodStats(pm.value),
  })).filter((pm) => pm.stats.transactionCount > 0);

  const totalAllExpenses = methodTotals.reduce((sum, m) => sum + m.stats.totalExpenses, 0);

  return (
    <div className="min-h-screen relative">
      <div className="bg-pattern" />
      <Navbar />
      
      <main className="pt-24 pb-12 px-4 sm:px-6 lg:px-8 max-w-7xl mx-auto relative z-10">
        {/* Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-8">
          <div>
            <h1 className="text-3xl font-bold text-[var(--foreground)]">Payment Methods</h1>
            <p className="text-[var(--foreground-secondary)] mt-1">
              View expenses categorized by payment method
            </p>
          </div>
          <div className="flex items-center gap-3">
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value as 'all' | 'past' | 'future')}
              className="select-field py-2 px-3"
            >
              <option value="all">All Time</option>
              <option value="past">Past Transactions</option>
              <option value="future">Projected/Future</option>
            </select>
            <button
              onClick={() => setIsModalOpen(true)}
              className="btn-primary flex items-center gap-2"
            >
              <Plus className="w-5 h-5" />
              Add Transaction
            </button>
          </div>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          {methodTotals.slice(0, 4).map((method) => {
            const percentage = totalAllExpenses > 0 
              ? ((method.stats.totalExpenses / totalAllExpenses) * 100).toFixed(1)
              : '0';

            return (
              <div
                key={method.value}
                className="stat-card cursor-pointer hover:border-[var(--border-glow)]"
                onClick={() => setExpandedMethod(expandedMethod === method.value ? null : method.value)}
                style={{ borderLeftColor: method.color, borderLeftWidth: '4px' }}
              >
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <div
                      className="w-10 h-10 rounded-xl flex items-center justify-center"
                      style={{ backgroundColor: `${method.color}20`, color: method.color }}
                    >
                      {getMethodIcon(method.value)}
                    </div>
                    <span className="font-medium text-[var(--foreground)]">{method.label}</span>
                  </div>
                </div>
                <p className="text-2xl font-bold text-[var(--foreground)]">
                  ${method.stats.totalExpenses.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                </p>
                <div className="flex items-center justify-between mt-2">
                  <span className="text-sm text-[var(--foreground-secondary)]">
                    {method.stats.transactionCount} transactions
                  </span>
                  <span className="text-sm font-medium" style={{ color: method.color }}>
                    {percentage}%
                  </span>
                </div>
                {/* Progress bar */}
                <div className="mt-3 h-2 bg-[var(--background-tertiary)] rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{
                      width: `${percentage}%`,
                      backgroundColor: method.color,
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>

        {/* Payment Method Breakdown */}
        <div className="space-y-4">
          {methodTotals.length === 0 ? (
            <div className="glass-card p-12 text-center">
              <CreditCard className="w-16 h-16 text-[var(--foreground-muted)] mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-[var(--foreground)] mb-2">
                No Transactions Yet
              </h3>
              <p className="text-[var(--foreground-secondary)] mb-6">
                Start adding transactions to see them categorized by payment method
              </p>
              <button
                onClick={() => setIsModalOpen(true)}
                className="btn-primary inline-flex items-center gap-2"
              >
                <Plus className="w-5 h-5" />
                Add Your First Transaction
              </button>
            </div>
          ) : (
            methodTotals.map((method) => (
              <div
                key={method.value}
                className="glass-card overflow-hidden"
                style={{ borderLeftColor: method.color, borderLeftWidth: '4px' }}
              >
                {/* Header */}
                <button
                  onClick={() => setExpandedMethod(expandedMethod === method.value ? null : method.value)}
                  className="w-full p-6 flex items-center justify-between hover:bg-[var(--background-tertiary)]/50 transition-colors"
                >
                  <div className="flex items-center gap-4">
                    <div
                      className="w-12 h-12 rounded-xl flex items-center justify-center"
                      style={{ backgroundColor: `${method.color}20`, color: method.color }}
                    >
                      {getMethodIcon(method.value)}
                    </div>
                    <div className="text-left">
                      <h3 className="text-lg font-semibold text-[var(--foreground)]">
                        {method.label}
                      </h3>
                      <p className="text-sm text-[var(--foreground-secondary)]">
                        {method.stats.transactionCount} transactions
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-6">
                    <div className="text-right">
                      <p className="text-lg font-bold text-[var(--accent-danger)]">
                        -${method.stats.totalExpenses.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                      </p>
                      {method.stats.totalIncome > 0 && (
                        <p className="text-sm text-[var(--accent-success)]">
                          +${method.stats.totalIncome.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                        </p>
                      )}
                    </div>
                    {expandedMethod === method.value ? (
                      <ChevronUp className="w-5 h-5 text-[var(--foreground-muted)]" />
                    ) : (
                      <ChevronDown className="w-5 h-5 text-[var(--foreground-muted)]" />
                    )}
                  </div>
                </button>

                {/* Expanded Content */}
                {expandedMethod === method.value && (
                  <div className="border-t border-[var(--border-color)] p-6">
                    <div className="space-y-3 max-h-[400px] overflow-y-auto">
                      {method.stats.transactions.map((txn) => {
                        const category = EXPENSE_CATEGORIES.find((c) => c.value === txn.category);
                        const isExpense = txn.type === 'expense';
                        const isFuture = new Date(txn.date) >= today || txn.isProjected;

                        return (
                          <div
                            key={txn.id}
                            className="flex items-center justify-between p-4 rounded-xl bg-[var(--background-tertiary)] border border-[var(--border-color)]"
                          >
                            <div className="flex items-center gap-4">
                              <div className="w-10 h-10 rounded-xl bg-[var(--background-secondary)] flex items-center justify-center text-xl">
                                {category?.icon || '📋'}
                              </div>
                              <div>
                                <div className="flex items-center gap-2">
                                  <p className="font-medium text-[var(--foreground)]">{txn.title}</p>
                                  {isFuture && (
                                    <span className="badge badge-projected">Projected</span>
                                  )}
                                </div>
                                <div className="flex items-center gap-2 text-sm text-[var(--foreground-secondary)]">
                                  <span>{format(parseISO(txn.date), 'MMM dd, yyyy')}</span>
                                  <span>•</span>
                                  <span>{category?.label}</span>
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center gap-4">
                              <div className="flex items-center gap-1">
                                {isExpense ? (
                                  <ArrowDownRight className="w-4 h-4 text-[var(--accent-danger)]" />
                                ) : (
                                  <ArrowUpRight className="w-4 h-4 text-[var(--accent-success)]" />
                                )}
                                <p className={`font-semibold ${isExpense ? 'text-[var(--accent-danger)]' : 'text-[var(--accent-success)]'}`}>
                                  ${txn.amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                                </p>
                              </div>
                              <button
                                onClick={() => deleteTransaction(txn.id)}
                                className="p-2 rounded-lg text-[var(--foreground-muted)] hover:text-[var(--accent-danger)] hover:bg-[var(--accent-danger)]/10 transition-colors"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        {/* Additional Methods without transactions */}
        {methodsWithData.length > 0 && methodsWithData.length < PAYMENT_METHODS.length && (
          <div className="mt-8">
            <h3 className="text-lg font-semibold text-[var(--foreground-secondary)] mb-4">
              Other Payment Methods
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
              {PAYMENT_METHODS.filter((pm) => !methodsWithData.find((m) => m.value === pm.value)).map((method) => (
                <div
                  key={method.value}
                  className="p-4 rounded-xl bg-[var(--background-secondary)] border border-[var(--border-color)] text-center opacity-60"
                >
                  <div
                    className="w-10 h-10 rounded-xl flex items-center justify-center mx-auto mb-2"
                    style={{ backgroundColor: `${method.color}20`, color: method.color }}
                  >
                    {getMethodIcon(method.value)}
                  </div>
                  <p className="text-sm text-[var(--foreground-secondary)]">{method.label}</p>
                  <p className="text-xs text-[var(--foreground-muted)] mt-1">No transactions</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>

      <AddTransactionModal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} />
    </div>
  );
}

