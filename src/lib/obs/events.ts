/**
 * The structured diagnostic event: one shape, queryable properties, no free-text
 * "message" field. Everything that wants to say something about the Accounts flow
 * says it here, and everything here goes through `redact()` before it exists.
 */

import { redact } from './redact';

export type Severity = 'debug' | 'info' | 'warn' | 'error';
export type ResultStatus = 'ok' | 'error' | 'stale' | 'empty';
export type EventCategory = 'activity' | 'span' | 'request' | 'provenance' | 'diagnostic';

export interface DiagEvent {
  timestamp: string;
  environment: string;
  application: string;
  eventName: string;
  eventCategory: EventCategory;
  severity: Severity;
  traceId: string;
  spanId?: string;
  parentSpanId?: string;
  requestId?: string;
  sessionId?: string;
  userIdHash?: string;
  route?: string;
  component?: string;
  endpoint?: string;
  operation?: string;
  service?: string;
  repository?: string;
  dataSource?: string;
  durationMs?: number;
  resultStatus?: ResultStatus;
  recordCount?: number;
  lastSyncAt?: string;
  calculationName?: string;
  calculationVersion?: string;
  metadata?: Record<string, unknown>;
}

export type DiagEventInput =
  Omit<DiagEvent, 'timestamp' | 'environment' | 'application' | 'severity' | 'eventCategory'>
  & Partial<Pick<DiagEvent, 'timestamp' | 'environment' | 'application' | 'severity' | 'eventCategory'>>;

export const APPLICATION = 'cashflow-forecast';

const LEVELS: Record<Severity, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function environment(): string {
  return process.env.NEXT_PUBLIC_OBS_ENV || process.env.NODE_ENV || 'development';
}

/**
 * Off in production unless explicitly switched on. Diagnostics that cost nothing when
 * nobody is looking is the only kind that survives contact with a production budget.
 */
function threshold(): number {
  const configured = process.env.NEXT_PUBLIC_OBS_LEVEL as Severity | 'off' | undefined;
  if (configured === 'off') return Infinity;
  if (configured && configured in LEVELS) return LEVELS[configured];
  return environment() === 'production' ? Infinity : LEVELS.debug;
}

export const isEnabled = () => threshold() !== Infinity;

// --- session + user correlation ------------------------------------------------

/**
 * FNV-1a. Correlation only — it exists so two events can be recognised as the same
 * person without the uid appearing in a log. Not a security control.
 */
export function hashId(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

let sessionId: string | undefined;
export function getSessionId(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  if (sessionId) return sessionId;
  try {
    const key = 'obs_session_id';
    sessionId = window.sessionStorage.getItem(key) ?? undefined;
    if (!sessionId) {
      sessionId = Math.random().toString(36).slice(2, 10);
      window.sessionStorage.setItem(key, sessionId);
    }
  } catch {
    sessionId = 'nosession';
  }
  return sessionId;
}

let userIdHash: string | undefined;
/** Called once by the Accounts hook when the signed-in user is known. */
export function setUser(uid: string | null | undefined): void {
  userIdHash = uid ? hashId(uid) : undefined;
}

// --- sinks ---------------------------------------------------------------------

const RING_MAX = 300; // bounded: a diagnostic buffer is not a database
const ring: DiagEvent[] = [];

/** Everything this browser context has recorded, newest last. Bounded. */
export const recentEvents = (): DiagEvent[] => [...ring];
export const eventsForTrace = (traceId: string): DiagEvent[] => ring.filter((e) => e.traceId === traceId);
export const clearEvents = (): void => { ring.length = 0; };

let queue: DiagEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_AT = 20;
const FLUSH_MS = 1000;

/** Ships the queue to the dev-only diagnostics endpoint. Never runs in production. */
export async function flush(): Promise<void> {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  const batch = queue;
  queue = [];
  if (!batch.length || typeof window === 'undefined' || environment() === 'production') return;
  if (typeof fetch !== 'function') return;
  try {
    await fetch('/api/diagnostics/trace', {
      method: 'POST',
      keepalive: true,
      headers: { 'content-type': 'application/json', traceparent: `00-${batch[0].traceId}-${batch[0].spanId ?? '0'.repeat(16)}-01` },
      body: JSON.stringify({ events: batch }),
    });
  } catch {
    // A diagnostics sink must never break the page it is diagnosing.
  }
}

function enqueue(event: DiagEvent): void {
  queue.push(event);
  if (queue.length >= FLUSH_AT) { void flush(); return; }
  if (!flushTimer) flushTimer = setTimeout(() => { void flush(); }, FLUSH_MS);
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => { void flush(); });
}

/**
 * Record one diagnostic event: redact → ring buffer → console (dev) → dev endpoint.
 * Synchronous and allocation-light; the network hop is batched and never awaited by
 * the caller, so nothing in the request path waits on diagnostics.
 */
export function emit(input: DiagEventInput): DiagEvent | null {
  const severity = input.severity ?? 'info';
  if (LEVELS[severity] < threshold()) return null;

  const event = redact({
    timestamp: input.timestamp ?? new Date().toISOString(),
    environment: input.environment ?? environment(),
    application: input.application ?? APPLICATION,
    eventCategory: input.eventCategory ?? 'activity',
    severity,
    sessionId: input.sessionId ?? getSessionId(),
    userIdHash: input.userIdHash ?? userIdHash,
    ...input,
  }) as DiagEvent;

  ring.push(event);
  if (ring.length > RING_MAX) ring.shift();

  // Console is a DEVELOPER sink: on in `next dev`, silent under test (where the ring
  // buffer is what assertions read) and unreachable in production.
  if (typeof console !== 'undefined' && environment() === 'development') {
    const line = severity === 'error' ? console.error : severity === 'warn' ? console.warn : console.debug;
    line.call(console, '[obs]', JSON.stringify(event));
  }

  if (typeof window !== 'undefined') enqueue(event);
  return event;
}
