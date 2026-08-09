/**
 * INV-1. reconcile() computes the only independent accuracy measurement in the
 * system — entered/provider balance minus derived balance — and throws it away.
 * After a re-anchor the two agree by construction, so this is the ONLY moment
 * the comparison exists.
 */
import { reconcile, driftStatus } from '@/lib/accounts';
import { PaymentAccount } from '@/types';

const anchored = { id: 'a', name: 'Chase', type: 'bank_account', provider: 'chase', color: '#000', isActive: true, openingBalance: 100, openingDate: '2026-01-01' } as PaymentAccount;
const unanchored = { ...anchored, openingDate: undefined };
const CTX = { includePending: false, providerCheckedAt: '2026-08-08T13:05:00Z', source: 'user' as const };
const NOW = '2026-08-08';
const LAST_SLOT = '2026-08-08T13:00:00Z';

describe('reconcile drift observation (INV-1)', () => {
  it('records an exact-cent drift', () => {
    const { driftCents, observation } = reconcile(anchored, 9235.00, 8770.00, NOW, CTX);
    expect(driftCents).toBe(46500);
    expect(observation.driftCents).toBe(46500);
    expect(observation.enteredCents).toBe(923500);
    expect(observation.derivedCents).toBe(877000);
    expect(observation.anchored).toBe(true);
    expect(observation.includePending).toBe(false);
  });

  it('records the observation even when the drift is zero', () => {
    const { driftCents, observation } = reconcile(anchored, 9235.00, 9235.00, NOW, CTX);
    expect(driftCents).toBe(0);
    expect(observation.driftCents).toBe(0);
  });

  it('marks an unanchored account as unanchored, never as passing', () => {
    const { observation } = reconcile(unanchored, 9235.00, 1200.00, NOW, CTX);
    expect(observation.anchored).toBe(false);
    expect(driftStatus(observation, LAST_SLOT)).toBe('NOT_APPLICABLE');
  });
});

describe('driftStatus', () => {
  const obs = (over: Partial<ReturnType<typeof reconcile>['observation']>) =>
    ({ accountId: 'a', at: '2026-08-08T13:05:00Z', enteredCents: 0, derivedCents: 0,
       driftCents: 0, includePending: false, anchored: true, source: 'user' as const,
       providerCheckedAt: '2026-08-08T13:05:00Z', ...over });

  it('PASS when an anchored account reconciles exactly', () => {
    expect(driftStatus(obs({ driftCents: 0 }), LAST_SLOT)).toBe('PASS');
  });

  it('VIOLATION when it does not and the provider data is fresh', () => {
    expect(driftStatus(obs({ driftCents: 1 }), LAST_SLOT)).toBe('VIOLATION');
  });

  it('STALE_INPUT when the provider was last checked before the latest slot', () => {
    expect(driftStatus(obs({ driftCents: 1, providerCheckedAt: '2026-08-05T07:00:00Z' }), LAST_SLOT))
      .toBe('STALE_INPUT');
  });

  it('NOT_APPLICABLE beats everything for an unanchored account', () => {
    expect(driftStatus(obs({ driftCents: 999, anchored: false }), LAST_SLOT)).toBe('NOT_APPLICABLE');
  });
});
