import { getFunctions, httpsCallable } from 'firebase/functions';
import { app } from '@/lib/firebase';

export interface SyncResult {
  added?: number;
  enriched?: number;
  pendingLive?: number;
  pendingCleared?: number;
  reanchored?: string[];
  unmatchedAccounts?: string[];
  /** Connections whose bank login expired: only the owner can fix these, in Link's update mode. */
  itemsNeedingRepair?: { itemId: string; institution: string; linkedAt?: string }[];
  lastSuccess?: string;
  error?: string;
}

/**
 * On-demand refresh from the banks (SimpleFIN). A callable, so Firebase verifies
 * the signed-in user and no shared secret ships in client code. Takes 10-20s —
 * it is really talking to the banks — so callers must show progress.
 */
export async function syncNow(): Promise<SyncResult> {
  const fns = getFunctions(app, 'us-central1');
  const res = await httpsCallable(fns, 'sync_now')({});
  return (res.data ?? {}) as SyncResult;
}

// ---------------------------------------------------------------------------
// Plaid Link — connect a bank (or repair an existing connection in place).
// The 10-lifetime-Item Trial rule lives server-side; this client NEVER sees an
// access token — it moves an opaque public_token from Link to the exchange
// callable and gets back only the institution name.
// ---------------------------------------------------------------------------

interface PlaidHandler {
  open: () => void;
  /** Closes Link; onExit still fires. */
  exit: (opts?: { force?: boolean }) => void;
  /** Removes Link's iframes. Not optional in practice — see ONE_AT_A_TIME below. */
  destroy: () => void;
}

interface PlaidSuccessMetadata {
  institution?: { name?: string; institution_id?: string } | null;
  accounts?: unknown[];
}

declare global {
  interface Window {
    Plaid?: {
      create: (opts: {
        token: string;
        onSuccess: (publicToken: string, metadata: PlaidSuccessMetadata) => void;
        onExit: (err: unknown) => void;
        onEvent?: (eventName: string, metadata: { institution_id?: string | null; institution_name?: string | null }) => void;
      }) => PlaidHandler;
    };
  }
}

/** A connected Item as the server lets this client see it: never a token. */
export interface LinkedInstitution {
  itemId: string;
  institution: string;
  institutionId: string;
}

export type ConnectResult =
  /** A new Item. `accountsShared` 0 means the owner ticked nothing (Schwab starts unchecked). */
  | { status: 'linked'; institution: string; itemId: string; accountsShared: number }
  /** One Item per institution (#183): nothing was created; repair `itemId` instead. */
  | { status: 'already-linked'; institution: string; itemId: string }
  /** Update mode finished on an existing Item. */
  | { status: 'repaired'; institution: string; itemId: string; accountsShared: number };

/**
 * #183: the Item already connected for the bank picked in Link. Same rule as the
 * server's existing_item_for (plaid_ingest.py): by institution_id, and by name only
 * for an Item linked before ids were stored.
 */
export function findLinkedInstitution(
  linked: readonly LinkedInstitution[],
  institutionId: string | null | undefined,
  institutionName: string | null | undefined,
): LinkedInstitution | null {
  const name = (institutionName ?? '').trim().toLowerCase();
  return linked.find((l) => l.institutionId
    ? !!institutionId && l.institutionId === institutionId
    : !!name && l.institution.trim().toLowerCase() === name) ?? null;
}

/** What the owner is told after Link, and whether a Repair button belongs beside it. */
export function describeConnect(r: ConnectResult): { message: string; repairItemId: string | null; refresh: boolean } {
  if (r.status === 'already-linked') {
    // Refresh too: a connection that exists but never synced (2026-09-15, Charles Schwab —
    // linked, then every scheduled run crashed) shows nothing until a sync runs, and
    // "already connected" with an empty list reads as "linking did nothing".
    return { message: `${r.institution} is already connected — pulling its data. Repair the connection to change which accounts are shared.`, repairItemId: r.itemId, refresh: true };
  }
  if (r.accountsShared === 0) {
    // Never an empty list that reads as "no money": say what happened and the next tap.
    return { message: 'No accounts were shared. Open the connection again and tick the accounts you want.', repairItemId: r.itemId, refresh: false };
  }
  const verb = r.status === 'repaired' ? 'updated' : 'connected';
  return { message: `${r.institution} ${verb} — pulling your data…`, repairItemId: null, refresh: true };
}

/**
 * ONE_AT_A_TIME. Plaid.create() appends its own iframes to the document; calling
 * it again without destroying the previous handler leaves TWO overlapping Link
 * instances, and the older one steals focus from the visible one — typing into
 * the phone or bank-search field then does nothing and the caret vanishes. So
 * exactly one handler exists at a time, and it is destroyed on success, on exit,
 * and before any new one is created.
 */
let activeHandler: PlaidHandler | null = null;

function closeActiveLink(): void {
  try {
    activeHandler?.destroy();
  } catch {
    // destroy() on an already-torn-down handler is not a failure worth surfacing
  }
  activeHandler = null;
}

const PLAID_LINK_SRC = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';

function loadPlaidScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.Plaid) return resolve();
    const existing = document.querySelector(`script[src="${PLAID_LINK_SRC}"]`);
    const script = (existing as HTMLScriptElement) ?? document.createElement('script');
    if (!existing) {
      script.src = PLAID_LINK_SRC;
      document.head.appendChild(script);
    }
    script.addEventListener('load', () => resolve());
    script.addEventListener('error', () => reject(new Error('Could not load Plaid Link.')));
    if (window.Plaid) resolve(); // raced: script finished between the check and here
  });
}

/**
 * Full connect flow: token -> Link popup -> exchange. Resolves with a ConnectResult,
 * or null when the user closed the popup. Pass `itemId` to REPAIR an existing
 * connection (update mode) instead of linking a new one.
 *
 * #183, one Item per institution, guarded twice:
 *  - in Link: picking a bank that is already connected closes Link at once, before
 *    the owner signs in, so no duplicate Item is ever created at Plaid;
 *  - on the server: plaid_exchange refuses a second Item for the same institution
 *    before minting a token (ALREADY_EXISTS), for anything that gets past the first.
 */
export async function connectBankWithPlaid(itemId?: string): Promise<ConnectResult | null> {
  const fns = getFunctions(app, 'us-central1');
  const tokenRes = await httpsCallable(fns, 'plaid_link_token')(itemId ? { itemId } : {});
  const { linkToken, linked = [] } = (tokenRes.data ?? {}) as { linkToken?: string; linked?: LinkedInstitution[] };
  if (!linkToken) throw new Error('No link token returned.');
  await loadPlaidScript();
  if (!window.Plaid) throw new Error('Plaid Link did not initialize.');

  closeActiveLink(); // never let two Link instances exist at once

  return new Promise((resolve, reject) => {
    let duplicate: LinkedInstitution | null = null;
    const handler = window.Plaid!.create({
      token: linkToken,
      onEvent: (eventName, metadata) => {
        if (itemId || eventName !== 'SELECT_INSTITUTION') return;
        duplicate = findLinkedInstitution(linked, metadata?.institution_id, metadata?.institution_name);
        if (duplicate) handler.exit({ force: true });
      },
      onSuccess: (publicToken, metadata) => {
        closeActiveLink();
        const institution = metadata?.institution?.name ?? 'Bank';
        const accountsShared = metadata?.accounts?.length ?? 0;
        if (itemId) {
          // Update mode: the Item and its access token are unchanged — nothing to exchange.
          resolve({ status: 'repaired', institution, itemId, accountsShared });
          return;
        }
        httpsCallable(fns, 'plaid_exchange')({
          publicToken,
          institution,
          institutionId: metadata?.institution?.institution_id ?? '',
        })
          .then((r) => {
            const data = (r.data ?? {}) as { institution?: string; itemId?: string };
            resolve({ status: 'linked', institution: data.institution ?? institution, itemId: data.itemId ?? '', accountsShared });
          })
          .catch((e: { code?: string; details?: { itemId?: string } }) => {
            if (e?.code === 'functions/already-exists' && e.details?.itemId) {
              resolve({ status: 'already-linked', institution, itemId: e.details.itemId });
            } else {
              reject(e);
            }
          });
      },
      onExit: () => {
        closeActiveLink();
        resolve(duplicate ? { status: 'already-linked', institution: duplicate.institution, itemId: duplicate.itemId } : null);
      },
    });
    activeHandler = handler;
    handler.open();
  });
}

/**
 * Revoke every linked bank at Plaid (#72).
 *
 * Wiping our data is not disconnecting the bank — the Item goes on living at Plaid,
 * still consuming one of the 10 lifetime Trial slots, with the consent the owner gave
 * their bank still granted. Only the server can end it, because the access tokens are
 * default-deny to this client by design.
 *
 * Throws if Plaid refuses. Callers must NOT swallow that: deleting the account anyway
 * would strand a live credential with nothing left to revoke it.
 */
export async function unlinkAllBanks(): Promise<number> {
  const fns = getFunctions(app, 'us-central1');
  const res = await httpsCallable(fns, 'plaid_unlink_all')({});
  return ((res.data ?? {}) as { removed?: number }).removed ?? 0;
}

/** One Reconnect button per connection that needs it. */
export interface RepairAction { itemId: string; label: string }

/**
 * The Reconnect buttons after a refresh: whatever the connect flow already offered,
 * plus every connection the sync found with an expired login, once each. Two Items at
 * the same bank are labelled by link date, so the owner reconnects the broken one.
 */
export function repairActions(keep: readonly RepairAction[], r: SyncResult): RepairAction[] {
  const byId = new Map(keep.map((a) => [a.itemId, a]));
  const sameBank = (name: string) => (r.itemsNeedingRepair ?? []).filter((i) => i.institution === name).length > 1;
  for (const i of r.itemsNeedingRepair ?? []) {
    if (byId.has(i.itemId)) continue;
    const name = i.institution || 'bank';
    const when = sameBank(i.institution) && i.linkedAt ? ` (linked ${i.linkedAt.slice(0, 10)})` : '';
    byId.set(i.itemId, { itemId: i.itemId, label: `Reconnect ${name}${when}` });
  }
  return [...byId.values()];
}

/** Plain-English summary of what a refresh actually did. */
export function describeSync(r: SyncResult): string {
  if (r.error) return r.error;
  const bits: string[] = [];
  if (r.added) bits.push(`${r.added} new transaction${r.added === 1 ? '' : 's'}`);
  if (r.enriched) bits.push(`${r.enriched} updated`);
  if (r.pendingLive) bits.push(`${r.pendingLive} pending`);
  if (r.reanchored?.length) bits.push(`${r.reanchored.length} balance${r.reanchored.length === 1 ? '' : 's'} refreshed`);
  // Said even when nothing else happened: "Already up to date" over a dead login is a lie.
  for (const i of r.itemsNeedingRepair ?? []) bits.push(`${i.institution || 'A bank'} needs you to sign in again`);
  if (!bits.length) return 'Already up to date';
  return bits.join(' · ');
}
