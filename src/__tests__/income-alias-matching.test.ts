/**
 * The alias escape hatch, pinned to the real failure it exists for.
 *
 * A source named after the EMPLOYER ("Canton Group") never appears verbatim on the
 * bank line, which reads "CANTON PAYROLL PPD" / "CANTON DEPOSIT PPD". Name-only
 * matching therefore yields zero matches and the owner's income silently reads $0
 * with no in-app way to fix it. `matchAliases` is that fix; these tests make sure
 * it stays wired.
 *
 * All names and amounts here are invented.
 */

import { matchApprovedSources, resolveInflow } from '@/lib/classify';
import { IncomeSource, Transaction } from '@/types';

const source = (o: Partial<IncomeSource> & { id: string; name: string }): IncomeSource => ({
  amount: 3200, frequency: 'biweekly', isActive: true, ...o,
});

const deposit = (title: string, amount = 3200): Transaction => ({
  id: `t-${title}`, title, amount, type: 'income', category: 'other',
  paymentMethod: 'chase', accountId: 'chk', date: '2026-07-15T00:00:00.000Z',
});

// The shapes actually seen on the bank feed, sanitized.
const PAYROLL = deposit('CANTON PAYROLL PPD');
const DIRECT_DEPOSIT = deposit('CANTON DEPOSIT PPD');
const DES = deposit('CANTON DES');

describe('the employer-name gap this feature would otherwise ship', () => {
  it('a source named for the employer does NOT match the bank line by name alone', () => {
    const employerNamed = [source({ id: 's1', name: 'Canton Group' })];
    expect(matchApprovedSources(PAYROLL, employerNamed)).toHaveLength(0);
    expect(matchApprovedSources(DIRECT_DEPOSIT, employerNamed)).toHaveLength(0);
    // ...and that is exactly how income reaches $0.
    expect(resolveInflow(PAYROLL, { sources: employerNamed }).meaning).toBe('unknown_inflow');
  });

  it('one alias rescues every shape of the same payroll line', () => {
    const withAlias = [source({ id: 's1', name: 'Canton Group', matchAliases: ['canton'] })];
    for (const row of [PAYROLL, DIRECT_DEPOSIT, DES]) {
      expect(matchApprovedSources(row, withAlias)).toHaveLength(1);
      expect(resolveInflow(row, { sources: withAlias }).meaning).toBe('earned_income');
    }
  });

  it('several aliases cover several descriptors without matching anything else', () => {
    const withAliases = [source({
      id: 's1', name: 'Canton Group', matchAliases: ['canton payroll', 'canton deposit'],
    })];
    expect(matchApprovedSources(PAYROLL, withAliases)).toHaveLength(1);
    expect(matchApprovedSources(DIRECT_DEPOSIT, withAliases)).toHaveLength(1);
    // A different descriptor is NOT swept in — aliases stay narrow.
    expect(matchApprovedSources(DES, withAliases)).toHaveLength(0);
    // An unrelated deposit stays unknown.
    expect(matchApprovedSources(deposit('ZELLE FROM A FRIEND', 1800), withAliases)).toHaveLength(0);
  });

  it('matching is case-insensitive, so the owner may type it however they like', () => {
    for (const alias of ['CANTON PAYROLL', 'canton payroll', 'Canton Payroll']) {
      expect(matchApprovedSources(PAYROLL, [source({ id: 's1', name: 'x-none', matchAliases: [alias] })])).toHaveLength(1);
    }
  });

  it('the name still works as an alias when the name IS on the bank line', () => {
    // Nobody who names the source "Canton" needs the new field at all.
    expect(matchApprovedSources(PAYROLL, [source({ id: 's1', name: 'Canton' })])).toHaveLength(1);
  });
});

describe('form parsing rules the Accounts page relies on', () => {
  // The income form splits on commas, trims, and drops fragments under 3 chars.
  const parse = (raw: string) => {
    const list = raw.split(',').map((a) => a.trim()).filter((a) => a.length >= 3);
    return list.length ? list : undefined;
  };

  it('splits and trims a comma-separated entry', () => {
    expect(parse('CANTON PAYROLL, CANTON DEPOSIT')).toEqual(['CANTON PAYROLL', 'CANTON DEPOSIT']);
  });

  it('drops blanks and 1-2 character fragments that would match half the ledger', () => {
    expect(parse('canton, , a, xy, deposit')).toEqual(['canton', 'deposit']);
  });

  it('an empty field becomes undefined, so the source falls back to its name', () => {
    expect(parse('')).toBeUndefined();
    expect(parse('  ,  ')).toBeUndefined();
    expect(parse('ab')).toBeUndefined();
  });

  it('what the form produces is what the matcher consumes', () => {
    const aliases = parse('CANTON PAYROLL, CANTON DEPOSIT')!;
    const s = [source({ id: 's1', name: 'Canton Group', matchAliases: aliases })];
    expect(resolveInflow(PAYROLL, { sources: s }).meaning).toBe('earned_income');
    expect(resolveInflow(DIRECT_DEPOSIT, { sources: s }).meaning).toBe('earned_income');
  });
});
