/**
 * #100 — settings must survive a logout.
 *
 * The bug these pin was not a wrong value; it was a value that never left the browser.
 * Three hand-maintained allowlists each had to name a field, and a miss failed silently
 * and late: the setting worked for the whole session and was gone at the next sign-in.
 *
 * So the important test here is NOT "includePendingInCalculations round-trips". It is
 * "an arbitrary field round-trips" — a test that fails for the NEXT setting somebody
 * adds, not only the one that broke this time.
 */
import { fromFirestoreSettings, toFirestoreSettings, ProfileSettings } from '@/lib/profile-settings';

const HOISTED = { monthlyBudget: 2500, currency: 'USD' };

/** Write, store, read back — the whole journey a setting makes across a logout. */
const roundTrip = (s: ProfileSettings): ProfileSettings =>
  fromFirestoreSettings(toFirestoreSettings(s, HOISTED));

describe('#100: whatever is in settings goes, and comes back', () => {
  it('carries a field nothing in this module knows about', () => {
    // The regression guard. No allowlist is consulted, so a setting added next year
    // survives without anyone editing this file.
    const stored = toFirestoreSettings({ someFutureSetting: 'kept' } as ProfileSettings, HOISTED);
    expect(stored.someFutureSetting).toBe('kept');
    expect(fromFirestoreSettings(stored)).toEqual({ someFutureSetting: 'kept' });
  });

  it('round-trips the setting that broke: include pending', () => {
    expect(roundTrip({ includePendingInCalculations: true })).toEqual({ includePendingInCalculations: true });
  });

  it('round-trips false, not just true — off must be storable, never merely absent', () => {
    // `?? false` on read means a dropped field and a stored `false` look identical.
    // Turning the setting OFF has to persist as deliberately as turning it on.
    const stored = toFirestoreSettings({ includePendingInCalculations: false }, HOISTED);
    expect(stored).toHaveProperty('includePendingInCalculations', false);
    expect(roundTrip({ includePendingInCalculations: false })).toEqual({ includePendingInCalculations: false });
  });

  it('round-trips the fields that were already listed', () => {
    const settings: ProfileSettings = {
      safetyThreshold: 500,
      emergencyFundGoal: 6,
      emergencyFundAmount: 12000,
      categoryBudgets: [{ categoryId: 'food', monthlyLimit: 400, isEnabled: true }],
      notificationPreferences: {
        remindDaysBefore: [1, 3, 7],
        channels: ['in_app'],
        billRemindersEnabled: true,
      },
    };
    expect(roundTrip(settings)).toEqual(settings);
  });

  it('round-trips timezone and notifications, which never persisted before', () => {
    // Both were in the READ allowlist and the type but not the WRITE one, so they had
    // silently never been saved. Same root cause, found while fixing this.
    const settings = { timezone: 'America/Chicago', notifications: false } as ProfileSettings;
    expect(roundTrip(settings)).toEqual(settings);
  });
});

describe('#100: the two keys that move between levels', () => {
  it('writes monthlyBudget and currency into the settings map', () => {
    const stored = toFirestoreSettings({}, HOISTED);
    expect(stored.monthlyBudget).toBe(2500);
    expect(stored.currency).toBe('USD');
  });

  it('strips them on read so the profile has ONE copy of each', () => {
    // They live at the top level of UserProfile. A second copy inside `settings` is a
    // second source of truth, and the two will eventually disagree.
    const back = fromFirestoreSettings({ monthlyBudget: 2500, currency: 'USD', safetyThreshold: 500 });
    expect(back).toEqual({ safetyThreshold: 500 });
  });
});

describe('#100: undefined is dropped, because Firestore rejects it', () => {
  it('omits unset optionals instead of sending undefined', () => {
    // One undefined value fails the WHOLE updateDoc call — so a single unset optional
    // would take every other setting in the same write down with it.
    const stored = toFirestoreSettings(
      { safetyThreshold: 500, emergencyFundGoal: undefined } as ProfileSettings,
      HOISTED
    );
    expect(stored).not.toHaveProperty('emergencyFundGoal');
    expect(stored.safetyThreshold).toBe(500);
    expect(Object.values(stored)).not.toContain(undefined);
  });

  it('tolerates a profile with no settings at all', () => {
    expect(toFirestoreSettings(undefined, HOISTED)).toEqual(HOISTED);
    expect(fromFirestoreSettings(undefined)).toEqual({});
  });
});
