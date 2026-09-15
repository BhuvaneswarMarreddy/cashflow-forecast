'use client';

import React, { useState, useEffect, useMemo } from 'react';
import dynamic from 'next/dynamic';
import { formatMoney, monthlyIncomeOf } from '@/lib/money';
import { reconcileAllIncome, type Cadence } from '@/lib/income-cadence';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { useUserProfile } from '@/context/UserProfileContext';
import { useTransactions } from '@/context/TransactionContext';
import Navbar from '@/components/Navbar';
import AccountsList from '@/components/AccountsList';
import AccountsDiagnostics from '@/components/AccountsDiagnostics';
import AccountDetailModal from '@/components/AccountDetailModal';
import SubscriptionsPanel from '@/components/SubscriptionsPanel';
import BudgetSettingsPanel from '@/components/BudgetSettingsPanel';
import BudgetStatusPanel from '@/components/BudgetStatusPanel';
import DebtPlannerPanel from '@/components/DebtPlannerPanel';
import { UnanchoredNote } from '@/components/UnanchoredNote';
import { PAYMENT_METHODS, ACCOUNT_TYPES, PaymentAccount, IncomeSource, AccountType, PaymentMethod, CategoryBudget } from '@/types';
import { withDerivedBalances, monthlyAverages, calculateCurrentCash } from '@/lib/forecast';
import { currentOf, isCashAccount, isDebtAccount, isUnanchored, openingAnchor, balanceCaption } from '@/lib/accounts';
import ReconcileSheet from '@/components/ReconcileSheet';
import { syncNow, describeSync, connectBankWithPlaid } from '@/lib/sync-client';
import { useAccountsObservability } from '@/lib/obs/useAccountsObservability';
import { safeSyncResult } from '@/lib/obs/sync-metadata';
import {
  CreditCard,
  DollarSign,
  Plus,
  Trash2,
  Edit3,
  Building2,
  Banknote,
  X,
  AlertCircle,
  BarChart3,
  RefreshCw,
  Upload,
} from 'lucide-react';
import LoadingScreen from '@/components/LoadingScreen';
// Lazy (#41 pattern): CSVImportModal pulls in `xlsx` and is closed until someone taps Import.
const CSVImportModal = dynamic(() => import('@/components/CSVImportModal'), { ssr: false });

/**
 * #68 (UX-002): distinguishes "the owner typed a budget in", "no budget typed
 * in but 6 months of spending gives a typical figure", and "nothing to show
 * yet" — mirrors runwayLabel()'s hasBurn contract in lib/home.ts. A brand-new
 * account (no monthlyBudget, no transaction history) must never fall through
 * to a $0.00 labeled "your set budget" — that is the value nobody entered.
 */
export type BudgetDisplay =
  | { status: 'set'; amount: number }
  | { status: 'derived'; amount: number }
  | { status: 'unset' };

export function resolveBudgetDisplay(monthlyBudget: number | undefined, derivedSpending: number): BudgetDisplay {
  if ((monthlyBudget || 0) > 0) return { status: 'set', amount: monthlyBudget! };
  if (derivedSpending > 0) return { status: 'derived', amount: derivedSpending };
  return { status: 'unset' };
}

export default function AccountsPage() {
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();
  const { 
    profile, 
    isLoading: profileLoading, 
    addPaymentAccount, 
    updatePaymentAccount,
    reorderPaymentAccounts,
    deletePaymentAccount,
    addIncomeSource,
    updateIncomeSource,
    deleteIncomeSource,
    updateProfile,
    incomeContext,
    refreshProfile,
    reconcileAccount,
  } = useUserProfile();
  const { transactions, isLoading: transactionsLoading, error: transactionsError, refreshTransactions } = useTransactions();
  const router = useRouter();
  
  // #200: the account list is always the page; these are the Tools under it.
  const [activeTab, setActiveTab] = useState<'income' | 'subscriptions' | 'budgets' | 'debt'>('income');
  const [showImport, setShowImport] = useState(false);

  // Live transfer pairing: match each leg leaving an account to the leg arriving in
  // another, so an internal move reads as ONE net-zero movement. Unpaired legs = the
  // other side is in an account you didn't import (external / a Zelle to a person).
  // Derived accounts (openingBalance + net → currentBalance). MUST stay above any early
  // return — a hook after a conditional return is React error #310.
  // FIN-PENDING-001 (#87): whether holds count is the OWNER'S APP-WIDE SETTING, not a
  // control on this page. A per-page toggle is exactly what made Accounts disagree with
  // Home and Forecast — this page held a parameter its siblings could not see.
  const pendingCount = useMemo(() => transactions.filter(t => t.pending).length, [transactions]);
  const derivedAccounts = useMemo(
    () => withDerivedBalances(profile?.paymentAccounts || [], transactions, incomeContext),
    [profile?.paymentAccounts, transactions, incomeContext]
  );
  // OBS-001: page-view / load lifecycle events, spans, and the sanitized provenance for
  // the summary cards below. Must stay above the early return (React error #310).
  const obs = useAccountsObservability({
    userId: user?.id,
    isLoading: authLoading || profileLoading || transactionsLoading,
    accounts: derivedAccounts,
    transactions,
    error: transactionsError,
  });
  const [showAccountModal, setShowAccountModal] = useState(false);
  const [showIncomeModal, setShowIncomeModal] = useState(false);
  const [editingAccount, setEditingAccount] = useState<PaymentAccount | null>(null);
  const [graphAccount, setGraphAccount] = useState<PaymentAccount | null>(null);
  // Round 3a: the account the "Set balance" control on an unanchored row was
  // clicked for. Opens ReconcileSheet — nothing anchors until its own Confirm.
  const [reconcileForAccount, setReconcileForAccount] = useState<PaymentAccount | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [syncErr, setSyncErr] = useState(false);
  const [editingIncome, setEditingIncome] = useState<IncomeSource | null>(null);
  
  const [accountForm, setAccountForm] = useState({
    name: '',
    type: 'credit_card' as AccountType,
    provider: 'chase' as PaymentMethod,
    balance: '',
    creditLimit: '',
    apr: '',
    statementDate: '',
    dueDate: '',
    lastFourDigits: '',
    paymentFromAccountId: '', // Which checking account pays this card/loan
    feedless: false, // #14: no transaction feed of its own — a payment IS the expense
    // Loan specific
    originalAmount: '',
    monthlyPayment: '',
    loanTerm: '',
  });

  const [incomeForm, setIncomeForm] = useState({
    name: '',
    amount: '',
    frequency: 'monthly' as 'weekly' | 'biweekly' | 'monthly' | 'yearly',
    payDate: '',
    // Comma-separated text that must appear on the bank line for a deposit to count
    // as THIS income. Without it the source name is the only alias, and a source
    // called "Canton Group" never matches a row that reads "CANTON PAYROLL PPD".
    matchAliases: '',
  });

  const [budgetAmount, setBudgetAmount] = useState('');
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [deleteType, setDeleteType] = useState<'account' | 'income' | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      router.push('/login');
    }
  }, [isAuthenticated, authLoading, router]);

  useEffect(() => {
    if (profile?.monthlyBudget) {
      setBudgetAmount(profile.monthlyBudget.toString());
    }
  }, [profile?.monthlyBudget]);

  if (authLoading || profileLoading) {
    return (
      <LoadingScreen />
    );
  }

  // Plaid Link: connect a new bank. The popup is Plaid's own; we get back only
  // the institution name. First data arrives on the next refresh (Plaid needs
  // a moment to prepare history after linking), so one is kicked off after.
  const handleConnectBank = async () => {
    setSyncErr(false); setSyncMsg(null);
    try {
      const institution = await connectBankWithPlaid();
      if (institution === null) return; // user closed the popup — say nothing
      setSyncMsg(`${institution} connected — pulling your data…`);
      await handleRefresh();
    } catch (e) {
      setSyncErr(true);
      setSyncMsg(e instanceof Error ? e.message : 'Could not connect the bank.');
    }
  };

  // Pulls straight from the banks (10-20s), then reloads so every derived number
  // on the page reflects the new rows and re-anchored balances.
  const handleRefresh = async () => {
    setSyncing(true); setSyncErr(false); setSyncMsg('Contacting your banks…');
    obs.trackRefreshClicked();
    try {
      const r = await syncNow();
      setSyncErr(Boolean(r.error));
      setSyncMsg(describeSync(r));
      // Counters only — safeSyncResult() strips everything the callable did not
      // already whitelist, and would strip an access URL if one ever appeared.
      obs.trackRefreshResult({ ok: !r.error, counts: safeSyncResult(r as Record<string, unknown>).counters });
      // Pull the server-written accounts/rows into the client. A full page reload
      // would re-serve the stale localStorage snapshot first and flash "0 accounts".
      if (!r.error) await Promise.all([refreshProfile(), refreshTransactions()]);
    } catch (e) {
      setSyncErr(true);
      setSyncMsg(e instanceof Error ? e.message : 'Refresh failed — try again.');
      obs.trackRefreshResult({ ok: false, error: e });
    } finally {
      setSyncing(false);
    }
  };

  const openEditAccount = (account: PaymentAccount) => {
    setEditingAccount(account);
    setAccountForm({
      name: account.name,
      type: account.type,
      provider: account.provider,
      // #83 round 4a Defect 2: an unanchored account's balance field prefills EMPTY,
      // never currentOf() — that derived figure is NET MOVEMENT, not a bank balance,
      // and prefilling it made every save (even one that only touched APR or colour)
      // write it back as a real anchor the owner never typed. A blank field asserts
      // nothing; openingAnchor('') below confirms that.
      balance: isUnanchored(account) ? '' : currentOf(account).toString(),
      creditLimit: account.creditLimit?.toString() || '',
      apr: account.apr?.toString() || '',
      statementDate: account.statementDate?.toString() || '',
      dueDate: account.dueDate?.toString() || '',
      lastFourDigits: account.lastFourDigits || '',
      paymentFromAccountId: account.paymentFromAccountId || '',
      feedless: account.feedless || false,
      originalAmount: account.originalAmount?.toString() || '',
      monthlyPayment: account.monthlyPayment?.toString() || '',
      loanTerm: account.loanTerm?.toString() || '',
    });
    setShowAccountModal(true);
  };

  const openEditIncome = (income: IncomeSource) => {
    setEditingIncome(income);
    setIncomeForm({
      name: income.name,
      amount: income.amount.toString(),
      frequency: income.frequency,
      payDate: income.payDate?.toString() || '',
      matchAliases: (income.matchAliases ?? []).join(', '),
    });
    setShowIncomeModal(true);
  };

  const handleSaveAccount = async () => {
    const providerInfo = PAYMENT_METHODS.find((p) => p.value === accountForm.provider);
    const isLoan = accountForm.type === 'personal_loan';
    const isCard = accountForm.type === 'credit_card';
    const needsPaymentSource = isCard || isLoan;

    // #14 (CRITICAL-3): a feedless card's derived balance is opening ± payments —
    // there is no feed, so nothing else ever anchors it. An UNANCHORED feedless card
    // starts from an invented $0 and goes NEGATIVE the moment a payment is recorded
    // (forecast.ts clamps that at $0 defensively, but a negative-then-clamped "owed"
    // is still not a real number). Refuse the save rather than invent an anchor —
    // the Save button's `disabled` below is the same guard, this is the belt.
    if (isCard && accountForm.feedless && !accountForm.balance.trim()) return;

    const accountData = {
      name: accountForm.name,
      type: accountForm.type,
      provider: accountForm.provider,
      // UI-106 (audit accuracy): re-anchor ONLY when the balance was actually
      // edited. Renaming an account must not move its numbers — the old code
      // set openingDate to today on every save, silently shifting balances.
      //
      // #83 round 4a Defect 2 (the plausible-anchor trap): round 3a "fixed" the
      // Edit-account trap by forcing this branch whenever isUnanchored(editingAccount),
      // delta or not — but that meant changing ONLY the APR, last-four digits, or
      // colour on an unanchored account wrote openingBalance: currentOf(editingAccount)
      // (a real, plausible-looking NUMBER — the derived net-movement figure) with
      // openingDate: today. That manufactures the exact assertion #83 exists to
      // prevent, just with a number instead of $0.
      //
      // The other half of the fix lives in openEditAccount(): an unanchored account's
      // balance field prefills EMPTY, not with currentOf(). A blank field parses to 0
      // here, which diverges from currentOf(editingAccount) by more than the delta
      // threshold, so the branch below still fires on an untouched APR-only edit —
      // but openingAnchor('') returns { openingBalance: 0 } with no openingDate, so
      // that write leaves the account unanchored unless the owner actually typed a
      // number. That covers the blank-field path on its own.
      //
      // It does NOT cover the owner reading the derived figure off the row caption,
      // opening Edit, and typing it back verbatim (e.g. $10,458.03 for the one real
      // unanchored account in production, Amazon Store Card): parseFloat(that string)
      // then EQUALS currentOf(editingAccount) exactly, delta 0, the plain guard takes
      // the `else` branch, and the save silently preserves "unanchored" with no
      // feedback — the confirmation from #83 round 4a Defect 1 (accounts.ts:111)
      // never happens because handleSaveAccount never even calls reconcile(). The
      // isUnanchored(editingAccount) disjunct restores that path: for an unanchored
      // account ANY save always re-derives openingAnchor from whatever is in the
      // field (blank => still unanchored, any typed number including the derived
      // figure or 0 => a real claim). An untouched ANCHORED account still takes the
      // `else` branch below and keeps its own anchor (UI-106) — isUnanchored is false
      // for it, so this disjunct never fires there.
      ...(!editingAccount || isUnanchored(editingAccount) || Math.abs((parseFloat(accountForm.balance) || 0) - currentOf(editingAccount)) > 0.004
        ? openingAnchor(accountForm.balance, new Date().toISOString().slice(0, 10))
        : {
            openingBalance: editingAccount.openingBalance,
            openingDate: editingAccount.openingDate,
          }),
      creditLimit: isCard ? parseFloat(accountForm.creditLimit) || undefined : undefined,
      apr: (isCard || isLoan) ? parseFloat(accountForm.apr) || undefined : undefined,
      statementDate: isCard ? (accountForm.statementDate ? parseInt(accountForm.statementDate) : undefined) : undefined,
      dueDate: (isCard || isLoan) ? (accountForm.dueDate ? parseInt(accountForm.dueDate) : undefined) : undefined,
      lastFourDigits: accountForm.lastFourDigits || undefined,
      paymentFromAccountId: needsPaymentSource && accountForm.paymentFromAccountId ? accountForm.paymentFromAccountId : undefined,
      // #14: only meaningful on a card — a payment into it stands in for the
      // itemized purchases there is no feed to supply. See src/lib/classify.ts.
      //
      // IMPORTANT-5: an explicit `false`, never `undefined` — updateAccount()
      // (firestore.ts) strips `undefined` keys entirely (Firestore rejects
      // `undefined`), so unticking the checkbox used to write NOTHING: the stored
      // `feedless: true` survived untouched, silently re-arming the spending rule
      // on reload even though the UI looked like it had turned off.
      feedless: isCard && accountForm.feedless,
      originalAmount: isLoan ? parseFloat(accountForm.originalAmount) || undefined : undefined,
      monthlyPayment: isLoan ? parseFloat(accountForm.monthlyPayment) || undefined : undefined,
      loanTerm: isLoan ? parseInt(accountForm.loanTerm) || undefined : undefined,
      color: isLoan ? '#f59e0b' : (providerInfo?.color || '#8b949e'),
      isActive: true,
    };

    if (editingAccount) {
      await updatePaymentAccount(editingAccount.id, accountData);
    } else {
      await addPaymentAccount(accountData);
    }

    resetAccountForm();
  };

  const handleSaveIncome = async () => {
    const incomeData = {
      name: incomeForm.name,
      amount: parseFloat(incomeForm.amount) || 0,
      frequency: incomeForm.frequency,
      payDate: incomeForm.payDate ? parseInt(incomeForm.payDate) : undefined,
      // Split, trim, drop blanks and 1-2 char fragments (matchApprovedSources rejects
      // those anyway — a 2-char alias would match half the ledger). Empty => undefined,
      // so the source falls back to matching on its own name.
      matchAliases: incomeForm.matchAliases
        .split(',').map((a) => a.trim()).filter((a) => a.length >= 3).length
        ? incomeForm.matchAliases.split(',').map((a) => a.trim()).filter((a) => a.length >= 3)
        : undefined,
      isActive: true,
    };

    if (editingIncome) {
      await updateIncomeSource(editingIncome.id, incomeData);
    } else {
      await addIncomeSource(incomeData);
    }

    resetIncomeForm();
  };

  const handleSaveBudget = async () => {
    await updateProfile({ monthlyBudget: parseFloat(budgetAmount) || 0 });
  };

  const resetAccountForm = () => {
    setAccountForm({
      name: '',
      type: 'credit_card',
      provider: 'chase',
      balance: '',
      creditLimit: '',
      apr: '',
      statementDate: '',
      dueDate: '',
      lastFourDigits: '',
      paymentFromAccountId: '',
      feedless: false,
      originalAmount: '',
      monthlyPayment: '',
      loanTerm: '',
    });
    setEditingAccount(null);
    setShowAccountModal(false);
  };

  const resetIncomeForm = () => {
    setIncomeForm({
      name: '',
      amount: '',
      frequency: 'monthly',
      payDate: '',
      matchAliases: '',
    });
    setEditingIncome(null);
    setShowIncomeModal(false);
  };

  const confirmDelete = (id: string, type: 'account' | 'income') => {
    setDeleteConfirmId(id);
    setDeleteType(type);
  };

  const handleDelete = async () => {
    if (!deleteConfirmId || !deleteType) return;
    
    setIsDeleting(true);
    try {
      if (deleteType === 'account') {
        await deletePaymentAccount(deleteConfirmId);
      } else {
        await deleteIncomeSource(deleteConfirmId);
      }
    } finally {
      setIsDeleting(false);
      setDeleteConfirmId(null);
      setDeleteType(null);
    }
  };

  const cancelDelete = () => {
    setDeleteConfirmId(null);
    setDeleteType(null);
  };

  const getItemToDelete = () => {
    if (!deleteConfirmId || !deleteType) return null;
    if (deleteType === 'account') {
      return profile?.paymentAccounts?.find(a => a.id === deleteConfirmId);
    }
    return profile?.incomeSources?.find(i => i.id === deleteConfirmId);
  };

  // Balances derived from linked transactions for every DISPLAY below. The edit form
  const totalCreditLimit = derivedAccounts
    .filter((a) => a.type === 'credit_card')
    .reduce((sum, a) => sum + (a.creditLimit || 0), 0);

  const totalCreditUsed = derivedAccounts
    .filter((a) => a.type === 'credit_card')
    .reduce((sum, a) => sum + currentOf(a), 0);

  // These were inline copies of calculateCurrentCash()/netWorthOf(). That duplication is
  // exactly how this page came to disagree with Home and Forecast: the copy here took an
  // includePending argument the shared helper never saw. One definition, one answer.
  const totalBankBalance = calculateCurrentCash(derivedAccounts);
  const totalDebt = derivedAccounts.filter(isDebtAccount).reduce((sum, a) => sum + currentOf(a), 0);
  const creditUtilization = totalCreditLimit > 0 ? Math.round((totalCreditUsed / totalCreditLimit) * 100) : 0;
  // #200: Cash | Credit | Other. Every account lands in exactly one group.
  const accountGroups = [
    { key: 'cash', label: 'Cash', accounts: derivedAccounts.filter(isCashAccount) },
    { key: 'credit', label: 'Credit', accounts: derivedAccounts.filter((a) => a.type === 'credit_card') },
    { key: 'other', label: 'Other', accounts: derivedAccounts.filter((a) => !isCashAccount(a) && a.type !== 'credit_card') },
  ];
  // A drag inside one group reorders only that group's slots in the full order.
  const reorderWithinGroup = (groupIds: string[]) => {
    const inGroup = new Set(groupIds);
    let next = 0;
    reorderPaymentAccounts(derivedAccounts.map((a) => (inGroup.has(a.id) ? groupIds[next++] : a.id)));
  };

  // Income & budget: use hand-entered income sources / budget when present, else DERIVE
  // from the last 6 months of transactions (so these never read a bare $0).
  // ACTIVE sources only: getIncomeSources() now returns paused sources too (so they
  // can be resumed), and a paused source is not money arriving.
  // #75: cross-check each source's declared frequency against its own deposits.
  // The first confident disagreement suppresses the figure everywhere it feeds.
  const incomeReconciliations = reconcileAllIncome(profile?.incomeSources, transactions);
  const incomeConflict = incomeReconciliations.find((r) => r.conflict) ?? null;
  const incomeFromSources = monthlyIncomeOf(profile?.incomeSources?.filter((i) => i.isActive) ?? []);
  const derivedMonthly = monthlyAverages(transactions, derivedAccounts, 6, incomeContext);
  const monthlyIncome = incomeFromSources > 0 ? incomeFromSources : derivedMonthly.income;
  const incomeIsDerived = incomeFromSources === 0 && derivedMonthly.income > 0;
  const budgetDisplay = resolveBudgetDisplay(profile?.monthlyBudget, derivedMonthly.spending);

  return (
    <div className="min-h-screen relative">
      <div className="bg-pattern" />
      <Navbar />
      
      <main className="pt-24 pb-24 md:pb-16 px-4 lg:px-8 max-w-content mx-auto relative z-10">
        {/* #200: "What do I own and owe?" — connecting is the first thing on the page. */}
        <div className="mb-6 space-y-3">
          <div>
            <h1 className="text-3xl font-[family-name:var(--font-display)] text-[var(--foreground)]">Accounts</h1>
            <p className="text-[var(--foreground-secondary)] mt-1">What you own and what you owe.</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={handleConnectBank}
              disabled={syncing}
              aria-label="Connect a bank through Plaid"
              className="btn-primary inline-flex items-center gap-2 min-h-[44px] disabled:opacity-60"
            >
              <Plus className="w-4 h-4" aria-hidden="true" />
              Connect bank
            </button>
            <button
              onClick={() => setShowImport(true)}
              className="btn-secondary inline-flex items-center gap-2 min-h-[44px]"
            >
              <Upload className="w-4 h-4" aria-hidden="true" />
              Import CSV
            </button>
            <button
              onClick={handleRefresh}
              disabled={syncing}
              aria-label="Refresh balances and transactions from your banks"
              title={syncing ? 'Refreshing…' : 'Refresh from banks'}
              className="w-11 h-11 rounded-control flex items-center justify-center text-[var(--foreground-secondary)] hover:text-[var(--foreground)] hover:bg-[var(--background-tertiary)] disabled:opacity-60"
            >
              <RefreshCw className={`w-5 h-5 ${syncing ? 'animate-spin' : ''}`} aria-hidden="true" />
            </button>
          </div>
          {/* Import, not Connect: Plaid reaches neither (owner brief). */}
          <p className="text-xs text-[var(--foreground-muted)]">
            Apple Card and Indian accounts (NRE, NRO, FDs) can&apos;t be connected. Use Import CSV for those.
          </p>
          {syncMsg && (
              <p role="status" aria-live="polite"
                 className={`text-xs mt-2 ${syncErr ? 'text-[var(--accent-danger)]' : 'text-[var(--foreground-muted)]'}`}>
                {syncMsg}
              </p>
            )}
        </div>

        {/* R5: the mode must be legible where the money is, not only in Settings —
            otherwise the owner reads an effective balance weeks later as a settled one.
            Read-only: the control itself lives in one place. */}
        {pendingCount > 0 && (
          <p className="mb-4 text-sm text-[var(--foreground-secondary)]">
            {incomeContext.includePending
              ? `Including ${pendingCount} pending ${pendingCount === 1 ? 'hold' : 'holds'} — these balances show what lands once they clear.`
              : `${pendingCount} pending ${pendingCount === 1 ? 'hold is' : 'holds are'} not counted below.`}{' '}
            <Link href="/settings" className="underline hover:text-[var(--foreground)]">
              Change in Settings
            </Link>
          </p>
        )}

        {/* #200: two numbers only, each disclosing only the accounts behind it. No net worth
            headline: a sum that includes unanchored figures is not a balance anyone has. */}
        <div className="grid grid-cols-2 gap-4 mb-8">
          <div className="stat-card p-4 lg:p-5 min-w-0">
            <span className="text-[var(--foreground-secondary)] text-sm">Cash</span>
            {derivedAccounts.some(isCashAccount) ? (
              <p className="mt-1 text-2xl font-[family-name:var(--font-display)] tnum truncate text-[var(--foreground)]">
                {formatMoney(totalBankBalance, profile?.currency, 2)}
              </p>
            ) : (
              <p className="mt-1 text-lg font-semibold text-[var(--foreground-muted)]">None linked</p>
            )}
            <p className="text-xs text-[var(--foreground-muted)]">across cash accounts</p>
            <UnanchoredNote accounts={derivedAccounts.filter(isCashAccount)} />
          </div>
          <div className="stat-card p-4 lg:p-5 min-w-0">
            <span className="text-[var(--foreground-secondary)] text-sm">Debt</span>
            {derivedAccounts.some(isDebtAccount) ? (
              <p className="mt-1 text-2xl font-[family-name:var(--font-display)] tnum truncate text-[var(--money-out)]">
                {formatMoney(totalDebt, profile?.currency, 2)}
              </p>
            ) : (
              <p className="mt-1 text-lg font-semibold text-[var(--foreground-muted)]">None linked</p>
            )}
            <p className="text-xs text-[var(--foreground-muted)] truncate">
              {totalCreditLimit > 0 ? `cards use ${creditUtilization}% of ${formatMoney(totalCreditLimit, profile?.currency, 0)}` : 'cards and loans'}
            </p>
            <UnanchoredNote accounts={derivedAccounts.filter(isDebtAccount)} />
          </div>
        </div>

        {/* #200: the map — Cash | Credit | Other. Drag reorders within a group. */}
        <section aria-labelledby="accounts-heading" className="mb-10">
          <div className="flex justify-between items-center gap-4 mb-4">
            <h2 id="accounts-heading" className="text-lg font-semibold text-[var(--foreground)] min-w-0">
              Your accounts ({profile?.paymentAccounts?.length || 0})
            </h2>
            <button
              onClick={() => setShowAccountModal(true)}
              className="btn-secondary inline-flex items-center gap-2 min-h-[44px] px-3 text-sm shrink-0 whitespace-nowrap"
            >
              <Plus className="w-4 h-4" aria-hidden="true" />
              Add Account
            </button>
          </div>

          {profile?.paymentAccounts && profile.paymentAccounts.length > 0 ? (
            <div className="space-y-6">
              {accountGroups.filter((g) => g.accounts.length > 0).map((group) => (
                <div key={group.key}>
                  <h3 className="mb-2 text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--accent-primary)]">{group.label}</h3>
                  <AccountsList
                    accounts={group.accounts}
                    onReorder={reorderWithinGroup}
                    renderRow={(account) => (
                    <div
                      className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-0 p-4 rounded-card bg-[var(--background-tertiary)] hover:bg-[var(--background-secondary)] transition-colors"
                    >
                      {/* UI-106: the whole row used to be an invisible button 2px
                          from a drag handle — the body is inert now; the graph
                          opens from the explicit chart button on the right. */}
                      <div className="flex items-center gap-4 flex-1 min-w-0">
                        {/* #200: no per-account brand colour or icon tile — the group heading
                            already says what kind of account this is. */}
                        <div className="min-w-0">
                          <p className="font-medium text-[var(--foreground)]">
                            {account.name}
                            {account.lastFourDigits && (
                              <span className="text-[var(--foreground-muted)]"> •••• {account.lastFourDigits}</span>
                            )}
                          </p>
                          <p className="text-sm text-[var(--foreground-secondary)]">
                            {(() => {
                              const provider = PAYMENT_METHODS.find((m) => m.value === account.provider)?.label;
                              const kind = ACCOUNT_TYPES.find((t) => t.value === account.type)?.label;
                              // "Bank Account • Bank Account" told the owner nothing twice.
                              return provider && provider !== kind && provider !== 'Other' ? `${provider} • ${kind}` : kind;
                            })()}
                          </p>
                          {account.type === 'credit_card' && (
                            <p className="text-xs text-[var(--foreground-muted)]">
                              {account.apr && `APR: ${account.apr}%`}
                              {account.apr && (account.statementDate || account.dueDate) && ' • '}
                              {account.statementDate && `Statement: ${account.statementDate}${getOrdinalSuffix(account.statementDate)}`}
                              {account.statementDate && account.dueDate && ' • '}
                              {account.dueDate && `Due: ${account.dueDate}${getOrdinalSuffix(account.dueDate)}`}
                            </p>
                          )}
                          {/* #14 round 4: the ONLY disclosure a feedless card's coverage guard gets
                              (see the `ponytail:` note at src/lib/classify.ts:612) — without it a
                              chronically sparse feed (a token row every month) silently guards every
                              month's stand-in payment, and the owner has no way to see why the
                              card's spend contribution collapsed. Reads `feedCoveredPeriods` directly. */}
                          {account.feedless && !!account.feedCoveredPeriods?.size && (
                            <p className="text-xs text-[var(--foreground-muted)]">
                              {account.feedCoveredPeriods.size} {account.feedCoveredPeriods.size === 1 ? 'month' : 'months'} covered by your card's own data
                            </p>
                          )}
                          {/* Show linked payment account */}
                          {(account.type === 'credit_card' || account.type === 'personal_loan') && account.paymentFromAccountId && (
                            <p className="text-xs text-[var(--accent-primary)] flex items-center gap-1 mt-1">
                              <Building2 className="w-3 h-3" />
                              Paid from: {profile?.paymentAccounts?.find(a => a.id === account.paymentFromAccountId)?.name || 'Unknown'}
                            </p>
                          )}
                          {(account.type === 'credit_card' || account.type === 'personal_loan') && !account.paymentFromAccountId && (
                            <p className="text-xs text-[var(--accent-warning)] flex items-center gap-1 mt-1">
                              <AlertCircle className="w-3 h-3" />
                              No payment account linked
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center justify-between sm:justify-end gap-4">
                        <div className="text-left sm:text-right">
                          {/* The balance YOU set is the truth (the CSV has no balance). */}
                          {/* #200: an unanchored figure is net movement, not a balance — say
                              "Not anchored" instead of printing it as one. The caption below
                              still says what the rows add up to since when. */}
                          {isUnanchored(account) ? (
                            <p className="text-lg font-semibold text-[var(--foreground-muted)]">Not anchored</p>
                          ) : (
                            <p className={`text-lg font-semibold tnum ${isDebtAccount(account) ? 'text-[var(--money-out)]' : 'text-[var(--foreground)]'}`}>
                              {isDebtAccount(account) ? '−' : ''}{formatMoney(Math.abs(currentOf(account)), profile?.currency, 2)}
                            </p>
                          )}
                          {/* #83: no opening anchor means this figure is net movement across the
                              rows we hold, not a bank balance — say so, don't just show it.
                              balanceCaption() is the SAME three-way text AccountDetailModal and
                              History already render for one account; this row used to hand-roll
                              its own copy, which is exactly how two screens describing the same
                              account drift into disagreeing captions. */}
                          <p
                            className="text-xs text-[var(--foreground-muted)]"
                            title={account.openingDate ? 'Balances derive from transactions since this date' : 'No starting balance was ever set; this is net movement across imported transactions'}
                          >
                            {balanceCaption(account, transactions)}
                          </p>
                          {/* Round 3a: the disclosure above used to be a dead end. The obvious
                              fix — open Edit, confirm the number — was a TRAP (see the comment
                              on handleSaveAccount above): the form prefills the derived figure,
                              so confirming it looked like a no-op and left the account unanchored
                              forever. This is the one real exit, and it goes through
                              ReconcileSheet -> reconcileAccount so the DriftObservation (INV-1)
                              still gets recorded — never a second path that writes openingDate
                              directly (FIN-SETTLEMENT-003: nothing here anchors on its own, the
                              sheet's own confirm step does). */}
                          {isUnanchored(account) && (
                            <button
                              type="button"
                              onClick={() => setReconcileForAccount(account)}
                              aria-label={`Set balance for ${account.name}`}
                              className="tap-target relative text-xs text-[var(--accent-primary)] underline decoration-dotted underline-offset-2 hover:text-[var(--foreground)] transition-colors"
                            >
                              Set balance
                            </button>
                          )}
                          {account.creditLimit && (
                            <p className="text-xs text-[var(--foreground-muted)]">
                              Limit: {formatMoney(account.creditLimit, profile?.currency, 2)}
                            </p>
                          )}
                        </div>
                        <div className="flex gap-1">
                          <button
                            onClick={() => setGraphAccount(account)}
                            aria-label={`${account.name} — view history graph`}
                            className="p-3 min-w-11 min-h-11 sm:p-2 sm:min-w-auto sm:min-h-auto rounded-control text-[var(--foreground-muted)] hover:text-[var(--accent-primary)] hover:bg-[var(--accent-primary)]/10 transition-colors"
                          >
                            <BarChart3 className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => openEditAccount(account)}
                            aria-label={`Edit ${account.name}`}
                            className="p-3 min-w-11 min-h-11 sm:p-2 sm:min-w-auto sm:min-h-auto rounded-control text-[var(--foreground-muted)] hover:text-[var(--accent-primary)] hover:bg-[var(--accent-primary)]/10 transition-colors"
                          >
                            <Edit3 className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => confirmDelete(account.id, 'account')}
                            aria-label={`Delete ${account.name}`}
                            className="p-3 min-w-11 min-h-11 sm:p-2 sm:min-w-auto sm:min-h-auto rounded-control text-[var(--foreground-muted)] hover:text-[var(--accent-danger)] hover:bg-[var(--accent-danger)]/10 transition-colors"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    </div>
                    )}
                  />
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-12 rounded-card border border-[var(--border-color)] bg-[var(--background-secondary)]">
              <CreditCard className="w-12 h-12 text-[var(--foreground-muted)] mx-auto mb-4" aria-hidden="true" />
              <h3 className="text-lg font-medium text-[var(--foreground)] mb-2">No accounts yet</h3>
              <p className="text-[var(--foreground-secondary)] mb-4">Connect a bank, or import a CSV for accounts Plaid can&apos;t reach.</p>
              <button onClick={handleConnectBank} disabled={syncing} className="btn-primary min-h-[44px] px-4">
                Connect bank
              </button>
            </div>
          )}
        </section>

        {/* #200: Tools live under the list, never above it. */}
        <section aria-labelledby="tools-heading">
          <h2 id="tools-heading" className="text-lg font-semibold text-[var(--foreground)] mb-3">Tools</h2>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
          <div className="stat-card p-4 lg:p-5">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[var(--foreground-secondary)] text-sm">Monthly Income</span>
              <Banknote className="w-5 h-5 text-[var(--money-in)]" />
            </div>
            {/* #75: when the declared pay frequency disagrees with the deposits
                that actually landed, this figure is wrong by the ratio between
                them — declaring biweekly while being paid monthly inflates it
                2.17×. It is the largest number on the screen and it feeds the
                budget's "savings potential", so it is not shown at all until the
                disagreement is settled. Same contract as the runway hero. */}
            {incomeConflict ? (
              <>
                <p className="text-lg font-bold text-[var(--accent-warning)]">Needs checking</p>
                <p className="text-xs text-[var(--foreground-secondary)]">
                  {incomeConflict.sourceName} is set to {incomeConflict.declared}, but deposits
                  arrive about every {Math.round(incomeConflict.medianGapDays)} days
                </p>
              </>
            ) : (
              <>
                <p className="text-2xl font-bold text-[var(--money-in)]">
                  {formatMoney(monthlyIncome, 'USD', 2)}
                </p>
                <p className="text-xs text-[var(--foreground-muted)]">{incomeIsDerived ? 'avg (from transactions)' : 'from income sources'}</p>
              </>
            )}
          </div>
          <div className="stat-card p-4 lg:p-5">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[var(--foreground-secondary)] text-sm">Monthly Budget</span>
              <DollarSign className="w-5 h-5 text-[var(--accent-warning)]" />
            </div>
            {budgetDisplay.status === 'unset' ? (
              <>
                <p className="text-2xl font-bold text-[var(--foreground-muted)]">Not set</p>
                <button
                  onClick={() => setActiveTab('budgets')}
                  className="text-xs text-[var(--accent-primary)] underline hover:no-underline"
                >
                  Set a budget
                </button>
              </>
            ) : (
              <>
                <p className="text-2xl font-bold text-[var(--foreground)]">
                  {formatMoney(budgetDisplay.amount, 'USD', 2)}
                </p>
                <p className="text-xs text-[var(--foreground-muted)]">
                  {budgetDisplay.status === 'derived' ? 'typical monthly spend' : 'your set budget'}
                </p>
              </>
            )}
          </div>
          </div>

          <div role="tablist" aria-label="Tools" className="flex gap-2 mb-4 overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
            {([
              { key: 'income', label: 'Income sources' },
              { key: 'subscriptions', label: 'Bills & subscriptions' },
              { key: 'budgets', label: 'Budget' },
              { key: 'debt', label: 'Debt plan' },
            ] as const).map((tab) => (
              <button
                key={tab.key}
                role="tab"
                aria-selected={activeTab === tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`min-h-[44px] px-4 rounded-pill text-sm font-medium whitespace-nowrap transition-colors ${
                  activeTab === tab.key
                    ? 'bg-[var(--accent-primary)] text-[#16181c]'
                    : 'bg-[var(--background-tertiary)] text-[var(--foreground-secondary)] hover:text-[var(--foreground)]'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="glass-card p-4 lg:p-5 mb-6">
          {/* Income sources (a Tool; Settings will own it in #201) */}
          {activeTab === 'income' && (
            <div>
              <div className="flex justify-between items-start gap-4 mb-4">
                <h2 className="text-xl font-semibold text-[var(--foreground)] min-w-0">
                  Income Sources ({profile?.incomeSources?.length || 0})
                </h2>
                <button
                  onClick={() => setShowIncomeModal(true)}
                  className="btn-primary flex items-center gap-2 shrink-0 whitespace-nowrap"
                >
                  <Plus className="w-4 h-4" />
                  Add Income
                </button>
              </div>

              {profile?.incomeSources && profile.incomeSources.length > 0 ? (
                <div className="space-y-3">
                  {profile.incomeSources.map((income) => (
                    <div
                      key={income.id}
                      className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-0 p-4 rounded-card bg-[var(--background-tertiary)] border-l-4 border-l-[var(--accent-success)] hover:bg-[var(--background-secondary)] transition-colors"
                    >
                      <div className="flex items-center gap-4">
                        <div className="w-12 h-12 rounded-card flex items-center justify-center bg-[var(--accent-success)]/20 text-[var(--accent-success)]">
                          <Banknote className="w-5 h-5" />
                        </div>
                        <div>
                          <p className="font-medium text-[var(--foreground)]">{income.name}</p>
                          <p className="text-sm text-[var(--foreground-secondary)]">
                            {income.frequency.charAt(0).toUpperCase() + income.frequency.slice(1)}
                            {income.payDate && ` • Pay day: ${income.payDate}${getOrdinalSuffix(income.payDate)}`}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center justify-between sm:justify-end gap-4">
                        <p className="text-lg font-semibold text-[var(--accent-success)]">
                          +{formatMoney(income.amount, profile?.currency, 2)}
                        </p>
                        <div className="flex gap-1">
                          <button
                            onClick={() => openEditIncome(income)}
                            aria-label={`Edit ${income.name}`}
                            className="p-3 min-w-11 min-h-11 sm:p-2 sm:min-w-auto sm:min-h-auto rounded-control text-[var(--foreground-muted)] hover:text-[var(--accent-primary)] hover:bg-[var(--accent-primary)]/10 transition-colors"
                          >
                            <Edit3 className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => confirmDelete(income.id, 'income')}
                            aria-label={`Delete ${income.name}`}
                            className="p-3 min-w-11 min-h-11 sm:p-2 sm:min-w-auto sm:min-h-auto rounded-control text-[var(--foreground-muted)] hover:text-[var(--accent-danger)] hover:bg-[var(--accent-danger)]/10 transition-colors"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-12">
                  <Banknote className="w-16 h-16 text-[var(--foreground-muted)] mx-auto mb-4" />
                  <h3 className="text-lg font-medium text-[var(--foreground)] mb-2">No income sources yet</h3>
                  <p className="text-[var(--foreground-secondary)] mb-4">Add your salary and other income to forecast cash flow</p>
                  <button onClick={() => setShowIncomeModal(true)} className="btn-primary">
                    Add Your First Income
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Spending Tab - Transactions by Account */}
          {activeTab === 'subscriptions' && (
            <div>
              <div className="mb-6">
                <h2 className="text-xl font-semibold text-[var(--foreground)] min-w-0">Subscriptions & autopay</h2>
                <p className="text-sm text-[var(--foreground-secondary)] mt-1">
                  Recurring charges detected across all your accounts and cards — what&apos;s paid this month and what&apos;s coming up.
                </p>
              </div>
              <SubscriptionsPanel
                accounts={derivedAccounts}
                transactions={transactions}
                currency={profile?.currency}
              />
            </div>
          )}

          {/* Budget Tab */}
          {activeTab === 'budgets' && (
            <div>
              <h2 className="text-xl font-semibold text-[var(--foreground)] mb-6">
                Monthly Budget
              </h2>

              <div className="max-w-md">
                <div className="p-6 rounded-card bg-[var(--background-tertiary)] mb-6">
                  <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
                    Target Monthly Spending
                  </label>
                  <div className="relative">
                    <DollarSign className="absolute left-[1.1rem] top-1/2 -translate-y-1/2 w-6 h-6 text-[var(--foreground-muted)]" />
                    <input
                      type="number"
                      value={budgetAmount}
                      onChange={(e) => setBudgetAmount(e.target.value)}
                      placeholder="3000"
                      className="input-field pl-[3.5rem] text-xl font-bold"
                    />
                  </div>
                </div>

                <button onClick={handleSaveBudget} className="btn-primary w-full">
                  Save Budget
                </button>

                {monthlyIncome > 0 && (
                  <div className="mt-6 p-4 rounded-card bg-[var(--accent-success)]/10 border border-[var(--accent-success)]/30">
                    <p className="text-sm text-[var(--foreground-secondary)] mb-1">Monthly Income</p>
                    <p className="text-xl font-bold text-[var(--accent-success)]">{formatMoney(monthlyIncome, 'USD', 2)}</p>
                    {parseFloat(budgetAmount) > 0 && (
                      <p className="text-sm text-[var(--foreground-secondary)] mt-2">
                        Savings potential: {formatMoney(monthlyIncome - parseFloat(budgetAmount), 'USD', 2)}/month
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Category Budgets Tab */}
          {activeTab === 'budgets' && (
            <div>
              <div className="flex justify-between items-start mb-6">
                <div>
                  <h2 className="text-xl font-semibold text-[var(--foreground)] min-w-0">
                    Category Budgets
                  </h2>
                  <p className="text-sm text-[var(--foreground-muted)] mt-1">
                    Set spending limits for each category to track and control expenses
                  </p>
                </div>
              </div>

              {/* Current Status */}
              {profile?.settings?.categoryBudgets && profile.settings.categoryBudgets.length > 0 && (
                <div className="mb-6">
                  <h3 className="text-sm font-medium text-[var(--foreground-muted)] uppercase tracking-wide mb-3">
                    Current Month Status
                  </h3>
                  <BudgetStatusPanel
                    budgets={profile.settings.categoryBudgets}
                    transactions={transactions}
                    accounts={profile?.paymentAccounts}
                    compact={false}
                  />
                </div>
              )}

              {/* Budget Settings */}
              <div className="border-t border-[var(--border-color)] pt-6">
                <h3 className="text-sm font-medium text-[var(--foreground-muted)] uppercase tracking-wide mb-3">
                  Set Category Limits
                </h3>
                <BudgetSettingsPanel
                  budgets={profile?.settings?.categoryBudgets || []}
                  monthlyIncome={monthlyIncome}
                  onSave={async (budgets: CategoryBudget[]) => {
                    await updateProfile({
                      settings: {
                        ...profile?.settings,
                        categoryBudgets: budgets,
                      },
                    });
                  }}
                />
              </div>
            </div>
          )}

          {/* Debt Planner Tab */}
          {activeTab === 'debt' && (
            <div>
              <div className="flex justify-between items-start mb-6">
                <div>
                  <h2 className="text-xl font-semibold text-[var(--foreground)] min-w-0">
                    Debt Payoff Planner
                  </h2>
                  <p className="text-sm text-[var(--foreground-muted)] mt-1">
                    Create a strategic plan to pay off credit cards and loans faster
                  </p>
                </div>
              </div>

              <DebtPlannerPanel
                accounts={derivedAccounts}
                currentCash={totalBankBalance}
              />
            </div>
          )}
          </div>

        {/* OBS-001: developer-only provenance for the summary figures. Renders null in production. */}
        <AccountsDiagnostics traceId={obs.traceId} provenance={obs.provenance} onOpen={obs.trackDiagnosticOpened} />
        </section>
      </main>

      <CSVImportModal isOpen={showImport} onClose={() => setShowImport(false)} />

      {graphAccount && (
        <AccountDetailModal
          account={graphAccount}
          transactions={transactions}
          onClose={() => setGraphAccount(null)}
        />
      )}

      {/* Round 3a Fix B: routed through reconcileAccount (not a direct
          updatePaymentAccount call) so the drift gets recorded as a
          DriftObservation — the entire premise of INV-1 — same as the reconcile
          entry point on /flow. No second math path. */}
      {reconcileForAccount && (
        <ReconcileSheet
          accountName={reconcileForAccount.name}
          inputLabel={isDebtAccount(reconcileForAccount) ? 'amount you currently owe' : 'real balance right now'}
          derivedCurrent={currentOf(reconcileForAccount)}
          currency={profile?.currency}
          unanchored={isUnanchored(reconcileForAccount)}
          onConfirm={(entered) => reconcileAccount(reconcileForAccount.id, entered, currentOf(reconcileForAccount))}
          onClose={() => setReconcileForAccount(null)}
        />
      )}

      {/* Account Modal */}
      {showAccountModal && (
        <div className="modal-overlay" onClick={resetAccountForm}>
          <div className="modal-content max-w-lg" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-start gap-4 mt-8 mb-4">
              <h2 className="text-xl font-bold text-[var(--foreground)]">
                {editingAccount ? 'Edit Account' : 'Add Account'}
              </h2>
              <button onClick={resetAccountForm} aria-label="Close" className="p-2 rounded-control text-[var(--foreground-muted)] hover:bg-[var(--background-tertiary)]">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">Account Name</label>
                  <input
                    type="text"
                    value={accountForm.name}
                    onChange={(e) => setAccountForm({ ...accountForm, name: e.target.value })}
                    placeholder="e.g., Chase Sapphire"
                    className="input-field"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">Last 4 Digits</label>
                  <input
                    type="text"
                    value={accountForm.lastFourDigits}
                    onChange={(e) => setAccountForm({ ...accountForm, lastFourDigits: e.target.value.slice(0, 4) })}
                    placeholder="1234"
                    maxLength={4}
                    className="input-field"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">Type</label>
                  <select
                    value={accountForm.type}
                    onChange={(e) => setAccountForm({ ...accountForm, type: e.target.value as AccountType })}
                    className="select-field"
                  >
                    {ACCOUNT_TYPES.map((type) => (
                      <option key={type.value} value={type.value}>{type.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">Provider</label>
                  <select
                    value={accountForm.provider}
                    onChange={(e) => setAccountForm({ ...accountForm, provider: e.target.value as PaymentMethod })}
                    className="select-field"
                  >
                    {PAYMENT_METHODS.map((method) => (
                      <option key={method.value} value={method.value}>{method.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">Current Balance</label>
                  <div className="relative">
                    <DollarSign className="absolute left-[1.1rem] top-1/2 -translate-y-1/2 w-5 h-5 text-[var(--foreground-muted)]" />
                    <input
                      type="number"
                      value={accountForm.balance}
                      onChange={(e) => setAccountForm({ ...accountForm, balance: e.target.value })}
                      placeholder="0.00"
                      className="input-field pl-[3.25rem]"
                    />
                  </div>
                </div>
                {accountForm.type === 'credit_card' && (
                  <div>
                    <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">Credit Limit</label>
                    <div className="relative">
                      <DollarSign className="absolute left-[1.1rem] top-1/2 -translate-y-1/2 w-5 h-5 text-[var(--foreground-muted)]" />
                      <input
                        type="number"
                        value={accountForm.creditLimit}
                        onChange={(e) => setAccountForm({ ...accountForm, creditLimit: e.target.value })}
                        placeholder="5000"
                        className="input-field pl-[3.25rem]"
                      />
                    </div>
                  </div>
                )}
              </div>

              {accountForm.type === 'credit_card' && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">APR (%)</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      max="100"
                      value={accountForm.apr}
                      onChange={(e) => setAccountForm({ ...accountForm, apr: e.target.value })}
                      placeholder="24.99"
                      className="input-field"
                    />
                  </div>
                  <label className="flex items-start gap-2 p-3 rounded-control bg-[var(--accent-primary)]/5 border border-[var(--accent-primary)]/20 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={accountForm.feedless}
                      onChange={(e) => setAccountForm({ ...accountForm, feedless: e.target.checked })}
                      className="mt-0.5"
                    />
                    <span className="text-sm text-[var(--foreground-secondary)]">
                      <span className="font-medium text-[var(--foreground)]">No transaction feed</span>
                      {' '}(e.g. an Amazon Store Card). Each payment INTO this card counts as the expense
                      itself, on the payment date. Set a starting balance below so it has something to
                      anchor to, and enter the last four digits so a payment naming this card is never
                      mistaken for one of your other cards. If this card later gains a feed, its own
                      itemized rows automatically take over and payments stop double-counting.
                    </span>
                  </label>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">Statement Date</label>
                      <select
                        value={accountForm.statementDate}
                        onChange={(e) => setAccountForm({ ...accountForm, statementDate: e.target.value })}
                        className="input-field"
                      >
                        <option value="">Not set</option>
                        {Array.from({ length: 31 }, (_, i) => String(i + 1)).map((d) => (
                          <option key={d} value={d}>{d}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">Due Date</label>
                      <select
                        value={accountForm.dueDate}
                        onChange={(e) => setAccountForm({ ...accountForm, dueDate: e.target.value })}
                        className="input-field"
                      >
                        <option value="">Not set</option>
                        {Array.from({ length: 31 }, (_, i) => String(i + 1)).map((d) => (
                          <option key={d} value={d}>{d}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                </>
              )}

              {/* Payment Source Account (for credit cards and loans) */}
              {(accountForm.type === 'credit_card' || accountForm.type === 'personal_loan') && (
                <div className="p-4 rounded-control bg-[var(--accent-primary)]/5 border border-[var(--accent-primary)]/20">
                  <label className="block text-sm font-medium text-[var(--foreground)] mb-2">
                    Pay this {accountForm.type === 'credit_card' ? 'card' : 'loan'} from:
                  </label>
                  <select
                    value={accountForm.paymentFromAccountId}
                    onChange={(e) => setAccountForm({ ...accountForm, paymentFromAccountId: e.target.value })}
                    className="input-field"
                  >
                    <option value="">Select checking account...</option>
                    {profile?.paymentAccounts
                      ?.filter(a => a.type === 'bank_account' || a.type === 'debit_card')
                      .filter(a => a.id !== editingAccount?.id)
                      .map(account => (
                        <option key={account.id} value={account.id}>
                          {account.name} {account.lastFourDigits ? `(•${account.lastFourDigits})` : ''}
                        </option>
                      ))
                    }
                  </select>
                  <p className="text-xs text-[var(--foreground-muted)] mt-2">
                    This links payments to your forecast. When this {accountForm.type === 'credit_card' ? 'card' : 'loan'} is due, 
                    the payment will show in your checking account forecast.
                  </p>
                </div>
              )}

              <button
                onClick={handleSaveAccount}
                disabled={
                  !accountForm.name ||
                  // #14 (CRITICAL-3): a feedless card without a starting balance has
                  // nothing to anchor its derived balance to — see the comment in
                  // handleSaveAccount above.
                  (accountForm.type === 'credit_card' && accountForm.feedless && !accountForm.balance.trim())
                }
                className="btn-primary w-full disabled:opacity-50"
              >
                {editingAccount ? 'Update Account' : 'Add Account'}
              </button>
              {accountForm.type === 'credit_card' && accountForm.feedless && !accountForm.balance.trim() && (
                <p className="text-xs text-[var(--accent-danger)] -mt-2">
                  Set a starting balance above — a no-feed card needs one to anchor its balance.
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Income Modal */}
      {showIncomeModal && (
        <div className="modal-overlay" onClick={resetIncomeForm}>
          <div className="modal-content max-w-lg" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-start gap-4 mt-8 mb-4">
              <h2 className="text-xl font-bold text-[var(--foreground)]">
                {editingIncome ? 'Edit Income' : 'Add Income'}
              </h2>
              <button onClick={resetIncomeForm} aria-label="Close" className="p-2 rounded-control text-[var(--foreground-muted)] hover:bg-[var(--background-tertiary)]">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">Income Name</label>
                <input
                  type="text"
                  value={incomeForm.name}
                  onChange={(e) => setIncomeForm({ ...incomeForm, name: e.target.value })}
                  placeholder="e.g., Salary, Freelance"
                  className="input-field"
                />
              </div>

              <div>
                <label htmlFor="income-aliases" className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
                  Bank description contains
                </label>
                <input
                  id="income-aliases"
                  type="text"
                  value={incomeForm.matchAliases}
                  onChange={(e) => setIncomeForm({ ...incomeForm, matchAliases: e.target.value })}
                  placeholder="e.g., CANTON PAYROLL, CANTON DEPOSIT"
                  className="input-field"
                  aria-describedby="income-aliases-help"
                />
                <p id="income-aliases-help" className="text-xs text-[var(--foreground-muted)] mt-2">
                  Text that appears on the bank line for this income, comma-separated. A deposit only
                  counts as earned income when it matches. Leave blank to match on the name above.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">Amount</label>
                  <div className="relative">
                    <DollarSign className="absolute left-[1.1rem] top-1/2 -translate-y-1/2 w-5 h-5 text-[var(--foreground-muted)]" />
                    <input
                      type="number"
                      value={incomeForm.amount}
                      onChange={(e) => setIncomeForm({ ...incomeForm, amount: e.target.value })}
                      placeholder="5000"
                      className="input-field pl-[3.25rem]"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">Frequency</label>
                  <select
                    value={incomeForm.frequency}
                    onChange={(e) => setIncomeForm({ ...incomeForm, frequency: e.target.value as Cadence })}
                    className="select-field"
                  >
                    <option value="weekly">Weekly</option>
                    <option value="biweekly">Bi-weekly</option>
                    <option value="monthly">Monthly</option>
                    <option value="yearly">Yearly</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">Pay Date (Day of Month)</label>
                <select
                        value={incomeForm.payDate}
                        onChange={(e) => setIncomeForm({ ...incomeForm, payDate: e.target.value })}
                        className="input-field"
                      >
                        <option value="">Not set</option>
                        {Array.from({ length: 31 }, (_, i) => String(i + 1)).map((d) => (
                          <option key={d} value={d}>{d}</option>
                        ))}
                      </select>
              </div>

              <button
                onClick={handleSaveIncome}
                disabled={!incomeForm.name || !incomeForm.amount}
                className="btn-primary w-full disabled:opacity-50"
              >
                {editingIncome ? 'Update Income' : 'Add Income'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteConfirmId && deleteType && (
        <div className="modal-overlay" onClick={cancelDelete}>
          <div className="delete-confirm-modal" onClick={(e) => e.stopPropagation()}>
            <Trash2 className="w-12 h-12 text-[var(--accent-danger)] mx-auto mb-4" />
            <h3 className="text-xl font-bold text-[var(--foreground)] mb-2">
              Delete {deleteType === 'account' ? 'Account' : 'Income Source'}?
            </h3>
            <p className="text-[var(--foreground-secondary)] mb-6">
              Are you sure you want to delete &quot;{getItemToDelete()?.name}&quot;? This action cannot be undone.
            </p>
            <div className="flex gap-3">
              <button
                onClick={cancelDelete}
                className="btn-secondary flex-1"
                disabled={isDeleting}
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                className="btn-danger flex-1 flex items-center justify-center gap-2"
                disabled={isDeleting}
              >
                {isDeleting ? (
                  <>
                    <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-pill animate-spin" />
                    Deleting...
                  </>
                ) : (
                  <>
                    <Trash2 className="w-4 h-4" />
                    Delete
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function getOrdinalSuffix(day: number): string {
  if (day > 3 && day < 21) return 'th';
  switch (day % 10) {
    case 1: return 'st';
    case 2: return 'nd';
    case 3: return 'rd';
    default: return 'th';
  }
}

