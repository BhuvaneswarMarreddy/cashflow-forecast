import { Transaction, PaymentAccount } from '@/types';
import {
  toCents, signedCents, signedRealNowCents, balanceAtEndOfDay,
  personFrom, isSelfPerson, displayPerson,
} from '@/lib/flows';

export const tx = (o: Partial<Transaction> & { id: string; amount: number }): Transaction => ({
  title: o.id, type: 'expense', category: 'other', paymentMethod: 'bank-transfer',
  date: '2026-01-15', ...o,
} as Transaction);

export const acct = (o: Partial<PaymentAccount> & { id: string; balance: number }): PaymentAccount => ({
  name: o.id, type: 'bank_account', provider: 'chase', color: '#000', isActive: true, ...o,
} as PaymentAccount);

describe('cents & balance rollback', () => {
  const bank = acct({ id: 'b1', balance: 100 });
  const card = acct({ id: 'c1', balance: 30, type: 'credit_card', provider: 'amex' });
  const accounts = [bank, card];

  it('toCents avoids float drift', () => {
    expect(toCents(19.99)).toBe(1999);
    expect(toCents(0.1 + 0.2)).toBe(30);
  });

  it('signedRealNowCents negates debt accounts', () => {
    expect(signedRealNowCents(bank)).toBe(10000);
    expect(signedRealNowCents(card)).toBe(-3000);
  });

  it('signedCents follows isPositive', () => {
    const income = tx({ id: 'i', amount: 50, type: 'income', accountId: 'b1' });
    const expense = tx({ id: 'e', amount: 20, type: 'expense', accountId: 'b1' });
    expect(signedCents(income, accounts)).toBe(5000);
    expect(signedCents(expense, accounts)).toBe(-2000);
  });

  it('balanceAtEndOfDay rolls back from the real balance', () => {
    const txns = [
      tx({ id: 'a', amount: 40, type: 'income', accountId: 'b1', date: '2026-01-10' }),
      tx({ id: 'b', amount: 15, type: 'expense', accountId: 'b1', date: '2026-01-20' }),
    ];
    // balance now 100; before the 01-20 expense it was 100 + 15 = 115
    expect(balanceAtEndOfDay(bank, txns, accounts, '2026-01-15')).toBe(11500);
    // before the 01-10 income it was 115 - 40 = 75
    expect(balanceAtEndOfDay(bank, txns, accounts, '2026-01-05')).toBe(7500);
  });
});

describe('person extraction', () => {
  it('parses the four real statement shapes', () => {
    expect(personFrom('Zelle payment to SRIDEVI GOGINENI Conf# ab12cd')).toBe('SRIDEVI GOGINENI');
    expect(personFrom('Zelle payment from LOK SUNDEEP PULUKURI 12345678')).toBe('LOK PULUKURI');
    expect(personFrom('Zelle Transfer Conf# X9Y8Z7; VENU GOPAL GUNTUPALLI')).toBe('VENU GUNTUPALLI');
    // Chase glues a BACxxxx confirmation token straight after the name ($23,300 of self rows)
    expect(personFrom('Zelle payment from BHUVANESWAR REDDY MARREDDY BACmc15udzvd')).toBe('BHUVANESWAR MARREDDY');
  });
  it('routes remittance to the Remitly node', () => {
    expect(personFrom('RMTLY* US1234 REMITLY')).toBe('REMITLY');
  });
  it('strips memo suffixes', () => {
    expect(personFrom('Zelle payment to VENU ANNA for "RENT"; conf 123')).toBe('VENU ANNA');
  });
  it('returns null on non-person text', () => {
    expect(personFrom('AMAZON MKTPL*AB12 SEATTLE')).toBeNull();
    expect(personFrom(undefined)).toBeNull();
  });
  it('detects self in all its forms', () => {
    expect(isSelfPerson('BHUVANESWAR MARREDDY')).toBe(true);
    expect(isSelfPerson('BHUVANESWAR REDDY')).toBe(true);
    expect(isSelfPerson('ME')).toBe(true);
    expect(isSelfPerson('SRIDEVI GOGINENI')).toBe(false);
  });
  it('title-cases for display', () => {
    expect(displayPerson('SRIDEVI GOGINENI')).toBe('Sridevi Gogineni');
  });
});
