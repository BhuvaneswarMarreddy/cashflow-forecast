/**
 * Integration-level coverage for CategoriesSettingsPanel + the REAL
 * UserProfileProvider (only Firestore and Auth are mocked) — see
 * reconcile-persists-drift.test.ts for why this tier exists.
 *
 * categories-settings-panel.test.tsx mocks useUserProfile entirely, so it can never
 * see what the real updateProfile does to `profile`/localStorage on a failed write.
 * That gap is exactly how this defect shipped: updateProfile applied the optimistic
 * setProfile()/saveLocalProfile() and never rolled either back on a confirmed
 * failure, so the new category APPEARED IN THE LIST at the same moment the panel
 * said "Could not save — check your connection and try again." — the error banner
 * and the list contradicted each other.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import CategoriesSettingsPanel from '@/components/CategoriesSettingsPanel';
import { UserProfileProvider, useUserProfile, UserProfileContextType } from '@/context/UserProfileContext';

const TEST_USER = { id: 'u1', email: 'a@b.com', name: 'A', createdAt: '2026-01-01T00:00:00.000Z' };

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ user: TEST_USER, isAuthenticated: true, isLoading: false }),
}));

jest.mock('@/lib/firestore', () => ({
  getUserProfile: jest.fn(),
  getAccounts: jest.fn(),
  getIncomeSources: jest.fn().mockResolvedValue([]),
  getInflowReviews: jest.fn().mockResolvedValue({}),
  updateUserSettings: jest.fn(),
  updateLastLogin: jest.fn().mockResolvedValue(undefined),
  createUserProfile: jest.fn().mockResolvedValue(undefined),
  newDocId: jest.fn(() => 'id1'),
}));

const firestoreMock = jest.requireMock('@/lib/firestore');

// A value the SYNCHRONOUS default profile the provider seeds before Firestore
// answers would never have (that one reads the system timezone). Waiting on it
// proves the async Firestore sync has landed, so "add category" below starts from
// a settled, known `profile.settings` instead of racing that sync.
const MARKER_TZ = 'Asia/Kolkata';

function Harness({ onReady }: { onReady: (ctx: UserProfileContextType) => void }) {
  const ctx = useUserProfile();
  onReady(ctx);
  return null;
}

function renderPanel() {
  let ctx: UserProfileContextType | undefined;
  render(
    React.createElement(
      UserProfileProvider,
      null,
      React.createElement(Harness, { onReady: (c) => { ctx = c; } }),
      React.createElement(CategoriesSettingsPanel)
    )
  );
  return {
    getCtx: () => ctx,
  };
}

describe('CategoriesSettingsPanel — integration with the real UserProfileProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    firestoreMock.getUserProfile.mockResolvedValue({
      uid: TEST_USER.id, email: TEST_USER.email, displayName: TEST_USER.name,
      createdAt: { toDate: () => new Date('2026-01-01') },
      metadata: { isOnboarded: true },
      settings: { timezone: MARKER_TZ, notifications: true },
    });
    firestoreMock.getAccounts.mockResolvedValue([]);
  });

  it('a confirmed write failure leaves the list unchanged and shows the error', async () => {
    firestoreMock.updateUserSettings.mockRejectedValue(new Error('permission-denied'));
    const { getCtx } = renderPanel();

    await waitFor(() => expect(getCtx()?.profile?.settings?.timezone).toBe(MARKER_TZ));

    fireEvent.change(screen.getByLabelText('Category name'), { target: { value: 'Side Hustle' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add category' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not save/i);
    // The whole point of this test: the error and the list must agree.
    expect(screen.queryByText('Side Hustle')).not.toBeInTheDocument();
    expect(getCtx()?.profile?.settings?.categories ?? []).toEqual([]);

    // Not just the rendered list — the state AND the persisted local copy both have
    // to roll back, or the next reload resurrects the unsaved category from cache.
    const stored = JSON.parse(localStorage.getItem(`cashflow_profile_${TEST_USER.id}`) || '{}');
    expect(stored.settings?.categories ?? []).toEqual([]);
  });

  it('a successful write updates the list', async () => {
    firestoreMock.updateUserSettings.mockResolvedValue(undefined);
    const { getCtx } = renderPanel();

    await waitFor(() => expect(getCtx()?.profile?.settings?.timezone).toBe(MARKER_TZ));

    fireEvent.change(screen.getByLabelText('Category name'), { target: { value: 'Side Hustle' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add category' }));

    expect(await screen.findByText('Side Hustle')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/Added "Side Hustle"/);
    expect(getCtx()?.profile?.settings?.categories).toEqual([{ value: 'side-hustle', label: 'Side Hustle' }]);

    const stored = JSON.parse(localStorage.getItem(`cashflow_profile_${TEST_USER.id}`) || '{}');
    expect(stored.settings?.categories).toEqual([{ value: 'side-hustle', label: 'Side Hustle' }]);
  });
});
