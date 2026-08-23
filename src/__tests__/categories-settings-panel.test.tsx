/**
 * cashflow-mobile#27. The only way to add/rename a category used to be asking the
 * chat (DataChatSheet's applyCategory). This is the point-and-click screen for the
 * same settings.categories store — same read-modify-write, same
 * slugForCategoryLabel collision safety, same "archived, never deleted" model.
 *
 * Removal-with-reassignment is explicitly OUT of scope here (a parallel task is
 * moving that to a server callable) — only add / rename / archive are covered.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import CategoriesSettingsPanel from '@/components/CategoriesSettingsPanel';
import { CustomCategory } from '@/types';

let PROFILE_SETTINGS: { categories?: CustomCategory[] } = {};
const updateProfile = jest.fn();

jest.mock('@/context/UserProfileContext', () => ({
  useUserProfile: () => ({
    profile: { id: 'user-1', settings: PROFILE_SETTINGS },
    updateProfile,
  }),
}));

beforeEach(() => {
  PROFILE_SETTINGS = {};
  updateProfile.mockReset().mockResolvedValue(true);
});

describe('CategoriesSettingsPanel — list', () => {
  it('renders defaults, custom, and archived entries distinctly', () => {
    PROFILE_SETTINGS = {
      categories: [
        { value: 'vacations', label: 'Vacations', icon: '🏖️' },
        { value: 'old-hobby', label: 'Old Hobby', archived: true },
      ],
    };
    render(<CategoriesSettingsPanel />);

    // Built-in — icon, label, value, and a "Built-in" distinction (never "Custom").
    const foodRow = screen.getByText('Food & Dining').closest('li')!;
    expect(within(foodRow).getByText('Built-in')).toBeInTheDocument();
    expect(within(foodRow).queryByText('Custom')).not.toBeInTheDocument();
    expect(within(foodRow).getByText('food')).toBeInTheDocument();

    // Custom, active.
    const vacationsRow = screen.getByText('Vacations').closest('li')!;
    expect(within(vacationsRow).getByText('Custom')).toBeInTheDocument();
    expect(within(vacationsRow).getByText('vacations')).toBeInTheDocument();
    expect(within(vacationsRow).queryByText('Archived')).not.toBeInTheDocument();

    // Custom, archived — still listed, but visibly de-emphasized AND labeled (not
    // colour-only): a text "Archived" badge plus a dimmed row.
    const oldHobbyRow = screen.getByText('Old Hobby').closest('li')!;
    expect(within(oldHobbyRow).getByText('Archived')).toBeInTheDocument();
    expect(oldHobbyRow.className).toEqual(expect.stringContaining('opacity'));
  });
});

describe('CategoriesSettingsPanel — add', () => {
  it('derives a collision-safe slug and preserves existing entries in the written array', async () => {
    PROFILE_SETTINGS = { categories: [{ value: 'vacations', label: 'Vacations' }] };
    render(<CategoriesSettingsPanel />);

    // "Travel" collides with the built-in 'travel' slug.
    fireEvent.change(screen.getByLabelText('Category name'), { target: { value: 'Travel' } });
    fireEvent.change(screen.getByLabelText('Emoji'), { target: { value: '🧳' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add category' }));

    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(1));
    expect(updateProfile).toHaveBeenCalledWith({
      settings: {
        categories: [
          { value: 'vacations', label: 'Vacations' },
          { value: 'travel-2', label: 'Travel', icon: '🧳' },
        ],
      },
    });
  });

  it('an emoji is optional — the written entry omits the icon key entirely', async () => {
    PROFILE_SETTINGS = {};
    render(<CategoriesSettingsPanel />);

    fireEvent.change(screen.getByLabelText('Category name'), { target: { value: 'Side Hustle' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add category' }));

    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(1));
    expect(updateProfile).toHaveBeenCalledWith({
      settings: { categories: [{ value: 'side-hustle', label: 'Side Hustle' }] },
    });
  });
});

describe('CategoriesSettingsPanel — rename', () => {
  it('renaming a custom entry only affects the target entry', async () => {
    PROFILE_SETTINGS = {
      categories: [
        { value: 'vacations', label: 'Vacations', icon: '🏖️' },
        { value: 'side-hustle', label: 'Side Hustle' },
      ],
    };
    render(<CategoriesSettingsPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Rename Vacations' }));
    fireEvent.change(screen.getByLabelText('New name for Vacations'), { target: { value: 'Trips' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(1));
    expect(updateProfile).toHaveBeenCalledWith({
      settings: {
        categories: [
          { value: 'vacations', label: 'Trips', icon: '🏖️' },
          { value: 'side-hustle', label: 'Side Hustle' },
        ],
      },
    });
  });

  it('a built-in category offers no rename control — by design (#27)', () => {
    render(<CategoriesSettingsPanel />);
    expect(screen.queryByRole('button', { name: 'Rename Food & Dining' })).not.toBeInTheDocument();
  });
});

describe('CategoriesSettingsPanel — archive', () => {
  it('archiving toggles only that entry, leaving every other entry untouched', async () => {
    PROFILE_SETTINGS = {
      categories: [
        { value: 'vacations', label: 'Vacations' },
        { value: 'side-hustle', label: 'Side Hustle' },
      ],
    };
    render(<CategoriesSettingsPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Archive Vacations' }));

    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(1));
    expect(updateProfile).toHaveBeenCalledWith({
      settings: {
        categories: [
          { value: 'vacations', label: 'Vacations', archived: true },
          { value: 'side-hustle', label: 'Side Hustle' },
        ],
      },
    });
  });

  it('unarchiving flips it back, leaving the other entry untouched', async () => {
    PROFILE_SETTINGS = {
      categories: [
        { value: 'vacations', label: 'Vacations', archived: true },
        { value: 'side-hustle', label: 'Side Hustle' },
      ],
    };
    render(<CategoriesSettingsPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Unarchive Vacations' }));

    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(1));
    expect(updateProfile).toHaveBeenCalledWith({
      settings: {
        categories: [
          { value: 'vacations', label: 'Vacations', archived: false },
          { value: 'side-hustle', label: 'Side Hustle' },
        ],
      },
    });
  });
});

describe('CategoriesSettingsPanel — failed write', () => {
  it('surfaces an error and does not claim success', async () => {
    updateProfile.mockReset().mockResolvedValue(false);
    render(<CategoriesSettingsPanel />);

    fireEvent.change(screen.getByLabelText('Category name'), { target: { value: 'Side Hustle' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add category' }));

    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not/i);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByText(/Added "Side Hustle"/)).not.toBeInTheDocument();
    // Never claim success: the newly-added category must not appear in the list.
    expect(screen.queryByText('Side Hustle')).not.toBeInTheDocument();
  });
});
