/**
 * FEEDLESS-CARD-001 (#14) — Amazon-store-card-style accounting.
 *
 * The owner's problem, verbatim: "my Amazon accounts where I don't have the
 * transactions going out of Amazon… I paid eight hundred of my money to the
 * Amazon credit card. So you should take that eight hundred as the expense
 * because I paid Amazon… I don't have to add all the balances and all
 * history. I'll start a balance from there on."
 *
 * Today a payment from checking to a card is (correctly) a TRANSFER, not
 * spend — the card's own itemized rows are the spend. For a card with NO
 * feed, that rule leaves a hole: nothing is ever counted. `feedless: true` on
 * the account makes the payment itself stand in as the expense, until the
 * card gains a feed of its own — at which point the guard must stop it from
 * double-counting alongside the real rows.
 *
 * Sanitized fixtures only — invented merchants, invented amounts.
 */
import { PaymentAccount, Transaction } from '@/types';
import { interpretTransaction, sumExpenseCents, POSTED_ONLY } from '@/lib/classify';
import { deriveAccountBalance, withDerivedBalances } from '@/lib/forecast';

const chk: PaymentAccount = {
  id: 'chk', name: 'Checking', type: 'bank_account', provider: 'chase',
  openingBalance: 5000, openingDate: '2026-01-01', color: '#111', isActive: true,
};

const feedlessCard: PaymentAccount = {
  id: 'amzn', name: 'Amazon Store Card', type: 'credit_card', provider: 'discover',
  feedless: true, openingBalance: 0, color: '#222', isActive: true,
};

const normalCard: PaymentAccount = {
  id: 'rewards', name: 'Rewards Card', type: 'credit_card', provider: 'amex',
  openingBalance: 400, openingDate: '2026-01-01', color: '#333', isActive: true,
};

const txn = (o: Partial<Transaction> & { id: string; title: string; amount: number }): Transaction => ({
  type: 'expense', category: 'other', paymentMethod: 'other', date: '2026-03-10', ...o,
});

describe('FEEDLESS-CARD-001: a payment to a feedless card is the expense', () => {
  const accounts = [chk, feedlessCard];
  const payment = txn({
    id: 'p1', title: 'DISCOVER PAYMENT ACH PMT', amount: 800, accountId: 'chk', date: '2026-03-15',
  });

  it('an $800 payment to a feedless card counts as $800 spend on the payment date', () => {
    const i = interpretTransaction(payment, accounts);
    expect(i.expense).toBe('counted');
    expect(i.financialMeaning).toBe('personal_expense');
    expect(i.transfer).toBe('none');
    expect(sumExpenseCents([payment], accounts, POSTED_ONLY)).toBe(80000); // exact cents
  });

  it('the SAME payment to a NORMAL (fed) card stays a transfer, not spend — unchanged', () => {
    const toNormalCard = txn({
      id: 'p2', title: 'AMEX EPAYMENT ACH PMT', amount: 800, accountId: 'chk', date: '2026-03-15',
    });
    const normalAccounts = [chk, normalCard];
    const i = interpretTransaction(toNormalCard, normalAccounts);
    expect(i.expense).toBe('excluded');
    expect(i.financialMeaning).toBe('card_payment');
    expect(i.transfer).toBe('card_settlement');
    expect(sumExpenseCents([toNormalCard], normalAccounts, POSTED_ONLY)).toBe(0);
  });
});

describe('FEEDLESS-CARD-001: balance anchoring — anchor minus payments, no history needed', () => {
  const anchored: PaymentAccount = { ...feedlessCard, openingBalance: 1200, openingDate: '2026-01-01' };

  it("an anchored feedless card's balance falls by each payment, with zero rows of its own", () => {
    const p1 = txn({ id: 'p1', title: 'DISCOVER PAYMENT ACH PMT', amount: 300, accountId: 'chk', date: '2026-02-01' });
    const p2 = txn({ id: 'p2', title: 'DISCOVER PAYMENT ACH PMT', amount: 200, accountId: 'chk', date: '2026-03-01' });
    const accounts = [chk, anchored];
    // owed = 1200 - 300 - 200 = 700, derived with NO rows on the card account itself.
    expect(deriveAccountBalance(anchored, [p1, p2], POSTED_ONLY, accounts)).toBe(700);
  });

  it('withDerivedBalances — the everyday path — produces the same figure', () => {
    const p1 = txn({ id: 'p1', title: 'DISCOVER PAYMENT ACH PMT', amount: 300, accountId: 'chk', date: '2026-02-01' });
    const [, card] = withDerivedBalances([chk, anchored], [p1], POSTED_ONLY);
    expect(card.currentBalance).toBe(900);
  });
});

describe('FEEDLESS-CARD-001: the double-count guard', () => {
  const anchored: PaymentAccount = { ...feedlessCard, openingBalance: 1000, openingDate: '2026-01-01' };
  const payment = (id: string, date: string) =>
    txn({ id, title: 'DISCOVER PAYMENT ACH PMT', amount: 100, accountId: 'chk', date });
  const itemizedRow = txn({ id: 'own1', title: 'Some Merchant', amount: 40, accountId: 'amzn', date: '2026-04-05' });

  it('a payment dated BEFORE the feed starts still counts as spend', () => {
    const [, card] = withDerivedBalances(
      [chk, anchored], [payment('before', '2026-04-04'), itemizedRow], POSTED_ONLY
    );
    expect(card.feedStartsAt).toBe('2026-04-05');
    const i = interpretTransaction(payment('before', '2026-04-04'), [chk, card]);
    expect(i.expense).toBe('counted');
    expect(i.financialMeaning).toBe('personal_expense');
  });

  it('a payment dated ON the feed-start day (inclusive boundary) stops counting as spend', () => {
    const [, card] = withDerivedBalances(
      [chk, anchored], [payment('same-day', '2026-04-05'), itemizedRow], POSTED_ONLY
    );
    const onBoundary = interpretTransaction(payment('same-day', '2026-04-05'), [chk, card]);
    expect(onBoundary.expense).toBe('excluded');
    expect(onBoundary.financialMeaning).toBe('card_payment'); // reverts to the ordinary settlement reading
    expect(onBoundary.reason).toMatch(/flagged for review/);
  });

  it('a payment dated AFTER the feed starts also stops counting as spend', () => {
    const [, card] = withDerivedBalances(
      [chk, anchored], [payment('before', '2026-04-04'), itemizedRow], POSTED_ONLY
    );
    const after = interpretTransaction(payment('after', '2026-05-01'), [chk, card]);
    expect(after.expense).toBe('excluded');
  });

  it('the guard also stops a post-feed payment from moving the card balance', () => {
    const txns = [payment('before', '2026-04-04'), itemizedRow, payment('after', '2026-05-01')];
    const accounts = [chk, anchored];
    // before-payment counts (100), itemized purchase raises owed (+40), after-payment
    // is guarded out entirely: owed = 1000 - 100 + 40 = 940.
    expect(deriveAccountBalance(anchored, txns, POSTED_ONLY, accounts)).toBe(940);
  });
});

describe('FEEDLESS-CARD-001: regression — a user with no feedless accounts is unaffected', () => {
  const accounts = [chk, normalCard];
  const purchase = txn({ id: 'x1', title: 'Groceries', amount: 60, accountId: 'rewards', category: 'food' });
  const cardLeg = txn({
    id: 'x2', title: 'AUTOPAY PAYMENT - THANK YOU', amount: 250, type: 'income', accountId: 'rewards', date: '2026-03-20',
  });
  const bankLeg = txn({ id: 'x3', title: 'AMEX EPAYMENT ACH PMT', amount: 250, accountId: 'chk', date: '2026-03-20' });

  it('spend totals, classification and balances are exactly what they were before #14', () => {
    expect(sumExpenseCents([purchase, cardLeg, bankLeg], accounts, POSTED_ONLY)).toBe(6000); // exact cents
    expect(interpretTransaction(bankLeg, accounts).financialMeaning).toBe('card_payment');
    expect(interpretTransaction(bankLeg, accounts).transfer).toBe('card_settlement');
    expect(deriveAccountBalance(normalCard, [purchase, cardLeg], POSTED_ONLY, accounts)).toBeCloseTo(400 + 60 - 250, 2);
  });
});
