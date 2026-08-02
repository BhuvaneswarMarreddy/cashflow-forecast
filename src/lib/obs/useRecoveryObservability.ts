'use client';

/**
 * The Flow Review vertical slice, in one hook — modelled on `useAccountsObservability`
 * per docs/observability/ADDING-A-TRACEABLE-FLOW.md:15-32, so `/flow` keeps a small diff.
 *
 * Boundaries only: the queue opening, an item being selected, a decision being confirmed,
 * an undo completing. No render logging, no hovers, no keystrokes.
 *
 * The DOMAIN events (`Refund.*`, `CardCredit.*`, `Duplicate*`, `Relation.*`) belong to the
 * modules that own them and are emitted there. This hook emits none of them a second
 * time — one namespace, one emitter.
 *
 * NEVER logged here: merchant strings, titles, descriptions, account names or numbers,
 * `lastFourDigits`, amounts as free values, the owner's typed message, the model's reply,
 * or an unhashed transaction id.
 */

import { useCallback, useEffect, useState } from 'react';
import { emit, eventsForTrace, flush, hashId, setUser } from './events';
import { getTrace, startTrace } from './trace';

const ROUTE = '/flow';
const COMPONENT = 'RecoveryReviewPanel';

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

export interface RecoveryObservability {
  traceId: string;
  trackQueueOpened: (counts: { total: number; countsByType: Record<string, number> }) => void;
  trackTransactionSelected: (info: { candidateType: string; queuePosition: number; state: string }) => void;
  trackClassificationConfirmed: (info: { candidateType: string; decisionStatus: string; confidence?: number }) => void;
  trackLinkConfirmed: (info: { candidateType: string; allocationCount: number; algorithmVersion: string; durationMs?: number }) => void;
  trackAllocationEdited: (info: { allocationCount: number; validationRejected: boolean }) => void;
  trackUndoCompleted: (info: { undoneEventName: string; durationMs: number; resultStatus: 'ok' | 'error' }) => void;
}

export function useRecoveryObservability(input: { userId?: string | null }): RecoveryObservability {
  const { userId } = input;

  // One trace per page-view operation, continuing the document's server trace when
  // middleware supplied one. A lazy state initializer rather than a ref written during
  // render: it runs exactly once, the id exists before the first callback can fire, and
  // it does not trip `react-hooks/refs` — which the repo's deploy gate blocks on.
  const [traceId] = useState<string>(() => {
    if (typeof window === 'undefined') return '';
    setUser(userId);
    return startTrace(documentTraceparent()).traceId;
  });

  useEffect(() => {
    if (!traceId) return;
    emit({
      eventName: 'MoneyReview.PageViewed',
      eventCategory: 'activity',
      traceId,
      route: ROUTE,
      component: COMPONENT,
      operation: 'MoneyReviewPageView',
    });
    // Mount only: a page view is ONE event, never one per dependency change.
    return () => { void flush(); };
  }, [traceId]);

  useEffect(() => { setUser(userId); }, [userId]);

  // Playwright and a developer console both need the id without reading a log line.
  useEffect(() => {
    if (typeof window === 'undefined' || !traceId) return;
    (window as unknown as Record<string, unknown>).__OBS__ = {
      traceId,
      route: ROUTE,
      events: () => eventsForTrace(traceId),
      flush,
    };
  }, [traceId]);

  const activity = useCallback(
    (eventName: string, metadata: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
      emit({
        eventName,
        eventCategory: 'activity',
        traceId: getTrace()?.traceId ?? traceId,
        route: ROUTE,
        component: COMPONENT,
        resultStatus: 'ok',
        metadata,
        ...extra,
      });
    },
    [traceId]
  );

  return {
    traceId,
    trackQueueOpened: useCallback(
      (c) => activity('MoneyReview.QueueOpened', { countsByType: c.countsByType }, { recordCount: c.total }),
      [activity]
    ),
    trackTransactionSelected: useCallback(
      (i) => activity('MoneyReview.TransactionSelected', { candidateType: i.candidateType, queuePosition: i.queuePosition, state: i.state }),
      [activity]
    ),
    trackClassificationConfirmed: useCallback(
      (i) => activity('MoneyReview.ClassificationConfirmed', { candidateType: i.candidateType, decisionStatus: i.decisionStatus, confidence: i.confidence }),
      [activity]
    ),
    trackLinkConfirmed: useCallback(
      (i) =>
        activity(
          'MoneyReview.LinkConfirmed',
          { candidateType: i.candidateType, allocationCount: i.allocationCount, algorithmVersion: i.algorithmVersion },
          { durationMs: i.durationMs }
        ),
      [activity]
    ),
    trackAllocationEdited: useCallback(
      (i) => activity('MoneyReview.AllocationEdited', { allocationCount: i.allocationCount, validationRejected: i.validationRejected }),
      [activity]
    ),
    trackUndoCompleted: useCallback(
      (i) =>
        emit({
          eventName: 'MoneyReview.UndoCompleted',
          eventCategory: 'activity',
          traceId: getTrace()?.traceId ?? traceId,
          route: ROUTE,
          component: COMPONENT,
          durationMs: i.durationMs,
          resultStatus: i.resultStatus,
          metadata: { undoneEventName: i.undoneEventName },
        }),
      [traceId]
    ),
  };
}

/** Transaction ids only ever appear hashed. Re-exported so callers cannot forget. */
export const safeId = hashId;
