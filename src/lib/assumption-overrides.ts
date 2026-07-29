import { AssumptionOverrides } from './behavior';

// ponytail: localStorage V1 — Phase 8 moves this to the Firestore rules
// subcollection (same AssumptionOverrides shape, keyed per user) for
// cross-device sync; swap these two functions, callers stay unchanged.
const KEY = 'assumptionOverrides';

export function loadOverrides(): AssumptionOverrides {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {
    return {}; // SSR (no localStorage), private mode, or corrupted JSON
  }
}

export function saveOverrides(o: AssumptionOverrides): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(o));
  } catch {
    // storage full / private mode — overrides just won't persist
  }
}
