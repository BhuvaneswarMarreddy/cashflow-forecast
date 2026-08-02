/**
 * Development/Test-only diagnostic endpoint.
 *
 *   POST /api/diagnostics/trace          ingest a sanitized browser event batch
 *   GET  /api/diagnostics/trace?traceId= read one operation back, correlated
 *   GET  /api/diagnostics/trace          list the trace ids currently held
 *
 * In production every method returns 404 — the route is not "protected", it does not
 * exist. Proven by src/__tests__/obs-diagnostics-route.test.ts.
 */

import { NextRequest, NextResponse } from 'next/server';
import { redact } from '@/lib/obs/redact';
import { DiagEvent, APPLICATION, environment } from '@/lib/obs/events';
import { continueOrStart } from '@/lib/obs/trace';
import * as store from '@/lib/obs/store';

const notFound = () => new NextResponse('Not Found', { status: 404 });

/** The single gate. Development and test only; anything else does not exist. */
function enabled(): boolean {
  const env = environment();
  return env === 'development' || env === 'test';
}

const MAX_BATCH = 200;

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!enabled()) return notFound();

  const ctx = continueOrStart(request.headers.get('traceparent'));
  const receivedAt = new Date().toISOString();

  let events: DiagEvent[] = [];
  try {
    const body = await request.json();
    const raw = Array.isArray(body?.events) ? body.events : [];
    events = (redact(raw.slice(0, MAX_BATCH)) as DiagEvent[]).filter((e) => e && typeof e.traceId === 'string');
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400, headers: { 'x-trace-id': ctx.traceId } });
  }

  // The backend's own evidence for this operation, under the SAME trace id the
  // browser used. This is what proves browser↔server correlation in the Playwright test.
  const serverEvent: DiagEvent = {
    timestamp: receivedAt,
    environment: environment(),
    application: APPLICATION,
    eventName: 'Diagnostics.Ingested',
    eventCategory: 'request',
    severity: 'info',
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    endpoint: 'POST /api/diagnostics/trace',
    operation: 'DiagnosticsIngest',
    service: 'DiagnosticsEndpoint',
    dataSource: 'InMemoryTraceStore',
    resultStatus: 'ok',
    recordCount: events.length,
    metadata: { eventNames: [...new Set(events.map((e) => e.eventName))] },
  };

  store.record([...events, serverEvent]);
  return NextResponse.json(
    { accepted: events.length, traceId: ctx.traceId },
    { headers: { 'x-trace-id': ctx.traceId } }
  );
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!enabled()) return notFound();

  const traceId = request.nextUrl.searchParams.get('traceId');
  if (!traceId) {
    return NextResponse.json({ environment: environment(), traces: store.list() });
  }

  const events = store.get(traceId);
  const spans = events.filter((e) => e.eventCategory === 'span');
  const provenance = events.filter((e) => e.eventCategory === 'provenance').map((e) => e.metadata?.provenance);

  return NextResponse.json(
    redact({
      traceId,
      application: APPLICATION,
      environment: environment(),
      eventCount: events.length,
      found: events.length > 0,
      summary: {
        routes: [...new Set(events.map((e) => e.route).filter(Boolean))],
        operations: [...new Set(events.map((e) => e.operation).filter(Boolean))],
        layers: {
          frontend: events.filter((e) => e.component).length,
          backend: events.filter((e) => e.endpoint).length,
          repository: events.filter((e) => e.repository).length,
        },
        totalDurationMs: spans.reduce((s, e) => s + (e.durationMs ?? 0), 0),
        errors: events.filter((e) => e.severity === 'error').length,
      },
      provenance,
      events,
    }),
    { headers: { 'x-trace-id': traceId } }
  );
}

export async function DELETE(): Promise<NextResponse> {
  if (!enabled()) return notFound();
  store.clear();
  return NextResponse.json({ cleared: true });
}
