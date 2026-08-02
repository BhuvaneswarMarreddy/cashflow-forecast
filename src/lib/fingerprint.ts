/**
 * Twin matching for dual-source ingest — see
 * docs/superpowers/specs/2026-08-02-dual-source-ingest.md.
 *
 * The same real-world charge arrives from the bank feed and from a Monarch CSV with
 * different ids, different posted dates and different merchant strings. Account +
 * signed cents is the only axis both sources agree on; the date is given a ±3 day
 * window because banks post on different days than the aggregator records.
 */

import { format } from 'date-fns';
import { Transaction } from '@/types';

/** What a row needs to be matched. A CSV preview row has no id yet, so not a Transaction. */
export type Fingerprintable = Pick<Transaction, 'amount' | 'type' | 'date'> &
  Partial<Pick<Transaction, 'accountId' | 'transferDirection'>>;

const DAY_MS = 86_400_000;

// A stored 'transfer' has its leg direction in a separate field; folding it into the
// type here keeps the sign rule in one expression.
const typeKey = (t: Fingerprintable): string =>
  t.type === 'transfer' && t.transferDirection ? `transfer-${t.transferDirection}` : t.type;

/**
 * Signed cents. The sign is load-bearing: a $50 refund and a $50 charge are the same
 * |amount| on the same card in the same week, and merging them erases a real expense.
 * A directionless 'transfer' counts as money leaving, matching isPositive() in classify.ts.
 */
const centsOf = (amount: number, type: string): number => {
  const cents = Math.round(Math.abs(amount) * 100);
  return type === 'income' || type === 'transfer-in' ? cents : -cents;
};

// Local calendar day, matching every other date consumer in the app (the stored ISO
// string is local midnight). A bare yyyy-MM-dd is passed through: new Date() would read
// it as UTC midnight and shift it a day back for US users.
const dayKey = (dateISO: string): string =>
  dateISO.length <= 10 ? dateISO : format(new Date(dateISO), 'yyyy-MM-dd');

// Whole days since epoch — an integer, so the window comparison is exact rather than
// off by an hour whenever DST or a timezone-less date string is in play.
const dayNumber = (dateISO: string): number =>
  Math.round(Date.parse(`${dayKey(dateISO)}T00:00:00Z`) / DAY_MS);

export const fingerprintOf = (
  accountId: string | undefined,
  amount: number,
  type: string, // income | expense | transfer | transfer-in | transfer-out
  dateISO: string
): string => `${accountId ?? 'none'}|${centsOf(amount, type)}|${dayKey(dateISO)}`;

/** fingerprintOf for a row that carries its transfer direction in its own field. */
export const fingerprintOfRow = (t: Fingerprintable): string =>
  fingerprintOf(t.accountId, t.amount, typeKey(t), t.date);

/**
 * The existing row `candidate` is a second sighting of, or null to insert it.
 *
 * ONE-TO-ONE: pass a shared `claimed` set when walking a batch and the returned row is
 * recorded in it, so two genuinely separate $5.00 coffees on one day can never collapse
 * onto a single stored row. Without that, a wrongly-merged pair silently understates
 * spending — the named risk in the spec.
 */
export function findTwin(
  candidate: Fingerprintable,
  existing: Transaction[],
  windowDays = 3,
  claimed?: Set<string>
): Transaction | null {
  const cents = centsOf(candidate.amount, typeKey(candidate));
  const day = dayNumber(candidate.date);
  let best: Transaction | null = null;
  let bestDistance = Infinity;

  for (const t of existing) {
    // Cheapest discriminators first: a 3,000-row import against 3,000 stored rows is
    // 9M comparisons, and parsing a date in each of them costs seconds.
    if ((t.accountId ?? '') !== (candidate.accountId ?? '')) continue;
    if (centsOf(t.amount, typeKey(t)) !== cents) continue;
    if (claimed?.has(t.id)) continue;
    const distance = Math.abs(dayNumber(t.date) - day);
    if (distance > windowDays) continue;
    // Nearest date wins; ties go to the earlier row so the result never depends on
    // the order Firestore happened to return.
    if (distance < bestDistance || (best && distance === bestDistance && t.date < best.date)) {
      best = t;
      bestDistance = distance;
    }
  }

  if (best) claimed?.add(best.id);
  return best;
}

// Monarch is the only source carrying real categories and cleaned merchant names, so
// its values replace what a raw bank feed wrote. Any other source only fills blanks.
const RICH_FIELDS = ['sourceCategory', 'category', 'merchant', 'title'] as const;

/**
 * The fields to write onto `existing` when enriching it from `incoming`. Empty object
 * = nothing to do, so the caller can skip the write entirely.
 *
 * amount/date/accountId are absent by construction — they are what the two rows matched
 * on. `description` keeps the raw statement text, which feeds Zelle/person attribution.
 * Anything the owner edited by hand (`userEdited.<field>`) is never overwritten.
 */
export function mergeFields(
  existing: Transaction,
  incoming: Partial<Transaction>,
  incomingSource: string
): Partial<Transaction> {
  const patch: Record<string, unknown> = {};
  const locked = (field: string) => existing.userEdited?.[field] === true;

  for (const field of RICH_FIELDS) {
    const value = incoming[field];
    if (!value || locked(field)) continue;
    if (existing[field] && incomingSource !== 'monarch') continue;
    if (existing[field] !== value) patch[field] = value;
  }

  if (incoming.description && !existing.description && !locked('description')) {
    patch.description = incoming.description;
  }

  const sources = [...new Set([...(existing.sources ?? []), incomingSource])];
  if (sources.length !== (existing.sources?.length ?? 0)) patch.sources = sources;

  return patch as Partial<Transaction>;
}
