/**
 * #182 ACCT-INV-001 — a linked brokerage account would count as cash and inflate runway.
 *
 * Plaid sends a Schwab brokerage as type `investment`; ingest used to store it as a
 * `bank_account`, and calculateCurrentCash summed it. The lie these pin: the moment a
 * portfolio is shared in Link, Home's runway, Forecast's cash and "can I afford this"
 * all overstate by its whole value. `investment` is net worth only.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import { calculateCurrentCash, generateForecast, withDerivedBalances } from '@/lib/forecast';
import { accountsBehindFigure, isCashAccount, isInvestmentAccount, netWorthOf } from '@/lib/accounts';
import { homeSummary } from '@/lib/home';
import { buildExportWorkbook } from '@/lib/export-xlsx';
import type { PaymentAccount, Transaction, UserProfile } from '@/types';

const acct = (o: Partial<PaymentAccount> & { id: string }): PaymentAccount => ({
  name: o.id, type: 'bank_account', provider: 'bank-transfer', color: '#000', isActive: true,
  openingBalance: 0, openingDate: '2026-01-01', ...o,
} as PaymentAccount);

const checking = acct({ id: 'chk', name: 'Everyday Checking', openingBalance: 5000 });
const brokerage = acct({ id: 'schwab-brk', name: 'Schwab Brokerage', type: 'investment', provider: 'other', openingBalance: 80000 });
const card = acct({ id: 'card', name: 'Rewards Card', type: 'credit_card', provider: 'amex', openingBalance: 1200 });

describe('a linked brokerage balance never inflates cash or runway (#182)', () => {
  it('$5,000 checking + $80,000 investment → cash is $5,000', () => {
    const derived = withDerivedBalances([checking, brokerage], [], {});
    expect(calculateCurrentCash(derived)).toBe(5000);
  });

  it('runway is identical with and without the brokerage', () => {
    const today = new Date('2026-09-15T12:00:00');
    const runway = (accounts: PaymentAccount[]) =>
      homeSummary({ currentCash: calculateCurrentCash(withDerivedBalances(accounts, [], {})), avgMonthlyExpense: 2500, cardsOwed: 0, lockedMonthly: 0, today });
    const without = runway([checking]);
    const withBrokerage = runway([checking, brokerage]);
    expect(withBrokerage.runwayDays).toBe(without.runwayDays);
    expect(withBrokerage.runwayMonths).toBe(2);
  });

  it('is not cash, is its own kind, and counts in net worth', () => {
    expect(isCashAccount(brokerage)).toBe(false);
    expect(isInvestmentAccount(brokerage)).toBe(true);
    expect(netWorthOf([checking, brokerage, card])).toBe(5000 + 80000 - 1200);
  });

  it('an unanchored brokerage is never disclosed under the cash figure it is not part of', () => {
    const unanchored = { ...brokerage, openingDate: undefined };
    expect(accountsBehindFigure('all', [checking, unanchored], 'cash')).toEqual([checking]);
  });

  it('a future transfer sitting on the brokerage does not move the cash forecast', () => {
    const future = new Date();
    future.setDate(future.getDate() + 10);
    const row = (accountId: string): Transaction => ({
      id: `x-${accountId}`, title: 'Transfer to brokerage', amount: 1000, type: 'transfer',
      transferDirection: 'out', category: 'other', paymentMethod: 'bank-transfer',
      accountId, date: future.toISOString().slice(0, 10),
    } as Transaction);
    const accounts = [checking, brokerage];
    const onBrokerage = generateForecast(5000, accounts, [], [row('schwab-brk')], {});
    const onChecking = generateForecast(5000, accounts, [], [row('chk')], {});
    expect(onBrokerage.endingBalance).toBe(5000);
    expect(onChecking.endingBalance).toBe(4000); // the control: the same row on cash does count
  });
});

describe('every cash surface agrees (#182)', () => {
  const profile = { name: 'T', email: 't@example.com', monthlyBudget: 0, currency: 'USD', settings: undefined } as unknown as Pick<UserProfile, 'name' | 'email' | 'monthlyBudget' | 'currency' | 'settings'>;

  it('export: the bank total is Home\'s cash; investments get their own net-worth-only line', () => {
    const cashType = acct({ id: 'wallet', name: 'Wallet', type: 'cash', openingBalance: 40 });
    const unanchoredBrokerage = { ...brokerage, openingDate: undefined, openingBalance: 0 };
    const wb = buildExportWorkbook({ profile, accounts: [checking, cashType, unanchoredBrokerage], incomeSources: [], transactions: [] });
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets['Summary'], { header: 1 });
    const at = (label: string) => rows.findIndex((r) => r[0] === label);
    expect(rows[at('Total Bank Balance')][1]).toBe(calculateCurrentCash([checking, cashType, unanchoredBrokerage]));
    expect(rows[at('Total Bank Balance')][1]).toBe(5040);
    expect(String(rows[at('Total Bank Balance') + 1]?.[0] ?? '')).not.toContain('unanchored');
    expect(rows[at('Total Investments (net worth only, not cash)')][1]).toBe(0);
    expect(String(rows[at('Total Investments (net worth only, not cash)') + 1]?.[0])).toContain('includes 1 unanchored account');
  });

  it('Home, Accounts and Forecast all take cash from calculateCurrentCash; Accounts lists Investments as its own group', () => {
    const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
    expect(read('src/app/dashboard/page.tsx')).toContain('calculateCurrentCash(derivedAccounts)');
    expect(read('src/app/forecast/page.tsx')).toContain('calculateCurrentCash(');
    const accounts = read('src/app/accounts/page.tsx');
    expect(accounts).toContain('calculateCurrentCash(derivedAccounts)');
    expect(accounts).toContain("{ key: 'investments', label: 'Investments', accounts: derivedAccounts.filter(isInvestmentAccount) }");
    expect(accounts).toMatch(/key: 'other'[^\n]*!isInvestmentAccount\(a\)/);
  });
});
