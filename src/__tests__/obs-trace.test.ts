import {
  parseTraceparent, formatTraceparent, continueOrStart, startTrace, getTrace, clearTrace,
  startSpan, newTraceId, newSpanId, errorType,
} from '@/lib/obs/trace';
import { clearEvents, eventsForTrace, recentEvents } from '@/lib/obs/events';

beforeEach(() => { clearTrace(); clearEvents(); });

describe('W3C traceparent', () => {
  it('generates ids of the right shape', () => {
    expect(newTraceId()).toMatch(/^[0-9a-f]{32}$/);
    expect(newSpanId()).toMatch(/^[0-9a-f]{16}$/);
    expect(newTraceId()).not.toBe(newTraceId());
  });

  it('parses a valid header', () => {
    const ctx = parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
    expect(ctx).toEqual({ traceId: '4bf92f3577b34da6a3ce929d0e0e4736', spanId: '00f067aa0ba902b7', sampled: true });
  });

  it('rejects malformed, all-zero and absent headers', () => {
    expect(parseTraceparent(null)).toBeNull();
    expect(parseTraceparent('')).toBeNull();
    expect(parseTraceparent('garbage')).toBeNull();
    expect(parseTraceparent('00-' + '0'.repeat(32) + '-00f067aa0ba902b7-01')).toBeNull();
    expect(parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-' + '0'.repeat(16) + '-01')).toBeNull();
    expect(parseTraceparent('99-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')).toBeNull();
  });

  it('round-trips through format', () => {
    const header = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    expect(formatTraceparent(parseTraceparent(header)!)).toBe(header);
  });
});

describe('correlation', () => {
  it('creates a trace when the request carries none', () => {
    const ctx = continueOrStart(null);
    expect(ctx.traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('CONTINUES an inbound trace id and starts a new span under it', () => {
    const inbound = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    const ctx = continueOrStart(inbound);
    expect(ctx.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(ctx.spanId).not.toBe('00f067aa0ba902b7');
  });

  it('parallel requests never share a trace', () => {
    const traces = Array.from({ length: 50 }, () => continueOrStart(null).traceId);
    expect(new Set(traces).size).toBe(50);
  });

  it('a span emits one event carrying the trace id, span id and parent', () => {
    const { traceId } = startTrace();
    const span = startSpan('Test.Operation', { repository: 'test.repo', dataSource: 'Fixture' });
    span.end({ recordCount: 3 });

    const events = eventsForTrace(traceId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventName: 'Test.Operation',
      eventCategory: 'span',
      traceId,
      parentSpanId: getTrace()!.spanId,
      repository: 'test.repo',
      dataSource: 'Fixture',
      recordCount: 3,
      resultStatus: 'ok',
    });
    expect(events[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('end() is idempotent — a double end does not double-log', () => {
    const { traceId } = startTrace();
    const span = startSpan('Test.Once');
    span.end();
    span.end({ status: 'error' });
    expect(eventsForTrace(traceId)).toHaveLength(1);
  });

  it('preserves correlation across await boundaries', async () => {
    const { traceId } = startTrace();
    const span = startSpan('Test.Async');
    await new Promise((r) => setTimeout(r, 5));
    span.end();
    expect(eventsForTrace(traceId)[0].traceId).toBe(traceId);
    expect(eventsForTrace(traceId)[0].durationMs).toBeGreaterThanOrEqual(4);
  });

  it('interleaved async spans stay on the same page trace but keep distinct span ids', async () => {
    const { traceId } = startTrace();
    const a = startSpan('Test.A');
    const b = startSpan('Test.B');
    await Promise.all([
      new Promise((r) => setTimeout(() => { b.end(); r(null); }, 1)),
      new Promise((r) => setTimeout(() => { a.end(); r(null); }, 10)),
    ]);
    const events = eventsForTrace(traceId);
    expect(events).toHaveLength(2);
    expect(new Set(events.map((e) => e.spanId)).size).toBe(2);
    expect(events.every((e) => e.traceId === traceId)).toBe(true);
  });

  it('a new page view starts a NEW trace, not a continuation of the old one', () => {
    const first = startTrace().traceId;
    const second = startTrace().traceId;
    expect(second).not.toBe(first);
  });

  it('an error span records a sanitized error type, never the message', () => {
    const { traceId } = startTrace();
    startSpan('Test.Fails').end({ status: 'error', error: new Error('token eyJhbGciOi.eyJzdWIiOi.SflKxwRJSM leaked') });
    const [event] = eventsForTrace(traceId);
    expect(event.severity).toBe('error');
    expect(event.resultStatus).toBe('error');
    expect(event.metadata?.errorType).toBe('Error');
    expect(JSON.stringify(event)).not.toContain('eyJhbGciOi');
  });

  it('the span header propagates the trace to an outbound request', () => {
    startTrace();
    const span = startSpan('Test.Outbound');
    const parsed = parseTraceparent(span.header())!;
    expect(parsed.traceId).toBe(span.traceId);
    expect(parsed.spanId).toBe(span.spanId);
  });
});

describe('errorType', () => {
  it('prefers a Firebase error code, then the class name', () => {
    expect(errorType({ code: 'permission-denied' })).toBe('permission-denied');
    expect(errorType(new TypeError('x'))).toBe('TypeError');
    expect(errorType('boom')).toBe('string');
  });
});

describe('event volume', () => {
  it('the ring buffer is bounded', () => {
    startTrace();
    for (let i = 0; i < 400; i++) startSpan(`Test.Span${i}`).end();
    expect(recentEvents().length).toBeLessThanOrEqual(300);
  });
});
