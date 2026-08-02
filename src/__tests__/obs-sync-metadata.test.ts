import { safeSyncProjection, safeSyncResult } from '@/lib/obs/sync-metadata';
import { FIXTURE_RAW_SYNC_DOC } from '@/lib/obs/fixtures';

const NOW = Date.parse('2026-08-02T00:00:00Z');

describe('safe sync-metadata projection', () => {
  const projected = safeSyncProjection(FIXTURE_RAW_SYNC_DOC, 'simplefinSync', NOW);

  it('NEVER exposes the SimpleFIN access URL or the Monarch session token', () => {
    const serialized = JSON.stringify(projected);
    // The VALUES must be gone entirely...
    expect(serialized).not.toContain('fixturetoken');
    expect(serialized).not.toContain('bridge.simplefin.test');
    expect(serialized).not.toContain('fixture-session-token-value');
    // ...while the field NAMES appear only as a declaration of what was withheld,
    // never as a key carrying data.
    expect(projected).not.toHaveProperty('accessUrl');
    expect(projected).not.toHaveProperty('session');
    expect(projected.withheldFields).toEqual(expect.arrayContaining(['accessUrl', 'session']));
  });

  it('is an allow-list: an unknown future secret field is dropped, not leaked', () => {
    const withNewSecret = safeSyncProjection(
      { ...FIXTURE_RAW_SYNC_DOC, brandNewCredential: 'super-secret-value' }, 'simplefinSync', NOW
    );
    expect(JSON.stringify(withNewSecret)).not.toContain('super-secret-value');
    expect(withNewSecret.withheldFields).toContain('brandNewCredential');
  });

  it('names the fields it withheld so the omission is visible', () => {
    expect(projected.withheldFields).toEqual(expect.arrayContaining(['accessUrl', 'session', 'lastSyncDate']));
  });

  it('projects the required safe fields', () => {
    expect(projected.source).toBe('simplefinSync');
    expect(projected.lastSuccessAt).toBe('2026-08-01T23:45:00.000Z');
    expect(projected.lastAttemptAt).toBe('2026-08-01T23:45:00.000Z');
    expect(projected.status).toBe('ok');
    expect(projected.staleness).toBe('fresh');
  });

  it('projects counters only — counts, never contents', () => {
    expect(projected.counters).toMatchObject({ fetched: 42, added: 7, skippedPending: 2 });
    // arrays become lengths: the names inside are account labels
    expect(projected.counters.reanchoredCount).toBe(2);
    expect(projected.counters.unmatchedAccountsCount).toBe(1);
    expect(JSON.stringify(projected)).not.toContain('Unknown Bank 1');
    expect(JSON.stringify(projected)).not.toContain('fx-checking');
  });

  it('sanitizes an error rather than echoing its payload', () => {
    const failed = safeSyncProjection(
      { ...FIXTURE_RAW_SYNC_DOC, error: 'GET https://user:leakedtoken@bridge.simplefin.test/accounts failed 403' },
      'simplefinSync', NOW
    );
    expect(failed.status).toBe('error');
    expect(failed.errorSummary).not.toContain('leakedtoken');
    expect(failed.errorSummary).toContain('[REDACTED]');
  });

  it('reports staleness honestly when the last success is old', () => {
    const stale = safeSyncProjection(FIXTURE_RAW_SYNC_DOC, 'simplefinSync', Date.parse('2026-08-10T00:00:00Z'));
    expect(stale.staleness).toBe('stale');
  });

  it('handles a missing or never-run document without inventing data', () => {
    expect(safeSyncProjection(null, 'monarchSync', NOW)).toMatchObject({ status: 'unknown', staleness: 'unknown', lastSuccessAt: null });
    expect(safeSyncProjection({}, 'monarchSync', NOW)).toMatchObject({ status: 'never-run' });
  });

  it('accepts Firestore Timestamp shapes', () => {
    const p = safeSyncProjection({ lastSuccess: { seconds: 1754091900 } }, 'monarchSync', NOW);
    expect(p.lastSuccessAt).toBe(new Date(1754091900 * 1000).toISOString());
  });
});

describe('safeSyncResult — the callable return value', () => {
  it('reduces the sync_now payload to counters and status', () => {
    const r = safeSyncResult({ added: 3, enriched: 1, pendingLive: 2, reanchored: ['a', 'b'], lastSuccess: '2026-08-01T23:45:00.000Z', error: '' });
    expect(r.counters).toMatchObject({ added: 3, enriched: 1, pendingLive: 2, reanchoredCount: 2 });
    expect(JSON.stringify(r)).not.toContain('"a"');
    expect(r.status).toBe('ok');
  });

  it('surfaces an error result', () => {
    expect(safeSyncResult({ error: 'Not configured' }).status).toBe('error');
  });
});
