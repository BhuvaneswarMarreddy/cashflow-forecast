'use client';

import React, { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { useUserProfile } from '@/context/UserProfileContext';
import { PAYMENT_METHODS, PaymentAccount, IncomeSource, AccountType, PaymentMethod } from '@/types';
import {
  TrendingUp,
  CreditCard,
  DollarSign,
  Calendar,
  Plus,
  Trash2,
  ChevronRight,
  ChevronLeft,
  Check,
  Wallet,
  Building2,
  Banknote,
  ArrowRight,
  Percent,
  Hash,
  Landmark,
  FileText,
  SkipForward,
} from 'lucide-react';

type Step = 'welcome' | 'bank-accounts' | 'credit-cards' | 'loans' | 'income' | 'budget' | 'complete';

// Extended account type with payment source
interface ExtendedPaymentAccount extends Omit<PaymentAccount, 'id'> {
  paymentFromAccountIndex?: number;
}

function OnboardingContent() {
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();
  const { 
    profile, 
    isLoading: profileLoading, 
    addPaymentAccount, 
    deletePaymentAccount,
    addIncomeSource,
    deleteIncomeSource,
    updateProfile,
    completeOnboarding 
  } = useUserProfile();
  const router = useRouter();
  const searchParams = useSearchParams();
  const isContinuing = searchParams?.get('continue') === 'true';
  
  const [currentStep, setCurrentStep] = useState<Step>('welcome');
  const [hasInitializedStep, setHasInitializedStep] = useState(false);
  const [bankAccounts, setBankAccounts] = useState<Omit<PaymentAccount, 'id'>[]>([]);
  const [creditCards, setCreditCards] = useState<ExtendedPaymentAccount[]>([]);
  const [loans, setLoans] = useState<Omit<PaymentAccount, 'id'>[]>([]);
  const [incomeSources, setIncomeSources] = useState<Omit<IncomeSource, 'id'>[]>([]);
  const [monthlyBudget, setMonthlyBudget] = useState('');
  const [dataLoaded, setDataLoaded] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  
  // Track counts of existing items to know what's new
  const [existingCounts, setExistingCounts] = useState({
    banks: 0,
    cards: 0,
    loans: 0,
    income: 0,
  });
  
  // Bank account form
  const [showBankForm, setShowBankForm] = useState(false);
  const [bankForm, setBankForm] = useState({
    name: '',
    type: 'bank_account' as AccountType,
    provider: 'chase' as PaymentMethod,
    balance: '',
    lastFourDigits: '',
  });

  // Credit card form
  const [showCardForm, setShowCardForm] = useState(false);
  const [cardForm, setCardForm] = useState({
    name: '',
    provider: 'chase' as PaymentMethod,
    balance: '',
    creditLimit: '',
    apr: '',
    statementDate: '',
    dueDate: '',
    lastFourDigits: '',
    paymentFromAccountIndex: -1,
  });

  // Loan form
  const [showLoanForm, setShowLoanForm] = useState(false);
  const [loanForm, setLoanForm] = useState({
    name: '',
    provider: 'other' as PaymentMethod,
    balance: '',
    originalAmount: '',
    apr: '',
    monthlyPayment: '',
    dueDate: '',
    loanTerm: '',
    paymentFromAccountIndex: -1,
  });

  // Income form
  const [showIncomeForm, setShowIncomeForm] = useState(false);
  const [incomeForm, setIncomeForm] = useState({
    name: '',
    amount: '',
    frequency: 'biweekly' as 'weekly' | 'biweekly' | 'monthly' | 'yearly',
    payDate: '',
  });
  
  // Loading states for add buttons
  const [isAddingBank, setIsAddingBank] = useState(false);
  const [isAddingCard, setIsAddingCard] = useState(false);
  const [isAddingLoan, setIsAddingLoan] = useState(false);
  const [isAddingIncome, setIsAddingIncome] = useState(false);
  
  // Delete confirmation state
  const [deleteConfirm, setDeleteConfirm] = useState<{
    show: boolean;
    type: 'bank' | 'card' | 'loan' | 'income';
    index: number;
    name: string;
  } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      router.push('/login');
    }
  }, [isAuthenticated, authLoading, router]);

  // Load existing data when continuing setup
  useEffect(() => {
    if (!profileLoading && profile && !dataLoaded) {
      // Load existing accounts from profile
      const existingBanks = profile.paymentAccounts?.filter(
        a => a.type === 'bank_account' || a.type === 'debit_card' || a.type === 'cash'
      ) || [];
      const existingCards = profile.paymentAccounts?.filter(
        a => a.type === 'credit_card'
      ) || [];
      const existingLoans = profile.paymentAccounts?.filter(
        a => a.type === 'personal_loan'
      ) || [];
      const existingIncome = profile.incomeSources || [];
      
      // Track existing counts so we only save NEW items
      setExistingCounts({
        banks: existingBanks.length,
        cards: existingCards.length,
        loans: existingLoans.length,
        income: existingIncome.length,
      });
      
      // Set existing data (remove id for display)
      setBankAccounts(existingBanks.map(({ id, ...rest }) => rest));
      setCreditCards(existingCards.map(({ id, ...rest }) => rest));
      setLoans(existingLoans.map(({ id, ...rest }) => rest));
      setIncomeSources(existingIncome.map(({ id, ...rest }) => rest));
      
      if (profile.monthlyBudget) {
        setMonthlyBudget(profile.monthlyBudget.toString());
      }
      
      setDataLoaded(true);
    }
  }, [profile, profileLoading, dataLoaded]);

  // Set initial step based on isContinuing - after data is loaded
  useEffect(() => {
    if (dataLoaded && !hasInitializedStep) {
      if (isContinuing) {
        // When continuing, start from bank accounts step (allows user to review/add more)
        setCurrentStep('bank-accounts');
      }
      setHasInitializedStep(true);
    }
  }, [dataLoaded, isContinuing, hasInitializedStep]);

  // Only redirect to dashboard if NOT continuing and already onboarded
  useEffect(() => {
    if (!profileLoading && profile?.isOnboarded && !isContinuing) {
      router.push('/forecast');
    }
  }, [profile, profileLoading, router, isContinuing]);

  if (authLoading || profileLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="bg-pattern" />
        <div className="animate-pulse-glow w-16 h-16 rounded-2xl bg-gradient-to-br from-[var(--accent-primary)] to-[var(--accent-secondary)] flex items-center justify-center">
          <TrendingUp className="w-8 h-8 text-white" />
        </div>
      </div>
    );
  }

  const steps: { key: Step; label: string; icon: React.ReactNode }[] = [
    { key: 'welcome', label: 'Welcome', icon: <TrendingUp className="w-5 h-5" /> },
    { key: 'bank-accounts', label: 'Banks', icon: <Landmark className="w-5 h-5" /> },
    { key: 'credit-cards', label: 'Cards', icon: <CreditCard className="w-5 h-5" /> },
    { key: 'loans', label: 'Loans', icon: <FileText className="w-5 h-5" /> },
    { key: 'income', label: 'Income', icon: <Banknote className="w-5 h-5" /> },
    { key: 'budget', label: 'Budget', icon: <DollarSign className="w-5 h-5" /> },
    { key: 'complete', label: 'Done', icon: <Check className="w-5 h-5" /> },
  ];

  const currentStepIndex = steps.findIndex((s) => s.key === currentStep);

  // Bank account functions
  const resetBankForm = () => {
    setBankForm({
      name: '',
      type: 'bank_account',
      provider: 'chase',
      balance: '',
      lastFourDigits: '',
    });
    setShowBankForm(false);
  };

  const addBankAccount = async () => {
    if (!bankForm.name || isAddingBank) return;
    
    setIsAddingBank(true);
    
    const providerInfo = PAYMENT_METHODS.find((p) => p.value === bankForm.provider);
    const newAccount: Omit<PaymentAccount, 'id'> = {
      name: bankForm.name,
      type: bankForm.type,
      provider: bankForm.provider,
      balance: parseFloat(bankForm.balance) || 0,
      lastFourDigits: bankForm.lastFourDigits || undefined,
      color: providerInfo?.color || '#8b949e',
      isActive: true,
    };
    
    // Save immediately to Firestore
    try {
      await addPaymentAccount(newAccount);
      // Add to local state for UI after successful save
      setBankAccounts(prev => [...prev, newAccount]);
      // Update existing count so we don't double-save
      setExistingCounts(prev => ({ ...prev, banks: prev.banks + 1 }));
      resetBankForm();
    } catch (err) {
      console.error('Failed to save bank account:', err);
    } finally {
      setIsAddingBank(false);
    }
  };

  // Show delete confirmation
  const showDeleteConfirm = (type: 'bank' | 'card' | 'loan' | 'income', index: number, name: string) => {
    setDeleteConfirm({ show: true, type, index, name });
  };

  // Handle confirmed delete - also deletes from Firestore if item was saved
  const handleConfirmedDelete = async () => {
    if (!deleteConfirm || !user?.id) return;
    
    setIsDeleting(true);
    const { type, index } = deleteConfirm;
    
    try {
      if (type === 'bank') {
        const account = bankAccounts[index];
        // Delete from Firestore if it has a real ID (was saved)
        const accountInProfile = profile?.paymentAccounts?.find(
          a => a.name === account?.name && a.type === account?.type
        );
        if (accountInProfile && !accountInProfile.id.startsWith('local_')) {
          await deletePaymentAccount(accountInProfile.id);
        }
        setBankAccounts(bankAccounts.filter((_, i) => i !== index));
        setCreditCards(creditCards.map(card => {
          if (card.paymentFromAccountIndex === index) {
            return { ...card, paymentFromAccountIndex: -1 };
          } else if (card.paymentFromAccountIndex !== undefined && card.paymentFromAccountIndex > index) {
            return { ...card, paymentFromAccountIndex: card.paymentFromAccountIndex - 1 };
          }
          return card;
        }));
        setExistingCounts(prev => ({ ...prev, banks: Math.max(0, prev.banks - 1) }));
      } else if (type === 'card') {
        const card = creditCards[index];
        const cardInProfile = profile?.paymentAccounts?.find(
          a => a.name === card?.name && a.type === 'credit_card'
        );
        if (cardInProfile && !cardInProfile.id.startsWith('local_')) {
          await deletePaymentAccount(cardInProfile.id);
        }
        setCreditCards(creditCards.filter((_, i) => i !== index));
        setExistingCounts(prev => ({ ...prev, cards: Math.max(0, prev.cards - 1) }));
      } else if (type === 'loan') {
        const loan = loans[index];
        const loanInProfile = profile?.paymentAccounts?.find(
          a => a.name === loan?.name && a.type === 'personal_loan'
        );
        if (loanInProfile && !loanInProfile.id.startsWith('local_')) {
          await deletePaymentAccount(loanInProfile.id);
        }
        setLoans(loans.filter((_, i) => i !== index));
        setExistingCounts(prev => ({ ...prev, loans: Math.max(0, prev.loans - 1) }));
      } else if (type === 'income') {
        const income = incomeSources[index];
        const incomeInProfile = profile?.incomeSources?.find(
          i => i.name === income?.name
        );
        if (incomeInProfile && !incomeInProfile.id.startsWith('local_')) {
          await deleteIncomeSource(incomeInProfile.id);
        }
        setIncomeSources(incomeSources.filter((_, i) => i !== index));
        setExistingCounts(prev => ({ ...prev, income: Math.max(0, prev.income - 1) }));
      }
    } catch (err) {
      console.error('Failed to delete:', err);
    } finally {
      setIsDeleting(false);
      setDeleteConfirm(null);
    }
  };

  const removeBankAccount = (index: number) => {
    showDeleteConfirm('bank', index, bankAccounts[index]?.name || 'Bank Account');
  };

  // Credit card functions
  const resetCardForm = () => {
    setCardForm({
      name: '',
      provider: 'chase',
      balance: '',
      creditLimit: '',
      apr: '',
      statementDate: '',
      dueDate: '',
      lastFourDigits: '',
      paymentFromAccountIndex: bankAccounts.length > 0 ? 0 : -1,
    });
    setShowCardForm(false);
  };

  const addCreditCard = async () => {
    if (!cardForm.name || isAddingCard) return;
    
    setIsAddingCard(true);
    
    const providerInfo = PAYMENT_METHODS.find((p) => p.value === cardForm.provider);
    const newCard: ExtendedPaymentAccount = {
      name: cardForm.name,
      type: 'credit_card',
      provider: cardForm.provider,
      balance: parseFloat(cardForm.balance) || 0,
      creditLimit: parseFloat(cardForm.creditLimit) || undefined,
      apr: parseFloat(cardForm.apr) || undefined,
      statementDate: cardForm.statementDate ? parseInt(cardForm.statementDate) : undefined,
      dueDate: cardForm.dueDate ? parseInt(cardForm.dueDate) : undefined,
      lastFourDigits: cardForm.lastFourDigits || undefined,
      color: providerInfo?.color || '#8b949e',
      isActive: true,
      paymentFromAccountIndex: cardForm.paymentFromAccountIndex >= 0 ? cardForm.paymentFromAccountIndex : undefined,
    };
    
    // Save immediately to Firestore (without paymentFromAccountIndex)
    try {
      const { paymentFromAccountIndex, ...cardData } = newCard;
      await addPaymentAccount(cardData);
      // Add to local state for UI after successful save
      setCreditCards(prev => [...prev, newCard]);
      setExistingCounts(prev => ({ ...prev, cards: prev.cards + 1 }));
      resetCardForm();
    } catch (err) {
      console.error('Failed to save credit card:', err);
    } finally {
      setIsAddingCard(false);
    }
  };

  const removeCreditCard = (index: number) => {
    showDeleteConfirm('card', index, creditCards[index]?.name || 'Credit Card');
  };

  // Loan functions
  const resetLoanForm = () => {
    setLoanForm({
      name: '',
      provider: 'other',
      balance: '',
      originalAmount: '',
      apr: '',
      monthlyPayment: '',
      dueDate: '',
      loanTerm: '',
      paymentFromAccountIndex: bankAccounts.length > 0 ? 0 : -1,
    });
    setShowLoanForm(false);
  };

  const addLoan = async () => {
    if (!loanForm.name || isAddingLoan) return;
    
    setIsAddingLoan(true);
    
    const newLoan: Omit<PaymentAccount, 'id'> = {
      name: loanForm.name,
      type: 'personal_loan',
      provider: loanForm.provider,
      balance: parseFloat(loanForm.balance) || 0,
      originalAmount: parseFloat(loanForm.originalAmount) || undefined,
      apr: parseFloat(loanForm.apr) || undefined,
      monthlyPayment: parseFloat(loanForm.monthlyPayment) || undefined,
      dueDate: loanForm.dueDate ? parseInt(loanForm.dueDate) : undefined,
      loanTerm: loanForm.loanTerm ? parseInt(loanForm.loanTerm) : undefined,
      color: '#f59e0b',
      isActive: true,
    };
    
    // Save immediately to Firestore
    try {
      await addPaymentAccount(newLoan);
      // Add to local state for UI after successful save
      setLoans(prev => [...prev, newLoan]);
      setExistingCounts(prev => ({ ...prev, loans: prev.loans + 1 }));
      resetLoanForm();
    } catch (err) {
      console.error('Failed to save loan:', err);
    } finally {
      setIsAddingLoan(false);
    }
  };

  const removeLoan = (index: number) => {
    showDeleteConfirm('loan', index, loans[index]?.name || 'Loan');
  };

  // Income functions
  const resetIncomeForm = () => {
    setIncomeForm({
      name: '',
      amount: '',
      frequency: 'biweekly',
      payDate: '',
    });
    setShowIncomeForm(false);
  };

  const addIncome = async () => {
    if (!incomeForm.name || !incomeForm.amount || isAddingIncome) return;
    
    setIsAddingIncome(true);
    
    const newIncome: Omit<IncomeSource, 'id'> = {
      name: incomeForm.name,
      amount: parseFloat(incomeForm.amount) || 0,
      frequency: incomeForm.frequency,
      payDate: incomeForm.payDate ? parseInt(incomeForm.payDate) : undefined,
      isActive: true,
    };
    
    // Save immediately to Firestore
    try {
      await addIncomeSource(newIncome);
      // Add to local state for UI after successful save
      setIncomeSources(prev => [...prev, newIncome]);
      setExistingCounts(prev => ({ ...prev, income: prev.income + 1 }));
      resetIncomeForm();
    } catch (err) {
      console.error('Failed to save income:', err);
    } finally {
      setIsAddingIncome(false);
    }
  };

  const removeIncome = (index: number) => {
    showDeleteConfirm('income', index, incomeSources[index]?.name || 'Income Source');
  };

  const handleComplete = async () => {
    setIsSaving(true);
    try {
      // Accounts are now saved immediately when added, so we just need to:
      // 1. Save budget
      await updateProfile({ monthlyBudget: parseFloat(monthlyBudget) || 0 });
      
      // 2. Complete onboarding
      await completeOnboarding();
      
      setCurrentStep('complete');
    } finally {
      setIsSaving(false);
    }
  };

  // Skip all - go directly to dashboard without adding anything
  const handleSkipAll = async () => {
    setIsSaving(true);
    try {
      // Mark as onboarded so dashboard shows
      await completeOnboarding();
      router.push('/forecast');
    } finally {
      setIsSaving(false);
    }
  };

  // Skip to dashboard - data is already saved as items are added
  const handleSkipToDashboard = async () => {
    setIsSaving(true);
    try {
      // Save budget if set
      if (monthlyBudget) {
        await updateProfile({ monthlyBudget: parseFloat(monthlyBudget) || 0 });
      }
      
      // Mark as onboarded (can be revisited from accounts page)
      await completeOnboarding();
      router.push('/forecast');
    } finally {
      setIsSaving(false);
    }
  };

  const getAccountIcon = (type: AccountType) => {
    switch (type) {
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

  const calculateMonthlyIncome = () => {
    return incomeSources.reduce((sum, inc) => {
      const monthly = inc.frequency === 'yearly' ? inc.amount / 12 :
        inc.frequency === 'biweekly' ? inc.amount * 26 / 12 :
        inc.frequency === 'weekly' ? inc.amount * 52 / 12 : inc.amount;
      return sum + monthly;
    }, 0);
  };

  const totalDebt = creditCards.reduce((sum, c) => sum + c.balance, 0) + loans.reduce((sum, l) => sum + l.balance, 0);
  const totalMonthlyPayments = loans.reduce((sum, l) => sum + (l.monthlyPayment || 0), 0);

  return (
    <div className="min-h-screen relative">
      <div className="bg-pattern" />
      
      {/* Delete Confirmation Modal */}
      {deleteConfirm?.show && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div 
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => !isDeleting && setDeleteConfirm(null)}
          />
          <div className="relative bg-[var(--background-secondary)] rounded-2xl p-6 max-w-sm w-full border border-[var(--border-color)] shadow-2xl">
            <div className="flex items-center justify-center w-12 h-12 rounded-full bg-[var(--accent-danger)]/20 mx-auto mb-4">
              <Trash2 className="w-6 h-6 text-[var(--accent-danger)]" />
            </div>
            <h3 className="text-lg font-semibold text-[var(--foreground)] text-center mb-2">
              Delete {deleteConfirm.type === 'bank' ? 'Bank Account' : 
                      deleteConfirm.type === 'card' ? 'Credit Card' : 
                      deleteConfirm.type === 'loan' ? 'Loan' : 'Income Source'}?
            </h3>
            <p className="text-sm text-[var(--foreground-secondary)] text-center mb-6">
              Are you sure you want to delete <span className="font-medium text-[var(--foreground)]">&quot;{deleteConfirm.name}&quot;</span>? This action cannot be undone.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setDeleteConfirm(null)}
                disabled={isDeleting}
                className="btn-secondary flex-1"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmedDelete}
                disabled={isDeleting}
                className="flex-1 px-4 py-2.5 rounded-xl bg-[var(--accent-danger)] text-white font-medium hover:bg-[var(--accent-danger)]/90 transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {isDeleting ? (
                  <>
                    <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
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
      
      <div className="relative z-10 max-w-3xl mx-auto px-4 py-8">
        {/* Progress Steps */}
        <div className="flex items-center justify-center mb-8 overflow-x-auto pb-2">
          {steps.map((step, index) => (
            <React.Fragment key={step.key}>
              <div className="flex flex-col items-center flex-shrink-0">
                <div
                  className={`w-9 h-9 md:w-11 md:h-11 rounded-xl flex items-center justify-center transition-all ${
                    index <= currentStepIndex
                      ? 'bg-gradient-to-br from-[var(--accent-primary)] to-[var(--accent-secondary)] text-white'
                      : 'bg-[var(--background-tertiary)] text-[var(--foreground-muted)]'
                  }`}
                >
                  {step.icon}
                </div>
                <span className={`text-[10px] md:text-xs mt-1 hidden md:block ${index <= currentStepIndex ? 'text-[var(--foreground)]' : 'text-[var(--foreground-muted)]'}`}>
                  {step.label}
                </span>
              </div>
              {index < steps.length - 1 && (
                <div
                  className={`w-6 md:w-8 h-0.5 mx-1 rounded transition-all flex-shrink-0 ${
                    index < currentStepIndex ? 'bg-[var(--accent-primary)]' : 'bg-[var(--background-tertiary)]'
                  }`}
                />
              )}
            </React.Fragment>
          ))}
        </div>

        {/* Step Content */}
        <div className="glass-card p-6 md:p-8">
          {/* Welcome Step */}
          {currentStep === 'welcome' && (
            <div className="text-center">
              <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-gradient-to-br from-[var(--accent-primary)] to-[var(--accent-secondary)] mb-6">
                <TrendingUp className="w-10 h-10 text-white" />
              </div>
              <h1 className="text-3xl font-bold text-[var(--foreground)] mb-4">
                Welcome to CashFlow, {user?.name?.split(' ')[0]}!
              </h1>
              <p className="text-[var(--foreground-secondary)] mb-8 max-w-md mx-auto">
                Let&apos;s set up your financial accounts. We&apos;ll start with your bank accounts, then credit cards, loans, and income.
              </p>
              <div className="flex flex-col sm:flex-row gap-3 justify-center">
                <button
                  onClick={() => setCurrentStep('bank-accounts')}
                  className="btn-primary inline-flex items-center justify-center gap-2"
                  disabled={isSaving}
                >
                  Get Started
                  <ArrowRight className="w-5 h-5" />
                </button>
                <button
                  onClick={handleSkipAll}
                  disabled={isSaving}
                  className="btn-secondary inline-flex items-center justify-center gap-2"
                >
                  {isSaving ? (
                    <>
                      <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                      Saving...
                    </>
                  ) : (
                    <>
                      <SkipForward className="w-4 h-4" />
                      Skip & View Forecast
                    </>
                  )}
                </button>
              </div>
              <p className="text-xs text-[var(--foreground-muted)] mt-4">
                You can always add accounts later from the Accounts page
              </p>
            </div>
          )}

          {/* Bank Accounts Step */}
          {currentStep === 'bank-accounts' && (
            <div>
              <div className="flex items-center gap-3 mb-2">
                <div className="w-10 h-10 rounded-xl bg-[var(--accent-primary)]/20 flex items-center justify-center">
                  <Landmark className="w-5 h-5 text-[var(--accent-primary)]" />
                </div>
                <div>
                  <h2 className="text-2xl font-bold text-[var(--foreground)]">
                    Bank Accounts
                  </h2>
                  <p className="text-sm text-[var(--foreground-secondary)]">
                    Add your checking and savings accounts
                  </p>
                </div>
              </div>

              {/* Added Bank Accounts */}
              {bankAccounts.length > 0 && (
                <div className="space-y-3 mb-6 mt-4">
                  {bankAccounts.map((account, index) => (
                    <div
                      key={index}
                      className="flex items-center justify-between p-4 rounded-xl bg-[var(--background-tertiary)] border-l-4"
                      style={{ borderLeftColor: account.color }}
                    >
                      <div className="flex items-center gap-4">
                        <div
                          className="w-10 h-10 rounded-xl flex items-center justify-center"
                          style={{ backgroundColor: `${account.color}20`, color: account.color }}
                        >
                          {getAccountIcon(account.type)}
                        </div>
                        <div>
                          <p className="font-medium text-[var(--foreground)]">
                            {account.name}
                            {account.lastFourDigits && ` •••• ${account.lastFourDigits}`}
                          </p>
                          <p className="text-sm text-[var(--foreground-secondary)]">
                            {PAYMENT_METHODS.find((p) => p.value === account.provider)?.label}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-4">
                        <p className="font-semibold text-[var(--accent-success)]">
                          ${account.balance.toLocaleString()}
                        </p>
                        <button
                          onClick={() => removeBankAccount(index)}
                          className="p-2 rounded-lg text-[var(--foreground-muted)] hover:text-[var(--accent-danger)] hover:bg-[var(--accent-danger)]/10 transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Add Bank Account Form */}
              {showBankForm ? (
                <div className="p-5 rounded-xl bg-[var(--background-tertiary)] border border-[var(--border-color)] mt-4">
                  <h3 className="text-lg font-semibold text-[var(--foreground)] mb-4">Add Bank Account</h3>
                  
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                    <div>
                      <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
                        Account Name *
                      </label>
                      <input
                        type="text"
                        value={bankForm.name}
                        onChange={(e) => setBankForm({ ...bankForm, name: e.target.value })}
                        placeholder="e.g., Chase Checking"
                        className="input-field"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
                        Last 4 Digits
                      </label>
                      <div className="relative">
                        <Hash className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--foreground-muted)]" />
                        <input
                          type="text"
                          value={bankForm.lastFourDigits}
                          onChange={(e) => setBankForm({ ...bankForm, lastFourDigits: e.target.value.replace(/\D/g, '').slice(0, 4) })}
                          placeholder="1234"
                          maxLength={4}
                          className="input-field pl-12"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                    <div>
                      <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
                        Account Type *
                      </label>
                      <select
                        value={bankForm.type}
                        onChange={(e) => setBankForm({ ...bankForm, type: e.target.value as AccountType })}
                        className="select-field"
                      >
                        <option value="bank_account">Checking / Savings</option>
                        <option value="debit_card">Debit Card</option>
                        <option value="cash">Cash</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
                        Bank *
                      </label>
                      <select
                        value={bankForm.provider}
                        onChange={(e) => setBankForm({ ...bankForm, provider: e.target.value as PaymentMethod })}
                        className="select-field"
                      >
                        {PAYMENT_METHODS.map((method) => (
                          <option key={method.value} value={method.value}>{method.label}</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                    <div>
                      <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
                        Current Balance *
                      </label>
                      <div className="relative">
                        <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--foreground-muted)]" />
                        <input
                          type="number"
                          step="0.01"
                          value={bankForm.balance}
                          onChange={(e) => setBankForm({ ...bankForm, balance: e.target.value })}
                          placeholder="0.00"
                          className="input-field pl-12"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="flex gap-3 pt-4 border-t border-[var(--border-color)]">
                    <button
                      onClick={addBankAccount}
                      disabled={!bankForm.name || isAddingBank}
                      className="btn-primary flex-1 flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {isAddingBank ? (
                        <>
                          <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                          Saving...
                        </>
                      ) : (
                        <>
                          <Plus className="w-4 h-4" />
                          Add & Save
                        </>
                      )}
                    </button>
                    <button
                      onClick={resetBankForm}
                      disabled={isAddingBank}
                      className="btn-secondary px-6"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setShowBankForm(true)}
                  className="w-full p-4 rounded-xl border-2 border-dashed border-[var(--border-color)] text-[var(--foreground-secondary)] hover:border-[var(--accent-primary)] hover:text-[var(--accent-primary)] transition-all flex items-center justify-center gap-2 mt-4"
                >
                  <Plus className="w-5 h-5" />
                  Add Bank Account
                </button>
              )}

              {/* Navigation */}
              <div className="flex justify-between mt-8 pt-6 border-t border-[var(--border-color)]">
                <button
                  onClick={() => setCurrentStep('welcome')}
                  className="btn-secondary flex items-center gap-2"
                >
                  <ChevronLeft className="w-4 h-4" />
                  Back
                </button>
                <div className="flex gap-2">
                  <button
                    onClick={() => setCurrentStep('credit-cards')}
                    className="btn-secondary flex items-center gap-2"
                  >
                    Skip
                    <SkipForward className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => setCurrentStep('credit-cards')}
                    className="btn-primary flex items-center gap-2"
                  >
                    Continue
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Credit Cards Step */}
          {currentStep === 'credit-cards' && (
            <div>
              <div className="flex items-center gap-3 mb-2">
                <div className="w-10 h-10 rounded-xl bg-[var(--accent-secondary)]/20 flex items-center justify-center">
                  <CreditCard className="w-5 h-5 text-[var(--accent-secondary)]" />
                </div>
                <div>
                  <h2 className="text-2xl font-bold text-[var(--foreground)]">
                    Credit Cards
                  </h2>
                  <p className="text-sm text-[var(--foreground-secondary)]">
                    Add your credit cards with billing details
                  </p>
                </div>
              </div>

              {/* Added Credit Cards */}
              {creditCards.length > 0 && (
                <div className="space-y-3 mb-6 mt-4">
                  {creditCards.map((card, index) => (
                    <div
                      key={index}
                      className="flex items-center justify-between p-4 rounded-xl bg-[var(--background-tertiary)] border-l-4"
                      style={{ borderLeftColor: card.color }}
                    >
                      <div className="flex items-center gap-4">
                        <div
                          className="w-10 h-10 rounded-xl flex items-center justify-center"
                          style={{ backgroundColor: `${card.color}20`, color: card.color }}
                        >
                          <CreditCard className="w-5 h-5" />
                        </div>
                        <div>
                          <p className="font-medium text-[var(--foreground)]">
                            {card.name}
                            {card.lastFourDigits && ` •••• ${card.lastFourDigits}`}
                          </p>
                          <p className="text-sm text-[var(--foreground-secondary)]">
                            {card.creditLimit && `Limit: $${card.creditLimit.toLocaleString()}`}
                            {card.apr && ` • APR: ${card.apr}%`}
                            {card.dueDate && ` • Due: ${card.dueDate}${getOrdinalSuffix(card.dueDate)}`}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-4">
                        <p className="font-semibold text-[var(--accent-danger)]">
                          -${card.balance.toLocaleString()}
                        </p>
                        <button
                          onClick={() => removeCreditCard(index)}
                          className="p-2 rounded-lg text-[var(--foreground-muted)] hover:text-[var(--accent-danger)] hover:bg-[var(--accent-danger)]/10 transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Add Credit Card Form */}
              {showCardForm ? (
                <div className="p-5 rounded-xl bg-[var(--background-tertiary)] border border-[var(--border-color)] mt-4">
                  <h3 className="text-lg font-semibold text-[var(--foreground)] mb-4">Add Credit Card</h3>
                  
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                    <div>
                      <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
                        Card Name *
                      </label>
                      <input
                        type="text"
                        value={cardForm.name}
                        onChange={(e) => setCardForm({ ...cardForm, name: e.target.value })}
                        placeholder="e.g., Chase Sapphire"
                        className="input-field"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
                        Last 4 Digits
                      </label>
                      <div className="relative">
                        <Hash className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--foreground-muted)]" />
                        <input
                          type="text"
                          value={cardForm.lastFourDigits}
                          onChange={(e) => setCardForm({ ...cardForm, lastFourDigits: e.target.value.replace(/\D/g, '').slice(0, 4) })}
                          placeholder="1234"
                          maxLength={4}
                          className="input-field pl-12"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                    <div>
                      <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
                        Card Provider *
                      </label>
                      <select
                        value={cardForm.provider}
                        onChange={(e) => setCardForm({ ...cardForm, provider: e.target.value as PaymentMethod })}
                        className="select-field"
                      >
                        {PAYMENT_METHODS.map((method) => (
                          <option key={method.value} value={method.value}>{method.label}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
                        Payment From Account
                      </label>
                      <select
                        value={cardForm.paymentFromAccountIndex}
                        onChange={(e) => setCardForm({ ...cardForm, paymentFromAccountIndex: parseInt(e.target.value) })}
                        className="select-field"
                      >
                        <option value={-1}>Select bank account...</option>
                        {bankAccounts.map((account, index) => (
                          <option key={index} value={index}>
                            {account.name} {account.lastFourDigits && `(•••• ${account.lastFourDigits})`}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
                    <div>
                      <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
                        Amount Owed *
                      </label>
                      <div className="relative">
                        <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--foreground-muted)]" />
                        <input
                          type="number"
                          step="0.01"
                          value={cardForm.balance}
                          onChange={(e) => setCardForm({ ...cardForm, balance: e.target.value })}
                          placeholder="0.00"
                          className="input-field pl-12"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
                        Credit Limit
                      </label>
                      <div className="relative">
                        <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--foreground-muted)]" />
                        <input
                          type="number"
                          step="0.01"
                          value={cardForm.creditLimit}
                          onChange={(e) => setCardForm({ ...cardForm, creditLimit: e.target.value })}
                          placeholder="5000.00"
                          className="input-field pl-12"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
                        Available Credit
                      </label>
                      <div className="h-[46px] px-4 rounded-xl bg-[var(--background-secondary)] border border-[var(--border-color)] flex items-center">
                        <DollarSign className="w-4 h-4 text-[var(--foreground-muted)] mr-2" />
                        <span className={`font-medium ${
                          (parseFloat(cardForm.creditLimit) || 0) - (parseFloat(cardForm.balance) || 0) >= 0 
                            ? 'text-[var(--accent-success)]' 
                            : 'text-[var(--accent-danger)]'
                        }`}>
                          {cardForm.creditLimit 
                            ? ((parseFloat(cardForm.creditLimit) || 0) - (parseFloat(cardForm.balance) || 0)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                            : '—'
                          }
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
                    <div>
                      <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
                        APR (%)
                      </label>
                      <div className="relative">
                        <Percent className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--foreground-muted)]" />
                        <input
                          type="number"
                          step="0.01"
                          value={cardForm.apr}
                          onChange={(e) => setCardForm({ ...cardForm, apr: e.target.value })}
                          placeholder="24.99"
                          className="input-field pl-12"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
                        Statement Date
                      </label>
                      <div className="relative">
                        <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--foreground-muted)]" />
                        <input
                          type="number"
                          min="1"
                          max="31"
                          value={cardForm.statementDate}
                          onChange={(e) => setCardForm({ ...cardForm, statementDate: e.target.value })}
                          placeholder="15"
                          className="input-field pl-12"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
                        Due Date (Day)
                      </label>
                      <div className="relative">
                        <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--foreground-muted)]" />
                        <input
                          type="number"
                          min="1"
                          max="31"
                          value={cardForm.dueDate}
                          onChange={(e) => setCardForm({ ...cardForm, dueDate: e.target.value })}
                          placeholder="5"
                          className="input-field pl-12"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="flex gap-3 pt-4 border-t border-[var(--border-color)]">
                    <button
                      onClick={addCreditCard}
                      disabled={!cardForm.name || isAddingCard}
                      className="btn-primary flex-1 flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {isAddingCard ? (
                        <>
                          <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                          Saving...
                        </>
                      ) : (
                        <>
                          <Plus className="w-4 h-4" />
                          Add & Save
                        </>
                      )}
                    </button>
                    <button
                      onClick={resetCardForm}
                      disabled={isAddingCard}
                      className="btn-secondary px-6"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => {
                    setCardForm(prev => ({
                      ...prev,
                      paymentFromAccountIndex: bankAccounts.length > 0 ? 0 : -1
                    }));
                    setShowCardForm(true);
                  }}
                  className="w-full p-4 rounded-xl border-2 border-dashed border-[var(--border-color)] text-[var(--foreground-secondary)] hover:border-[var(--accent-secondary)] hover:text-[var(--accent-secondary)] transition-all flex items-center justify-center gap-2 mt-4"
                >
                  <Plus className="w-5 h-5" />
                  Add Credit Card
                </button>
              )}

              {/* Navigation */}
              <div className="flex justify-between mt-8 pt-6 border-t border-[var(--border-color)]">
                <button
                  onClick={() => setCurrentStep('bank-accounts')}
                  className="btn-secondary flex items-center gap-2"
                >
                  <ChevronLeft className="w-4 h-4" />
                  Back
                </button>
                <div className="flex gap-2">
                  <button
                    onClick={() => setCurrentStep('loans')}
                    className="btn-secondary flex items-center gap-2"
                  >
                    Skip
                    <SkipForward className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => setCurrentStep('loans')}
                    className="btn-primary flex items-center gap-2"
                  >
                    Continue
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Loans Step */}
          {currentStep === 'loans' && (
            <div>
              <div className="flex items-center gap-3 mb-2">
                <div className="w-10 h-10 rounded-xl bg-[var(--accent-warning)]/20 flex items-center justify-center">
                  <FileText className="w-5 h-5 text-[var(--accent-warning)]" />
                </div>
                <div>
                  <h2 className="text-2xl font-bold text-[var(--foreground)]">
                    Personal Loans
                  </h2>
                  <p className="text-sm text-[var(--foreground-secondary)]">
                    Add any personal loans, auto loans, or student loans
                  </p>
                </div>
              </div>

              {/* Added Loans */}
              {loans.length > 0 && (
                <div className="space-y-3 mb-6 mt-4">
                  {loans.map((loan, index) => (
                    <div
                      key={index}
                      className="flex items-center justify-between p-4 rounded-xl bg-[var(--background-tertiary)] border-l-4 border-l-[var(--accent-warning)]"
                    >
                      <div className="flex items-center gap-4">
                        <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-[var(--accent-warning)]/20 text-[var(--accent-warning)]">
                          <FileText className="w-5 h-5" />
                        </div>
                        <div>
                          <p className="font-medium text-[var(--foreground)]">{loan.name}</p>
                          <p className="text-sm text-[var(--foreground-secondary)]">
                            {loan.originalAmount && `Original: $${loan.originalAmount.toLocaleString()}`}
                            {loan.apr && ` • APR: ${loan.apr}%`}
                            {loan.monthlyPayment && ` • Payment: $${loan.monthlyPayment}/mo`}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-4">
                        <p className="font-semibold text-[var(--accent-danger)]">
                          -${loan.balance.toLocaleString()}
                        </p>
                        <button
                          onClick={() => removeLoan(index)}
                          className="p-2 rounded-lg text-[var(--foreground-muted)] hover:text-[var(--accent-danger)] hover:bg-[var(--accent-danger)]/10 transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Add Loan Form */}
              {showLoanForm ? (
                <div className="p-5 rounded-xl bg-[var(--background-tertiary)] border border-[var(--border-color)] mt-4">
                  <h3 className="text-lg font-semibold text-[var(--foreground)] mb-4">Add Loan</h3>
                  
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                    <div>
                      <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
                        Loan Name *
                      </label>
                      <input
                        type="text"
                        value={loanForm.name}
                        onChange={(e) => setLoanForm({ ...loanForm, name: e.target.value })}
                        placeholder="e.g., Car Loan, Student Loan"
                        className="input-field"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
                        Lender
                      </label>
                      <select
                        value={loanForm.provider}
                        onChange={(e) => setLoanForm({ ...loanForm, provider: e.target.value as PaymentMethod })}
                        className="select-field"
                      >
                        {PAYMENT_METHODS.map((method) => (
                          <option key={method.value} value={method.value}>{method.label}</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                    <div>
                      <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
                        Remaining Balance *
                      </label>
                      <div className="relative">
                        <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--foreground-muted)]" />
                        <input
                          type="number"
                          step="0.01"
                          value={loanForm.balance}
                          onChange={(e) => setLoanForm({ ...loanForm, balance: e.target.value })}
                          placeholder="0.00"
                          className="input-field pl-12"
                        />
                      </div>
                      <p className="text-xs text-[var(--foreground-muted)] mt-1">What you still owe</p>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
                        Original Amount
                      </label>
                      <div className="relative">
                        <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--foreground-muted)]" />
                        <input
                          type="number"
                          step="0.01"
                          value={loanForm.originalAmount}
                          onChange={(e) => setLoanForm({ ...loanForm, originalAmount: e.target.value })}
                          placeholder="10000.00"
                          className="input-field pl-12"
                        />
                      </div>
                      <p className="text-xs text-[var(--foreground-muted)] mt-1">Initial loan amount</p>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
                    <div>
                      <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
                        APR (%)
                      </label>
                      <div className="relative">
                        <Percent className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--foreground-muted)]" />
                        <input
                          type="number"
                          step="0.01"
                          value={loanForm.apr}
                          onChange={(e) => setLoanForm({ ...loanForm, apr: e.target.value })}
                          placeholder="7.5"
                          className="input-field pl-12"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
                        Monthly Payment
                      </label>
                      <div className="relative">
                        <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--foreground-muted)]" />
                        <input
                          type="number"
                          step="0.01"
                          value={loanForm.monthlyPayment}
                          onChange={(e) => setLoanForm({ ...loanForm, monthlyPayment: e.target.value })}
                          placeholder="350.00"
                          className="input-field pl-12"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
                        Due Date (Day)
                      </label>
                      <div className="relative">
                        <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--foreground-muted)]" />
                        <input
                          type="number"
                          min="1"
                          max="31"
                          value={loanForm.dueDate}
                          onChange={(e) => setLoanForm({ ...loanForm, dueDate: e.target.value })}
                          placeholder="15"
                          className="input-field pl-12"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="flex gap-3 pt-4 border-t border-[var(--border-color)]">
                    <button
                      onClick={addLoan}
                      disabled={!loanForm.name || isAddingLoan}
                      className="btn-primary flex-1 flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {isAddingLoan ? (
                        <>
                          <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                          Saving...
                        </>
                      ) : (
                        <>
                          <Plus className="w-4 h-4" />
                          Add & Save
                        </>
                      )}
                    </button>
                    <button
                      onClick={resetLoanForm}
                      disabled={isAddingLoan}
                      className="btn-secondary px-6"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setShowLoanForm(true)}
                  className="w-full p-4 rounded-xl border-2 border-dashed border-[var(--border-color)] text-[var(--foreground-secondary)] hover:border-[var(--accent-warning)] hover:text-[var(--accent-warning)] transition-all flex items-center justify-center gap-2 mt-4"
                >
                  <Plus className="w-5 h-5" />
                  Add Personal Loan
                </button>
              )}

              {/* Navigation */}
              <div className="flex justify-between mt-8 pt-6 border-t border-[var(--border-color)]">
                <button
                  onClick={() => setCurrentStep('credit-cards')}
                  className="btn-secondary flex items-center gap-2"
                >
                  <ChevronLeft className="w-4 h-4" />
                  Back
                </button>
                <div className="flex gap-2">
                  <button
                    onClick={() => setCurrentStep('income')}
                    className="btn-secondary flex items-center gap-2"
                  >
                    Skip
                    <SkipForward className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => setCurrentStep('income')}
                    className="btn-primary flex items-center gap-2"
                  >
                    Continue
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Income Step */}
          {currentStep === 'income' && (
            <div>
              <div className="flex items-center gap-3 mb-2">
                <div className="w-10 h-10 rounded-xl bg-[var(--accent-success)]/20 flex items-center justify-center">
                  <Banknote className="w-5 h-5 text-[var(--accent-success)]" />
                </div>
                <div>
                  <h2 className="text-2xl font-bold text-[var(--foreground)]">
                    Income Sources
                  </h2>
                  <p className="text-sm text-[var(--foreground-secondary)]">
                    Add your paychecks and other income
                  </p>
                </div>
              </div>

              {/* Added Income Sources */}
              {incomeSources.length > 0 && (
                <div className="space-y-3 mb-4 mt-4">
                  {incomeSources.map((income, index) => (
                    <div
                      key={index}
                      className="flex items-center justify-between p-4 rounded-xl bg-[var(--background-tertiary)] border-l-4 border-l-[var(--accent-success)]"
                    >
                      <div className="flex items-center gap-4">
                        <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-[var(--accent-success)]/20 text-[var(--accent-success)]">
                          <Banknote className="w-5 h-5" />
                        </div>
                        <div>
                          <p className="font-medium text-[var(--foreground)]">{income.name}</p>
                          <p className="text-sm text-[var(--foreground-secondary)]">
                            {income.frequency === 'weekly' && 'Weekly'}
                            {income.frequency === 'biweekly' && 'Every 2 weeks'}
                            {income.frequency === 'monthly' && 'Monthly'}
                            {income.frequency === 'yearly' && 'Yearly'}
                            {income.payDate && ` • Day ${income.payDate}`}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-4">
                        <p className="font-semibold text-[var(--accent-success)]">
                          +${income.amount.toLocaleString()}
                        </p>
                        <button
                          onClick={() => removeIncome(index)}
                          className="p-2 rounded-lg text-[var(--foreground-muted)] hover:text-[var(--accent-danger)] hover:bg-[var(--accent-danger)]/10 transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                  
                  {/* Monthly Income Summary */}
                  <div className="p-4 rounded-xl bg-[var(--accent-success)]/10 border border-[var(--accent-success)]/30">
                    <div className="flex justify-between items-center">
                      <span className="text-[var(--foreground-secondary)]">Est. Monthly Income:</span>
                      <span className="text-lg font-bold text-[var(--accent-success)]">
                        ${calculateMonthlyIncome().toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* Add Income Form */}
              {showIncomeForm ? (
                <div className="p-5 rounded-xl bg-[var(--background-tertiary)] border border-[var(--border-color)] mt-4">
                  <h3 className="text-lg font-semibold text-[var(--foreground)] mb-4">Add Income Source</h3>
                  
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                    <div>
                      <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
                        Income Name *
                      </label>
                      <input
                        type="text"
                        value={incomeForm.name}
                        onChange={(e) => setIncomeForm({ ...incomeForm, name: e.target.value })}
                        placeholder="e.g., Main Job, Side Gig"
                        className="input-field"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
                        Amount per Paycheck *
                      </label>
                      <div className="relative">
                        <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--foreground-muted)]" />
                        <input
                          type="number"
                          step="0.01"
                          value={incomeForm.amount}
                          onChange={(e) => setIncomeForm({ ...incomeForm, amount: e.target.value })}
                          placeholder="2500.00"
                          className="input-field pl-12"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                    <div>
                      <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
                        Pay Frequency *
                      </label>
                      <select
                        value={incomeForm.frequency}
                        onChange={(e) => setIncomeForm({ ...incomeForm, frequency: e.target.value as any })}
                        className="select-field"
                      >
                        <option value="weekly">Weekly</option>
                        <option value="biweekly">Bi-weekly (Every 2 weeks)</option>
                        <option value="monthly">Monthly</option>
                        <option value="yearly">Yearly</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
                        Pay Day
                      </label>
                      <div className="relative">
                        <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--foreground-muted)]" />
                        <input
                          type="number"
                          min="1"
                          max="31"
                          value={incomeForm.payDate}
                          onChange={(e) => setIncomeForm({ ...incomeForm, payDate: e.target.value })}
                          placeholder="15"
                          className="input-field pl-12"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="flex gap-3 pt-4 border-t border-[var(--border-color)]">
                    <button
                      onClick={addIncome}
                      disabled={!incomeForm.name || !incomeForm.amount || isAddingIncome}
                      className="btn-primary flex-1 flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {isAddingIncome ? (
                        <>
                          <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                          Saving...
                        </>
                      ) : (
                        <>
                          <Plus className="w-4 h-4" />
                          Add & Save
                        </>
                      )}
                    </button>
                    <button
                      onClick={resetIncomeForm}
                      disabled={isAddingIncome}
                      className="btn-secondary px-6"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => setShowIncomeForm(true)}
                  className="w-full p-4 rounded-xl border-2 border-dashed border-[var(--border-color)] text-[var(--foreground-secondary)] hover:border-[var(--accent-success)] hover:text-[var(--accent-success)] transition-all flex items-center justify-center gap-2 mt-4"
                >
                  <Plus className="w-5 h-5" />
                  Add Income Source
                </button>
              )}

              {/* Navigation */}
              <div className="flex justify-between mt-8 pt-6 border-t border-[var(--border-color)]">
                <button
                  onClick={() => setCurrentStep('loans')}
                  className="btn-secondary flex items-center gap-2"
                >
                  <ChevronLeft className="w-4 h-4" />
                  Back
                </button>
                <div className="flex gap-2">
                  <button
                    onClick={() => setCurrentStep('budget')}
                    className="btn-secondary flex items-center gap-2"
                  >
                    Skip
                    <SkipForward className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => setCurrentStep('budget')}
                    className="btn-primary flex items-center gap-2"
                  >
                    Continue
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Budget Step */}
          {currentStep === 'budget' && (
            <div>
              <div className="flex items-center gap-3 mb-6">
                <div className="w-10 h-10 rounded-xl bg-[var(--accent-tertiary)]/20 flex items-center justify-center">
                  <DollarSign className="w-5 h-5 text-[var(--accent-tertiary)]" />
                </div>
                <div>
                  <h2 className="text-2xl font-bold text-[var(--foreground)]">
                    Monthly Budget
                  </h2>
                  <p className="text-sm text-[var(--foreground-secondary)]">
                    Set your target spending limit
                  </p>
                </div>
              </div>

              <div className="max-w-md mx-auto">
                <div>
                  <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2 text-center">
                    Monthly Spending Budget
                  </label>
                  <div className="relative">
                    <DollarSign className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-[var(--foreground-muted)]" />
                    <input
                      type="number"
                      step="0.01"
                      value={monthlyBudget}
                      onChange={(e) => setMonthlyBudget(e.target.value)}
                      placeholder="3000.00"
                      className="input-field pl-12 text-xl text-center font-semibold"
                      style={{ height: '56px' }}
                    />
                  </div>
                </div>

                {/* Summary */}
                <div className="mt-6 space-y-3">
                  {incomeSources.length > 0 && (
                    <div className="p-3 rounded-xl bg-[var(--accent-success)]/10 border border-[var(--accent-success)]/30">
                      <div className="flex justify-between items-center">
                        <span className="text-sm text-[var(--foreground-secondary)]">Monthly Income:</span>
                        <span className="font-bold text-[var(--accent-success)]">
                          ${calculateMonthlyIncome().toLocaleString(undefined, { maximumFractionDigits: 0 })}
                        </span>
                      </div>
                    </div>
                  )}

                  {totalDebt > 0 && (
                    <div className="p-3 rounded-xl bg-[var(--accent-danger)]/10 border border-[var(--accent-danger)]/30">
                      <div className="flex justify-between items-center">
                        <span className="text-sm text-[var(--foreground-secondary)]">Total Debt:</span>
                        <span className="font-bold text-[var(--accent-danger)]">
                          ${totalDebt.toLocaleString()}
                        </span>
                      </div>
                    </div>
                  )}

                  {totalMonthlyPayments > 0 && (
                    <div className="p-3 rounded-xl bg-[var(--background-tertiary)]">
                      <div className="flex justify-between items-center">
                        <span className="text-sm text-[var(--foreground-secondary)]">Loan Payments:</span>
                        <span className="font-medium text-[var(--foreground)]">
                          ${totalMonthlyPayments.toLocaleString()}/mo
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Navigation */}
              <div className="flex justify-between mt-8 pt-6 border-t border-[var(--border-color)]">
                <button
                  onClick={() => setCurrentStep('income')}
                  disabled={isSaving}
                  className="btn-secondary flex items-center gap-2"
                >
                  <ChevronLeft className="w-4 h-4" />
                  Back
                </button>
                <button
                  onClick={handleComplete}
                  disabled={isSaving}
                  className="btn-primary flex items-center gap-2"
                >
                  {isSaving ? (
                    <>
                      <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                      Saving...
                    </>
                  ) : (
                    <>
                      Complete Setup
                      <Check className="w-4 h-4" />
                    </>
                  )}
                </button>
              </div>
            </div>
          )}

          {/* Complete Step */}
          {currentStep === 'complete' && (
            <div className="text-center">
              <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-[var(--accent-success)]/20 mb-6">
                <Check className="w-10 h-10 text-[var(--accent-success)]" />
              </div>
              <h2 className="text-3xl font-bold text-[var(--foreground)] mb-4">
                You&apos;re All Set!
              </h2>
              <p className="text-[var(--foreground-secondary)] mb-8 max-w-md mx-auto">
                Your accounts have been configured. You can add more accounts anytime from the Accounts page.
              </p>
              
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 max-w-lg mx-auto mb-8">
                <div className="p-3 rounded-xl bg-[var(--background-tertiary)]">
                  <p className="text-xl font-bold text-[var(--accent-primary)]">{bankAccounts.length}</p>
                  <p className="text-xs text-[var(--foreground-secondary)]">Banks</p>
                </div>
                <div className="p-3 rounded-xl bg-[var(--background-tertiary)]">
                  <p className="text-xl font-bold text-[var(--accent-secondary)]">{creditCards.length}</p>
                  <p className="text-xs text-[var(--foreground-secondary)]">Cards</p>
                </div>
                <div className="p-3 rounded-xl bg-[var(--background-tertiary)]">
                  <p className="text-xl font-bold text-[var(--accent-warning)]">{loans.length}</p>
                  <p className="text-xs text-[var(--foreground-secondary)]">Loans</p>
                </div>
                <div className="p-3 rounded-xl bg-[var(--background-tertiary)]">
                  <p className="text-xl font-bold text-[var(--accent-success)]">{incomeSources.length}</p>
                  <p className="text-xs text-[var(--foreground-secondary)]">Income</p>
                </div>
              </div>

              <button
                onClick={() => router.push('/forecast')}
                className="btn-primary inline-flex items-center gap-2"
              >
                View Your Forecast
                <ArrowRight className="w-5 h-5" />
              </button>
            </div>
          )}
        </div>

        {/* Skip to Dashboard - Always visible except on welcome/complete */}
        {currentStep !== 'welcome' && currentStep !== 'complete' && (
          <div className="text-center mt-4">
            <button
              onClick={handleSkipToDashboard}
              disabled={isSaving}
              className="text-sm text-[var(--foreground-muted)] hover:text-[var(--foreground-secondary)] transition-colors inline-flex items-center gap-1 disabled:opacity-50"
            >
              {isSaving ? (
                <>
                  <div className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <SkipForward className="w-3 h-3" />
                  Save & go to Dashboard
                </>
              )}
            </button>
          </div>
        )}
      </div>
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

export default function OnboardingPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-[var(--foreground-muted)]">Loading...</div>
      </div>
    }>
      <OnboardingContent />
    </Suspense>
  );
}
