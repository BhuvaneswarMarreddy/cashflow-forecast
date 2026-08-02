/**
 * Bounded, in-memory, development-only trace store.
 *
 * Deliberately NOT a database: it lives in the dev server process, holds a fixed
 * number of traces, and disappears on restart. Anything that needs to outlive that
 * is exported to a diagnostic bundle (scripts/diagnostics/export-trace.mjs).
 */

import { DiagEvent } from './events';

const MAX_TRACES = 50;
const MAX_EVENTS_PER_TRACE = 200;

const traces = new Map<string, DiagEvent[]>();

export function record(events: DiagEvent[]): void {
  for (const event of events) {
    if (!event?.traceId) continue;
    const list = traces.get(event.traceId) ?? [];
    if (list.length >= MAX_EVENTS_PER_TRACE) list.shift();
    list.push(event);
    // Re-insert so Map iteration order is LRU: the oldest key is the first to evict.
    traces.delete(event.traceId);
    traces.set(event.traceId, list);
  }
  while (traces.size > MAX_TRACES) {
    const oldest = traces.keys().next().value;
    if (oldest === undefined) break;
    traces.delete(oldest);
  }
}

export function get(traceId: string): DiagEvent[] {
  return [...(traces.get(traceId) ?? [])].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

/** Trace ids held right now, newest-touched last. */
export function list(): Array<{ traceId: string; eventCount: number; firstSeen: string; lastSeen: string }> {
  return [...traces.entries()].map(([traceId, events]) => {
    const stamps = events.map((e) => e.timestamp).sort();
    return { traceId, eventCount: events.length, firstSeen: stamps[0], lastSeen: stamps[stamps.length - 1] };
  });
}

export function clear(): void {
  traces.clear();
}
