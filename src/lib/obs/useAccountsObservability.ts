'use client';

/**
 * The Accounts vertical slice, in one hook, so page.tsx keeps a three-line diff.
 *
 * Instruments boundaries only — route opened, load started, load completed/failed,
 * the summary calculation, and the meaningful clicks. No render logging, no
 * per-method spans; the repository spans come from src/lib/firestore.ts and the
 * service span from UserProfileContext, and they join this trace automatically.
 */

import { useEffect, useMemo, useRef, useCallback } from 'react';
import { PaymentAccount, Transaction } from '@/types';
import { startTrace, startSpan, getTrace, errorType } from './trace';
import { emit, setUser, eventsForTrace, flush, isEnabled } from './events';
import { accountsSummaryProvenance, AccountsProvenance, CALCULATION_NAME, CALCULATION_VERSION } from './provenance';

const ROUTE = '/accounts';
const COMPONENT = 'AccountsPage';

/** The document's own trace, handed to the browser by middleware via Server-Timing. */
function documentTraceparent(): string | null {
  if (typeof performance === 'undefined') return null;
  try {
    const nav = performance.getEntriesByType('navigation')[0] as
      | (PerformanceEntry & { serverTiming?: ReadonlyArray<{ name: string; description: string }> })
      | undefined;
    return nav?.serverTiming?.find((t) => t.name === 'traceparent')?.description || null;
  } catch {
    return null;
  }
}

export interface AccountsObservability {
  traceId: string;
  provenance: AccountsProvenance | null;
  trackRefreshClicked: () => void;
  trackRefreshResult: (result: { ok: boolean; error?: unknown; counts?: Record<string, unknown> }) => void;
  trackAccountSelected: (accountId: string) => void;
  trackFilterChanged: (filter: string, value: string) => void;
  trackDiagnosticOpened: () => void;
}

export function useAccountsObservability(input: {
  userId?: string | null;
  isLoading: boolean;
  accounts: PaymentAccount[];
  transactions: Transaction[];
  error?: string | null;
}): AccountsObservability {
  const { userId, isLoading, accounts, transactions, error } = input;

  // One trace per page-view operation. Continues the document's server trace when
  // middleware supplied one, so the page load and everything under it share an id.
  const traceRef = useRef<string | null>(null);
  const pageSpan = useRef<ReturnType<typeof startSpan> | null>(null);
  const settled = useRef(false);

  if (traceRef.current === null && typeof window !== 'undefined') {
    setUser(userId);
    traceRef.current = startTrace(documentTraceparent()).traceId;
  }
  const traceId = traceRef.current ?? '';

  useEffect(() => {
    if (!traceId) return;
    emit({
      eventName: 'Accounts.PageViewed',
      eventCategory: 'activity',
      traceId,
      route: ROUTE,
      component: COMPONENT,
      operation: 'AccountsPageView',
    });
    emit({
      eventName: 'Accounts.LoadStarted',
      eventCategory: 'activity',
      traceId,
      route: ROUTE,
      component: COMPONENT,
      operation: 'AccountsLoad',
    });
    pageSpan.current = startSpan('Accounts.Render', { route: ROUTE, component: COMPONENT });

    return () => { void flush(); };
    // Mount only: a page view is one event, not one per dependency change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [traceId]);

  useEffect(() => { setUser(userId); }, [userId]);

  // The calculation boundary. Memoised on exactly the inputs the page's own totals
  // use, so provenance is recomputed when — and only when — the numbers change.
  const provenance = useMemo(() => {
    if (!traceId || isLoading || typeof window === 'undefined' || !isEnabled()) return null;

    const serverRead = eventsForTrace(traceId).some((e) => e.repository === 'firestore.getAccounts');
    const span = startSpan('Accounts.Summarize', {
      route: ROUTE,
      component: COMPONENT,
      calculationName: CALCULATION_NAME,
      calculationVersion: CALCULATION_VERSION,
    });
    const p = accountsSummaryProvenance(accounts, transactions, {
      traceId,
      dataSource: serverRead ? 'Firestore' : 'LocalStorageCache',
      cacheStatus: serverRead ? (settled.current ? 'refill' : 'miss') : 'hit',
    });
    span.end({ recordCount: accounts.length, lastSyncAt: p.lastSourceSync ?? undefined, status: p.staleness === 'stale' ? 'stale' : 'ok' });

    emit({
      eventName: 'Accounts.ProvenanceComputed',
      eventCategory: 'provenance',
      traceId,
      route: ROUTE,
      component: COMPONENT,
      calculationName: CALCULATION_NAME,
      calculationVersion: CALCULATION_VERSION,
      recordCount: accounts.length,
      lastSyncAt: p.lastSourceSync ?? undefined,
      dataSource: p.dataSource,
      resultStatus: p.staleness === 'stale' ? 'stale' : 'ok',
      metadata: { provenance: p },
    });
    return p;
  }, [traceId, isLoading, accounts, transactions]);

  // Load completed / failed — emitted once, when the page first has something to show.
  useEffect(() => {
    if (!traceId || isLoading || settled.current) return;
    settled.current = true;

    if (error) {
      emit({
        eventName: 'Accounts.LoadFailed',
        eventCategory: 'activity',
        severity: 'error',
        traceId,
        route: ROUTE,
        component: COMPONENT,
        operation: 'AccountsLoad',
        resultStatus: 'error',
        metadata: { errorType: errorType(error) },
      });
      pageSpan.current?.end({ status: 'error', error });
    } else {
      emit({
        eventName: 'Accounts.LoadCompleted',
        eventCategory: 'activity',
        traceId,
        route: ROUTE,
        component: COMPONENT,
        operation: 'AccountsLoad',
        resultStatus: accounts.length ? 'ok' : 'empty',
        recordCount: accounts.length,
        dataSource: provenance?.dataSource,
        lastSyncAt: provenance?.lastSourceSync ?? undefined,
        metadata: { transactionCount: transactions.length, cacheStatus: provenance?.cacheStatus },
      });
      pageSpan.current?.end({ recordCount: accounts.length, status: 'ok' });
    }
    void flush();
  }, [traceId, isLoading, error, accounts.length, transactions.length, provenance]);

  // Playwright and a developer console both need the id without reading a log line.
  useEffect(() => {
    if (typeof window === 'undefined' || !traceId) return;
    (window as unknown as Record<string, unknown>).__OBS__ = {
      traceId,
      route: ROUTE,
      provenance,
      events: () => eventsForTrace(traceId),
      flush,
    };
  }, [traceId, provenance]);

  const activity = useCallback(
    (eventName: string, metadata?: Record<string, unknown>) => {
      emit({ eventName, eventCategory: 'activity', traceId: getTrace()?.traceId ?? traceId, route: ROUTE, component: COMPONENT, metadata });
    },
    [traceId]
  );

  return {
    traceId,
    provenance,
    trackRefreshClicked: useCallback(() => activity('Accounts.RefreshClicked'), [activity]),
    trackRefreshResult: useCallback(
      (r: { ok: boolean; error?: unknown; counts?: Record<string, unknown> }) =>
        emit({
          eventName: r.ok ? 'Accounts.RefreshCompleted' : 'Accounts.RefreshFailed',
          eventCategory: 'activity',
          severity: r.ok ? 'info' : 'error',
          traceId: getTrace()?.traceId ?? traceId,
          route: ROUTE,
          component: COMPONENT,
          service: 'sync_now',
          dataSource: 'SimpleFIN/Monarch',
          resultStatus: r.ok ? 'ok' : 'error',
          metadata: r.ok ? r.counts : { errorType: errorType(r.error) },
        }),
      [traceId]
    ),
    trackAccountSelected: useCallback((accountId: string) => activity('Accounts.AccountSelected', { accountId }), [activity]),
    trackFilterChanged: useCallback((filter: string, value: string) => activity('Accounts.FilterChanged', { filter, value }), [activity]),
    trackDiagnosticOpened: useCallback(() => activity('Accounts.DiagnosticExplanationOpened'), [activity]),
  };
}
