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
