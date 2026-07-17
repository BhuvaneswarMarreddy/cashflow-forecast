'use client';

import React, { createContext, useContext, useState, useEffect, ReactNode, useCallback, useRef } from 'react';
import { Transaction, PaymentMethod, ExpenseCategory } from '@/types';
import { useAuth } from './AuthContext';
import * as firestoreService from '@/lib/firestore';
import { generateSampleData } from '@/lib/storage';

interface TransactionContextType {
  transactions: Transaction[];
  isLoading: boolean;
  error: string | null;
  addTransaction: (transaction: Omit<Transaction, 'id'>) => Promise<void>;
  addBulkTransactions: (transactions: Omit<Transaction, 'id'>[]) => Promise<void>;
  updateTransaction: (id: string, updates: Partial<Transaction>) => Promise<void>;
  deleteTransaction: (id: string) => Promise<void>;
  refreshTransactions: () => Promise<void>;
  getTransactionsByDate: (date: Date) => Transaction[];
  getTransactionsByPaymentMethod: (method: PaymentMethod) => Transaction[];
  getTransactionsByCategory: (category: ExpenseCategory) => Transaction[];
  getPastTransactions: () => Transaction[];
  getFutureTransactions: () => Transaction[];
  getTotalByPaymentMethod: () => { method: PaymentMethod; total: number; count: number }[];
  getTotalByCategory: () => { category: ExpenseCategory; total: number; count: number }[];
  getMonthlyTotals: () => { month: string; income: number; expenses: number }[];
  initializeSampleData: () => Promise<void>;
}

const TransactionContext = createContext<TransactionContextType | undefined>(undefined);

const LOCAL_STORAGE_KEY = 'cashflow_transactions_';

export function TransactionProvider({ children }: { children: ReactNode }) {
  const { user, isAuthenticated } = useAuth();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isFirestoreOnline, setIsFirestoreOnline] = useState(true);
  const isFetching = useRef(false);
  const lastUserId = useRef<string | null>(null);

  // Load from localStorage - synchronous
  const loadLocalTransactions = useCallback((userId: string): Transaction[] => {
    if (typeof window === 'undefined') return [];
    try {
      const stored = localStorage.getItem(LOCAL_STORAGE_KEY + userId);
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  }, []);

  // Save to localStorage
  const saveLocalTransactions = useCallback((userId: string, data: Transaction[]) => {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem(LOCAL_STORAGE_KEY + userId, JSON.stringify(data));
    } catch (e) {
      console.warn('Failed to save to localStorage:', e);
    }
  }, []);

  // Sync transactions from Firestore (background operation)
  const syncFromFirestore = useCallback(async (userId: string) => {
    if (isFetching.current) return;
    isFetching.current = true;

    try {
      const userTransactions = await firestoreService.getTransactions(userId);
      setIsFirestoreOnline(true);
      setTransactions(userTransactions);
      saveLocalTransactions(userId, userTransactions);
      setError(null);
    } catch (err) {
      console.warn('Firestore sync failed, using cached data:', err);
      setIsFirestoreOnline(false);
    } finally {
      isFetching.current = false;
    }
  }, [saveLocalTransactions]);

  // Handle auth state changes - FAST path with localStorage first
  useEffect(() => {
    if (!isAuthenticated || !user?.id) {
      setTransactions([]);
      setIsLoading(false);
      lastUserId.current = null;
      return;
    }

    // Skip if same user already loaded
    if (lastUserId.current === user.id && transactions.length > 0) {
      return;
    }
    lastUserId.current = user.id;

    // FAST: Load from localStorage immediately
    const localTransactions = loadLocalTransactions(user.id);
    setTransactions(localTransactions);
    setIsLoading(false);

    // Sync from Firestore in background (don't await)
    syncFromFirestore(user.id);
  }, [isAuthenticated, user?.id, loadLocalTransactions, syncFromFirestore, transactions.length]);

  const addTransaction = async (transaction: Omit<Transaction, 'id'>) => {
    console.log('📝 [TransactionContext] addTransaction called:', transaction);
    
    if (!user?.id) {
      console.warn('⚠️ [TransactionContext] No user ID, cannot add transaction');
      return;
    }

    const tempId = `local_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const newTransaction: Transaction = {
      ...transaction,
      id: tempId,
    };

    console.log('📝 [TransactionContext] Created transaction with temp ID:', tempId);

    // Update local state immediately
    setTransactions((prev) => {
      const updated = [newTransaction, ...prev];
      saveLocalTransactions(user.id, updated);
      return updated;
    });

    // Try to sync with Firestore
    if (isFirestoreOnline) {
      try {
        console.log('📝 [TransactionContext] Syncing to Firestore...');
        const firestoreId = await firestoreService.addTransaction(user.id, transaction);
        console.log('✅ [TransactionContext] Firestore returned ID:', firestoreId);
        
        // Update the ID with the Firestore ID
        setTransactions((prev) => {
          const updated = prev.map((t) => 
            t.id === tempId ? { ...t, id: firestoreId } : t
          );
          saveLocalTransactions(user.id, updated);
          return updated;
        });
      } catch (err) {
        console.error('❌ [TransactionContext] Firestore sync failed:', err);
      }
    } else {
      console.warn('⚠️ [TransactionContext] Firestore offline, using localStorage only');
    }
  };

  const addBulkTransactions = async (newTransactions: Omit<Transaction, 'id'>[]) => {
    if (!user?.id || newTransactions.length === 0) return;

    // Create temp IDs for all transactions
    const transactionsWithIds: Transaction[] = newTransactions.map((t, i) => ({
      ...t,
      id: `local_${Date.now()}_${i}_${Math.random().toString(36).substr(2, 9)}`,
    }));

    // Update local state immediately
    setTransactions((prev) => {
      const updated = [...transactionsWithIds, ...prev];
      saveLocalTransactions(user.id, updated);
      return updated;
    });

    // Try to sync with Firestore
    if (isFirestoreOnline) {
      try {
        await firestoreService.addBulkTransactions(user.id, newTransactions);
        // Refresh to get Firestore IDs
        await syncFromFirestore(user.id);
      } catch (err) {
        console.warn('Firestore bulk sync failed, using localStorage:', err);
      }
    }
  };

  const updateTransaction = async (id: string, updates: Partial<Transaction>) => {
    if (!user?.id) return;

    // Update local state immediately
    setTransactions((prev) => {
      const updated = prev.map((t) => (t.id === id ? { ...t, ...updates } : t));
      saveLocalTransactions(user.id, updated);
      return updated;
    });

    // Try to sync with Firestore
    if (isFirestoreOnline && !id.startsWith('local_')) {
      try {
        await firestoreService.updateTransaction(user.id, id, updates);
      } catch (err) {
        console.warn('Firestore update failed, using localStorage:', err);
      }
    }
  };

  const deleteTransaction = async (id: string) => {
    if (!user?.id) return;

    // Update local state immediately
    setTransactions((prev) => {
      const updated = prev.filter((t) => t.id !== id);
      saveLocalTransactions(user.id, updated);
      return updated;
    });

    // Try to sync with Firestore
    if (isFirestoreOnline && !id.startsWith('local_')) {
      try {
        await firestoreService.deleteTransaction(user.id, id);
      } catch (err) {
        console.warn('Firestore delete failed, using localStorage:', err);
      }
    }
  };

  const refreshTransactions = async () => {
    if (!user?.id) return;
    isFetching.current = false; // Reset to allow fetch
    await syncFromFirestore(user.id);
  };

  const getTransactionsByDate = (date: Date): Transaction[] => {
    const dateStr = date.toISOString().split('T')[0];
    return transactions.filter((t) => t.date.split('T')[0] === dateStr);
  };

  const getTransactionsByPaymentMethod = (method: PaymentMethod): Transaction[] => {
    return transactions.filter((t) => t.paymentMethod === method);
  };

  const getTransactionsByCategory = (category: ExpenseCategory): Transaction[] => {
    return transactions.filter((t) => t.category === category);
  };

  const getPastTransactions = (): Transaction[] => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return transactions.filter((t) => new Date(t.date) < today);
  };

  const getFutureTransactions = (): Transaction[] => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return transactions.filter((t) => new Date(t.date) >= today);
  };

  const getTotalByPaymentMethod = (): { method: PaymentMethod; total: number; count: number }[] => {
    const totals: { [key: string]: { total: number; count: number } } = {};
    
    transactions
      .filter((t) => t.type === 'expense')
      .forEach((t) => {
        if (!totals[t.paymentMethod]) {
          totals[t.paymentMethod] = { total: 0, count: 0 };
        }
        totals[t.paymentMethod].total += t.amount;
        totals[t.paymentMethod].count += 1;
      });

    return Object.entries(totals).map(([method, data]) => ({
      method: method as PaymentMethod,
      total: data.total,
      count: data.count,
    }));
  };

  const getTotalByCategory = (): { category: ExpenseCategory; total: number; count: number }[] => {
    const totals: { [key: string]: { total: number; count: number } } = {};
    
    transactions
      .filter((t) => t.type === 'expense')
      .forEach((t) => {
        if (!totals[t.category]) {
          totals[t.category] = { total: 0, count: 0 };
        }
        totals[t.category].total += t.amount;
        totals[t.category].count += 1;
      });

    return Object.entries(totals).map(([category, data]) => ({
      category: category as ExpenseCategory,
      total: data.total,
      count: data.count,
    }));
  };

  const getMonthlyTotals = (): { month: string; income: number; expenses: number }[] => {
    const monthlyData: { [key: string]: { income: number; expenses: number } } = {};
    
    transactions.forEach((t) => {
      const date = new Date(t.date);
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      
      if (!monthlyData[monthKey]) {
        monthlyData[monthKey] = { income: 0, expenses: 0 };
      }
      
      if (t.type === 'income') {
        monthlyData[monthKey].income += t.amount;
      } else {
        monthlyData[monthKey].expenses += t.amount;
      }
    });

    return Object.entries(monthlyData)
      .map(([month, data]) => ({
        month,
        income: data.income,
        expenses: data.expenses,
      }))
      .sort((a, b) => a.month.localeCompare(b.month));
  };

  const initializeSampleData = async () => {
    if (!user?.id) return;

    try {
      setIsLoading(true);
      const sampleData = generateSampleData();
      
      if (isFirestoreOnline) {
        await firestoreService.addBulkTransactions(user.id, sampleData.map(({ id, ...rest }) => rest));
        await syncFromFirestore(user.id);
      } else {
        // Offline mode - just use localStorage
        setTransactions(sampleData);
        saveLocalTransactions(user.id, sampleData);
      }
    } catch (err) {
      console.error('Error initializing sample data:', err);
      setError('Failed to initialize sample data');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <TransactionContext.Provider
      value={{
        transactions,
        isLoading,
        error,
        addTransaction,
        addBulkTransactions,
        updateTransaction,
        deleteTransaction,
        refreshTransactions,
        getTransactionsByDate,
        getTransactionsByPaymentMethod,
        getTransactionsByCategory,
        getPastTransactions,
        getFutureTransactions,
        getTotalByPaymentMethod,
        getTotalByCategory,
        getMonthlyTotals,
        initializeSampleData,
      }}
    >
      {children}
    </TransactionContext.Provider>
  );
}

export function useTransactions() {
  const context = useContext(TransactionContext);
  if (context === undefined) {
    throw new Error('useTransactions must be used within a TransactionProvider');
  }
  return context;
}
