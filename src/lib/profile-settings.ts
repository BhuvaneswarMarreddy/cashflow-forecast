/**
 * The user-settings round trip, in one place.
 *
 * WHY THIS FILE EXISTS. A settings field used to have to be hand-listed in three
 * separate places to survive a logout: the `FirestoreUser['settings']` type, a write
 * allowlist in UserProfileContext, and a read allowlist right beside it. Miss one and
 * the failure is silent and delayed — the value works for the whole session and is gone
 * the next time you sign in (#100). `includePendingInCalculations` missed all three;
 * `timezone` and `notifications` missed the write list and had never persisted either.
 *
 * The allowlists are gone. These two functions are the whole contract, and the rule
 * they keep is: WHATEVER IS IN `profile.settings` GOES, AND COMES BACK. Adding a
 * setting is now adding a field to the type in `@/types` — nothing else.
 *
 * PURE module: no Firestore, no React, so the invariant is testable directly.
 */
import { UserProfile } from '@/types';

export type ProfileSettings = NonNullable<UserProfile['settings']>;

/**
 * `monthlyBudget` and `currency` live at the TOP level of `UserProfile` but inside
 * `settings` in the Firestore document. They are the only two that move, and they move
 * in both directions here so no caller has to remember it.
 */
export interface HoistedSettings {
  monthlyBudget: number;
  currency: string;
}

/**
 * Profile settings → the flat map `updateUserSettings()` writes as `settings.<key>`.
 *
 * `undefined` is dropped rather than sent: Firestore rejects an undefined value outright,
 * so one unset optional field would fail the whole write and take every other setting in
 * the same call down with it.
 */
export function toFirestoreSettings(
  settings: ProfileSettings | undefined,
  hoisted: HoistedSettings
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    monthlyBudget: hoisted.monthlyBudget,
    currency: hoisted.currency,
  };
  for (const [key, value] of Object.entries(settings ?? {})) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * The Firestore document's `settings` map → profile settings.
 *
 * The two hoisted keys are removed, because the profile carries them at the top level
 * and a second copy inside `settings` is a second source of truth that will eventually
 * disagree with the first. Everything else passes through untouched — including fields
 * this build has never heard of, so a client on an older version does not delete a
 * setting written by a newer one.
 */
export function fromFirestoreSettings(
  stored: Record<string, unknown> | undefined
): ProfileSettings {
  const { monthlyBudget: _mb, currency: _cur, ...rest } = stored ?? {};
  return rest as ProfileSettings;
}

/**
 * Sanitize the `assumedMonthlySpend` setting (FIN-SPEND-001).
 *
 * The write side enforces the constraint, but a doc edited by hand or by an older
 * client must not turn into a fabricated $0/negative "burn" downstream. This guard
 * ensures the value is numeric, finite, and > 0, or returns null. Called by both
 * web pages and homeSnapshot (server) so web and mobile never diverge on the same
 * corrupt input.
 *
 * @param value The raw value from settings (unknown type to catch all cases)
 * @returns The value if it's a positive finite number, else null
 */
export function sanitizeAssumedSpend(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0
    ? value
    : null;
}
