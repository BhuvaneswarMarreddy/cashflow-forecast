/**
 * Firestore Database Structure
 * ============================
 * 
 * Collections:
 * 
 * users/{userId}
 *   - Core user profile data
 *   - Created on first sign-in
 * 
 * users/{userId}/accounts/{accountId}
 *   - Payment accounts (credit cards, bank accounts, etc.)
 *   - Subcollection for better scalability
 * 
 * users/{userId}/income/{incomeId}
 *   - Income sources
 *   - Subcollection for better scalability
 * 
 * users/{userId}/transactions/{transactionId}
 *   - All transactions (expenses & income)
 *   - Subcollection for better scalability and security
 */

import {
  db,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  addDoc,
  serverTimestamp,
  Timestamp,
  writeBatch,
} from './firebase';
import { 
  Transaction, 
  PaymentAccount, 
  IncomeSource,
  ExpenseCategory,
  CategoryBudget,
  NotificationPreferences,
  SavingsGoal,
  Reminder,
  ReminderStatus,
  PlannedTransaction,
  PlannedTransactionStatus,
} from '@/types';
import { startSpan } from '@/lib/obs/trace';

// ============================================
// Types for Firestore Documents
// ============================================

export interface FirestoreUser {
  uid: string;
  email: string;
  displayName: string;
  photoURL?: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  settings: {
    currency: string;
    timezone: string;
    monthlyBudget: number;
    notifications: boolean;
    safetyThreshold?: number;
    emergencyFundGoal?: number; // Target in months
    emergencyFundAmount?: number; // Target in dollars
    categoryBudgets?: CategoryBudget[]; // Per-category spending limits
    notificationPreferences?: NotificationPreferences; // Reminder settings
  };
  metadata: {
    isOnboarded: boolean;
    lastLoginAt: Timestamp;
    signUpMethod: 'email' | 'google';
  };
}

export interface FirestoreSavingsGoal {
  id?: string;
  name: string;
  targetAmount: number;
  currentAmount: number;
  targetDate?: string;
  linkedAccountId?: string;
  priority: 1 | 2 | 3 | 4 | 5;
  color: string;
  isActive: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface FirestoreReminder {
  id?: string;
  date: Timestamp;
  title: string;
  amount?: number;
  relatedAccountId?: string;
  relatedTransactionId?: string;
  type: 'bill' | 'credit_card' | 'loan' | 'subscription';
  status: ReminderStatus;
  createdAt: Timestamp;
}

export interface FirestorePlannedTransaction {
  id?: string;
  title: string;
  amount: number;
  type: 'expense' | 'income';
  category: ExpenseCategory;
  accountId?: string;
  dueDate: Timestamp;
  notes?: string;
  status: PlannedTransactionStatus;
  priority: 'high' | 'medium' | 'low';
  isRecurring?: boolean;
  recurringFrequency?: 'weekly' | 'monthly' | 'yearly';
  completedDate?: Timestamp;
  linkedTransactionId?: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface FirestoreAccount {
  id?: string;
  name: string;
  type: 'credit_card' | 'debit_card' | 'bank_account' | 'cash' | 'personal_loan';
  provider: string;
  openingBalance: number;
  creditLimit?: number;
  apr?: number;
  statementDate?: number;
  dueDate?: number;
  lastFourDigits?: string;
  color: string;
  isActive: boolean;
  sortIndex?: number; // user-defined display order
  openingDate?: string; // ISO yyyy-MM-dd (Phase B)
  paymentFromAccountId?: string; // Which account pays this card/loan
  // Loan specific
  originalAmount?: number;
  monthlyPayment?: number;
  loanTerm?: number;
  loanStartDate?: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface FirestoreIncome {
  id?: string;
  name: string;
  amount: number;
  frequency: 'weekly' | 'biweekly' | 'monthly' | 'yearly';
  payDate?: number;
  nextPayDate?: string; // ISO date string
  isActive: boolean;
  endDate?: string; // ISO date when income ends
  remainingPayments?: number; // Number of remaining payments
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface FirestoreTransaction {
  id?: string;
  title: string;
  amount: number;
  type: 'expense' | 'income';
  category: ExpenseCategory;
  paymentMethod: string;
  accountId?: string;
  date: Timestamp;
  description?: string;
  merchant?: string;
  isRecurring?: boolean;
  recurringFrequency?: 'weekly' | 'monthly' | 'yearly';
  recurringEndDate?: string; // ISO date when recurring ends
  recurringCount?: number; // Number of remaining payments
  isProjected?: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ============================================
// Helper to check if error is offline error
// ============================================
function isOfflineError(error: any): boolean {
  return error?.code === 'unavailable' || 
         error?.message?.includes('offline') ||
         error?.message?.includes('Failed to get document');
}

// ============================================
// User Profile Operations
// ============================================

export async function createUserProfile(
  userId: string,
  data: {
    email: string;
    displayName: string;
    photoURL?: string;
    signUpMethod: 'email' | 'google';
  }
): Promise<void> {
  // OBS-001: was logging the user's email and, below, the entire profile document.
  const span = startSpan('Firestore.CreateUserProfile', {
    repository: 'firestore.createUserProfile',
    dataSource: 'Firestore',
    metadata: { collection: 'users', signUpMethod: data.signUpMethod },
  });

  try {
    const userRef = doc(db, 'users', userId);

    const now = serverTimestamp();

    const profileData = {
      uid: userId,
      email: data.email,
      displayName: data.displayName,
      photoURL: data.photoURL || null,
      createdAt: now,
      updatedAt: now,
      settings: {
        currency: 'USD',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        monthlyBudget: 0,
        notifications: true,
      },
      metadata: {
        isOnboarded: false,
        lastLoginAt: now,
        signUpMethod: data.signUpMethod,
      },
    };

    // Set a timeout for the write operation to detect hanging
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Write operation timed out after 10 seconds')), 10000);
    });
    
    const writePromise = setDoc(userRef, profileData);
    
    // Race between the write and timeout
    await Promise.race([writePromise, timeoutPromise]);
    
    // Verify the write by reading back. Existence only — the document itself is the
    // user's profile and has no business in a console.
    let verified: boolean | 'unknown' = 'unknown';
    try {
      verified = (await getDoc(userRef)).exists();
      if (!verified) console.warn('⚠️ [Firestore] Profile not found after write (may still be syncing)');
    } catch {
      console.warn('⚠️ [Firestore] Could not verify profile write');
    }
    span.end({ recordCount: 1, metadata: { verified } });

  } catch (error: any) {
    span.end({ status: 'error', error, metadata: { timedOut: Boolean(error?.message?.includes('timed out')) } });

    if (isOfflineError(error)) {
      console.warn('⚠️ [Firestore] Offline - profile will sync when online');
      return;
    }
    throw error;
  }
}

export async function getUserProfile(userId: string): Promise<FirestoreUser | null> {
  try {
    const userRef = doc(db, 'users', userId);
    const userSnap = await getDoc(userRef);
    
    if (userSnap.exists()) {
      return userSnap.data() as FirestoreUser;
    }
    return null;
  } catch (error) {
    if (isOfflineError(error)) {
      console.warn('Firestore offline - using local data');
      return null;
    }
    console.error('Error getting user profile:', error);
    return null;
  }
}

export async function updateUserProfile(
  userId: string,
  updates: Partial<FirestoreUser>
): Promise<void> {
  try {
    const userRef = doc(db, 'users', userId);
    await updateDoc(userRef, {
      ...updates,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    if (isOfflineError(error)) {
      console.warn('Firestore offline - update will sync when online');
      return;
    }
    throw error;
  }
}

export async function updateUserSettings(
  userId: string,
  settings: Partial<FirestoreUser['settings']>
): Promise<void> {
  try {
    const userRef = doc(db, 'users', userId);
    const updates: Record<string, any> = { updatedAt: serverTimestamp() };
    
    Object.entries(settings).forEach(([key, value]) => {
      updates[`settings.${key}`] = value;
    });
    
    await updateDoc(userRef, updates);
  } catch (error) {
    if (isOfflineError(error)) {
      console.warn('Firestore offline - settings will sync when online');
      return;
    }
    throw error;
  }
}

export async function completeUserOnboarding(userId: string): Promise<void> {
  try {
    const userRef = doc(db, 'users', userId);
    await updateDoc(userRef, {
      'metadata.isOnboarded': true,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    if (isOfflineError(error)) {
      console.warn('Firestore offline - onboarding status will sync when online');
      return;
    }
    throw error;
  }
}

export async function updateLastLogin(userId: string): Promise<void> {
  try {
    const userRef = doc(db, 'users', userId);
    await updateDoc(userRef, {
      'metadata.lastLoginAt': serverTimestamp(),
    });
  } catch (error) {
    // Silent fail for last login update
    console.warn('Could not update last login:', error);
  }
}

// ============================================
// Payment Account Operations
// ============================================

// Helper to remove undefined values from object (Firestore doesn't accept undefined)
function removeUndefined<T extends Record<string, any>>(obj: T): Partial<T> {
  const result: Partial<T> = {};
  for (const key of Object.keys(obj)) {
    if (obj[key] !== undefined) {
      result[key as keyof T] = obj[key];
    }
  }
  return result;
}

export async function addAccount(
  userId: string,
  account: Omit<FirestoreAccount, 'id' | 'createdAt' | 'updatedAt'>
): Promise<string> {
  // OBS-001: the old logging here printed the whole account payload (balance, credit
  // limit, last four) to the browser console on every add. Replaced with a span that
  // records the SHAPE of the write — which fields were set — and never their values.
  const span = startSpan('Firestore.AddAccount', {
    repository: 'firestore.addAccount',
    dataSource: 'Firestore',
    metadata: { collection: 'users/{uid}/accounts' },
  });

  // Remove undefined values - Firestore doesn't accept them
  const cleanAccount = removeUndefined(account);

  try {
    const accountsRef = collection(db, 'users', userId, 'accounts');
    const now = serverTimestamp();

    const docRef = await addDoc(accountsRef, {
      ...cleanAccount,
      createdAt: now,
      updatedAt: now,
    });

    span.end({ recordCount: 1, metadata: { accountId: docRef.id, type: account.type, fieldsSet: Object.keys(cleanAccount).sort() } });
    return docRef.id;
  } catch (error: any) {
    span.end({ status: 'error', error });

    if (isOfflineError(error)) {
      console.warn('⚠️ [Firestore] Offline - account will sync when online');
      return `offline_${Date.now()}`;
    }
    throw error;
  }
}

export async function getAccounts(userId: string): Promise<PaymentAccount[]> {
  // Repository boundary: record count + duration + source, never the documents.
  const span = startSpan('Firestore.GetAccounts', {
    repository: 'firestore.getAccounts',
    dataSource: 'Firestore',
    metadata: { collection: 'users/{uid}/accounts', filter: 'isActive == true' },
  });
  try {
    const accountsRef = collection(db, 'users', userId, 'accounts');
    const q = query(accountsRef, where('isActive', '==', true));
    const snapshot = await getDocs(q);

    const accounts = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    })) as PaymentAccount[];
    span.end({ recordCount: accounts.length, metadata: { fromCache: snapshot.metadata.fromCache } });
    return accounts;
  } catch (error) {
    if (isOfflineError(error)) {
      console.warn('Firestore offline - using local accounts');
      span.end({ status: 'error', error, recordCount: 0, metadata: { offline: true } });
      return [];
    }
    console.error('Error getting accounts:', error);
    span.end({ status: 'error', error, recordCount: 0 });
    return [];
  }
}

export async function updateAccount(
  userId: string,
  accountId: string,
  updates: Partial<FirestoreAccount>
): Promise<void> {
  try {
    const accountRef = doc(db, 'users', userId, 'accounts', accountId);
    // Remove undefined fields to avoid Firestore errors
    const cleanedUpdates = removeUndefined(updates);
    await updateDoc(accountRef, {
      ...cleanedUpdates,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    if (isOfflineError(error)) {
      console.warn('Firestore offline - update will sync when online');
      return;
    }
    throw error;
  }
}

/** Persist a new display order: one atomic batch, one sortIndex per changed account. */
export async function updateAccountsBatch(
  userId: string,
  updates: Array<{ id: string; sortIndex: number }>
): Promise<void> {
  if (updates.length === 0) return;
  const batch = writeBatch(db);
  for (const u of updates) {
    batch.update(doc(db, 'users', userId, 'accounts', u.id), {
      sortIndex: u.sortIndex,
      updatedAt: serverTimestamp(),
    });
  }
  await batch.commit();
}

export async function deleteAccount(userId: string, accountId: string): Promise<void> {
  try {
    const accountRef = doc(db, 'users', userId, 'accounts', accountId);
    await deleteDoc(accountRef);
  } catch (error) {
    if (isOfflineError(error)) {
      console.warn('Firestore offline - delete will sync when online');
      return;
    }
    throw error;
  }
}

// ============================================
// Income Source Operations
// ============================================

export async function addIncome(
  userId: string,
  income: Omit<FirestoreIncome, 'id' | 'createdAt' | 'updatedAt'>
): Promise<string> {
  console.log('📝 [Firestore] addIncome called for user:', userId);
  
  // Remove undefined values - Firestore doesn't accept them
  const cleanIncome = removeUndefined(income);
  console.log('📝 [Firestore] Income data (cleaned):', JSON.stringify(cleanIncome, null, 2));
  
  try {
    const incomeRef = collection(db, 'users', userId, 'income');
    const now = serverTimestamp();
    
    const docRef = await addDoc(incomeRef, {
      ...cleanIncome,
      createdAt: now,
      updatedAt: now,
    });
    
    console.log('✅ [Firestore] Income created with ID:', docRef.id);
    return docRef.id;
  } catch (error: any) {
    console.error('❌ [Firestore] Failed to add income:', error);
    if (isOfflineError(error)) {
      console.warn('Firestore offline - income will sync when online');
      return `offline_${Date.now()}`;
    }
    throw error;
  }
}

export async function getIncomeSources(userId: string): Promise<IncomeSource[]> {
  try {
    const incomeRef = collection(db, 'users', userId, 'income');
    const q = query(incomeRef, where('isActive', '==', true));
    const snapshot = await getDocs(q);
    
    return snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    })) as IncomeSource[];
  } catch (error) {
    if (isOfflineError(error)) {
      console.warn('Firestore offline - using local income sources');
      return [];
    }
    console.error('Error getting income sources:', error);
    return [];
  }
}

export async function updateIncome(
  userId: string,
  incomeId: string,
  updates: Partial<FirestoreIncome>
): Promise<void> {
  try {
    const incomeRef = doc(db, 'users', userId, 'income', incomeId);
    await updateDoc(incomeRef, {
      ...updates,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    if (isOfflineError(error)) {
      console.warn('Firestore offline - update will sync when online');
      return;
    }
    throw error;
  }
}

export async function deleteIncome(userId: string, incomeId: string): Promise<void> {
  try {
    const incomeRef = doc(db, 'users', userId, 'income', incomeId);
    await deleteDoc(incomeRef);
  } catch (error) {
    if (isOfflineError(error)) {
      console.warn('Firestore offline - delete will sync when online');
      return;
    }
    throw error;
  }
}

// ============================================
// Transaction Operations
// ============================================

export async function addTransaction(
  userId: string,
  transaction: Omit<Transaction, 'id'>
): Promise<string> {
  try {
    const transactionsRef = collection(db, 'users', userId, 'transactions');
    const now = serverTimestamp();
    
    // Remove undefined fields to avoid Firestore errors
    const cleanedTransaction = removeUndefined(transaction);
    
    console.log('📝 [Firestore] Adding transaction:', JSON.stringify(cleanedTransaction, null, 2));
    
    const docRef = await addDoc(transactionsRef, {
      ...cleanedTransaction,
      date: Timestamp.fromDate(new Date(transaction.date)),
      createdAt: now,
      updatedAt: now,
    });
    
    console.log('✅ [Firestore] Transaction saved with ID:', docRef.id);
    return docRef.id;
  } catch (error) {
    console.error('❌ [Firestore] Error adding transaction:', error);
    if (isOfflineError(error)) {
      console.warn('Firestore offline - transaction will sync when online');
      return `offline_${Date.now()}`;
    }
    throw error;
  }
}

export async function getTransactions(
  userId: string,
  options?: {
    startDate?: Date;
    endDate?: Date;
    category?: ExpenseCategory;
    limit?: number;
  }
): Promise<Transaction[]> {
  const span = startSpan('Firestore.GetTransactions', {
    repository: 'firestore.getTransactions',
    dataSource: 'Firestore',
    metadata: { collection: 'users/{uid}/transactions', orderBy: 'date desc' },
  });
  try {
    const transactionsRef = collection(db, 'users', userId, 'transactions');
    const q = query(transactionsRef, orderBy('date', 'desc'));

    const snapshot = await getDocs(q);

    let transactions = snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        ...data,
        date: data.date instanceof Timestamp ? data.date.toDate().toISOString() : data.date,
      };
    }) as Transaction[];
    
    // Client-side filtering
    if (options?.startDate) {
      transactions = transactions.filter(t => new Date(t.date) >= options.startDate!);
    }
    if (options?.endDate) {
      transactions = transactions.filter(t => new Date(t.date) <= options.endDate!);
    }
    if (options?.category) {
      transactions = transactions.filter(t => t.category === options.category);
    }
    if (options?.limit) {
      transactions = transactions.slice(0, options.limit);
    }

    span.end({
      recordCount: transactions.length,
      metadata: { fetched: snapshot.size, fromCache: snapshot.metadata.fromCache, filtered: snapshot.size !== transactions.length },
    });
    return transactions;
  } catch (error) {
    span.end({ status: 'error', error });
    // Must throw, never return []. The caller writes whatever comes back straight over
    // the localStorage mirror, so returning [] for a failed read erased the user's
    // entire cached history. Throwing is also the only way the caller can tell a
    // failed read apart from a genuinely empty collection.
    if (isOfflineError(error)) {
      console.warn('Firestore offline - using local transactions');
    } else {
      console.error('Error getting transactions:', error);
    }
    throw error;
  }
}

export async function updateTransaction(
  userId: string,
  transactionId: string,
  updates: Partial<Transaction>
): Promise<void> {
  try {
    const transactionRef = doc(db, 'users', userId, 'transactions', transactionId);
    // Remove undefined fields to avoid Firestore errors
    const cleanedUpdates = removeUndefined(updates);
    const updateData: Record<string, any> = {
      ...cleanedUpdates,
      updatedAt: serverTimestamp(),
    };
    
    if (updates.date) {
      updateData.date = Timestamp.fromDate(new Date(updates.date));
    }
    
    await updateDoc(transactionRef, updateData);
  } catch (error) {
    if (isOfflineError(error)) {
      console.warn('Firestore offline - update will sync when online');
      return;
    }
    throw error;
  }
}

export async function deleteTransaction(userId: string, transactionId: string): Promise<void> {
  try {
    const transactionRef = doc(db, 'users', userId, 'transactions', transactionId);
    await deleteDoc(transactionRef);
  } catch (error) {
    if (isOfflineError(error)) {
      console.warn('Firestore offline - delete will sync when online');
      return;
    }
    throw error;
  }
}

/**
 * A transaction supplying its own `id` is written to that exact document, so
 * re-importing a row the user already has overwrites it instead of duplicating.
 * Rows without an id keep Firestore's auto-generated ids.
 */
export async function addBulkTransactions(
  userId: string,
  transactions: (Omit<Transaction, 'id'> & { id?: string })[]
): Promise<void> {
  try {
    const transactionsRef = collection(db, 'users', userId, 'transactions');

    // Firestore rejects a batch of more than 500 writes, and a Monarch export can be
    // 5,000 rows. Each chunk commits independently: a failure part-way leaves earlier
    // chunks committed, which is safe precisely because the ids are deterministic —
    // re-running the import finishes the job rather than duplicating it.
    for (let i = 0; i < transactions.length; i += 500) {
      const batch = writeBatch(db);
      const now = serverTimestamp();

      transactions.slice(i, i + 500).forEach(({ id, ...transaction }) => {
        const docRef = id ? doc(transactionsRef, id) : doc(transactionsRef);
        batch.set(
          docRef,
          {
            ...removeUndefined(transaction),
            date: Timestamp.fromDate(new Date(transaction.date)),
            updatedAt: now,
            ...(id ? {} : { createdAt: now }),
          },
          // merge so a re-import cannot blank fields the CSV does not carry
          // (a description the user typed, isRecurring they set by hand).
          { merge: true }
        );
      });

      await batch.commit();
    }
  } catch (error) {
    // Deliberately NOT swallowing an offline error here. Returning void made a failed
    // bulk write indistinguishable from a successful one, so the importer reported
    // "Successfully imported N" for rows that reached neither Firestore nor the local
    // mirror. The caller needs to know so it can fall back to a local-only write.
    if (isOfflineError(error)) {
      console.warn('Firestore offline - bulk write did not land');
    }
    throw error;
  }
}

// ============================================
// Savings Goals Operations
// ============================================

export async function addSavingsGoal(
  userId: string,
  goal: Omit<SavingsGoal, 'id' | 'createdAt' | 'updatedAt'>
): Promise<string> {
  try {
    const goalsRef = collection(db, 'users', userId, 'goals');
    const now = serverTimestamp();
    
    const cleanGoal = removeUndefined(goal);
    
    const docRef = await addDoc(goalsRef, {
      ...cleanGoal,
      createdAt: now,
      updatedAt: now,
    });
    
    return docRef.id;
  } catch (error) {
    if (isOfflineError(error)) {
      console.warn('Firestore offline - goal will sync when online');
      return `offline_${Date.now()}`;
    }
    throw error;
  }
}

export async function getSavingsGoals(userId: string): Promise<SavingsGoal[]> {
  try {
    const goalsRef = collection(db, 'users', userId, 'goals');
    const q = query(goalsRef, where('isActive', '==', true));
    const snapshot = await getDocs(q);
    
    return snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        ...data,
        createdAt: data.createdAt?.toDate?.()?.toISOString() || new Date().toISOString(),
        updatedAt: data.updatedAt?.toDate?.()?.toISOString() || new Date().toISOString(),
      };
    }) as SavingsGoal[];
  } catch (error) {
    if (isOfflineError(error)) {
      console.warn('Firestore offline - using local goals');
      return [];
    }
    console.error('Error getting savings goals:', error);
    return [];
  }
}

export async function updateSavingsGoal(
  userId: string,
  goalId: string,
  updates: Partial<SavingsGoal>
): Promise<void> {
  try {
    const goalRef = doc(db, 'users', userId, 'goals', goalId);
    const cleanedUpdates = removeUndefined(updates);
    await updateDoc(goalRef, {
      ...cleanedUpdates,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    if (isOfflineError(error)) {
      console.warn('Firestore offline - update will sync when online');
      return;
    }
    throw error;
  }
}

export async function deleteSavingsGoal(userId: string, goalId: string): Promise<void> {
  try {
    const goalRef = doc(db, 'users', userId, 'goals', goalId);
    await deleteDoc(goalRef);
  } catch (error) {
    if (isOfflineError(error)) {
      console.warn('Firestore offline - delete will sync when online');
      return;
    }
    throw error;
  }
}

// ============================================
// Reminders Operations
// ============================================

export async function addReminder(
  userId: string,
  reminder: Omit<Reminder, 'id' | 'createdAt'>
): Promise<string> {
  try {
    const remindersRef = collection(db, 'users', userId, 'reminders');
    const now = serverTimestamp();
    
    const cleanReminder = removeUndefined(reminder);
    
    const docRef = await addDoc(remindersRef, {
      ...cleanReminder,
      date: Timestamp.fromDate(new Date(reminder.date)),
      createdAt: now,
    });
    
    return docRef.id;
  } catch (error) {
    if (isOfflineError(error)) {
      console.warn('Firestore offline - reminder will sync when online');
      return `offline_${Date.now()}`;
    }
    throw error;
  }
}

export async function getReminders(
  userId: string,
  options?: { status?: ReminderStatus; startDate?: Date; endDate?: Date }
): Promise<Reminder[]> {
  try {
    const remindersRef = collection(db, 'users', userId, 'reminders');
    const q = query(remindersRef, orderBy('date', 'asc'));
    
    const snapshot = await getDocs(q);
    
    let reminders = snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        ...data,
        date: data.date instanceof Timestamp ? data.date.toDate().toISOString() : data.date,
        createdAt: data.createdAt?.toDate?.()?.toISOString() || new Date().toISOString(),
      };
    }) as Reminder[];
    
    // Client-side filtering
    if (options?.status) {
      reminders = reminders.filter(r => r.status === options.status);
    }
    if (options?.startDate) {
      reminders = reminders.filter(r => new Date(r.date) >= options.startDate!);
    }
    if (options?.endDate) {
      reminders = reminders.filter(r => new Date(r.date) <= options.endDate!);
    }
    
    return reminders;
  } catch (error) {
    if (isOfflineError(error)) {
      console.warn('Firestore offline - using local reminders');
      return [];
    }
    console.error('Error getting reminders:', error);
    return [];
  }
}

export async function updateReminder(
  userId: string,
  reminderId: string,
  updates: Partial<Reminder>
): Promise<void> {
  try {
    const reminderRef = doc(db, 'users', userId, 'reminders', reminderId);
    const updateData: Record<string, any> = { ...removeUndefined(updates) };
    
    if (updates.date) {
      updateData.date = Timestamp.fromDate(new Date(updates.date));
    }
    
    await updateDoc(reminderRef, updateData);
  } catch (error) {
    if (isOfflineError(error)) {
      console.warn('Firestore offline - update will sync when online');
      return;
    }
    throw error;
  }
}

export async function deleteReminder(userId: string, reminderId: string): Promise<void> {
  try {
    const reminderRef = doc(db, 'users', userId, 'reminders', reminderId);
    await deleteDoc(reminderRef);
  } catch (error) {
    if (isOfflineError(error)) {
      console.warn('Firestore offline - delete will sync when online');
      return;
    }
    throw error;
  }
}

// Delete old reminders (cleanup)
export async function cleanupOldReminders(userId: string, daysOld: number = 30): Promise<void> {
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysOld);
    
    const reminders = await getReminders(userId);
    const oldReminders = reminders.filter(r => 
      new Date(r.date) < cutoffDate && (r.status === 'paid' || r.status === 'dismissed')
    );
    
    const batch = writeBatch(db);
    oldReminders.forEach(r => {
      const reminderRef = doc(db, 'users', userId, 'reminders', r.id);
      batch.delete(reminderRef);
    });
    
    await batch.commit();
  } catch (error) {
    console.warn('Error cleaning up old reminders:', error);
  }
}

// ============================================
// Utility Functions
// ============================================

export async function hasUserData(userId: string): Promise<boolean> {
  try {
    const transactionsRef = collection(db, 'users', userId, 'transactions');
    const snapshot = await getDocs(query(transactionsRef));
    return !snapshot.empty;
  } catch (error) {
    return false;
  }
}

export async function deleteAllUserData(userId: string): Promise<void> {
  try {
    // Delete all subcollections first
    const subcollections = ['accounts', 'income', 'transactions', 'goals', 'reminders'];
    
    for (const subcollection of subcollections) {
      const collectionRef = collection(db, 'users', userId, subcollection);
      const snapshot = await getDocs(collectionRef);
      const batch = writeBatch(db);
      
      snapshot.docs.forEach((doc) => {
        batch.delete(doc.ref);
      });
      
      await batch.commit();
    }
    
    // Delete user document
    const userRef = doc(db, 'users', userId);
    await deleteDoc(userRef);
  } catch (error) {
    if (isOfflineError(error)) {
      console.warn('Firestore offline - deletion will sync when online');
      return;
    }
    throw error;
  }
}

// ============================================
// Planned Transactions Operations (Financial Todos)
// ============================================

export async function addPlannedTransaction(
  userId: string,
  planned: Omit<PlannedTransaction, 'id' | 'createdAt' | 'updatedAt'>
): Promise<string> {
  try {
    const plannedRef = collection(db, 'users', userId, 'plannedTransactions');
    const now = serverTimestamp();
    
    const cleanPlanned = removeUndefined(planned);
    
    const docRef = await addDoc(plannedRef, {
      ...cleanPlanned,
      dueDate: Timestamp.fromDate(new Date(planned.dueDate)),
      completedDate: planned.completedDate ? Timestamp.fromDate(new Date(planned.completedDate)) : null,
      createdAt: now,
      updatedAt: now,
    });
    
    return docRef.id;
  } catch (error) {
    if (isOfflineError(error)) {
      console.warn('Firestore offline - planned transaction will sync when online');
      return `offline_${Date.now()}`;
    }
    throw error;
  }
}

export async function getPlannedTransactions(
  userId: string,
  options?: { status?: PlannedTransactionStatus; month?: string }
): Promise<PlannedTransaction[]> {
  try {
    const plannedRef = collection(db, 'users', userId, 'plannedTransactions');
    const q = query(plannedRef, orderBy('dueDate', 'asc'));
    const snapshot = await getDocs(q);
    
    let planned = snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        ...data,
        dueDate: data.dueDate instanceof Timestamp ? data.dueDate.toDate().toISOString() : data.dueDate,
        completedDate: data.completedDate instanceof Timestamp ? data.completedDate.toDate().toISOString() : data.completedDate,
        createdAt: data.createdAt?.toDate?.()?.toISOString() || new Date().toISOString(),
        updatedAt: data.updatedAt?.toDate?.()?.toISOString() || new Date().toISOString(),
      };
    }) as PlannedTransaction[];
    
    // Client-side filtering
    if (options?.status) {
      planned = planned.filter(p => p.status === options.status);
    }
    if (options?.month) {
      const [year, month] = options.month.split('-').map(Number);
      planned = planned.filter(p => {
        const date = new Date(p.dueDate);
        return date.getFullYear() === year && date.getMonth() + 1 === month;
      });
    }
    
    return planned;
  } catch (error) {
    if (isOfflineError(error)) {
      console.warn('Firestore offline - using local planned transactions');
      return [];
    }
    console.error('Error getting planned transactions:', error);
    return [];
  }
}

export async function updatePlannedTransaction(
  userId: string,
  plannedId: string,
  updates: Partial<PlannedTransaction>
): Promise<void> {
  try {
    const plannedRef = doc(db, 'users', userId, 'plannedTransactions', plannedId);
    const cleanedUpdates = removeUndefined(updates);
    
    // Convert dates to Timestamps
    const firestoreUpdates: Record<string, unknown> = { ...cleanedUpdates };
    if (updates.dueDate) {
      firestoreUpdates.dueDate = Timestamp.fromDate(new Date(updates.dueDate));
    }
    if (updates.completedDate) {
      firestoreUpdates.completedDate = Timestamp.fromDate(new Date(updates.completedDate));
    }
    
    await updateDoc(plannedRef, {
      ...firestoreUpdates,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    if (isOfflineError(error)) {
      console.warn('Firestore offline - update will sync when online');
      return;
    }
    throw error;
  }
}

export async function deletePlannedTransaction(userId: string, plannedId: string): Promise<void> {
  try {
    const plannedRef = doc(db, 'users', userId, 'plannedTransactions', plannedId);
    await deleteDoc(plannedRef);
  } catch (error) {
    if (isOfflineError(error)) {
      console.warn('Firestore offline - delete will sync when online');
      return;
    }
    throw error;
  }
}

export async function completePlannedTransaction(
  userId: string,
  plannedId: string,
  transactionId?: string
): Promise<void> {
  try {
    const plannedRef = doc(db, 'users', userId, 'plannedTransactions', plannedId);
    await updateDoc(plannedRef, {
      status: 'completed',
      completedDate: serverTimestamp(),
      linkedTransactionId: transactionId || null,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    if (isOfflineError(error)) {
      console.warn('Firestore offline - completion will sync when online');
      return;
    }
    throw error;
  }
}

// ============================================
// Export helper to check Firestore connection
// ============================================

export async function checkFirestoreConnection(): Promise<boolean> {
  // Always return true - let individual operations handle errors
  // This prevents hanging on connection check
  return true;
}
