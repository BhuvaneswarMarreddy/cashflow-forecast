/**
 * cashflow-mobile#24 — the reviewed finding: BudgetStatusPanel looked up a
 * category's icon (and, before this file's own fix, implicitly assumed its
 * label) via the hardcoded 13-value EXPENSE_CATEGORIES, so a budget on the
 * owner's OWN custom category rendered with a blank icon — `EXPENSE_CATEGORIES
 * .find(...)` returns undefined for anything outside the 13 defaults, and the
 * icon `<span>` had no fallback at all. This proves the fix: a custom (and an
 * archived-but-still-referenced) category now resolves to its real icon/label,
 * pulled from the owner's own resolved set (profile.settings.categories) —
 * never blank.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import BudgetStatusPanel from '@/components/BudgetStatusPanel';
import { CategoryBudget, ExpenseCategory } from '@/types';

let PROFILE_SETTINGS: { categories?: { value: string; label: string; icon?: string; archived?: boolean }[] } = {};
jest.mock('@/context/UserProfileContext', () => ({
  useUserProfile: () => ({ profile: { id: 'user-1', settings: PROFILE_SETTINGS } }),
}));

beforeEach(() => {
  PROFILE_SETTINGS = {};
});

const budgetFor = (categoryId: string): CategoryBudget[] => [
  { categoryId: categoryId as ExpenseCategory, monthlyLimit: 100, isEnabled: true },
];

describe('BudgetStatusPanel — custom/archived category display', () => {
  it('a custom category resolves to its real icon and label, not a blank icon', () => {
    PROFILE_SETTINGS = { categories: [{ value: 'vacations', label: 'Vacations', icon: '🏖️' }] };
    render(
      <BudgetStatusPanel budgets={budgetFor('vacations')} transactions={[]} compact={false} />
    );
    expect(screen.getByText('Vacations')).toBeInTheDocument();
    expect(screen.getByText('🏖️')).toBeInTheDocument();
  });

  it('an archived category (removed, but a budget row still points at it) still resolves to its label', () => {
    PROFILE_SETTINGS = { categories: [{ value: 'old-hobby', label: 'Old Hobby', archived: true }] };
    render(
      <BudgetStatusPanel budgets={budgetFor('old-hobby')} transactions={[]} compact={false} />
    );
    // resolveCategories keeps archived entries resolvable for display — this is
    // display of an EXISTING row, never a new-selection picker.
    expect(screen.getByText('Old Hobby')).toBeInTheDocument();
  });
});
