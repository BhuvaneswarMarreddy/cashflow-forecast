'use client';

import React, { useState, useRef, useEffect } from 'react';
import { X, DollarSign, Calendar, CreditCard, Tag, FileText, Building2, Wallet, Store, ChevronDown } from 'lucide-react';
import { useTransactions } from '@/context/TransactionContext';
import { useUserProfile } from '@/context/UserProfileContext';
import { PAYMENT_METHODS, EXPENSE_CATEGORIES, COMMON_MERCHANTS, Transaction, TransactionType, TransferDirection, PaymentMethod, ExpenseCategory, AccountType, suggestCategoryFromMerchant, getMerchantColor } from '@/types';

interface AddTransactionModalProps {
  isOpen: boolean;
  onClose: () => void;
  defaultDate?: Date;
  editTransaction?: Transaction | null; // Transaction to edit
}

export default function AddTransactionModal({ isOpen, onClose, defaultDate, editTransaction }: AddTransactionModalProps) {
  const { addTransaction, updateTransaction, addBulkTransactions, transactions } = useTransactions();
  const { profile } = useUserProfile();
  const [formData, setFormData] = useState({
    title: '',
    amount: '',
    type: 'expense' as TransactionType,
    transferDirection: 'out' as TransferDirection,
    // From/To only apply to a NEW transfer (which creates both legs); editing keeps the
    // single-account + direction path via accountId/transferDirection above.
    fromAccountId: '',
    toAccountId: '',
    category: 'other' as ExpenseCategory,
    paymentMethod: 'chase' as PaymentMethod,
    accountId: '',
    date: defaultDate ? defaultDate.toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
    description: '',
    merchant: '',
    isProjected: false,
    isRecurring: false,
    recurringFrequency: 'monthly' as 'weekly' | 'monthly' | 'yearly',
    recurringEndDate: '', // When payments end
    recurringCount: '', // Number of remaining payments
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showMerchantSuggestions, setShowMerchantSuggestions] = useState(false);
  const [merchantFilter, setMerchantFilter] = useState('');
  const merchantInputRef = useRef<HTMLInputElement>(null);
  const merchantDropdownRef = useRef<HTMLDivElement>(null);

  // Get unique merchants from transaction history
  const recentMerchants = React.useMemo(() => {
    const merchantSet = new Set<string>();
    transactions.forEach(t => {
      if (t.merchant) merchantSet.add(t.merchant);
    });
    return Array.from(merchantSet).slice(0, 10);
  }, [transactions]);

  // Filter merchants based on input
  const filteredMerchants = React.useMemo(() => {
    const filter = merchantFilter.toLowerCase();
    const commonFiltered = COMMON_MERCHANTS
      .filter(m => m.name.toLowerCase().includes(filter))
      .slice(0, 8);
    
    const recentFiltered = recentMerchants
      .filter(m => m.toLowerCase().includes(filter) && !commonFiltered.some(cm => cm.name === m))
      .slice(0, 4);
    
    return { common: commonFiltered, recent: recentFiltered };
  }, [merchantFilter, recentMerchants]);

  // Handle merchant selection
  const handleMerchantSelect = (merchantName: string) => {
    const suggestedCategory = suggestCategoryFromMerchant(merchantName);
    setFormData({
      ...formData,
      merchant: merchantName,
      category: suggestedCategory || formData.category,
    });
    setShowMerchantSuggestions(false);
    setMerchantFilter(merchantName);
  };

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        merchantDropdownRef.current &&
        !merchantDropdownRef.current.contains(event.target as Node) &&
        merchantInputRef.current &&
        !merchantInputRef.current.contains(event.target as Node)
      ) {
        setShowMerchantSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Populate form when editing a transaction
  React.useEffect(() => {
    if (editTransaction && isOpen) {
      setFormData({
        title: editTransaction.title,
        amount: editTransaction.amount.toString(),
        type: editTransaction.type,
        transferDirection: editTransaction.transferDirection || 'out',
        fromAccountId: '',
        toAccountId: '',
        category: editTransaction.category,
        paymentMethod: editTransaction.paymentMethod,
        accountId: editTransaction.accountId || '',
        date: editTransaction.date.split('T')[0],
        description: editTransaction.description || '',
        merchant: editTransaction.merchant || '',
        isProjected: editTransaction.isProjected || false,
        isRecurring: editTransaction.isRecurring || false,
        recurringFrequency: editTransaction.recurringFrequency || 'monthly',
        recurringEndDate: editTransaction.recurringEndDate?.split('T')[0] || '',
        recurringCount: editTransaction.recurringCount?.toString() || '',
      });
      setMerchantFilter(editTransaction.merchant || '');
    } else if (defaultDate) {
      setFormData((prev) => ({
        ...prev,
        date: defaultDate.toISOString().split('T')[0],
      }));
    }
  }, [editTransaction, defaultDate, isOpen]);

  // Set default account when modal opens
  React.useEffect(() => {
    if (isOpen && profile?.paymentAccounts?.length && !formData.accountId) {
      const firstAccount = profile.paymentAccounts[0];
      setFormData((prev) => ({
        ...prev,
        accountId: firstAccount.id,
        paymentMethod: firstAccount.provider,
      }));
    }
  }, [isOpen, profile?.paymentAccounts, formData.accountId]);

  const handleAccountChange = (accountId: string) => {
    const account = profile?.paymentAccounts?.find((a) => a.id === accountId);
    if (account) {
      setFormData({
        ...formData,
        accountId: accountId,
        paymentMethod: account.provider,
      });
    } else {
      setFormData({
        ...formData,
        accountId: '',
        paymentMethod: 'chase',
      });
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const transactionDate = new Date(formData.date);

    // NEW transfer: create BOTH legs (out of From, into To) instead of one row.
    if (formData.type === 'transfer' && !editTransaction) {
      const accounts = profile?.paymentAccounts || [];
      const from = accounts.find((a) => a.id === formData.fromAccountId);
      const to = accounts.find((a) => a.id === formData.toAccountId);
      if (!from || !to) {
        setIsSubmitting(false);
        return; // both required; the To picker excludes From so they can't match
      }

      const shared = {
        amount: parseFloat(formData.amount),
        type: 'transfer' as const,
        category: formData.category,
        date: transactionDate.toISOString(),
        description: formData.description,
        merchant: formData.merchant || undefined,
        isProjected: transactionDate >= today || formData.isProjected,
      };
      const fromLeg = {
        ...shared,
        transferDirection: 'out' as TransferDirection,
        accountId: from.id,
        paymentMethod: from.provider,
        title: `Transfer to ${to.name}`,
      };
      const toLeg = {
        ...shared,
        transferDirection: 'in' as TransferDirection,
        accountId: to.id,
        paymentMethod: to.provider,
        title: `Transfer from ${from.name}`,
      };

      try {
        // No ids passed, so both legs get auto-ids.
        await addBulkTransactions([fromLeg, toLeg]);
      } catch (error) {
        console.error('❌ Error saving transfer:', error);
      }
      resetForm();
      setIsSubmitting(false);
      onClose();
      return;
    }

    const transactionData = {
      title: formData.title,
      amount: parseFloat(formData.amount),
      type: formData.type,
      transferDirection: formData.type === 'transfer' ? formData.transferDirection : undefined,
      category: formData.category,
      paymentMethod: formData.paymentMethod,
      accountId: formData.accountId || undefined,
      date: transactionDate.toISOString(),
      description: formData.description,
      merchant: formData.merchant || undefined,
      isProjected: transactionDate >= today || formData.isProjected,
      isRecurring: formData.isRecurring,
      recurringFrequency: formData.isRecurring ? formData.recurringFrequency : undefined,
      recurringEndDate: formData.isRecurring && formData.recurringEndDate ? formData.recurringEndDate : undefined,
      recurringCount: formData.isRecurring && formData.recurringCount ? parseInt(formData.recurringCount) : undefined,
    };

    try {
      if (editTransaction) {
        // Update existing transaction
        await updateTransaction(editTransaction.id, transactionData);
      } else {
        // Add new transaction
        console.log('📝 Adding transaction:', transactionData);
        await addTransaction(transactionData);
        console.log('✅ Transaction added successfully');
      }
    } catch (error) {
      console.error('❌ Error saving transaction:', error);
    }

    resetForm();
    setIsSubmitting(false);
    onClose();
  };

  const resetForm = () => {
    const firstAccount = profile?.paymentAccounts?.[0];
    setFormData({
      title: '',
      amount: '',
      type: 'expense',
      transferDirection: 'out',
      fromAccountId: '',
      toAccountId: '',
      category: 'other',
      paymentMethod: firstAccount?.provider || 'chase',
      accountId: firstAccount?.id || '',
      date: new Date().toISOString().split('T')[0],
      description: '',
      merchant: '',
      isProjected: false,
      isRecurring: false,
      recurringFrequency: 'monthly',
      recurringEndDate: '',
      recurringCount: '',
    });
    setMerchantFilter('');
  };

  const getAccountIcon = (type: AccountType) => {
    switch (type) {
      case 'credit_card':
      case 'debit_card':
        return <CreditCard className="w-4 h-4" />;
      case 'bank_account':
        return <Building2 className="w-4 h-4" />;
      case 'cash':
        return <Wallet className="w-4 h-4" />;
    }
  };

  if (!isOpen) return null;

  const hasAccounts = profile?.paymentAccounts && profile.paymentAccounts.length > 0;
  // A NEW transfer picks From + To and creates both legs; editing keeps the old
  // single-account + in/out behavior untouched.
  const isNewTransfer = formData.type === 'transfer' && !editTransaction;
  const accountsList = profile?.paymentAccounts || [];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-2xl font-bold text-[var(--foreground)]">
            {editTransaction ? 'Edit Transaction' : 'Add Transaction'}
          </h2>
          <button
            onClick={onClose}
            className="p-2 rounded-xl text-[var(--foreground-secondary)] hover:bg-[var(--background-tertiary)] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Transaction Type */}
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setFormData({ ...formData, type: 'expense' })}
              className={`flex-1 py-3 rounded-xl font-medium transition-all ${
                formData.type === 'expense'
                  ? 'bg-[var(--accent-danger)] text-white'
                  : 'bg-[var(--background-tertiary)] text-[var(--foreground-secondary)] hover:text-[var(--foreground)]'
              }`}
            >
              Expense
            </button>
            <button
              type="button"
              onClick={() => setFormData({ ...formData, type: 'income' })}
              className={`flex-1 py-3 rounded-xl font-medium transition-all ${
                formData.type === 'income'
                  ? 'bg-[var(--accent-success)] text-white'
                  : 'bg-[var(--background-tertiary)] text-[var(--foreground-secondary)] hover:text-[var(--foreground)]'
              }`}
            >
              Income
            </button>
            {/* Without this, opening a transfer to fix a typo highlights neither
                button and saving silently rewrites its type. */}
            <button
              type="button"
              disabled={!editTransaction && accountsList.length < 2}
              title={!editTransaction && accountsList.length < 2 ? 'Transfers need at least two accounts' : undefined}
              onClick={() => setFormData({ ...formData, type: 'transfer' })}
              className={`flex-1 py-3 rounded-xl font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
                formData.type === 'transfer'
                  ? 'bg-[var(--accent-primary)] text-[#16181c]'
                  : 'bg-[var(--background-tertiary)] text-[var(--foreground-secondary)] hover:text-[var(--foreground)]'
              }`}
            >
              Transfer
            </button>
          </div>

          {/* Editing a transfer keeps the single-account in/out toggle. A transfer's
              amount is stored unsigned, so the leg direction is the only thing that says
              whether this account gained or lost the money. */}
          {formData.type === 'transfer' && editTransaction && (
            <div className="flex gap-3">
              {(['out', 'in'] as TransferDirection[]).map((dir) => (
                <button
                  key={dir}
                  type="button"
                  onClick={() => setFormData({ ...formData, transferDirection: dir })}
                  className={`flex-1 py-2 rounded-xl text-sm font-medium transition-all ${
                    formData.transferDirection === dir
                      ? 'bg-[var(--background-secondary)] text-[var(--foreground)] border border-[var(--accent-primary)]'
                      : 'bg-[var(--background-tertiary)] text-[var(--foreground-secondary)] hover:text-[var(--foreground)]'
                  }`}
                >
                  {dir === 'out' ? 'Money out of this account' : 'Money into this account'}
                </button>
              ))}
            </div>
          )}

          {/* NEW transfer: pick From + To. Submitting creates both legs. The To list
              excludes the chosen From so the two can never be the same account. */}
          {isNewTransfer && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
                  From account
                </label>
                <select
                  value={formData.fromAccountId}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      fromAccountId: e.target.value,
                      // If To now equals From, clear it so the user re-picks a valid target.
                      toAccountId: formData.toAccountId === e.target.value ? '' : formData.toAccountId,
                    })
                  }
                  className="select-field"
                  required
                >
                  <option value="">Select account</option>
                  {accountsList.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}{a.lastFourDigits ? ` ••••${a.lastFourDigits}` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
                  To account
                </label>
                <select
                  value={formData.toAccountId}
                  onChange={(e) => setFormData({ ...formData, toAccountId: e.target.value })}
                  className="select-field"
                  required
                >
                  <option value="">Select account</option>
                  {accountsList
                    .filter((a) => a.id !== formData.fromAccountId)
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}{a.lastFourDigits ? ` ••••${a.lastFourDigits}` : ''}
                      </option>
                    ))}
                </select>
              </div>
            </div>
          )}

          {/* Title — auto-generated ("Transfer to/from …") for a new transfer, so optional there */}
          {!isNewTransfer && (
          <div>
            <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
              Title
            </label>
            <div className="relative">
              <FileText className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--foreground-muted)] pointer-events-none" />
              <input
                type="text"
                value={formData.title}
                onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                placeholder="Enter transaction title"
                className="input-field pl-12"
                required
              />
            </div>
          </div>
          )}

          {/* Merchant */}
          <div className="relative">
            <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
              Merchant / Store
            </label>
            <div className="relative">
              <Store className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--foreground-muted)] pointer-events-none z-10" />
              <input
                ref={merchantInputRef}
                type="text"
                value={merchantFilter}
                onChange={(e) => {
                  setMerchantFilter(e.target.value);
                  setFormData({ ...formData, merchant: e.target.value });
                  setShowMerchantSuggestions(true);
                }}
                onFocus={() => setShowMerchantSuggestions(true)}
                placeholder="Amazon, Walmart, Starbucks..."
                className="input-field pl-12 pr-10"
              />
              <button
                type="button"
                onClick={() => setShowMerchantSuggestions(!showMerchantSuggestions)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--foreground-muted)] hover:text-[var(--foreground)] z-10"
              >
                <ChevronDown className={`w-4 h-4 transition-transform ${showMerchantSuggestions ? 'rotate-180' : ''}`} />
              </button>
            </div>
            
            {/* Merchant suggestions dropdown */}
            {showMerchantSuggestions && (
              <div
                ref={merchantDropdownRef}
                className="absolute z-50 w-full mt-1 bg-[var(--background-secondary)] border border-[var(--border-color)] rounded-xl shadow-xl max-h-64 overflow-y-auto"
              >
                {/* Recent merchants from history */}
                {filteredMerchants.recent.length > 0 && (
                  <div className="p-2 border-b border-[var(--border-color)]">
                    <p className="text-xs font-medium text-[var(--foreground-muted)] px-2 mb-1">Recent</p>
                    {filteredMerchants.recent.map((merchant) => (
                      <button
                        key={merchant}
                        type="button"
                        onClick={() => handleMerchantSelect(merchant)}
                        className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-[var(--background-tertiary)] transition-colors text-left"
                      >
                        <div
                          className="w-8 h-8 rounded-lg flex items-center justify-center text-white font-bold text-sm"
                          style={{ backgroundColor: getMerchantColor(merchant) }}
                        >
                          {merchant.charAt(0)}
                        </div>
                        <span className="text-sm text-[var(--foreground)]">{merchant}</span>
                      </button>
                    ))}
                  </div>
                )}
                
                {/* Common merchants */}
                {filteredMerchants.common.length > 0 && (
                  <div className="p-2">
                    <p className="text-xs font-medium text-[var(--foreground-muted)] px-2 mb-1">Popular</p>
                    <div className="grid grid-cols-2 gap-1">
                      {filteredMerchants.common.map((merchant) => (
                        <button
                          key={merchant.name}
                          type="button"
                          onClick={() => handleMerchantSelect(merchant.name)}
                          className="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-[var(--background-tertiary)] transition-colors text-left"
                        >
                          <div
                            className="w-6 h-6 rounded flex items-center justify-center text-white text-xs font-bold"
                            style={{ backgroundColor: merchant.color }}
                          >
                            {merchant.name.charAt(0)}
                          </div>
                          <span className="text-sm text-[var(--foreground)] truncate">{merchant.name}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                
                {filteredMerchants.common.length === 0 && filteredMerchants.recent.length === 0 && (
                  <div className="p-4 text-center text-[var(--foreground-muted)] text-sm">
                    No matching merchants. Type to add custom.
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Amount */}
          <div>
            <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
              Amount
            </label>
            <div className="relative">
              <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--foreground-muted)] pointer-events-none" />
              <input
                type="number"
                step="0.01"
                min="0"
                value={formData.amount}
                onChange={(e) => setFormData({ ...formData, amount: e.target.value })}
                placeholder="Enter amount"
                className="input-field pl-12"
                required
              />
            </div>
          </div>

          {/* Date */}
          <div>
            <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
              Date
            </label>
            <div className="relative">
              <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--foreground-muted)] pointer-events-none" />
              <input
                type="date"
                value={formData.date}
                onChange={(e) => setFormData({ ...formData, date: e.target.value })}
                className="input-field pl-12"
                required
              />
            </div>
          </div>

          {/* Category */}
          <div>
            <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
              Category
            </label>
            <div className="relative">
              <Tag className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--foreground-muted)] pointer-events-none z-10" />
              <select
                value={formData.category}
                onChange={(e) => setFormData({ ...formData, category: e.target.value as ExpenseCategory })}
                className="select-field pl-12"
              >
                {EXPENSE_CATEGORIES.map((cat) => (
                  <option key={cat.value} value={cat.value}>
                    {cat.icon} {cat.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Payment Account - Show user's accounts if available. A new transfer already
              chose From/To above, so the single-account picker is hidden for it. */}
          {isNewTransfer ? null : hasAccounts ? (
            <div>
              <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
                Account
              </label>
              <div className="grid grid-cols-2 gap-2">
                {profile.paymentAccounts.map((account) => (
                  <button
                    key={account.id}
                    type="button"
                    onClick={() => handleAccountChange(account.id)}
                    className={`p-3 rounded-xl border-2 transition-all flex items-center gap-2 ${
                      formData.accountId === account.id
                        ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)]/10'
                        : 'border-[var(--border-color)] hover:border-[var(--border-glow)]'
                    }`}
                  >
                    <div
                      className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                      style={{ backgroundColor: `${account.color}20`, color: account.color }}
                    >
                      {getAccountIcon(account.type)}
                    </div>
                    <div className="text-left overflow-hidden">
                      <p className="text-sm font-medium text-[var(--foreground)] truncate">
                        {account.name}
                      </p>
                      {account.lastFourDigits && (
                        <p className="text-xs text-[var(--foreground-muted)]">
                          •••• {account.lastFourDigits}
                        </p>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div>
              <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
                Payment Method
              </label>
              <div className="relative">
                <CreditCard className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--foreground-muted)] pointer-events-none z-10" />
                <select
                  value={formData.paymentMethod}
                  onChange={(e) => setFormData({ ...formData, paymentMethod: e.target.value as PaymentMethod })}
                  className="select-field pl-12"
                >
                  {PAYMENT_METHODS.map((method) => (
                    <option key={method.value} value={method.value}>
                      {method.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {/* Description */}
          <div>
            <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
              Description (Optional)
            </label>
            <textarea
              value={formData.description}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
              placeholder="Add any notes or details..."
              rows={3}
              className="input-field resize-none"
            />
          </div>

          {/* Projected Transaction Toggle */}
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              id="isProjected"
              checked={formData.isProjected}
              onChange={(e) => setFormData({ ...formData, isProjected: e.target.checked })}
              className="w-5 h-5 rounded border-[var(--border-color)] bg-[var(--background-tertiary)] text-[var(--accent-primary)] focus:ring-[var(--accent-primary)] cursor-pointer"
            />
            <label htmlFor="isProjected" className="text-sm text-[var(--foreground-secondary)] cursor-pointer">
              Mark as projected/future expense
            </label>
          </div>

          {/* Recurring Transaction Section — hidden for a new transfer, whose two-leg
              submit path doesn't carry the recurring flag (the control would be a no-op). */}
          {!isNewTransfer && (
          <div className="p-4 rounded-xl bg-[var(--background-tertiary)] border border-[var(--border-color)]">
            <div className="flex items-center gap-3 mb-4">
              <input
                type="checkbox"
                id="isRecurring"
                checked={formData.isRecurring}
                onChange={(e) => setFormData({ ...formData, isRecurring: e.target.checked })}
                className="w-5 h-5 rounded border-[var(--border-color)] bg-[var(--background-secondary)] text-[var(--accent-primary)] focus:ring-[var(--accent-primary)] cursor-pointer"
              />
              <label htmlFor="isRecurring" className="text-sm font-medium text-[var(--foreground)] cursor-pointer">
                This is a recurring {formData.type === 'income' ? 'income' : 'payment'}
              </label>
            </div>

            {formData.isRecurring && (
              <div className="space-y-4">
                {/* Frequency */}
                <div>
                  <label className="block text-sm text-[var(--foreground-secondary)] mb-2">
                    Repeats
                  </label>
                  <select
                    value={formData.recurringFrequency}
                    onChange={(e) => setFormData({ ...formData, recurringFrequency: e.target.value as any })}
                    className="input-field"
                  >
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                    <option value="yearly">Yearly</option>
                  </select>
                </div>

                {/* Duration Options */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm text-[var(--foreground-secondary)] mb-2">
                      End Date (Optional)
                    </label>
                    <div className="relative">
                      <Calendar className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-[var(--foreground-muted)]" />
                      <input
                        type="date"
                        value={formData.recurringEndDate}
                        onChange={(e) => setFormData({ ...formData, recurringEndDate: e.target.value, recurringCount: '' })}
                        className="input-field pl-12"
                        min={formData.date}
                      />
                    </div>
                    <p className="text-xs text-[var(--foreground-muted)] mt-1">
                      Last payment date
                    </p>
                  </div>

                  <div>
                    <label className="block text-sm text-[var(--foreground-secondary)] mb-2">
                      # of Payments (Optional)
                    </label>
                    <input
                      type="number"
                      value={formData.recurringCount}
                      onChange={(e) => setFormData({ ...formData, recurringCount: e.target.value, recurringEndDate: '' })}
                      placeholder="e.g., 36"
                      min="1"
                      className="input-field"
                    />
                    <p className="text-xs text-[var(--foreground-muted)] mt-1">
                      {formData.recurringFrequency === 'monthly' ? 'months' : formData.recurringFrequency === 'weekly' ? 'weeks' : 'years'} remaining
                    </p>
                  </div>
                </div>

                {/* Preview */}
                {(formData.recurringEndDate || formData.recurringCount) && (
                  <div className="p-3 rounded-lg bg-[var(--accent-primary)]/10 border border-[var(--accent-primary)]/20">
                    <p className="text-sm text-[var(--foreground)]">
                      {formData.recurringEndDate ? (
                        <>Payments until <strong>{new Date(formData.recurringEndDate).toLocaleDateString()}</strong></>
                      ) : formData.recurringCount ? (
                        <><strong>{formData.recurringCount}</strong> {formData.recurringFrequency} payments remaining</>
                      ) : null}
                    </p>
                  </div>
                )}

                {!formData.recurringEndDate && !formData.recurringCount && (
                  <p className="text-xs text-[var(--foreground-muted)]">
                    Leave both empty for indefinite recurring payments
                  </p>
                )}
              </div>
            )}
          </div>
          )}

          {/* Submit Button */}
          <button
            type="submit"
            disabled={isSubmitting}
            className="btn-primary w-full disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSubmitting 
              ? (editTransaction ? 'Saving...' : 'Adding...') 
              : (editTransaction ? 'Save Changes' : 'Add Transaction')
            }
          </button>
        </form>
      </div>
    </div>
  );
}
