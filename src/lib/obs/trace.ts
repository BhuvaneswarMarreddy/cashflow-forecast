/**
 * W3C trace-context (https://www.w3.org/TR/trace-context/) for a Next.js app whose
 * "backend" for the Accounts flow is the Firebase SDK running in the browser.
 *
 * ponytail: the wire format is the standard one (16-byte trace id, 8-byte span id,
 * `traceparent: 00-<trace>-<span>-<flags>`), the implementation is 70 lines instead
 * of the ~8 OpenTelemetry packages, because none of those packages can instrument
 * the client-side Firestore reads that ARE this flow. Swap in `@vercel/otel` +
 * `@opentelemetry/api` when a second service appears — the ids stay compatible.
 */

import { emit } from './events';

const HEX = '0123456789abcdef';

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(buf);
  } else {
    for (let i = 0; i < bytes; i++) buf[i] = Math.floor(Math.random() * 256);
  }
  let out = '';
  for (const b of buf) out += HEX[b >> 4] + HEX[b & 15];
  return out;
}

export const newTraceId = () => randomHex(16);
export const newSpanId = () => randomHex(8);

export interface TraceContext {
  traceId: string;
  spanId: string;
  sampled: boolean;
}

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE = '0'.repeat(32);
const ZERO_SPAN = '0'.repeat(16);

/** Parse an inbound `traceparent`. Returns null for absent/invalid/all-zero ids. */
export function parseTraceparent(header: string | null | undefined): TraceContext | null {
  if (!header) return null;
  const m = TRACEPARENT_RE.exec(header.trim().toLowerCase());
  if (!m) return null;
  const [, traceId, spanId, flags] = m;
  if (traceId === ZERO_TRACE || spanId === ZERO_SPAN) return null;
  return { traceId, spanId, sampled: (parseInt(flags, 16) & 1) === 1 };
}

export function formatTraceparent(ctx: TraceContext): string {
  return `00-${ctx.traceId}-${ctx.spanId}-${ctx.sampled ? '01' : '00'}`;
}

/** Continue an inbound trace, or start a fresh root when there is nothing to continue. */
export function continueOrStart(header: string | null | undefined): TraceContext {
  const parent = parseTraceparent(header);
  return parent
    ? { traceId: parent.traceId, spanId: newSpanId(), sampled: parent.sampled }
    : { traceId: newTraceId(), spanId: newSpanId(), sampled: true };
}

// ---------------------------------------------------------------------------
// Current trace — browser only.
//
// One operation ("open Accounts") owns one trace. Spans nest by passing the parent
// explicitly, which survives `await` for free; there is no AsyncLocalStorage on the
// client and none is needed, because a browser tab runs one operation at a time.
// Server code (middleware, route handlers) NEVER reads this: it derives its context
// from the inbound request, so parallel requests can never share a trace.
// ---------------------------------------------------------------------------

let current: TraceContext | null = null;

export function startTrace(header?: string | null): TraceContext {
  current = continueOrStart(header);
  return current;
}

export function getTrace(): TraceContext | null {
  return current;
}

/** Test-only reset so suites do not leak a trace into each other. */
export function clearTrace(): void {
  current = null;
}

export interface SpanFields {
  /** Defaults to the span name; set it when the business operation differs. */
  operation?: string;
  component?: string;
  service?: string;
  repository?: string;
  dataSource?: string;
  endpoint?: string;
  route?: string;
  calculationName?: string;
  calculationVersion?: string;
  recordCount?: number;
  lastSyncAt?: string;
  metadata?: Record<string, unknown>;
}

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  /** Close the span and emit one structured event. Safe to call once. */
  end(result?: { status?: 'ok' | 'error' | 'stale'; error?: unknown } & SpanFields): void;
  /** `traceparent` value to attach to an outbound request made inside this span. */
  header(): string;
}

/**
 * Start a child span of the current trace (starting the trace if none exists).
 * Emits exactly one event, on `end()` — a start event per span doubles the volume
 * and tells you nothing you cannot read off the completed span.
 */
export function startSpan(operation: string, fields: SpanFields = {}): Span {
  const parent = current ?? startTrace();
  const spanId = newSpanId();
  const startedAt = Date.now();
  let ended = false;

  return {
    traceId: parent.traceId,
    spanId,
    parentSpanId: parent.spanId,
    header: () => formatTraceparent({ traceId: parent.traceId, spanId, sampled: parent.sampled }),
    end(result = {}) {
      if (ended) return;
      ended = true;
      const { status = 'ok', error, ...rest } = result;
      emit({
        eventName: operation,
        eventCategory: 'span',
        severity: status === 'error' ? 'error' : 'info',
        traceId: parent.traceId,
        spanId,
        parentSpanId: parent.spanId,
        operation: fields.operation ?? operation,
        durationMs: Date.now() - startedAt,
        resultStatus: status,
        ...fields,
        ...rest,
        metadata: { ...fields.metadata, ...rest.metadata, ...(error ? { errorType: errorType(error) } : {}) },
      });
    },
  };
}

/** Sanitized error type — the class name, never the message (messages carry data). */
export function errorType(error: unknown): string {
  if (error && typeof error === 'object') {
    const code = (error as { code?: string }).code;
    if (typeof code === 'string') return code;
    if (error instanceof Error) return error.name;
    return 'ObjectError';
  }
  return typeof error;
}
