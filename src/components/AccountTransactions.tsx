'use client';

import React, { useState, useMemo } from 'react';
import { 
  ChevronDown, 
  ChevronUp, 
  Calendar, 
  TrendingUp, 
  TrendingDown,
  Receipt,
  CreditCard,
  Building2,
  Wallet,
  FileText,
  DollarSign,
  ArrowUpRight,
  ArrowDownRight,
} from 'lucide-react';
import { Transaction, PaymentAccount, EXPENSE_CATEGORIES, getMerchantColor } from '@/types';
import { isPositive } from '@/lib/classify';
import { format, parseISO, startOfMonth, endOfMonth, isWithinInterval } from 'date-fns';
import { currentOf } from '@/lib/accounts';

interface AccountTransactionsProps {
  account: PaymentAccount;
  transactions: Transaction[];
}

export default function AccountTransactions({ account, transactions }: AccountTransactionsProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [showAll, setShowAll] = useState(false);

  // Filter transactions for this account
  const accountTransactions = useMemo(() => {
    return transactions
      .filter(t => t.accountId === account.id)
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [transactions, account.id]);

  // Calculate this month's spending
  const thisMonthStats = useMemo(() => {
    const now = new Date();
    const monthStart = startOfMonth(now);
    const monthEnd = endOfMonth(now);
    
    const monthTransactions = accountTransactions.filter(t => {
      const txnDate = parseISO(t.date);
      return isWithinInterval(txnDate, { start: monthStart, end: monthEnd });
    });
    
    // Keyed off the display sign, not the raw type: a card payment is stored as a
    // 'transfer', so filtering on 'income' made these tiles read $0 for every
    // payment the user made.
    const spent = monthTransactions
      .filter(t => !isPositive(t, [account]))
      .reduce((sum, t) => sum + t.amount, 0);

    const payments = monthTransactions
      .filter(t => isPositive(t, [account]))
      .reduce((sum, t) => sum + t.amount, 0);
    
    return { spent, payments, count: monthTransactions.length };
  }, [accountTransactions, account]);

  // Display transactions (limited or all)
  const displayTransactions = showAll 
    ? accountTransactions 
    : accountTransactions.slice(0, 5);

  const getAccountIcon = () => {
    switch (account.type) {
      case 'credit_card':
      case 'debit_card':
        return <CreditCard className="w-5 h-5" />;
      case 'bank_account':
        return <Building2 className="w-5 h-5" />;
      case 'cash':
        return <Wallet className="w-5 h-5" />;
      case 'personal_loan':
        return <FileText className="w-5 h-5" />;
    }
  };

  if (accountTransactions.length === 0) {
    return null; // Don't show accounts with no transactions
  }

  return (
    <div className="bg-[var(--background-secondary)] border border-[var(--border-color)] rounded-xl overflow-hidden">
      {/* Account Header - Clickable */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full p-4 flex items-center justify-between hover:bg-[var(--background-tertiary)] transition-colors"
      >
        <div className="flex items-center gap-4">
          <div
            className="w-12 h-12 rounded-xl flex items-center justify-center"
            style={{ backgroundColor: `${account.color}20`, color: account.color }}
          >
            {getAccountIcon()}
          </div>
          <div className="text-left">
            <p className="font-medium text-[var(--foreground)]">
              {account.name}
              {account.lastFourDigits && (
                <span className="text-[var(--foreground-muted)]"> •••• {account.lastFourDigits}</span>
              )}
            </p>
            <p className="text-sm text-[var(--foreground-muted)]">
              {accountTransactions.length} transaction{accountTransactions.length !== 1 ? 's' : ''}
              {thisMonthStats.count > 0 && ` • ${thisMonthStats.count} this month`}
            </p>
          </div>
        </div>
        
        <div className="flex items-center gap-4">
          {/* This Month Stats */}
          <div className="text-right hidden sm:block">
            <p className="text-sm text-[var(--foreground-muted)]">This Month</p>
            <div className="flex items-center gap-2">
              {thisMonthStats.spent > 0 && (
                <span className="text-sm font-medium text-red-400">
                  -${thisMonthStats.spent.toLocaleString()}
                </span>
              )}
              {thisMonthStats.payments > 0 && (
                <span className="text-sm font-medium text-emerald-500">
                  +${thisMonthStats.payments.toLocaleString()}
                </span>
              )}
              {thisMonthStats.spent === 0 && thisMonthStats.payments === 0 && (
                <span className="text-sm text-[var(--foreground-muted)]">$0</span>
              )}
            </div>
          </div>
          
          {/* Balance */}
          <div className="text-right">
            <p className="text-sm text-[var(--foreground-muted)]">Balance</p>
            <p className={`text-lg font-bold ${
              account.type === 'credit_card' || account.type === 'personal_loan'
                ? 'text-red-400' 
                : 'text-emerald-500'
            }`}>
              {account.type === 'credit_card' || account.type === 'personal_loan' ? '-' : ''}
              ${currentOf(account).toLocaleString()}
            </p>
          </div>
          
          {isExpanded ? (
            <ChevronUp className="w-5 h-5 text-[var(--foreground-muted)]" />
          ) : (
            <ChevronDown className="w-5 h-5 text-[var(--foreground-muted)]" />
          )}
        </div>
      </button>

      {/* Expanded Transaction List */}
      {isExpanded && (
        <div className="border-t border-[var(--border-color)]">
          {/* Quick Stats */}
          <div className="grid grid-cols-3 gap-4 p-4 bg-[var(--background-tertiary)]">
            <div>
              <p className="text-xs text-[var(--foreground-muted)]">Total Spent</p>
              <p className="text-lg font-bold text-red-400">
                ${accountTransactions
                  .filter(t => !isPositive(t, [account]))
                  .reduce((sum, t) => sum + t.amount, 0)
                  .toLocaleString()}
              </p>
            </div>
            <div>
              <p className="text-xs text-[var(--foreground-muted)]">Total Payments</p>
              <p className="text-lg font-bold text-emerald-500">
                ${accountTransactions
                  .filter(t => isPositive(t, [account]))
                  .reduce((sum, t) => sum + t.amount, 0)
                  .toLocaleString()}
              </p>
            </div>
            <div>
              <p className="text-xs text-[var(--foreground-muted)]">
                {account.creditLimit ? 'Available Credit' : 'Avg Transaction'}
              </p>
              <p className="text-lg font-bold text-[var(--foreground)]">
                {account.creditLimit 
                  ? `$${(account.creditLimit - currentOf(account)).toLocaleString()}`
                  : `$${Math.round(
                      accountTransactions.reduce((sum, t) => sum + t.amount, 0) / 
                      (accountTransactions.length || 1)
                    ).toLocaleString()}`
                }
              </p>
            </div>
          </div>

          {/* Transaction List */}
          <div className="divide-y divide-[var(--border-color)]">
            {displayTransactions.map((txn) => {
              const category = EXPENSE_CATEGORIES.find(c => c.value === txn.category);
              const merchantColor = txn.merchant ? getMerchantColor(txn.merchant) : null;
              
              return (
                <div
                  key={txn.id}
                  className="p-4 flex items-center justify-between hover:bg-[var(--background-tertiary)] transition-colors"
                >
                  <div className="flex items-center gap-3">
                    {/* Icon */}
                    {txn.merchant ? (
                      <div 
                        className="w-10 h-10 rounded-lg flex items-center justify-center text-white font-bold text-sm"
                        style={{ backgroundColor: merchantColor || undefined }}
                      >
                        {txn.merchant.charAt(0).toUpperCase()}
                      </div>
                    ) : (
                      <div className="w-10 h-10 rounded-lg bg-[var(--background-tertiary)] flex items-center justify-center text-xl">
                        {category?.icon || '📋'}
                      </div>
                    )}
                    
                    {/* Details */}
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="font-medium text-[var(--foreground)]">{txn.title}</p>
                        {txn.merchant && (
                          <span 
                            className="text-xs px-2 py-0.5 rounded-full text-white hidden sm:inline"
                            style={{ backgroundColor: merchantColor || undefined }}
                          >
                            {txn.merchant}
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-[var(--foreground-muted)]">
                        {format(parseISO(txn.date), 'MMM d, yyyy')}
                        <span className="mx-1">•</span>
                        {category?.label || txn.category}
                      </p>
                    </div>
                  </div>
                  
                  {/* Amount */}
                  <div className="flex items-center gap-2">
                    {isPositive(txn, account ? [account] : undefined) ? (
                      <>
                        <ArrowUpRight className="w-4 h-4 text-emerald-500" />
                        <p className="font-semibold text-emerald-500">
                          +${txn.amount.toLocaleString()}
                        </p>
                      </>
                    ) : (
                      <>
                        <ArrowDownRight className="w-4 h-4 text-red-400" />
                        <p className="font-semibold text-[var(--foreground)]">
                          -${txn.amount.toLocaleString()}
                        </p>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Show More Button */}
          {accountTransactions.length > 5 && (
            <button
              onClick={() => setShowAll(!showAll)}
              className="w-full p-3 text-sm text-[var(--accent-primary)] hover:bg-[var(--background-tertiary)] transition-colors flex items-center justify-center gap-1"
            >
              {showAll ? (
                <>Show Less <ChevronUp className="w-4 h-4" /></>
              ) : (
                <>Show All {accountTransactions.length} Transactions <ChevronDown className="w-4 h-4" /></>
              )}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

