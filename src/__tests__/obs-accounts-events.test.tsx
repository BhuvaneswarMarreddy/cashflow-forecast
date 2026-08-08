import { POSTED_ONLY } from '@/lib/classify';
/**
 * The Accounts user-activity events, driven through the real hook.
 */

import React from 'react';
import { render, act, waitFor } from '@testing-library/react';
import { useAccountsObservability } from '@/lib/obs/useAccountsObservability';
import { clearEvents, eventsForTrace, recentEvents } from '@/lib/obs/events';
import { clearTrace } from '@/lib/obs/trace';
import { FIXTURE_ACCOUNTS, FIXTURE_TRANSACTIONS } from '@/lib/obs/fixtures';
import { withDerivedBalances } from '@/lib/forecast';

const derived = withDerivedBalances(FIXTURE_ACCOUNTS, FIXTURE_TRANSACTIONS, POSTED_ONLY);

let api: ReturnType<typeof useAccountsObservability> | null = null;

function Harness({ isLoading = false, error = null as string | null }) {
  api = useAccountsObservability({
    userId: 'fx-user',
    isLoading,
    accounts: derived,
    transactions: FIXTURE_TRANSACTIONS,
    error,
  });
  return <div data-testid="trace">{api.traceId}</div>;
}

beforeEach(() => { clearEvents(); clearTrace(); api = null; });

const names = (traceId: string) => eventsForTrace(traceId).map((e) => e.eventName);

describe('Accounts activity events', () => {
  it('emits PageViewed and LoadStarted on open', async () => {
    const { getByTestId } = render(<Harness />);
    const traceId = getByTestId('trace').textContent!;
    await waitFor(() => expect(names(traceId)).toEqual(expect.arrayContaining(['Accounts.PageViewed', 'Accounts.LoadStarted'])));
  });

  it('emits LoadCompleted once the data has settled, with the record count', async () => {
    const { getByTestId } = render(<Harness />);
    const traceId = getByTestId('trace').textContent!;
    await waitFor(() => expect(names(traceId)).toContain('Accounts.LoadCompleted'));

    const completed = eventsForTrace(traceId).find((e) => e.eventName === 'Accounts.LoadCompleted')!;
    expect(completed).toMatchObject({
      route: '/accounts',
      component: 'AccountsPage',
      traceId,
      recordCount: FIXTURE_ACCOUNTS.length,
      resultStatus: 'ok',
    });
  });

  it('emits LoadFailed with a sanitized error type instead of LoadCompleted', async () => {
    const { getByTestId } = render(<Harness error="Firestore sync failed for token eyJhbGciOi.eyJzdWIiOi.SflKxwRJSM" />);
    const traceId = getByTestId('trace').textContent!;
    await waitFor(() => expect(names(traceId)).toContain('Accounts.LoadFailed'));

    const failed = eventsForTrace(traceId).find((e) => e.eventName === 'Accounts.LoadFailed')!;
    expect(failed.severity).toBe('error');
    expect(failed.traceId).toBe(traceId);
    expect(names(traceId)).not.toContain('Accounts.LoadCompleted');
    expect(JSON.stringify(failed)).not.toContain('eyJhbGciOi');
  });

  it('every event carries event name, route and trace id', async () => {
    const { getByTestId } = render(<Harness />);
    const traceId = getByTestId('trace').textContent!;
    await waitFor(() => expect(names(traceId)).toContain('Accounts.LoadCompleted'));

    for (const e of eventsForTrace(traceId).filter((x) => x.eventCategory === 'activity')) {
      expect(e.eventName).toMatch(/^Accounts\./);
      expect(e.route).toBe('/accounts');
      expect(e.traceId).toBe(traceId);
      expect(e.timestamp).toBeTruthy();
      expect(e.sessionId).toBeTruthy();
      expect(e.userIdHash).toMatch(/^[0-9a-f]{8}$/);
    }
  });

  it('correlates the whole page operation under ONE trace id', async () => {
    const { getByTestId } = render(<Harness />);
    const traceId = getByTestId('trace').textContent!;
    await waitFor(() => expect(names(traceId)).toContain('Accounts.LoadCompleted'));
    expect(new Set(recentEvents().map((e) => e.traceId))).toEqual(new Set([traceId]));
  });

  it('records the meaningful clicks and nothing else', async () => {
    const { getByTestId } = render(<Harness />);
    const traceId = getByTestId('trace').textContent!;
    await waitFor(() => expect(api).not.toBeNull());

    act(() => {
      api!.trackRefreshClicked();
      api!.trackAccountSelected('fx-card');
      api!.trackFilterChanged('tab', 'transfers');
      api!.trackDiagnosticOpened();
      api!.trackRefreshResult({ ok: true, counts: { added: 3 } });
    });

    expect(names(traceId)).toEqual(expect.arrayContaining([
      'Accounts.RefreshClicked',
      'Accounts.AccountSelected',
      'Accounts.FilterChanged',
      'Accounts.DiagnosticExplanationOpened',
      'Accounts.RefreshCompleted',
    ]));
  });

  it('a failed refresh records the error type, not the error text', async () => {
    render(<Harness />);
    await waitFor(() => expect(api).not.toBeNull());
    act(() => { api!.trackRefreshResult({ ok: false, error: { code: 'functions/unauthenticated' } }); });

    const failed = recentEvents().find((e) => e.eventName === 'Accounts.RefreshFailed')!;
    expect(failed.metadata?.errorType).toBe('functions/unauthenticated');
    expect(failed.severity).toBe('error');
  });

  it('emits the provenance event with the calculation identity', async () => {
    const { getByTestId } = render(<Harness />);
    const traceId = getByTestId('trace').textContent!;
    await waitFor(() => expect(names(traceId)).toContain('Accounts.ProvenanceComputed'));

    const p = eventsForTrace(traceId).find((e) => e.eventName === 'Accounts.ProvenanceComputed')!;
    expect(p).toMatchObject({ calculationName: 'AccountsSummary', calculationVersion: 'v1', eventCategory: 'provenance' });
    expect(p.recordCount).toBe(FIXTURE_ACCOUNTS.length);
  });

  it('emits no events at all while still loading', () => {
    render(<Harness isLoading />);
    expect(recentEvents().filter((e) => e.eventName === 'Accounts.LoadCompleted')).toHaveLength(0);
  });

  it('contains no sensitive values anywhere in the emitted stream', async () => {
    const { getByTestId } = render(<Harness />);
    const traceId = getByTestId('trace').textContent!;
    await waitFor(() => expect(names(traceId)).toContain('Accounts.LoadCompleted'));

    const serialized = JSON.stringify(eventsForTrace(traceId));
    expect(serialized).not.toMatch(/\b\d{12,19}\b/);           // no card/account numbers
    expect(serialized).not.toContain('fixture@example.test');   // no email
    for (const t of FIXTURE_TRANSACTIONS) expect(serialized).not.toContain(t.title);
  });

  it('exposes the trace id and provenance to the page for Playwright', async () => {
    const { getByTestId } = render(<Harness />);
    const traceId = getByTestId('trace').textContent!;
    await waitFor(() => expect((window as any).__OBS__?.provenance).toBeTruthy());
    expect((window as any).__OBS__.traceId).toBe(traceId);
    expect((window as any).__OBS__.provenance.metrics.length).toBeGreaterThan(0);
  });
});
