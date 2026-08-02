/**
 * FIN-LEDGER-001 — authoritative transaction classification + pending semantics.
 *
 * Two defects are pinned here:
 *  1. card-payment correctness — a purchase whose title merely contains "PAYMENT"
 *     was read as a settlement (hiding the spend AND reducing card debt), while the
 *     real bank-side payment leg was read as ordinary spending (double counting).
 *  2. pending rows arrive from SimpleFIN with `pending: true` (functions-sync/simplefin.py)
 *     and were silently counted as posted accounting truth.
 *
 * Sanitized fixtures only — invented merchants, invented amounts.
 */

import { PaymentAccount, Transaction } from '@/types';
import {
  classifyTransaction,
  isPositive,
  interpretTransaction,
  isPosted,
  postedOnly,
  sumIncomeCents,
  sumExpenseCents,
} from '@/lib/classify';
import { matchTransfers } from '@/lib/transfers';
import { deriveAccountBalance } from '@/lib/forecast';

const accounts: PaymentAccount[] = [
  {
    id: 'chk', name: 'Everyday Checking (...4410)', type: 'bank_account', provider: 'chase',
    openingBalance: 2000, openingDate: '2000-01-01', color: '#111', isActive: true,
  },
  {
    id: 'card', name: 'Rewards Card (...9021)', type: 'credit_card', provider: 'amex',
    lastFourDigits: '9021', openingBalance: 400, openingDate: '2000-01-01',
    creditLimit: 5000, color: '#222', isActive: true,
  },
  {
    id: 'loan', name: 'Personal Loan', type: 'personal_loan', provider: 'other',
    openingBalance: 3000, openingDate: '2000-01-01', color: '#333', isActive: true,
  },
];

const txn = (o: Partial<Transaction> & { id: string; title: string; amount: number }): Transaction => ({
  type: 'expense', category: 'other', paymentMethod: 'other', date: '2026-03-10', ...o,
});

// ---------------------------------------------------------------------------
// B. Card-payment correctness
// ---------------------------------------------------------------------------
describe('card-payment correctness', () => {
  // The headline defect: "PAYMENT" is a substring of plenty of real merchants.
  const purchaseNamedPayment = txn({
    id: 'p1', title: 'PAYMENT PROCESSING SOLUTIONS LLC', amount: 63.75,
    type: 'expense', category: 'shopping', accountId: 'card',
  });

  it('a card PURCHASE whose title contains "PAYMENT" is spending, not a settlement', () => {
    expect(classifyTransaction(purchaseNamedPayment, accounts)).toBe('expense');
  });

  it('that same purchase does not reduce the card balance', () => {
    // isPositive drives deriveAccountBalance; a false positive here silently
    // understates debt by twice the amount (missing spend + phantom payment).
    expect(isPositive(purchaseNamedPayment, accounts)).toBe(false);
    expect(deriveAccountBalance(accounts[1], [purchaseNamedPayment])).toBeCloseTo(463.75, 2);
  });

  it('a genuine credit-card payment on the card account is a transfer that lowers debt', () => {
    // Arrives from both ingest paths as a credit on the card (positive amount).
    const cardLeg = txn({
      id: 'c1', title: 'AUTOPAY PAYMENT - THANK YOU', amount: 250, type: 'income', accountId: 'card',
    });
    expect(classifyTransaction(cardLeg, accounts)).toBe('transfer');
    expect(isPositive(cardLeg, accounts)).toBe(true);
    expect(interpretTransaction(cardLeg, accounts).transfer).toBe('card_settlement');
  });

  it('the bank-account payment leg is a transfer out, not ordinary spending', () => {
    // SimpleFIN gives no category, so this arrives typed 'expense'. Left raw it is
    // counted as spending while the card leg is counted as income — the double count.
    const bankLeg = txn({
      id: 'b1', title: 'AMEX EPAYMENT ACH PMT', amount: 250, type: 'expense', accountId: 'chk',
    });
    expect(classifyTransaction(bankLeg, accounts)).toBe('transfer');
    expect(isPositive(bankLeg, accounts)).toBe(false);
    expect(interpretTransaction(bankLeg, accounts).transfer).toBe('card_settlement');
  });

  it('a payment-titled outflow that names no card of ours stays an expense', () => {
    const rent = txn({ id: 'r1', title: 'PAYMENT TO NORTHGATE PROPERTIES', amount: 1450, accountId: 'chk' });
    expect(classifyTransaction(rent, accounts)).toBe('expense');
    expect(interpretTransaction(rent, accounts).expense).toBe('counted');
  });

  it('matches the two legs of a card payment as one net-zero movement', () => {
    const cardLeg = txn({ id: 'c2', title: 'AUTOPAY PAYMENT - THANK YOU', amount: 250, type: 'income', accountId: 'card' });
    const bankLeg = txn({ id: 'b2', title: 'AMEX EPAYMENT ACH PMT', amount: 250, type: 'expense', accountId: 'chk' });

    const m = matchTransfers([cardLeg, bankLeg], accounts);
    expect(m.pairs).toHaveLength(1);
    expect(m.pairs[0].fromAccountId).toBe('chk');
    expect(m.pairs[0].toAccountId).toBe('card');
    expect(m.unmatchedOut).toHaveLength(0);
    expect(m.unmatchedIn).toHaveLength(0);
  });

  it('surfaces an unmatched payment candidate instead of hiding it', () => {
    // Only the bank leg imported (the card is not a tracked account here).
    const bankLeg = txn({ id: 'b3', title: 'AMEX EPAYMENT ACH PMT', amount: 250, type: 'expense', accountId: 'chk' });
    const m = matchTransfers([bankLeg], accounts);
    expect(m.pairs).toHaveLength(0);
    expect(m.unmatchedOut.map((t) => t.id)).toEqual(['b3']);
  });

  it('never counts a card purchase and its later settlement as two expenses', () => {
    const purchase = txn({ id: 'x1', title: 'Brightleaf Coffee', amount: 40, accountId: 'card', category: 'food' });
    const cardLeg = txn({ id: 'x2', title: 'AUTOPAY PAYMENT - THANK YOU', amount: 40, type: 'income', accountId: 'card', date: '2026-03-20' });
    const bankLeg = txn({ id: 'x3', title: 'AMEX EPAYMENT ACH PMT', amount: 40, type: 'expense', accountId: 'chk', date: '2026-03-20' });

    expect(sumExpenseCents([purchase, cardLeg, bankLeg], accounts)).toBe(4000);
    expect(sumIncomeCents([purchase, cardLeg, bankLeg], accounts)).toBe(0);
  });

  it('does not flip the sign of an ordinary purchase', () => {
    const groceries = txn({ id: 'g1', title: 'Willowbrook Market', amount: 82.4, accountId: 'chk', category: 'food' });
    expect(isPositive(groceries, accounts)).toBe(false);
    expect(interpretTransaction(groceries, accounts).direction).toBe('outflow');
    expect(sumExpenseCents([groceries], accounts)).toBe(8240);
  });

  it('leaves loan payments alone (ingest forces them to type expense)', () => {
    const loanPay = txn({ id: 'l1', title: 'Personal Loan Payment', amount: 300, accountId: 'loan' });
    expect(isPositive(loanPay, accounts)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C. Pending semantics
// ---------------------------------------------------------------------------
describe('pending semantics', () => {
  const pendingHold = txn({
    id: 'ph1', title: 'Brightleaf Coffee', amount: 50, accountId: 'card',
    category: 'food', pending: true,
  });
  const postedRow = txn({ id: 'pp1', title: 'Willowbrook Market', amount: 120, accountId: 'card', category: 'food' });

  it('marks a pending row as pending and a normal row as posted', () => {
    expect(isPosted(pendingHold)).toBe(false);
    expect(isPosted(postedRow)).toBe(true);
    expect(interpretTransaction(pendingHold, accounts).pending).toBe('pending');
    expect(interpretTransaction(postedRow, accounts).pending).toBe('posted');
  });

  it('a pending row still appears — it is filtered from totals, not from sight', () => {
    const all = [pendingHold, postedRow];
    expect(all).toHaveLength(2);
    expect(postedOnly(all).map((t) => t.id)).toEqual(['pp1']);
  });

  it('a pending row is NOT final posted accounting truth', () => {
    expect(sumExpenseCents([pendingHold, postedRow], accounts)).toBe(12000);
    // The bank's re-anchored balance is a POSTED balance; adding holds double counts.
    expect(deriveAccountBalance(accounts[1], [pendingHold, postedRow])).toBeCloseTo(520, 2);
  });

  it('the interpretation says outright that a pending row is excluded everywhere it matters', () => {
    const i = interpretTransaction(pendingHold, accounts);
    expect(i.expense).toBe('excluded');
    expect(i.budget).toBe('excluded');
    expect(i.forecast).toBe('excluded');
    expect(i.reason).toMatch(/pending/i);
  });

  it('once pending becomes posted it counts exactly once', () => {
    // simplefin.py deletes the pending_ doc when the charge posts under its real id.
    const posted = txn({ id: 'sf_777', title: 'Brightleaf Coffee', amount: 58, accountId: 'card', category: 'food' });
    expect(sumExpenseCents([posted], accounts)).toBe(5800);
  });

  it('a pending hold and its posted twin never both count', () => {
    // The hold ($50) and the settled charge ($58) coexist for one sync window.
    const posted = txn({ id: 'sf_777', title: 'Brightleaf Coffee', amount: 58, accountId: 'card', category: 'food' });
    expect(sumExpenseCents([pendingHold, posted], accounts)).toBe(5800);
  });

  it('a posted transaction appears exactly once in the posted set', () => {
    const rows = [pendingHold, postedRow];
    expect(postedOnly(rows).filter((t) => t.id === 'pp1')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// E. The shared interpretation
// ---------------------------------------------------------------------------
describe('shared interpretation output', () => {
  it('exposes every decision a financial consumer needs', () => {
    const i = interpretTransaction(
      txn({ id: 'i1', title: 'Willowbrook Market', amount: 20, accountId: 'chk', category: 'food' }),
      accounts
    );
    expect(Object.keys(i).sort()).toEqual(
      ['budget', 'confidence', 'direction', 'expense', 'financialMeaning', 'forecast', 'income',
       'incomeSourceId', 'meaning', 'pending', 'reason', 'transfer', 'type'].sort()
    );
    expect(i.confidence).toBeGreaterThan(0);
    expect(i.confidence).toBeLessThanOrEqual(1);
    expect(typeof i.reason).toBe('string');
  });

  it('an internal transfer counts as neither income nor expense', () => {
    const out = txn({ id: 'tr1', title: 'Online Transfer to Savings', amount: 500, type: 'transfer', transferDirection: 'out', accountId: 'chk' });
    const i = interpretTransaction(out, accounts);
    expect(i.income).toBe('excluded');
    expect(i.expense).toBe('excluded');
    expect(i.transfer).toBe('internal_leg');
    expect(i.meaning).toBe('internal_transfer');
  });

  it('a stored provider transfer is never re-derived from the title', () => {
    const stored = txn({ id: 'tr2', title: 'Payroll Deposit', amount: 900, type: 'transfer', transferDirection: 'in', accountId: 'chk' });
    expect(interpretTransaction(stored, accounts).type).toBe('transfer');
    expect(interpretTransaction(stored, accounts).confidence).toBe(1);
  });

  it('names a refund and a reward without pretending they are earned income', () => {
    // Meaning is this layer's job; whether an inflow is EARNED income is FIN-INCOME-001's.
    const refund = txn({ id: 'rf1', title: 'Refund - Brightleaf Coffee', amount: 12, type: 'income', accountId: 'card' });
    const reward = txn({ id: 'rw1', title: 'Cashback Reward', amount: 5, type: 'income', accountId: 'card' });
    expect(interpretTransaction(refund, accounts).meaning).toBe('refund');
    expect(interpretTransaction(reward, accounts).meaning).toBe('reward');
  });

  it('an ordinary deposit is an income candidate, not a settled earned-income claim', () => {
    // The hand-off FIN-LEDGER-001 defined: the ledger layer refuses to call this
    // spending and refuses to call it income. FIN-INCOME-001 settles it — and with
    // no approved income source in the context, the settled answer is NOT income.
    const dep = txn({ id: 'd1', title: 'Direct Deposit - Larkspur Studio', amount: 3200, type: 'income', accountId: 'chk' });
    const i = interpretTransaction(dep, accounts);
    expect(i.meaning).toBe('income_candidate');
    expect(i.direction).toBe('inflow');
    expect(i.financialMeaning).toBe('unknown_inflow');
    expect(i.income).toBe('excluded');

    // With the owner's approved source supplied, the same row IS earned income.
    const withSource = interpretTransaction(dep, accounts, {
      sources: [{ id: 'src1', name: 'Larkspur Studio', amount: 3200, frequency: 'biweekly', isActive: true }],
    });
    expect(withSource.financialMeaning).toBe('earned_income');
    expect(withSource.income).toBe('counted');
    expect(withSource.incomeSourceId).toBe('src1');
  });
});
