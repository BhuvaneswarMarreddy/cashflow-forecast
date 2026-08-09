'use client';

import React, { createContext, useContext, useState, useEffect, ReactNode, useCallback, useRef, useMemo } from 'react';
import { UserProfile, PaymentAccount, IncomeSource, InflowReview, DriftStatus } from '@/types';
import type { IncomeContext } from '@/lib/classify';
import { useAuth } from './AuthContext';
import * as firestoreService from '@/lib/firestore';
import { sortAccounts, reindex, reconcile, driftStatus } from '@/lib/accounts';
import { lastScheduledSyncSlot } from '@/lib/dates';
import { fromFirestoreSettings, toFirestoreSettings } from '@/lib/profile-settings';
import { startSpan, getTrace, errorType } from '@/lib/obs/trace';
import { isUnsyncedId } from '@/lib/offline-queue';
import { emit } from '@/lib/obs/events';
import { recordAudit, auditEntry } from '@/lib/audit';

export interface UserProfileContextType {
  profile: UserProfile | null;
  isLoading: boolean;
  isOnboarded: boolean;
  error: string | null;
  updateProfile: (updates: Partial<UserProfile>) => Promise<void>;
  addPaymentAccount: (account: Omit<PaymentAccount, 'id'>) => Promise<void>;
  // Create several accounts in one state update and return their ids in order. Used by
  // CSV import to auto-create the accounts a file references; a per-account loop over
  // addPaymentAccount would read a stale `profile` each iteration and lose all but one.
  addPaymentAccounts: (accounts: Omit<PaymentAccount, 'id'>[]) => Promise<string[]>;
  updatePaymentAccount: (id: string, updates: Partial<PaymentAccount>) => Promise<void>;
  // INV-1 Fix 3: the interpretation of the drift reconcile() just measured, not only
  // its magnitude — driftStatus()'s one production caller lives inside this function.
  //
  // `failed` (#83 round 4a Defect 4): true only on the two guard clauses below, where
  // reconcile() never even ran (no profile / account not found) — there is no
  // observation and nothing was written. Absent on every real call, including a
  // legitimate NOT_APPLICABLE, so it stays a marker of "could not proceed", not a
  // second status enum a caller has to cross-reference against DriftStatus.
  reconcileAccount: (id: string, enteredCurrent: number, derivedCurrent: number) => Promise<{ driftCents: number; status: DriftStatus; failed?: true }>;
  reorderPaymentAccounts: (orderedIds: string[]) => Promise<void>;
  deletePaymentAccount: (id: string) => Promise<void>;
  addIncomeSource: (income: Omit<IncomeSource, 'id'>) => Promise<void>;
  updateIncomeSource: (id: string, updates: Partial<IncomeSource>) => Promise<void>;
  deleteIncomeSource: (id: string) => Promise<void>;
  /**
   * The ONE earned-income context, passed verbatim to sumIncomeCents(),
   * monthlyAverages(), generateForecast() and selectInflowReviewQueue() by every
   * screen. One object so no surface can drift into its own idea of what income is.
   */
  incomeContext: IncomeContext;
  setInflowReview: (review: InflowReview) => Promise<void>;
  completeOnboarding: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

export const UserProfileContext = createContext<UserProfileContextType | undefined>(undefined);

const LOCAL_STORAGE_KEY = 'cashflow_profile_';

// Helper to create default profile
const createDefaultProfile = (user: { id: string; email: string; name: string }): UserProfile => ({
  id: user.id,
  email: user.email,
  name: user.name,
  createdAt: new Date().toISOString(),
  isOnboarded: false,
  monthlyBudget: 0,
  currency: 'USD',
  paymentAccounts: [],
  incomeSources: [],
  settings: {
    timezone: typeof window !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC',
    notifications: true,
  },
});

export function UserProfileProvider({ children }: { children: ReactNode }) {
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();
  const [profile, setProfile] = useState<UserProfile | null>(null);
  // users/{uid}/reviews — the owner's decisions about individual inflows, kept OUT of
  // the profile document because they are per-transaction, not per-user settings.
  const [inflowReviews, setInflowReviews] = useState<Record<string, InflowReview>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isFirestoreOnline, setIsFirestoreOnline] = useState(true);
  const isFetching = useRef(false);
  const lastUserId = useRef<string | null>(null);

  // Load profile from localStorage - synchronous for instant UI
  const loadLocalProfile = useCallback((userId: string): UserProfile | null => {
    if (typeof window === 'undefined') return null;
    try {
      const stored = localStorage.getItem(LOCAL_STORAGE_KEY + userId);
      return stored ? JSON.parse(stored) : null;
    } catch {
      return null;
    }
  }, []);

  // Save profile to localStorage
  const saveLocalProfile = useCallback((userId: string, data: UserProfile) => {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem(LOCAL_STORAGE_KEY + userId, JSON.stringify(data));
    } catch (e) {
      console.warn('Failed to save to localStorage:', e);
    }
  }, []);

  // Sync profile from Firestore (background operation)
  const syncFromFirestore = useCallback(async (userId: string) => {
    if (isFetching.current) return;
    isFetching.current = true;

    // Application-service boundary for the Accounts flow. Joins whatever trace the
    // page started; the repository spans below nest under it automatically.
    const span = startSpan('UserProfile.SyncFromFirestore', {
      service: 'UserProfileContext',
      operation: 'LoadAccountsAndProfile',
      dataSource: 'Firestore',
    });
    try {
      // Fetch all data in parallel. Do NOT swallow errors into [] here: a failed
      // accounts read must reject the whole sync (outer catch keeps the cached
      // profile) — otherwise one hiccup renders "you have zero accounts" and even
      // caches that empty state to localStorage. Same bug class as the old
      // getTransactions empty-read wipe.
      const [firestoreUser, accounts, incomeSources, reviews] = await Promise.all([
        firestoreService.getUserProfile(userId),
        firestoreService.getAccounts(userId),
        firestoreService.getIncomeSources(userId),
        firestoreService.getInflowReviews(userId),
      ]);
      setInflowReviews(reviews);

      setIsFirestoreOnline(true);

      if (firestoreUser) {
        const fullProfile: UserProfile = {
          id: firestoreUser.uid,
          email: firestoreUser.email,
          name: firestoreUser.displayName,
          createdAt: firestoreUser.createdAt?.toDate?.()?.toISOString() || new Date().toISOString(),
          isOnboarded: firestoreUser.metadata?.isOnboarded || false,
          monthlyBudget: firestoreUser.settings?.monthlyBudget || 0,
          currency: firestoreUser.settings?.currency || 'USD',
          paymentAccounts: sortAccounts(accounts),
          incomeSources: incomeSources,
          // #100: whatever was stored comes back. The allowlist that used to be here
          // rebuilt this object field by field, so a setting it did not name was dropped
          // on every reload — the bug looked like "it forgets when I log in".
          settings: fromFirestoreSettings(firestoreUser.settings),
        };

        setProfile(fullProfile);
        saveLocalProfile(userId, fullProfile);
        span.end({ recordCount: accounts.length, metadata: { incomeSourceCount: incomeSources.length, profileExisted: true } });

        // Update last login in background - fire and forget
        firestoreService.updateLastLogin(userId).catch(() => {});
      } else if (user) {
        // No profile doc exists yet. Without this, `profile` stays null and EVERY
        // profile-dependent write silently no-ops — account creation, onboarding,
        // settings — which is how a CSV import can land 2000+ rows completely unlinked.
        // Seed a profile immediately (with any accounts/income already in Firestore) and
        // create the backing doc in the background.
        const seeded: UserProfile = { ...createDefaultProfile(user), paymentAccounts: sortAccounts(accounts), incomeSources };
        setProfile(seeded);
        saveLocalProfile(userId, seeded);
        span.end({ recordCount: accounts.length, metadata: { incomeSourceCount: incomeSources.length, profileExisted: false } });
        firestoreService.createUserProfile(userId, {
          email: user.email,
          displayName: user.name || user.email.split('@')[0] || 'User',
          signUpMethod: 'email',
        }).catch(err => console.warn('Failed to create missing profile doc:', err));
      }
    } catch (err) {
      console.warn('Firestore sync failed, using cached data:', err);
      setIsFirestoreOnline(false);
      span.end({ status: 'error', error: err });
    } finally {
      isFetching.current = false;
      span.end(); // no-op if already ended; guarantees no span is left open
    }
  }, [saveLocalProfile, user]);

  // Handle auth state changes - FAST path with localStorage first
  useEffect(() => {
    // If auth is still loading, wait
    if (authLoading) {
      return;
    }

    // If not authenticated, clear profile and stop loading
    if (!isAuthenticated || !user?.id) {
      setProfile(null);
      setIsLoading(false);
      lastUserId.current = null;
      return;
    }

    // Skip if same user already loaded
    if (lastUserId.current === user.id && profile) {
      return;
    }
    lastUserId.current = user.id;

    // FAST: Load from localStorage immediately
    const localProfile = loadLocalProfile(user.id);
    if (localProfile) {
      setProfile(localProfile);
      setIsLoading(false);
      // Sync from Firestore in background (don't await)
      syncFromFirestore(user.id);
    } else {
      // No local cache - create default profile and show UI immediately
      const defaultProfile = createDefaultProfile(user);
      setProfile(defaultProfile);
      setIsLoading(false);
      saveLocalProfile(user.id, defaultProfile);
      // Sync from Firestore in background
      syncFromFirestore(user.id);
    }
  }, [isAuthenticated, authLoading, user?.id, user, loadLocalProfile, syncFromFirestore, saveLocalProfile, profile]);

  // Update profile
  const updateProfile = async (updates: Partial<UserProfile>) => {
    if (!profile || !user?.id) return;

    // Merge settings properly
    const mergedSettings = updates.settings 
      ? { ...profile.settings, ...updates.settings }
      : profile.settings;

    const updatedProfile = { 
      ...profile, 
      ...updates,
      settings: mergedSettings,
    };
    setProfile(updatedProfile);
    saveLocalProfile(user.id, updatedProfile);

    {
      try {
        // #100: every settings key goes, not a hand-listed subset. The old allowlist
        // here silently dropped anything not named in it — `includePendingInCalculations`
        // was never written at all, and `timezone`/`notifications` never had been either.
        const firestoreSettings = toFirestoreSettings(mergedSettings, {
          monthlyBudget: updates.monthlyBudget ?? profile.monthlyBudget,
          currency: updates.currency ?? profile.currency,
        });

        await firestoreService.updateUserSettings(user.id, firestoreSettings);
        setIsFirestoreOnline(true);
      } catch (err) {
        console.error('Failed to sync profile update:', err);
        setIsFirestoreOnline(false);
      }
    }
  };

  // Add payment account
  const addPaymentAccount = async (account: Omit<PaymentAccount, 'id'>) => {
    // OBS-001: was logging the account name here and the Firestore id below.
    if (!profile || !user?.id) {
      emit({
        eventName: 'Accounts.AddSkipped', eventCategory: 'activity', severity: 'warn',
        traceId: getTrace()?.traceId ?? '', service: 'UserProfileContext', operation: 'AddPaymentAccount',
        resultStatus: 'error', metadata: { reason: 'no-profile-or-user' },
      });
      return;
    }

    // #71: real Firestore id minted locally, so there is no temp id to swap afterwards
    // and no window in which the account exists only in localStorage.
    const id = firestoreService.newDocId(user.id, 'accounts');
    const newAccount: PaymentAccount = { ...account, id };

    const updatedProfile = {
      ...profile,
      paymentAccounts: [...profile.paymentAccounts, newAccount],
    };
    setProfile(updatedProfile);
    saveLocalProfile(user.id, updatedProfile);

    // Unawaited: offline this settles only on reconnect, while the write is already
    // durable in the SDK's cache.
    firestoreService.addAccount(user.id, account, id).catch((err) => {
      emit({
        eventName: 'Accounts.AddFailed', eventCategory: 'activity', severity: 'error',
        traceId: getTrace()?.traceId ?? '', service: 'UserProfileContext', operation: 'AddPaymentAccount',
        resultStatus: 'error', metadata: { errorType: errorType(err) },
      });
    });
  };

  const addPaymentAccounts = async (accounts: Omit<PaymentAccount, 'id'>[]): Promise<string[]> => {
    if (!profile || !user?.id || accounts.length === 0) return [];

    // #71: mint first, write unawaited. The old loop awaited each write and, on
    // failure, kept a `local_` id that no code path would ever persist.
    const created: PaymentAccount[] = accounts.map((account) => ({
      ...account,
      id: firestoreService.newDocId(user.id, 'accounts'),
    }));
    for (const account of created) {
      const { id, ...rest } = account;
      firestoreService.addAccount(user.id, rest, id).catch((err) => {
        console.error('Imported account write queued or failed:', err);
      });
    }

    // One state update with every new account appended — reads `profile` once.
    const updatedProfile = {
      ...profile,
      paymentAccounts: [...profile.paymentAccounts, ...created],
    };
    setProfile(updatedProfile);
    saveLocalProfile(user.id, updatedProfile);
    return created.map(a => a.id);
  };

  // Update payment account
  const updatePaymentAccount = async (id: string, updates: Partial<PaymentAccount>) => {
    if (!profile || !user?.id) return;

    const updatedAccounts = profile.paymentAccounts.map((acc) =>
      acc.id === id ? { ...acc, ...updates } : acc
    );
    const updatedProfile = { ...profile, paymentAccounts: updatedAccounts };
    setProfile(updatedProfile);
    saveLocalProfile(user.id, updatedProfile);

    // Always attempt the server write for a real account id. Gating this on a cached
    // `isFirestoreOnline` flag silently dropped balance edits: the value updated the
    // screen and localStorage but never reached Firestore, so a reload (which reads
    // balances from the server) showed 0 again. The try/catch already handles a true
    // offline; on success we know we're online.
    if (!isUnsyncedId(id)) {
      try {
        await firestoreService.updateAccount(user.id, id, updates as any);
        setIsFirestoreOnline(true);
      } catch (err) {
        console.error('Failed to sync account update:', err);
        setIsFirestoreOnline(false);
      }
    }
  };

  // Reconcile an account to the user's real balance. `derivedCurrent` is passed by the
  // caller (which holds the transaction ledger) so this context stays ledger-free. Any
  // drift re-anchors (openingBalance = entered, openingDate = today). Returns drift cents
  // AND the interpreted status (INV-1 Fix 3), so a caller can surface what the
  // measurement actually found instead of a bare number.
  const reconcileAccount = async (id: string, enteredCurrent: number, derivedCurrent: number): Promise<{ driftCents: number; status: DriftStatus; failed?: true }> => {
    // `failed: true` (Defect 4): these two returns are NOT a measurement — reconcile()
    // never runs, so there is no observation and nothing gets written. The old code
    // reused NOT_APPLICABLE's shape for this, and ReconcileSheet's NOT_APPLICABLE
    // copy ("it's now anchored to $X") then claimed a write that never happened.
    if (!profile) return { driftCents: 0, status: 'NOT_APPLICABLE', failed: true };
    const acc = profile.paymentAccounts.find((x) => x.id === id);
    if (!acc) return { driftCents: 0, status: 'NOT_APPLICABLE', failed: true };
    const today = new Date().toISOString().slice(0, 10);
    // includePending was a Task-4 placeholder (`false` always); this is the one real
    // policy value every other screen already reads, so a reconcile computed under a
    // different pending-inclusion rule than the balance it's checking is not possible.
    //
    // providerCheckedAt (INV-1 Fix 2) is deliberately OMITTED: the only place that value
    // exists client-side is sync_now's callable response (src/lib/sync-client.ts), which
    // is a live 10-20s bank round trip — never something to trigger just to interpret a
    // reconcile. meta/<source> itself is not client-readable (no match block for `meta`
    // in firestore.rules; see src/lib/obs/provenance.ts's identical conclusion). Until
    // something already loads that value into app state, STALE_INPUT stays reachable in
    // driftStatus() but unobserved in production — an absent value is honest; blocking
    // this on a network read would not be.
    const { driftCents, reanchor, observation } = reconcile(acc, enteredCurrent, derivedCurrent, today,
      { includePending: incomeContext.includePending ?? false, source: 'user' });
    // driftStatus's one production caller: interpret the observation against the sync
    // schedule at the SAME instant it was stamped (observation.at), not a fresh
    // `new Date()` here — the two calls are microseconds apart, but the observation's
    // own timestamp is the one honest reference for "when was this measured".
    const status = driftStatus(observation, lastScheduledSyncSlot(new Date(observation.at)).toISOString());
    // INV-1: write the observation BEFORE the reanchor lands. Once `updatePaymentAccount`
    // below moves openingBalance/openingDate, entered and derived agree by construction —
    // the drift this observation records is the only trace it was ever off. recordAudit
    // never throws (src/lib/audit.ts), so a dropped log entry can't cost us the reanchor.
    if (user?.id) {
      await recordAudit(user.id, auditEntry('account.reconcile', `accounts/${acc.id}`, {
        actor: 'user',
        after: observation,
      }));
    }
    if (reanchor) await updatePaymentAccount(id, reanchor);
    return { driftCents, status };
  };

  // Persist a new account order: optimistic reorder + one batched sortIndex write.
  const reorderPaymentAccounts = async (orderedIds: string[]) => {
    if (!profile || !user?.id) return;
    const prev = profile.paymentAccounts;
    const byId = new Map(prev.map((acc) => [acc.id, acc]));
    const reordered = orderedIds
      .map((id) => byId.get(id))
      .filter((acc): acc is PaymentAccount => Boolean(acc))
      .map((acc, i) => ({ ...acc, sortIndex: i }));
    const updates = reindex(orderedIds, prev);
    const next = { ...profile, paymentAccounts: reordered };
    setProfile(next);
    saveLocalProfile(user.id, next);
    try {
      await firestoreService.updateAccountsBatch(user.id, updates);
      setIsFirestoreOnline(true);
    } catch (err) {
      console.error('Failed to persist account order:', err);
      setIsFirestoreOnline(false);
      // Offline is tolerated (local order persists); roll back only a real failure.
      if (!(err as { code?: string })?.code?.includes('unavailable')) {
        const restored = { ...profile, paymentAccounts: prev };
        setProfile(restored);
        saveLocalProfile(user.id, restored);
      }
    }
  };

  // Delete payment account
  const deletePaymentAccount = async (id: string) => {
    if (!profile || !user?.id) return;

    const updatedAccounts = profile.paymentAccounts.filter((acc) => acc.id !== id);
    const updatedProfile = { ...profile, paymentAccounts: updatedAccounts };
    setProfile(updatedProfile);
    saveLocalProfile(user.id, updatedProfile);

    // Always attempt the delete (see updatePaymentAccount) — gating on a cached
    // online flag left deleted accounts to reappear on the next reload.
    if (!isUnsyncedId(id)) {
      try {
        await firestoreService.deleteAccount(user.id, id);
        setIsFirestoreOnline(true);
      } catch (err) {
        console.error('Failed to sync account deletion:', err);
        setIsFirestoreOnline(false);
      }
    }
  };

  // Add income source
  const addIncomeSource = async (income: Omit<IncomeSource, 'id'>) => {
    if (!profile || !user?.id) return;

    // #71: real id up front; no connectivity branch, because the SDK queues the write.
    // An income source lost offline is how a paycheck stops being recognised as income.
    const id = firestoreService.newDocId(user.id, 'income');
    const newIncome: IncomeSource = { ...income, id };

    const updatedProfile = {
      ...profile,
      incomeSources: [...profile.incomeSources, newIncome],
    };
    setProfile(updatedProfile);
    saveLocalProfile(user.id, updatedProfile);

    firestoreService.addIncome(user.id, income as never, id).catch((err) => {
      console.error('Income write queued or failed:', err);
    });
  };

  // Update income source
  const updateIncomeSource = async (id: string, updates: Partial<IncomeSource>) => {
    if (!profile || !user?.id) return;

    const updatedSources = profile.incomeSources.map((inc) =>
      inc.id === id ? { ...inc, ...updates } : inc
    );
    const updatedProfile = { ...profile, incomeSources: updatedSources };
    setProfile(updatedProfile);
    saveLocalProfile(user.id, updatedProfile);

    if (!isUnsyncedId(id)) {
      try {
        await firestoreService.updateIncome(user.id, id, updates as any);
      } catch (err) {
        console.error('Failed to sync income update:', err);
      }
    }
  };

  // Delete income source
  const deleteIncomeSource = async (id: string) => {
    if (!profile || !user?.id) return;

    const updatedSources = profile.incomeSources.filter((inc) => inc.id !== id);
    const updatedProfile = { ...profile, incomeSources: updatedSources };
    setProfile(updatedProfile);
    saveLocalProfile(user.id, updatedProfile);

    if (!isUnsyncedId(id)) {
      try {
        await firestoreService.deleteIncome(user.id, id);
      } catch (err) {
        console.error('Failed to sync income deletion:', err);
      }
    }
  };

  /**
   * Record the owner's decision about one inflow. Optimistic, matching every other
   * write here: the queue and every income total update in the same render, and the
   * Firestore write is fire-and-forget (offline persistence makes awaiting the ack
   * hang until the network returns).
   *
   * Writes ONLY the review document. The transaction's provider description, provider
   * category, amount, provider id and posted date are never touched.
   */
  const setInflowReview = async (review: InflowReview) => {
    const stamped: InflowReview = { ...review, updatedAt: new Date().toISOString() };
    setInflowReviews((prev) => ({ ...prev, [review.transactionId]: stamped }));
    if (!user?.id || !isFirestoreOnline) return;
    try {
      await firestoreService.setInflowReview(user.id, stamped);
    } catch (err) {
      console.error('Failed to sync inflow review:', err);
    }
  };

  // The app's financial policy, resolved once. Every screen already reads this, so
  // FIN-PENDING-001's setting reaches all of them from here — that is the whole
  // reason it lives on this object rather than in a second context.
  const incomeContext = useMemo<IncomeContext>(
    () => ({
      sources: profile?.incomeSources ?? [],
      reviews: inflowReviews,
      includePending: profile?.settings?.includePendingInCalculations ?? false,
    }),
    [profile?.incomeSources, inflowReviews, profile?.settings?.includePendingInCalculations]
  );

  // Complete onboarding
  const completeOnboarding = async () => {
    if (!profile || !user?.id) return;

    const updatedProfile = { ...profile, isOnboarded: true };
    setProfile(updatedProfile);
    saveLocalProfile(user.id, updatedProfile);

    if (isFirestoreOnline) {
      try {
        await firestoreService.completeUserOnboarding(user.id);
      } catch (err) {
        console.error('Failed to sync onboarding status:', err);
      }
    }
  };

  const refreshProfile = async () => {
    if (!user?.id) return;
    isFetching.current = false; // Reset to allow fetch
    await syncFromFirestore(user.id);
  };

  return (
    <UserProfileContext.Provider
      value={{
        profile,
        isLoading,
        isOnboarded: profile?.isOnboarded ?? false,
        error,
        updateProfile,
        addPaymentAccount,
        addPaymentAccounts,
        updatePaymentAccount,
        reconcileAccount,
        reorderPaymentAccounts,
        deletePaymentAccount,
        addIncomeSource,
        updateIncomeSource,
        deleteIncomeSource,
        incomeContext,
        setInflowReview,
        completeOnboarding,
        refreshProfile,
      }}
    >
      {children}
    </UserProfileContext.Provider>
  );
}

export function useUserProfile() {
  const context = useContext(UserProfileContext);
  if (context === undefined) {
    throw new Error('useUserProfile must be used within a UserProfileProvider');
  }
  return context;
}
