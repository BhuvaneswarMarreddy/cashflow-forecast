'use client';

import React, { createContext, useContext, useState, useEffect, ReactNode, useCallback, useMemo, useRef } from 'react';
import { Transaction, PaymentAccount, PaymentMethod, ExpenseCategory } from '@/types';
import { useAuth } from './AuthContext';
import * as firestoreService from '@/lib/firestore';
import { db, collection, doc, getDocs, setDoc, updateDoc, deleteDoc } from '@/lib/firebase';
import { applyMappingRules, definedSet, MappingRule, NewMappingRule } from '@/lib/mapping-rules';
import { generateSampleData } from '@/lib/storage';
import { isUnsyncedId, planDrain, withoutId } from '@/lib/offline-queue';
import { interpretTransaction, withoutSupersededHolds, IncomeContext } from '@/lib/classify';

export interface TransactionContextType {
  transactions: Transaction[];
  isLoading: boolean;
  error: string | null;
  // User-defined mapping rules (users/{uid}/rules). Newest first = highest precedence.
  rules: MappingRule[];
  addRule: (rule: NewMappingRule) => Promise<MappingRule | undefined>;
  deleteRule: (id: string) => Promise<void>;
  toggleRule: (id: string, enabled: boolean) => Promise<void>;
  addTransaction: (transaction: Omit<Transaction, 'id'>) => Promise<void>;
  addBulkTransactions: (
    transactions: (Omit<Transaction, 'id'> & { id?: string })[]
  ) => Promise<{ persisted: boolean } | undefined>;
  updateTransaction: (id: string, updates: Partial<Transaction>) => Promise<void>;
  deleteTransaction: (id: string) => Promise<void>;
  refreshTransactions: () => Promise<void>;
  getTransactionsByDate: (date: Date) => Transaction[];
  getTransactionsByPaymentMethod: (method: PaymentMethod) => Transaction[];
  getTransactionsByCategory: (category: ExpenseCategory) => Transaction[];
  getPastTransactions: () => Transaction[];
  getFutureTransactions: () => Transaction[];
  getTotalByPaymentMethod: (accounts?: PaymentAccount[], income?: IncomeContext) => { method: PaymentMethod; total: number; count: number }[];
  getTotalByCategory: (accounts?: PaymentAccount[], income?: IncomeContext) => { category: ExpenseCategory; total: number; count: number }[];
  getMonthlyTotals: (accounts?: PaymentAccount[], income?: IncomeContext) => { month: string; income: number; expenses: number }[];
  initializeSampleData: () => Promise<void>;
}

export const TransactionContext = createContext<TransactionContextType | undefined>(undefined);

const LOCAL_STORAGE_KEY = 'cashflow_transactions_';

export function TransactionProvider({ children }: { children: ReactNode }) {
  const { user, isAuthenticated } = useAuth();
  // Raw = exactly what was stored. `transactions` below is this with the owner's
  // mapping rules applied, and is what every consumer sees.
  const [rawTransactions, setRawTransactions] = useState<Transaction[]>([]);
  const [rules, setRules] = useState<MappingRule[]>([]);
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
      // A failed read now throws rather than returning [], so an empty result here is
      // a genuinely empty collection. Inferring failure from the row count instead
      // would pin a user with local-only history offline forever.
      const userTransactions = await firestoreService.getTransactions(userId);

      // Firestore is authoritative for rows it knows about, but rows created while
      // offline live only in the mirror and have never been written. Dropping them
      // here — which a plain overwrite does — destroys the user's only copy.
      const synced = new Set(userTransactions.map((t) => t.id));
      const { toPersist } = planDrain(loadLocalTransactions(userId), synced);

      // #71 DRAIN. Preserving the orphans in the mirror (all the old code did) only
      // postponed the loss to the next storage eviction. Now they are written for real,
      // under fresh ids, the moment a sync succeeds. This is the data the user is most
      // likely to miss, and it is the half of the fix that recovers rather than prevents.
      const rescued: Transaction[] = [];
      for (const orphan of toPersist) {
        const id = firestoreService.newDocId(userId, 'transactions');
        rescued.push({ ...orphan, id });
        firestoreService
          .addTransaction(userId, withoutId(orphan) as Omit<Transaction, 'id'>, id)
          .catch((err) => console.warn('Orphan rescue queued or failed:', err));
      }
      if (rescued.length) {
        console.info(`[#71] rescued ${rescued.length} row(s) that had never reached Firestore`);
      }

      const merged = [...rescued, ...userTransactions];

      setIsFirestoreOnline(true);
      setRawTransactions(merged);
      saveLocalTransactions(userId, merged);
      setError(null);
    } catch (err) {
      console.warn('Firestore sync failed, using cached data:', err);
      setIsFirestoreOnline(false);
    } finally {
      isFetching.current = false;
    }
  }, [saveLocalTransactions, loadLocalTransactions]);

  // Handle auth state changes - FAST path with localStorage first
  useEffect(() => {
    if (!isAuthenticated || !user?.id) {
      setRawTransactions([]);
      setIsLoading(false);
      lastUserId.current = null;
      return;
    }

    // Skip if same user already loaded
    if (lastUserId.current === user.id && rawTransactions.length > 0) {
      return;
    }
    lastUserId.current = user.id;

    // FAST: Load from localStorage immediately
    const localTransactions = loadLocalTransactions(user.id);
    setRawTransactions(localTransactions);
    setIsLoading(false);

    // Sync from Firestore in background (don't await)
    syncFromFirestore(user.id);
  }, [isAuthenticated, user?.id, loadLocalTransactions, syncFromFirestore, rawTransactions.length]);

  // Mapping rules live in their OWN subcollection, never in profile.settings —
  // syncFromFirestore() there rebuilds settings from a hardcoded whitelist and would
  // silently drop them. Loaded once per user, newest first (= highest precedence).
  useEffect(() => {
    if (!isAuthenticated || !user?.id) {
      setRules([]);
      return;
    }
    let cancelled = false;
    getDocs(collection(db, 'users', user.id, 'rules'))
      .then((snap) => {
        if (cancelled) return;
        const loaded = snap.docs.map((d) => ({ ...(d.data() as Omit<MappingRule, 'id'>), id: d.id }));
        setRules(loaded.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')));
      })
      .catch((err) => console.warn('Mapping rules load failed:', err));
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, user?.id]);

  // The single place rules are applied. Every screen reads `transactions` from this
  // context, so one rule corrects history and every future sync with no per-screen change.
  //
  // The superseded-hold guard rides here for the same reason: a hold whose posted row has
  // already arrived must not be visible to ANY screen, and one filter at the entrance is
  // the only version of that nobody can forget. `raw` below is untouched, so the audit
  // view still shows exactly what was stored.
  const transactions = useMemo(
    () => withoutSupersededHolds(
      rules.length ? rawTransactions.map((t) => applyMappingRules(t, rules)) : rawTransactions
    ),
    [rawTransactions, rules]
  );

  // Writes are optimistic, like every other write in this file: with offline persistence
  // enabled, awaiting the server ack hangs until the network comes back.
  const addRule = useCallback(
    async (rule: NewMappingRule): Promise<MappingRule | undefined> => {
      if (!user?.id) return;
      const ref = rule.id
        ? doc(db, 'users', user.id, 'rules', rule.id)
        : doc(collection(db, 'users', user.id, 'rules'));
      const saved: MappingRule = {
        ...rule,
        set: definedSet(rule.set),
        id: ref.id,
        createdAt: rule.createdAt || new Date().toISOString(),
      };

      setRules((prev) => [saved, ...prev.filter((r) => r.id !== saved.id)]);
      setDoc(ref, {
        match: saved.match,
        set: saved.set,
        createdAt: saved.createdAt,
        enabled: saved.enabled,
      }).catch((err) => console.warn('Mapping rule write failed:', err));

      return saved;
    },
    [user?.id]
  );

  const deleteRule = useCallback(
    async (id: string) => {
      if (!user?.id) return;
      setRules((prev) => prev.filter((r) => r.id !== id));
      deleteDoc(doc(db, 'users', user.id, 'rules', id)).catch((err) =>
        console.warn('Mapping rule delete failed:', err)
      );
    },
    [user?.id]
  );

  const toggleRule = useCallback(
    async (id: string, enabled: boolean) => {
      if (!user?.id) return;
      setRules((prev) => prev.map((r) => (r.id === id ? { ...r, enabled } : r)));
      updateDoc(doc(db, 'users', user.id, 'rules', id), { enabled }).catch((err) =>
        console.warn('Mapping rule toggle failed:', err)
      );
    },
    [user?.id]
  );

  const addTransaction = async (transaction: Omit<Transaction, 'id'>) => {
    console.log('📝 [TransactionContext] addTransaction called:', transaction);
    
    if (!user?.id) {
      console.warn('⚠️ [TransactionContext] No user ID, cannot add transaction');
      return;
    }

    // #71: a REAL Firestore id, minted locally. There is no temp id to reconcile and
    // no branch on connectivity — the row's identity is settled before the write, so
    // the same code path works online and off.
    const id = firestoreService.newDocId(user.id, 'transactions');
    const newTransaction: Transaction = { ...transaction, id };

    setRawTransactions((prev) => {
      const updated = [newTransaction, ...prev];
      saveLocalTransactions(user.id, updated);
      return updated;
    });

    // NOT awaited, deliberately. Offline this promise does not settle until reconnect
    // (it resolves on the server's ack), while the write itself is already durable in
    // the SDK's IndexedDB cache. Awaiting would freeze the form for the length of an
    // outage and buy nothing.
    firestoreService.addTransaction(user.id, transaction, id).catch((err) => {
      console.warn('Transaction write queued or failed:', err);
    });
  };

  // `id` is optional: the CSV importer supplies deterministic ids so re-importing the
  // same rows overwrites instead of duplicating. Everything else keeps auto-ids.
  const addBulkTransactions = async (
    newTransactions: (Omit<Transaction, 'id'> & { id?: string })[]
  ) => {
    if (!user?.id || newTransactions.length === 0) return;

    // Commit to Firestore BEFORE touching local state. The previous order inserted all
    // N rows optimistically and swallowed a failed write, so the mirror claimed rows
    // that were never persisted and the caller reported success either way.
    if (isFirestoreOnline) {
      try {
        await firestoreService.addBulkTransactions(user.id, newTransactions);
        await syncFromFirestore(user.id);
        return { persisted: true };
      } catch (err) {
        // The write did not land. Fall through to the local mirror so the rows still
        // exist somewhere, and tell the caller it was not a clean import.
        console.warn('Bulk write failed, keeping rows locally:', err);
        setIsFirestoreOnline(false);
      }
    }

    // #71: real ids here too, and the write is re-fired rather than abandoned. The old
    // code minted `local_` ids and stopped, so a bulk import that failed once lived in
    // localStorage forever. Any caller-supplied import id is preserved — it is
    // deterministic, so re-importing overwrites instead of duplicating.
    const transactionsWithIds: Transaction[] = newTransactions.map((t) => ({
      ...t,
      id: t.id ?? firestoreService.newDocId(user.id, 'transactions'),
    }));

    setRawTransactions((prev) => {
      const updated = [...transactionsWithIds, ...prev];
      saveLocalTransactions(user.id, updated);
      return updated;
    });

    // Hand it back to the SDK unawaited: it queues durably and replays on reconnect.
    firestoreService.addBulkTransactions(user.id, transactionsWithIds).catch((err) => {
      console.warn('Bulk write queued or failed:', err);
    });

    return { persisted: false };
  };

  const updateTransaction = async (id: string, updates: Partial<Transaction>) => {
    if (!user?.id) return;

    // Update local state immediately
    setRawTransactions((prev) => {
      const updated = prev.map((t) => (t.id === id ? { ...t, ...updates } : t));
      saveLocalTransactions(user.id, updated);
      return updated;
    });

    // #71: no connectivity branch and no `local_` guard. Both existed to skip writes
    // that would "fail" offline; the SDK queues them instead, and skipping is what
    // stranded the rows. An id that is still `local_` belongs to an orphan from an
    // older version — syncFromFirestore rescues those, so nothing is written under one.
    if (!isUnsyncedId(id)) {
      firestoreService.updateTransaction(user.id, id, updates).catch((err) => {
        console.warn('Transaction update queued or failed:', err);
      });
    }
  };

  const deleteTransaction = async (id: string) => {
    if (!user?.id) return;

    // Update local state immediately
    setRawTransactions((prev) => {
      const updated = prev.filter((t) => t.id !== id);
      saveLocalTransactions(user.id, updated);
      return updated;
    });

    // #71: same as update — queue it, do not skip it. A `local_` id has no server
    // document to delete, so there is nothing to send for one.
    if (!isUnsyncedId(id)) {
      firestoreService.deleteTransaction(user.id, id).catch((err) => {
        console.warn('Transaction delete queued or failed:', err);
      });
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

  // These three drive the dashboard's spending breakdowns, so they use the SHARED
  // interpretation rather than the stored type — otherwise a credit-card payment is
  // charged to a payment method / category as if it were a purchase, on top of the
  // purchases it settles. `accounts` is optional so the classifier can see account
  // types; the dashboard passes profile.paymentAccounts.
  // PENDING: EXCLUDED — interpretTransaction returns 'excluded' for a hold.
  const getTotalByPaymentMethod = (accounts?: PaymentAccount[], income?: IncomeContext): { method: PaymentMethod; total: number; count: number }[] => {
    const totals: { [key: string]: { total: number; count: number } } = {};

    transactions
      .filter((t) => interpretTransaction(t, accounts, income).expense === 'counted')
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

  const getTotalByCategory = (accounts?: PaymentAccount[], income?: IncomeContext): { category: ExpenseCategory; total: number; count: number }[] => {
    const totals: { [key: string]: { total: number; count: number } } = {};

    transactions
      .filter((t) => interpretTransaction(t, accounts, income).expense === 'counted')
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

  const getMonthlyTotals = (accounts?: PaymentAccount[], income?: IncomeContext): { month: string; income: number; expenses: number }[] => {
    const monthlyData: { [key: string]: { income: number; expenses: number } } = {};

    transactions.forEach((t) => {
      const date = new Date(t.date);
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      
      if (!monthlyData[monthKey]) {
        monthlyData[monthKey] = { income: 0, expenses: 0 };
      }
      
      // Bare `else` would bucket every transfer as spending. This drives the
      // dashboard's Monthly Overview chart, and the interpretation keeps it
      // agreeing with /flow and /analytics on the same data.
      const i = interpretTransaction(t, accounts, income);
      if (i.income === 'counted') {
        monthlyData[monthKey].income += t.amount;
      } else if (i.expense === 'counted') {
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
        setRawTransactions(sampleData);
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
        rules,
        addRule,
        deleteRule,
        toggleRule,
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
