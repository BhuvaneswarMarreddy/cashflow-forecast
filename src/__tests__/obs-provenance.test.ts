import { accountsSummaryProvenance, lastSourceSync, CALCULATION_NAME } from '@/lib/obs/provenance';
import { FIXTURE_ACCOUNTS, FIXTURE_TRANSACTIONS } from '@/lib/obs/fixtures';
import { withDerivedBalances } from '@/lib/forecast';
import { currentOf } from '@/lib/accounts';
import { PaymentAccount } from '@/types';

const derived = () => withDerivedBalances(FIXTURE_ACCOUNTS, FIXTURE_TRANSACTIONS);
const ctx = { traceId: 'a'.repeat(32), dataSource: 'Firestore', cacheStatus: 'miss' as const };

const metric = (name: string) => accountsSummaryProvenance(derived(), FIXTURE_TRANSACTIONS, ctx).metrics.find((m) => m.metric === name)!;

describe('accounts provenance — counts', () => {
  it('covers the metrics the page displays', () => {
    const names = accountsSummaryProvenance(derived(), FIXTURE_TRANSACTIONS, ctx).metrics.map((m) => m.metric);
    expect(names).toEqual(expect.arrayContaining(['BankBalance', 'CreditUsed', 'TotalDebt', 'NetWorth', 'AvailableCredit', 'AccountCount']));
  });

  it('BankBalance includes exactly the cash accounts and excludes the rest with reasons', () => {
    const m = metric('BankBalance');
    // fixture: 2 bank_account + 1 cash included; 2 credit_card + 1 personal_loan excluded
    expect(m.includedAccountCount).toBe(3);
    expect(m.includedAccountTypes.sort()).toEqual(['bank_account', 'cash']);
    expect(m.excludedAccountCount).toBe(3);
    expect(m.exclusionReasons).toEqual({ 'type:credit_card': 2, 'type:personal_loan': 1 });
  });

  it('CreditUsed includes both cards, TotalDebt adds the loan', () => {
    expect(metric('CreditUsed').includedAccountCount).toBe(2);
    expect(metric('TotalDebt').includedAccountCount).toBe(3);
    expect(metric('TotalDebt').includedAccountTypes.sort()).toEqual(['credit_card', 'personal_loan']);
  });

  it('AvailableCredit excludes a card with no creditLimit and says so', () => {
    const m = metric('AvailableCredit');
    expect(m.includedAccountCount).toBe(1);
    expect(m.excludedAccountCount).toBe(1);
  });

  it('reports every account for AccountCount', () => {
    expect(metric('AccountCount').displayedValue).toBe(FIXTURE_ACCOUNTS.length);
  });
});

describe('accounts provenance — fidelity to the real calculation', () => {
  it('reproduces the page reducers exactly', () => {
    const accounts = derived();
    const bank = accounts.filter((a) => ['bank_account', 'debit_card', 'cash'].includes(a.type)).reduce((s, a) => s + currentOf(a), 0);
    const used = accounts.filter((a) => a.type === 'credit_card').reduce((s, a) => s + currentOf(a), 0);
    const debt = accounts.filter((a) => ['credit_card', 'personal_loan'].includes(a.type)).reduce((s, a) => s + currentOf(a), 0);

    expect(metric('BankBalance').displayedValue).toBeCloseTo(bank, 2);
    expect(metric('CreditUsed').displayedValue).toBeCloseTo(used, 2);
    expect(metric('NetWorth').displayedValue).toBeCloseTo(bank - debt, 2);
  });

  it('does NOT modify the financial result it describes', () => {
    const accounts = derived();
    const before = JSON.stringify(accounts);
    const txBefore = JSON.stringify(FIXTURE_TRANSACTIONS);
    accountsSummaryProvenance(accounts, FIXTURE_TRANSACTIONS, ctx);
    expect(JSON.stringify(accounts)).toBe(before);
    expect(JSON.stringify(FIXTURE_TRANSACTIONS)).toBe(txBefore);
  });

  it('describes the pending/date treatment the derivation actually applies', () => {
    expect(metric('BankBalance').pendingDataTreatment).toMatch(/dated after today are excluded as forecast/);
  });

  it('states the isActive limitation instead of pretending the calculation filters it', () => {
    const p = accountsSummaryProvenance(derived(), FIXTURE_TRANSACTIONS, ctx);
    expect(p.limitations.join(' ')).toMatch(/isActive == true at the repository/);
  });

  it('carries the calculation name, version and trace id onto every metric', () => {
    const p = accountsSummaryProvenance(derived(), FIXTURE_TRANSACTIONS, ctx);
    for (const m of p.metrics) {
      expect(m.calculationName).toBe(CALCULATION_NAME);
      expect(m.calculationVersion).toBe('v1');
      expect(m.traceId).toBe(ctx.traceId);
      expect(Date.parse(m.asOf)).not.toBeNaN();
    }
  });
});

describe('accounts provenance — last sync', () => {
  it('prefers the account updatedAt written by the sync re-anchor', () => {
    const accounts = derived().map((a, i) =>
      i === 0 ? ({ ...a, updatedAt: { toDate: () => new Date('2026-08-01T23:45:00Z') } } as unknown as PaymentAccount) : a
    );
    const { at, source } = lastSourceSync(accounts, FIXTURE_TRANSACTIONS);
    expect(at).toBe('2026-08-01T23:45:00.000Z');
    expect(source).toMatch(/updatedAt/);
  });

  it('falls back to the newest bank-feed transaction and labels the fallback', () => {
    const { at, source } = lastSourceSync(derived(), FIXTURE_TRANSACTIONS);
    expect(at).toBe('2020-02-03T00:00:00.000Z'); // newest row with a non-manual source
    expect(source).toMatch(/bank-feed transaction/);
  });

  it('reports unavailable rather than inventing a timestamp', () => {
    const manualOnly = FIXTURE_TRANSACTIONS.map((t) => ({ ...t, sources: ['manual'] }));
    const { at, source } = lastSourceSync(derived(), manualOnly);
    expect(at).toBeNull();
    expect(source).toMatch(/unavailable/);
  });

  it('marks a very old sync as stale', () => {
    const p = accountsSummaryProvenance(derived(), FIXTURE_TRANSACTIONS, { ...ctx, now: Date.parse('2026-08-02T00:00:00Z') });
    expect(p.staleness).toBe('stale');
  });

  it('marks a recent sync as fresh', () => {
    const recent = FIXTURE_TRANSACTIONS.map((t) => (t.id === 'fx-t3' ? { ...t, date: '2026-08-01T20:00:00.000Z' } : t));
    const p = accountsSummaryProvenance(derived(), recent, { ...ctx, now: Date.parse('2026-08-02T00:00:00Z') });
    expect(p.staleness).toBe('fresh');
  });
});

describe('accounts provenance — privacy', () => {
  it('never contains a full account number, and masks the last four', () => {
    const serialized = JSON.stringify(accountsSummaryProvenance(derived(), FIXTURE_TRANSACTIONS, ctx));
    expect(serialized).not.toMatch(/\b\d{12,19}\b/);
    expect(serialized).toContain('****4242');
    expect(serialized).not.toMatch(/"4242"/);
  });

  it('carries no transaction titles, merchants or descriptions', () => {
    const serialized = JSON.stringify(accountsSummaryProvenance(derived(), FIXTURE_TRANSACTIONS, ctx));
    for (const t of FIXTURE_TRANSACTIONS) expect(serialized).not.toContain(t.title);
  });
});
