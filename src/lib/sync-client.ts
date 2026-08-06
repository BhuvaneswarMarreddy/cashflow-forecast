import { getFunctions, httpsCallable } from 'firebase/functions';
import { app } from '@/lib/firebase';

export interface SyncResult {
  added?: number;
  enriched?: number;
  pendingLive?: number;
  pendingCleared?: number;
  reanchored?: string[];
  unmatchedAccounts?: string[];
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

declare global {
  interface Window {
    Plaid?: {
      create: (opts: {
        token: string;
        onSuccess: (publicToken: string, metadata: { institution?: { name?: string } }) => void;
        onExit: (err: unknown) => void;
      }) => { open: () => void };
    };
  }
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
 * Full connect flow: token -> Link popup -> exchange. Resolves with the
 * institution name, or null when the user closed the popup. Pass `itemId` to
 * REPAIR an existing connection (update mode) instead of linking a new one.
 */
export async function connectBankWithPlaid(itemId?: string): Promise<string | null> {
  const fns = getFunctions(app, 'us-central1');
  const tokenRes = await httpsCallable(fns, 'plaid_link_token')(itemId ? { itemId } : {});
  const linkToken = (tokenRes.data as { linkToken?: string })?.linkToken;
  if (!linkToken) throw new Error('No link token returned.');
  await loadPlaidScript();
  if (!window.Plaid) throw new Error('Plaid Link did not initialize.');

  return new Promise((resolve, reject) => {
    window.Plaid!.create({
      token: linkToken,
      onSuccess: (publicToken, metadata) => {
        httpsCallable(fns, 'plaid_exchange')({
          publicToken,
          institution: metadata?.institution?.name ?? 'Bank',
        })
          .then((r) => resolve((r.data as { institution?: string })?.institution ?? 'Bank'))
          .catch(reject);
      },
      onExit: () => resolve(null),
    }).open();
  });
}

/** Plain-English summary of what a refresh actually did. */
export function describeSync(r: SyncResult): string {
  if (r.error) return r.error;
  const bits: string[] = [];
  if (r.added) bits.push(`${r.added} new transaction${r.added === 1 ? '' : 's'}`);
  if (r.enriched) bits.push(`${r.enriched} updated`);
  if (r.pendingLive) bits.push(`${r.pendingLive} pending`);
  if (r.reanchored?.length) bits.push(`${r.reanchored.length} balance${r.reanchored.length === 1 ? '' : 's'} refreshed`);
  if (!bits.length) return 'Already up to date';
  return bits.join(' · ');
}
