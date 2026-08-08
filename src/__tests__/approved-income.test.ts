/**
 * FIN-INCOME-001 — approved income sources and the unknown-inflow default.
 *
 * THE GOVERNING RULE, pinned here:
 *   money entering an account is EARNED INCOME only when it matches an active
 *   approved source, or the owner explicitly confirmed it. Everything else is an
 *   `unknown_inflow` — real cash, not income.
 *
 * A positive row must never become income because it is large, recurring, called
 * "deposit", arrived by Zelle, came from the same person twice, or was tagged
 * "Paychecks" by an importer. Each of those has a test below.
 *
 * Sanitized fixtures only — invented employers, invented amounts, invented accounts.
 */

import { IncomeSource, PaymentAccount, Transaction, InflowReview, FINANCIAL_MEANINGS, isFinancialMeaning } from '@/types';
import {
  interpretTransaction,
  sumIncomeCents,
  countsAsEarnedIncome,
  personalCostSign,
  matchApprovedSources,
  activeApprovedSources,
  selectInflowReviewQueue,
  IncomeContext, POSTED_ONLY } from '@/lib/classify';
import { deriveAccountBalance, generateForecast, monthlyAverages } from '@/lib/forecast';

const accounts: PaymentAccount[] = [
  {
    id: 'chk', name: 'Everyday Checking', type: 'bank_account', provider: 'chase',
    openingBalance: 1000, openingDate: '2000-01-01', color: '#111', isActive: true,
  },
  {
    id: 'sav', name: 'Reserve Savings', type: 'bank_account', provider: 'chase',
    openingBalance: 0, openingDate: '2000-01-01', color: '#112', isActive: true,
  },
  {
    id: 'card', name: 'Rewards Card', type: 'credit_card', provider: 'amex',
    lastFourDigits: '9021', creditLimit: 5000,
    openingBalance: 0, openingDate: '2000-01-01', color: '#222', isActive: true,
  },
];

const tx = (o: Partial<Transaction> & { id: string; title: string; amount: number }): Transaction => ({
  type: 'income', category: 'other', paymentMethod: 'other', date: '2026-03-10', accountId: 'chk', ...o,
});

/** A source shaped exactly like a document written before FIN-INCOME-001 existed. */
const LEGACY_SOURCE: IncomeSource = {
  id: 'src-legacy', name: 'Larkspur Studio', amount: 3200, frequency: 'biweekly', isActive: true,
};

const EMPLOYER: IncomeSource = {
  ...LEGACY_SOURCE,
  id: 'src-employer',
  matchAliases: ['larkspur studio', 'larkspur payroll'],
  depositAccountIds: ['chk'],
  kind: 'employment',
  userApproved: true,
};

const SIDE_GIG: IncomeSource = {
  id: 'src-gig', name: 'Foxglove Consulting', amount: 900, frequency: 'monthly', isActive: true,
  matchAliases: ['foxglove'], kind: 'contract', userApproved: true,
};

const ctxOf = (sources: IncomeSource[], reviews?: Record<string, InflowReview>): IncomeContext =>
  ({ sources, reviews });

const meaningOf = (t: Transaction, income?: IncomeContext) =>
  interpretTransaction(t, accounts, income).financialMeaning;

// ---------------------------------------------------------------------------
// The taxonomy this task OWNS (FIN-REVIEW-002 §3 imports it)
// ---------------------------------------------------------------------------
describe('shared financial-meaning taxonomy', () => {
  it('exposes every value FIN-REVIEW-002 §3 requires, as stable strings', () => {
    for (const required of [
      'personal_expense', 'shared_expense', 'reimbursable_expense', 'business_expense',
      'subscription', 'recurring_bill', 'one_time_expense', 'internal_transfer',
      'card_payment', 'refund', 'earned_income', 'shared_expense_reimbursement',
      'receivable_repayment', 'sale_proceeds', 'gift_or_personal_transfer',
      'other_non_income_credit', 'unknown_inflow',
    ]) {
      expect(FINANCIAL_MEANINGS).toContain(required);
    }
    expect(new Set(FINANCIAL_MEANINGS).size).toBe(FINANCIAL_MEANINGS.length);
  });

  it('is a CLOSED set at the trust boundary', () => {
    expect(isFinancialMeaning('earned_income')).toBe(true);
    expect(isFinancialMeaning('salary')).toBe(false);
    expect(isFinancialMeaning('')).toBe(false);
    expect(isFinancialMeaning(null)).toBe(false);
    expect(isFinancialMeaning({ toString: () => 'earned_income' })).toBe(false);
  });

  it('earned_income is the ONLY meaning that counts as income (§3.1.2)', () => {
    expect(FINANCIAL_MEANINGS.filter(countsAsEarnedIncome)).toEqual(['earned_income']);
  });

  it('personal cost: transfers/card payments are zero, a refund is negative (§3.1.3)', () => {
    expect(personalCostSign('internal_transfer')).toBe(0);
    expect(personalCostSign('card_payment')).toBe(0);
    expect(personalCostSign('refund')).toBe(-1);
    expect(personalCostSign('personal_expense')).toBe(1);
    expect(personalCostSign('unknown_inflow')).toBe(0);
    expect(personalCostSign('earned_income')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Zero / one / many sources
// ---------------------------------------------------------------------------
describe('approved income sources are configurable: zero, one, many', () => {
  const payLarkspur = tx({ id: 'a1', title: 'DIRECT DEP LARKSPUR STUDIO', amount: 3200 });
  const payFoxglove = tx({ id: 'a2', title: 'ACH CREDIT FOXGLOVE CONSULTING', amount: 900, accountId: 'chk' });

  it('ZERO sources: nothing is earned income, everything is an unknown inflow', () => {
    expect(meaningOf(payLarkspur, ctxOf([]))).toBe('unknown_inflow');
    expect(meaningOf(payLarkspur)).toBe('unknown_inflow'); // no context at all
    expect(sumIncomeCents([payLarkspur, payFoxglove], accounts, ctxOf([]))).toBe(0);
  });

  it('ONE source: only the deposit it explains is earned income', () => {
    const c = ctxOf([EMPLOYER]);
    expect(meaningOf(payLarkspur, c)).toBe('earned_income');
    expect(meaningOf(payFoxglove, c)).toBe('unknown_inflow');
    expect(sumIncomeCents([payLarkspur, payFoxglove], accounts, c)).toBe(320000);
  });

  it('MANY sources: each deposit resolves to its own source', () => {
    const c = ctxOf([EMPLOYER, SIDE_GIG]);
    expect(meaningOf(payLarkspur, c)).toBe('earned_income');
    expect(meaningOf(payFoxglove, c)).toBe('earned_income');
    expect(sumIncomeCents([payLarkspur, payFoxglove], accounts, c)).toBe(410000);
    expect(matchApprovedSources(payLarkspur, [EMPLOYER, SIDE_GIG]).map((s) => s.id)).toEqual(['src-employer']);
  });

  it('one source may pay into several accounts; one account may take several sources', () => {
    const multi: IncomeSource = { ...EMPLOYER, depositAccountIds: ['chk', 'sav'] };
    const toSavings = tx({ id: 'a3', title: 'DIRECT DEP LARKSPUR STUDIO', amount: 3200, accountId: 'sav' });
    expect(meaningOf(toSavings, ctxOf([multi]))).toBe('earned_income');
    expect(meaningOf(payLarkspur, ctxOf([multi]))).toBe('earned_income');
    // and both sources land in checking
    expect(meaningOf(payFoxglove, ctxOf([multi, SIDE_GIG]))).toBe('earned_income');
  });

  it('PAUSED (inactive) and unapproved sources never make income', () => {
    expect(meaningOf(payLarkspur, ctxOf([{ ...EMPLOYER, isActive: false }]))).toBe('unknown_inflow');
    expect(meaningOf(payLarkspur, ctxOf([{ ...EMPLOYER, userApproved: false }]))).toBe('unknown_inflow');
    expect(activeApprovedSources([{ ...EMPLOYER, isActive: false }, SIDE_GIG]).map((s) => s.id)).toEqual(['src-gig']);
  });

  it('a legacy source document — no new fields at all — still matches by its name', () => {
    expect(LEGACY_SOURCE.matchAliases).toBeUndefined();
    expect(LEGACY_SOURCE.userApproved).toBeUndefined();
    expect(meaningOf(payLarkspur, ctxOf([LEGACY_SOURCE]))).toBe('earned_income');
  });
});

// ---------------------------------------------------------------------------
// The things that must NEVER auto-promote money to income
// ---------------------------------------------------------------------------
describe('no positive transaction becomes income by resemblance', () => {
  const c = ctxOf([EMPLOYER]);

  it('an unrecognised positive is an unknown inflow', () => {
    expect(meaningOf(tx({ id: 'n1', title: 'AB-4471 CREDIT', amount: 88 }), c)).toBe('unknown_inflow');
  });

  it('Zelle does not auto-count as income', () => {
    const zelle = tx({ id: 'n2', title: 'ZELLE FROM ROWAN ASHDOWN', amount: 1800 });
    expect(meaningOf(zelle, c)).toBe('unknown_inflow');
    expect(sumIncomeCents([zelle], accounts, c)).toBe(0);
  });

  it('a RECURRING deposit from the same sender does not auto-count', () => {
    const monthly = [1, 2, 3, 4, 5, 6].map((m) =>
      tx({ id: `r${m}`, title: 'DEPOSIT FROM ROWAN ASHDOWN', amount: 1500, date: `2026-0${m}-01` })
    );
    expect(monthly.every((t) => meaningOf(t, c) === 'unknown_inflow')).toBe(true);
    expect(sumIncomeCents(monthly, accounts, c)).toBe(0);
  });

  it('a LARGE deposit does not auto-count', () => {
    const big = tx({ id: 'n3', title: 'INCOMING WIRE', amount: 42000 });
    expect(meaningOf(big, c)).toBe('unknown_inflow');
  });

  it('a deposit near payday for a paycheck-like amount does not auto-count', () => {
    const lookalike = tx({ id: 'n4', title: 'DEPOSIT', amount: 3200, date: '2026-03-10' });
    expect(meaningOf(lookalike, c)).toBe('unknown_inflow');
  });

  it('a provider category of "Paychecks" SUGGESTS but never decides', () => {
    const tagged = tx({ id: 'n5', title: 'AB-4471 CREDIT', amount: 4100, sourceCategory: 'Paychecks' });
    expect(meaningOf(tagged, c)).toBe('unknown_inflow');
    expect(sumIncomeCents([tagged], accounts, c)).toBe(0);
  });

  it('amount is SUPPORTING evidence: an exact-amount match with no name match is not income', () => {
    const exact = tx({ id: 'n6', title: 'MOBILE CHECK DEPOSIT', amount: 3200 });
    expect(matchApprovedSources(exact, [EMPLOYER])).toHaveLength(0);
  });

  it('a configured amount tolerance can REJECT a name match (never create one)', () => {
    const guarded: IncomeSource = { ...EMPLOYER, amountToleranceCents: 5000 };
    const normal = tx({ id: 'n7', title: 'DIRECT DEP LARKSPUR STUDIO', amount: 3230 });
    const wild = tx({ id: 'n8', title: 'DIRECT DEP LARKSPUR STUDIO', amount: 31000 });
    expect(meaningOf(normal, ctxOf([guarded]))).toBe('earned_income');
    expect(meaningOf(wild, ctxOf([guarded]))).toBe('unknown_inflow');
  });

  it('a deposit-account gate rejects the same employer paying an account it never pays', () => {
    const wrongAccount = tx({ id: 'n9', title: 'DIRECT DEP LARKSPUR STUDIO', amount: 3200, accountId: 'sav' });
    expect(meaningOf(wrongAccount, ctxOf([EMPLOYER]))).toBe('unknown_inflow');
  });

  it('a one-or-two character alias can never match everything', () => {
    const junk: IncomeSource = { id: 'j', name: 'A', amount: 1, frequency: 'monthly', isActive: true };
    expect(matchApprovedSources(tx({ id: 'n10', title: 'ANY MERCHANT AT ALL', amount: 5 }), [junk])).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Ambiguity goes to review, never to a silent pick
// ---------------------------------------------------------------------------
describe('a transaction matching two sources goes to review', () => {
  const twin: IncomeSource = {
    id: 'src-twin', name: 'Larkspur Studio Media', amount: 1200, frequency: 'monthly', isActive: true,
    matchAliases: ['larkspur studio'],
  };
  const both = tx({ id: 'amb1', title: 'DIRECT DEP LARKSPUR STUDIO', amount: 3200 });
  const c = ctxOf([EMPLOYER, twin]);

  it('matches both, so it is NOT earned income', () => {
    expect(matchApprovedSources(both, [EMPLOYER, twin])).toHaveLength(2);
    expect(meaningOf(both, c)).toBe('unknown_inflow');
    expect(sumIncomeCents([both], accounts, c)).toBe(0);
  });

  it('and it lands in the review queue naming both candidates', () => {
    const q = selectInflowReviewQueue([both], accounts, c);
    expect(q).toHaveLength(1);
    expect(q[0].reasons).toContain('inflow_income_source_conflict');
    expect(q[0].candidateSourceIds.sort()).toEqual(['src-employer', 'src-twin']);
  });
});

// ---------------------------------------------------------------------------
// Importer shapes
// ---------------------------------------------------------------------------
describe('importer rows match approved sources without any provider category', () => {
  it('a SimpleFIN row (no sourceCategory, no merchant) matches on its own text', () => {
    const simplefin = tx({
      id: 'sf_991', title: 'ACH CREDIT LARKSPUR PAYROLL PPD ID 9921', amount: 3187.44,
      type: 'income', sourceCategory: undefined,
    });
    expect(simplefin.sourceCategory).toBeUndefined();
    expect(meaningOf(simplefin, ctxOf([EMPLOYER]))).toBe('earned_income');
  });

  it('a Monarch row matches on merchant, with its verbatim category ignored', () => {
    const monarch = tx({
      id: 'mo_1', title: 'Deposit', merchant: 'Larkspur Studio', amount: 3200,
      sourceCategory: 'Other Income',
    });
    expect(meaningOf(monarch, ctxOf([EMPLOYER]))).toBe('earned_income');
  });
});

// ---------------------------------------------------------------------------
// Everything else that is not earned income
// ---------------------------------------------------------------------------
describe('non-income credits stay out of earned income', () => {
  const c = ctxOf([EMPLOYER]);

  it('internal transfers are excluded', () => {
    const inLeg = tx({ id: 'x1', title: 'Online Transfer from Checking', amount: 500, type: 'transfer', transferDirection: 'in', accountId: 'sav' });
    expect(meaningOf(inLeg, c)).toBe('internal_transfer');
    expect(countsAsEarnedIncome(meaningOf(inLeg, c))).toBe(false);
    expect(sumIncomeCents([inLeg], accounts, c)).toBe(0);
  });

  it('a card payment is excluded on both legs', () => {
    const cardLeg = tx({ id: 'x2', title: 'AUTOPAY PAYMENT - THANK YOU', amount: 300, accountId: 'card' });
    expect(meaningOf(cardLeg, c)).toBe('card_payment');
    expect(sumIncomeCents([cardLeg], accounts, c)).toBe(0);
  });

  it('refunds are excluded', () => {
    const refund = tx({ id: 'x3', title: 'Refund - Brightleaf Coffee', amount: 15, accountId: 'card' });
    expect(meaningOf(refund, c)).toBe('refund');
    expect(sumIncomeCents([refund], accounts, c)).toBe(0);
  });

  it('reimbursements are excluded', () => {
    const reimb = tx({ id: 'x4', title: 'REIMBURSEMENT ROWAN ASHDOWN', amount: 240 });
    expect(countsAsEarnedIncome(meaningOf(reimb, c))).toBe(false);
    expect(sumIncomeCents([reimb], accounts, c)).toBe(0);
  });

  it('card rewards are a credit, not earnings', () => {
    const reward = tx({ id: 'x5', title: 'Cashback Reward', amount: 5, accountId: 'card' });
    expect(meaningOf(reward, c)).toBe('other_non_income_credit');
    expect(sumIncomeCents([reward], accounts, c)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Unknown inflow: real cash, not income
// ---------------------------------------------------------------------------
describe('unknown inflows are real money that is not income', () => {
  const unknown = tx({ id: 'u1', title: 'AB-4471 CREDIT', amount: 88, date: '2026-03-19' });
  const c = ctxOf([EMPLOYER]);

  it('raises the account balance', () => {
    expect(deriveAccountBalance(accounts[0], [unknown], POSTED_ONLY)).toBeCloseTo(1088, 2);
  });

  it('but contributes nothing to earned-income analytics', () => {
    expect(sumIncomeCents([unknown], accounts, c)).toBe(0);
    expect(interpretTransaction(unknown, accounts, c).income).toBe('excluded');
  });

  it('does not raise the recurring monthly-income estimate', () => {
    const now = new Date();
    const m = (back: number) =>
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 15)).toISOString().slice(0, 10);
    const ledger = [
      tx({ id: 'p1', title: 'DIRECT DEP LARKSPUR STUDIO', amount: 3000, date: m(1) }),
      tx({ id: 'p2', title: 'DIRECT DEP LARKSPUR STUDIO', amount: 3000, date: m(2) }),
      tx({ id: 'z1', title: 'ZELLE FROM ROWAN ASHDOWN', amount: 5000, date: m(1) }),
      tx({ id: 'z2', title: 'AB-4471 CREDIT', amount: 400, date: m(2) }),
    ];
    expect(monthlyAverages(ledger, accounts, 2, c).income).toBe(3000);
    // and with no approved sources configured at all, nothing is claimed as income
    expect(monthlyAverages(ledger, accounts, 2, ctxOf([])).income).toBe(0);
  });

  it('creates no future income event in the forecast', () => {
    const future = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    const f = generateForecast(1000, accounts, [], [tx({ id: 'u2', title: 'AB-4471 CREDIT', amount: 2500, date: future })], 500, 30, {}, c);
    expect(f.events.filter((e) => e.type === 'income')).toHaveLength(0);
    expect(f.totalIncome).toBe(0);
  });

  it('appears in the review queue with a reason', () => {
    const q = selectInflowReviewQueue([unknown], accounts, c);
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ transactionId: 'u1', meaning: 'unknown_inflow', state: 'unreviewed', amountCents: 8800 });
    expect(q[0].reasons).toContain('inflow_unknown_credit');
    expect(q[0].reason).toEqual(expect.any(String));
  });

  it('a plain unmatched DEPOSIT gets its own reason id', () => {
    const dep = tx({ id: 'u3', title: 'MOBILE CHECK DEPOSIT', amount: 400 });
    expect(selectInflowReviewQueue([dep], accounts, c)[0].reasons).toContain('inflow_unmatched_deposit');
  });

  it('earned income, transfers, refunds and card payments never enter the queue', () => {
    const ledger = [
      tx({ id: 'q1', title: 'DIRECT DEP LARKSPUR STUDIO', amount: 3200 }),
      tx({ id: 'q2', title: 'Online Transfer from Checking', amount: 500, type: 'transfer', transferDirection: 'in', accountId: 'sav' }),
      tx({ id: 'q3', title: 'Refund - Brightleaf Coffee', amount: 15, accountId: 'card' }),
      tx({ id: 'q4', title: 'AUTOPAY PAYMENT - THANK YOU', amount: 300, accountId: 'card' }),
      tx({ id: 'q5', title: 'Willowbrook Market', amount: 40, type: 'expense', accountId: 'chk' }),
      unknown,
    ];
    expect(selectInflowReviewQueue(ledger, accounts, c).map((i) => i.transactionId)).toEqual(['u1']);
  });

  it('is deterministic: newest first, then id', () => {
    const rows = [
      tx({ id: 'b', title: 'AB-1 CREDIT', amount: 10, date: '2026-03-01' }),
      tx({ id: 'a', title: 'AB-2 CREDIT', amount: 10, date: '2026-03-01' }),
      tx({ id: 'c', title: 'AB-3 CREDIT', amount: 10, date: '2026-03-02' }),
    ];
    expect(selectInflowReviewQueue(rows, accounts, c).map((i) => i.transactionId)).toEqual(['c', 'a', 'b']);
  });
});

// ---------------------------------------------------------------------------
// Manual classification, persisted independently of category
// ---------------------------------------------------------------------------
describe('user confirmation is authoritative and never re-asked', () => {
  const gift = tx({ id: 'c1', title: 'ZELLE FROM ROWAN ASHDOWN', amount: 1800 });
  const sideJob = tx({ id: 'c2', title: 'AB-7781 CREDIT', amount: 750 });

  const review = (o: Partial<InflowReview> & { transactionId: string }): InflowReview => ({
    state: 'confirmed', updatedAt: '2026-03-20T00:00:00.000Z', source: 'user', ...o,
  });

  it('a confirmed earned-income inflow counts, even with no source matching it', () => {
    const c = ctxOf([EMPLOYER], { c2: review({ transactionId: 'c2', meaning: 'earned_income' }) });
    expect(meaningOf(sideJob, c)).toBe('earned_income');
    expect(sumIncomeCents([sideJob], accounts, c)).toBe(75000);
  });

  it('a confirmed non-income inflow stays out of income and out of the queue', () => {
    const c = ctxOf([EMPLOYER], { c1: review({ transactionId: 'c1', meaning: 'gift_or_personal_transfer' }) });
    expect(meaningOf(gift, c)).toBe('gift_or_personal_transfer');
    expect(sumIncomeCents([gift], accounts, c)).toBe(0);
    expect(selectInflowReviewQueue([gift], accounts, c)).toHaveLength(0);
  });

  it('review state lives OUTSIDE the category — the category is untouched by confirming', () => {
    const c = ctxOf([], { c1: review({ transactionId: 'c1', meaning: 'gift_or_personal_transfer' }) });
    expect(gift.category).toBe('other');
    interpretTransaction(gift, accounts, c);
    expect(gift.category).toBe('other');
    // an identically-categorised row with no review record is still queued
    expect(selectInflowReviewQueue([gift, sideJob], accounts, c).map((i) => i.transactionId)).toEqual(['c2']);
  });

  it('a dismissed row leaves the queue but never becomes income', () => {
    const c = ctxOf([], { c1: review({ transactionId: 'c1', state: 'dismissed' }) });
    expect(selectInflowReviewQueue([gift], accounts, c)).toHaveLength(0);
    expect(sumIncomeCents([gift], accounts, c)).toBe(0);
  });

  it('a suggested row is still in the queue — a suggestion is not a confirmation', () => {
    const c = ctxOf([], { c1: review({ transactionId: 'c1', state: 'suggested', meaning: 'earned_income' }) });
    expect(sumIncomeCents([gift], accounts, c)).toBe(0);
    expect(selectInflowReviewQueue([gift], accounts, c)).toHaveLength(1);
  });

  it('confirmation cannot re-derive a provider-sourced transfer into income', () => {
    const stored = tx({ id: 'c3', title: 'Payroll Deposit', amount: 900, type: 'transfer', transferDirection: 'in' });
    const c = ctxOf([], { c3: review({ transactionId: 'c3', meaning: 'earned_income' }) });
    expect(meaningOf(stored, c)).toBe('internal_transfer');
    expect(sumIncomeCents([stored], accounts, c)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Provider data is immutable
// ---------------------------------------------------------------------------
describe('raw provider data is never modified', () => {
  it('classifying, matching and queueing leave every row byte-identical', () => {
    const rows = [
      tx({ id: 'i1', title: 'DIRECT DEP LARKSPUR STUDIO', amount: 3200, description: 'ACH CREDIT', sourceCategory: 'Paychecks' }),
      tx({ id: 'i2', title: 'ZELLE FROM ROWAN ASHDOWN', amount: 1800, sourceCategory: 'Other Income' }),
    ];
    const before = JSON.stringify(rows);
    const c = ctxOf([EMPLOYER]);
    rows.forEach((t) => interpretTransaction(t, accounts, c));
    matchApprovedSources(rows[0], [EMPLOYER]);
    selectInflowReviewQueue(rows, accounts, c);
    sumIncomeCents(rows, accounts, c);
    expect(JSON.stringify(rows)).toBe(before);
  });
});
