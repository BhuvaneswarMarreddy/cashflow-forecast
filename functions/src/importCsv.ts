/**
 * importCsv — one CSV in, the owner's ledger updated, from any client.
 *
 * The parsing is NOT reimplemented here. `@/lib/csv-import` is the same module
 * the browser's import modal runs, compiled into this bundle by
 * `functions/tsconfig.json`; so is `@/lib/fingerprint`, which decides whether a
 * row is new or an enrichment of one already stored. Two importers would mean
 * one file producing two different ledgers depending on which client opened it,
 * and the sign conventions alone (Amex and Discover post charges POSITIVE) are
 * not worth getting right twice.
 *
 * This exists because Apple Card has no aggregator path anywhere and Synchrony's
 * Plaid integration is unreliable — a statement import is the only route to
 * those accounts, and it should not require a laptop.
 */

import { getFirestore, Timestamp, type WriteBatch } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';

import {
  CREATE_ACCOUNT,
  CSV_SOURCE,
  detectAccountFromFilename,
  inferAccountFromCsv,
  inferAccountType,
  matchAccountByName,
  parseCsv,
} from '@/lib/csv-import';
import { findTwin, fingerprintOfRow, mergeFields } from '@/lib/fingerprint';
import type { PaymentAccount, Transaction } from '@/types';

/** Firestore's own ceiling is 500 operations per batch. */
const BATCH_LIMIT = 450;

/**
 * Guards against someone pasting a 200MB file into a callable whose request
 * body is capped anyway — a clear message beats a truncated parse.
 */
const MAX_BYTES = 8 * 1024 * 1024;

interface Request {
  content?: string;
  filename?: string;
}

const toIso = (value: unknown): string =>
  value instanceof Timestamp ? value.toDate().toISOString() : String(value ?? '');

export const importCsv = onCall({ cors: true, memory: '512MiB', timeoutSeconds: 300 }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in to import.');
  }

  const { content, filename } = (request.data ?? {}) as Request;
  if (!content) {
    throw new HttpsError('invalid-argument', 'No file contents.');
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) {
    throw new HttpsError('invalid-argument', 'That file is too large to import in one go.');
  }

  const db = getFirestore();
  const user = db.collection('users').doc(request.auth.uid);
  const userDocEarly = await user.get();

  // `parseCsv` builds each date with `new Date(y, m-1, d)` — LOCAL midnight,
  // matching every consumer, which reads it back with local-time date maths. In
  // a Cloud Function "local" is UTC, so a row dated 1 Aug was stored as
  // 2026-08-01T00:00:00Z and rendered as 31 July for an owner in Chicago. The
  // browser produces the owner's local midnight; this makes the server agree.
  // Set unconditionally. Guarding on truthiness left a warm instance carrying
  // the previous invocation's zone, and an owner document written before
  // `timezone` was persisted silently fell back to the runtime's UTC.
  // ponytail: process-global TZ, single-tenant app. Pass the zone into
  // parseCsv if this ever serves two owners from one instance.
  const timezone = (userDocEarly.data()?.settings as { timezone?: string } | undefined)?.timezone;
  process.env.TZ = timezone || 'America/Chicago';

  const { rows, error } = parseCsv(content);
  if (error) throw new HttpsError('invalid-argument', error);
  if (rows.length === 0) {
    return { parsed: 0, imported: 0, enriched: 0, skipped: 0, unchanged: 0, createdAccounts: [] };
  }

  const [accountsSnap, transactionsSnap] = await Promise.all([
    user.collection('accounts').where('isActive', '==', true).get(),
    user.collection('transactions').get(),
  ]);

  const accounts: PaymentAccount[] = accountsSnap.docs.map(
    (d) => ({ id: d.id, ...d.data() }) as PaymentAccount,
  );
  const existing: Transaction[] = transactionsSnap.docs.map((d) => {
    const data = d.data();
    return { ...data, id: d.id, date: toIso(data.date) } as Transaction;
  });

  const valid = rows.filter((r) => r.isValid);
  // Rows already imported are SKIPPED, never rewritten, so a category the owner
  // corrected by hand survives every future import of the same export.
  const alreadyImported = new Set(existing.map((t) => t.id));
  const fresh = valid.filter((r) => !alreadyImported.has(r.id));

  const batches: WriteBatch[] = [db.batch()];
  let ops = 0;
  const write = (ref: FirebaseFirestore.DocumentReference, data: Record<string, unknown>) => {
    if (ops >= BATCH_LIMIT) {
      batches.push(db.batch());
      ops = 0;
    }
    // Stripped HERE, not at each call site. One undefined value rejects the
    // whole batch, and the call that forgot it was the account create — where
    // `lastFourDigits` is undefined for any label without digits, "Apple Card"
    // being the exact case this feature exists for.
    batches[batches.length - 1]!.set(ref, stripUndefined(data), { merge: true });
    ops += 1;
  };

  // ── Auto-create the accounts the file mentions and the owner does not have ──
  // Defaulting to create rather than import-unlinked: "just give it the CSV" is
  // the whole point, and an unlinked row contributes to no balance at all.
  const labels = [...new Set(valid.map((r) => r.csvAccount).filter(Boolean))];
  const fromFilename = detectAccountFromFilename(filename ?? '', accounts);
  const resolved = new Map<string, PaymentAccount>();
  const createdAccounts: string[] = [];

  for (const label of labels) {
    // The filename only stands in when the file describes ONE account — in a
    // multi-account export it would attribute an unrecognised label to whatever
    // the filename hinted at.
    const match = matchAccountByName(label, accounts) ?? (labels.length === 1 ? fromFilename : null);
    if (match) {
      resolved.set(label, match);
      continue;
    }
    const spec = { ...inferAccountFromCsv(label), type: inferAccountType(label) };
    const ref = user.collection('accounts').doc();
    // stripUndefined, NOT a raw spread: `inferAccountFromCsv` leaves
    // `lastFourDigits` undefined for any label with no digits in it — "Apple
    // Card" being the exact case this feature exists for — and one undefined
    // value makes Firestore reject the whole batch, so a single such label
    // aborted the entire import.
    write(ref, { ...spec, createdAt: Timestamp.now(), updatedAt: Timestamp.now() });
    const created = { ...spec, id: ref.id } as PaymentAccount;
    resolved.set(label, created);
    // Added to the in-memory list so a LATER label in the same file matches it
    // instead of creating a second account. Monarch renames accounts over time,
    // so a multi-year export legitimately carries both "Apple Card (...5678)"
    // and "Apple Card".
    accounts.push(created);
    createdAccounts.push(spec.name);
  }

  // A single-account export (Chase, Discover, Apple Card) carries no Account
  // column at all, so every row has an empty label and leans on the filename.
  let fallback = fromFilename ?? undefined;
  if (labels.length === 0 && !fallback) {
    // Importing unlinked is NOT the neutral option: `fingerprint.ts` treats a
    // missing accountId as a matchable value, so an unlinked row can absorb an
    // unrelated card's row of the same amount and the real charge is never
    // written. Creating a renameable account is the safe default.
    const label = (filename ?? 'Imported account')
      .replace(/\.[^.]+$/, '')
      .replace(/[_-]+/g, ' ')
      .trim();
    const spec = { ...inferAccountFromCsv(label), type: inferAccountType(label) };
    const ref = user.collection('accounts').doc();
    write(ref, { ...spec, createdAt: Timestamp.now(), updatedAt: Timestamp.now() });
    fallback = { ...spec, id: ref.id } as PaymentAccount;
    accounts.push(fallback);
    createdAccounts.push(spec.name);
  }

  // ── Enrich or insert ───────────────────────────────────────────────────────
  // Rows whose id already exists were skipped above, so their stored documents
  // are pre-claimed: otherwise a genuinely NEW same-amount row (the second $5
  // coffee that day) would absorb one and a real expense would vanish.
  const claimed = new Set(valid.map((r) => r.id).filter((id) => alreadyImported.has(id)));
  let imported = 0;
  let enriched = 0;
  let unchanged = 0;

  for (const parsed of fresh) {
    const account = parsed.csvAccount ? resolved.get(parsed.csvAccount) : fallback;
    const row = {
      title: parsed.title,
      amount: parsed.amount,
      type: parsed.type,
      transferDirection: parsed.transferDirection,
      category: parsed.category,
      sourceCategory: parsed.sourceCategory,
      paymentMethod: account?.provider ?? parsed.paymentMethod,
      date: parsed.date,
      // Undefined rather than '' / false: the write merges, so only fields the
      // CSV genuinely carries should overwrite what is already stored.
      description: parsed.description || undefined,
      merchant: parsed.merchant,
      accountId: account?.id,
    };

    const twin = findTwin(row, existing, 3, claimed);
    if (!twin) {
      write(user.collection('transactions').doc(parsed.id), {
        ...row,
        // A Timestamp, never the ISO string. `addTransaction` and
        // `addBulkTransactions` both store `Timestamp.fromDate(...)`, and the
        // Plaid sync's dedupe scans a Firestore date RANGE — a string sorts
        // outside that range, so an imported charge stayed invisible to the
        // sync and got written a second time from the issuer's feed.
        date: Timestamp.fromDate(new Date(row.date)),
        fingerprint: fingerprintOfRow(row),
        sources: [CSV_SOURCE],
        createdAt: Timestamp.now(),
        updatedAt: Timestamp.now(),
      });
      imported += 1;
      continue;
    }

    const patch = mergeFields(twin, row, CSV_SOURCE);
    if (Object.keys(patch).length === 0) {
      unchanged += 1;
      continue;
    }
    write(user.collection('transactions').doc(twin.id), {
      ...patch,
      updatedAt: Timestamp.now(),
    });
    enriched += 1;
  }

  // Sequential, not Promise.all: a few thousand rows is several batches, and
  // firing them together is how a write burst turns into contention errors.
  for (const batch of batches) await batch.commit();

  return {
    parsed: rows.length,
    imported,
    enriched,
    unchanged,
    skipped: valid.length - fresh.length,
    invalid: rows.length - valid.length,
    createdAccounts,
  };
});

/** Firestore rejects `undefined`; the row builder above uses it to mean "absent". */
function stripUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
}

// `CREATE_ACCOUNT` is part of the shared module's contract but only the browser
// needs it (it is the "user chose to create" sentinel in the modal's dropdown);
// referenced here so the import stays honest about what this file does not use.
void CREATE_ACCOUNT;
