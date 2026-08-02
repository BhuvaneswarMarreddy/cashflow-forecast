/**
 * Safe projection of the operational sync documents.
 *
 *   meta/simplefinSync   — counters, timestamps, AND an `accessUrl` credential
 *   meta/monarchSync     — counters, timestamps, AND a `session` token
 *
 * Those documents must never be handed to a client, a log line, a diagnostic
 * endpoint or a bundle as-is. This module is the ONLY sanctioned way to look at
 * them: it takes the raw document and returns a fixed, allow-listed shape. It is an
 * allow-list, not a deny-list — a new secret field added upstream is dropped by
 * default rather than leaking until someone remembers to blacklist it.
 */

import { redactString } from './redact';

export type SyncStatus = 'ok' | 'error' | 'never-run' | 'unknown';
export type SyncStaleness = 'fresh' | 'stale' | 'unknown';

export interface SafeSyncMetadata {
  source: string;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  status: SyncStatus;
  /** Counts only — never rows, never amounts, never identifiers. */
  counters: Record<string, number>;
  /** Sanitized: the error's shape, never its payload. */
  errorSummary: string | null;
  staleness: SyncStaleness;
  /** Field names present on the raw doc but deliberately not projected. */
  withheldFields: string[];
}

/** The only keys allowed out. Anything absent from these lists is withheld. */
const TIMESTAMP_KEYS = { success: ['lastSuccess'], attempt: ['lastRun', 'lastAttempt'] };
const COUNTER_KEYS = [
  'fetched', 'added', 'enriched', 'updated', 'skipped', 'skippedPending', 'skippedUnmatched',
  'skippedCsvTwin', 'skippedAlreadySynced', 'pendingLive', 'pendingCleared', 'accounts',
];
/** Array-valued fields we report the LENGTH of, never the contents (they carry account names). */
const COUNTABLE_LISTS = ['reanchored', 'unmatchedAccounts', 'ambiguousAccounts', 'untrustedBalances'];

const STALE_AFTER_HOURS = 36;

function iso(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return Number.isNaN(Date.parse(value)) ? null : new Date(value).toISOString();
  if (value instanceof Date) return value.toISOString();
  const ts = value as { toDate?: () => Date; seconds?: number };
  if (typeof ts.toDate === 'function') return ts.toDate().toISOString();
  if (typeof ts.seconds === 'number') return new Date(ts.seconds * 1000).toISOString();
  return null;
}

function first(raw: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = iso(raw[k]);
    if (v) return v;
  }
  return null;
}

/**
 * Reduce a raw sync document to the safe projection.
 *
 * `source` is the document name (`simplefinSync` / `monarchSync`) — supplied by the
 * caller so this function never has to guess from a field that might be a credential.
 */
export function safeSyncProjection(
  raw: Record<string, unknown> | null | undefined,
  source: string,
  now = Date.now()
): SafeSyncMetadata {
  const doc = raw ?? {};

  const counters: Record<string, number> = {};
  for (const k of COUNTER_KEYS) {
    const v = doc[k];
    if (typeof v === 'number' && Number.isFinite(v)) counters[k] = v;
  }
  for (const k of COUNTABLE_LISTS) {
    const v = doc[k];
    if (Array.isArray(v)) counters[`${k}Count`] = v.length;
  }

  const lastSuccessAt = first(doc, TIMESTAMP_KEYS.success);
  const lastAttemptAt = first(doc, TIMESTAMP_KEYS.attempt) ?? lastSuccessAt;

  const rawError = doc.error;
  const errorSummary = rawError
    ? redactString(String(rawError)).slice(0, 200)
    : null;

  const status: SyncStatus = errorSummary ? 'error' : lastSuccessAt ? 'ok' : raw ? 'never-run' : 'unknown';

  const staleness: SyncStaleness = lastSuccessAt
    ? now - Date.parse(lastSuccessAt) > STALE_AFTER_HOURS * 3600_000 ? 'stale' : 'fresh'
    : 'unknown';

  const projected = new Set([
    ...TIMESTAMP_KEYS.success, ...TIMESTAMP_KEYS.attempt, ...COUNTER_KEYS, ...COUNTABLE_LISTS, 'error',
  ]);

  return {
    source,
    lastSuccessAt,
    lastAttemptAt,
    status,
    counters,
    errorSummary,
    staleness,
    withheldFields: Object.keys(doc).filter((k) => !projected.has(k)).sort(),
  };
}

/**
 * Projection for the `sync_now` callable's return value, which is already a
 * whitelisted subset (functions-sync/main.py) but arrives client-side and therefore
 * still goes through the same gate before it can reach a diagnostic event.
 */
export function safeSyncResult(result: Record<string, unknown>, source = 'simplefinSync'): SafeSyncMetadata {
  return safeSyncProjection(result, source);
}
