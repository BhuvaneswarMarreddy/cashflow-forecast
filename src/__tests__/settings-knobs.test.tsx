/**
 * #201 — Settings holds the knobs so Home / Forecast / Activity stay quiet.
 *
 * The lies these pin:
 * - an income alias like "CA" saved from Settings would match half the ledger and turn
 *   stray deposits into earned income (the save path must keep Accounts' ≥3-char rule);
 * - a blank "monthly spending" box saved as 0 would become a fabricated $0 burn and an
 *   infinite runway (blank must save `null` = use actual spending);
 * - saving reserve MONTHS while an old fixed AMOUNT is still stored would change nothing,
 *   because EmergencyFundPanel lets the amount win;
 * - two income editors (Accounts and Settings) drifting apart.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import IncomeSourcesSettings from '@/components/IncomeSourcesSettings';
import AssumptionsSettings from '@/components/AssumptionsSettings';

let SETTINGS: Record<string, unknown> = {};
const updateProfile = jest.fn();
const addIncomeSource = jest.fn();
const updateIncomeSource = jest.fn();
const deleteIncomeSource = jest.fn();

jest.mock('@/context/UserProfileContext', () => ({
  useUserProfile: () => ({
    profile: {
      id: 'user-1', currency: 'USD', settings: SETTINGS,
      incomeSources: [{ id: 'inc-1', name: 'Canton Group', amount: 4200, frequency: 'biweekly', payDate: 1, isActive: true, matchAliases: ['canton payroll'] }],
    },
    updateProfile, addIncomeSource, updateIncomeSource, deleteIncomeSource,
  }),
}));

beforeEach(() => {
  SETTINGS = {};
  for (const fn of [updateProfile, addIncomeSource, updateIncomeSource, deleteIncomeSource]) fn.mockReset().mockResolvedValue(true);
});

describe('Income sources in Settings (#201)', () => {
  it('saves a new source with short alias fragments dropped', async () => {
    render(<IncomeSourcesSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'Add Income' }));
    fireEvent.change(screen.getByLabelText('Income Name'), { target: { value: 'Side gig' } });
    fireEvent.change(screen.getByLabelText('Bank description contains'), { target: { value: 'GIG PAY, CA, , UPWORK' } });
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '800' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Add Income' }).at(-1)!);
    await waitFor(() => expect(addIncomeSource).toHaveBeenCalledTimes(1));
    expect(addIncomeSource).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Side gig', amount: 800, frequency: 'monthly', matchAliases: ['GIG PAY', 'UPWORK'], isActive: true,
    }));
  });

  it('edits in place and deletes only after confirmation', async () => {
    render(<IncomeSourcesSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Canton Group' }));
    expect(screen.getByLabelText('Bank description contains')).toHaveValue('canton payroll');
    fireEvent.click(screen.getByRole('button', { name: 'Update Income' }));
    await waitFor(() => expect(updateIncomeSource).toHaveBeenCalledWith('inc-1', expect.objectContaining({ matchAliases: ['canton payroll'] })));

    fireEvent.click(screen.getByRole('button', { name: 'Delete Canton Group' }));
    expect(deleteIncomeSource).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteIncomeSource).toHaveBeenCalledWith('inc-1'));
  });
});

describe('Assumptions in Settings (#201)', () => {
  it('a blank spending box saves null (use actual spending), never 0', async () => {
    render(<AssumptionsSettings />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[0]);
    await waitFor(() => expect(updateProfile).toHaveBeenCalledWith({ settings: { assumedMonthlySpend: null } }));
  });

  it('zero or negative spending cannot be saved', () => {
    render(<AssumptionsSettings />);
    for (const v of ['0', '-50']) {
      fireEvent.change(screen.getByLabelText('Monthly spending for runway'), { target: { value: v } });
      expect(screen.getAllByRole('button', { name: 'Save' })[0]).toBeDisabled();
    }
  });

  it('shows and clears an owner-set spending number', async () => {
    SETTINGS = { assumedMonthlySpend: 3200 };
    render(<AssumptionsSettings />);
    expect(screen.getByText(/Runway uses your number, \$3,200 a month/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Use actual spending' }));
    await waitFor(() => expect(updateProfile).toHaveBeenCalledWith({ settings: { assumedMonthlySpend: null } }));
  });

  it('reserve months replaces a stored fixed amount, so the new goal actually applies', async () => {
    SETTINGS = { emergencyFundAmount: 15000 };
    render(<AssumptionsSettings />);
    expect(screen.getByText(/fixed \$15,000/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Reserve goal'), { target: { value: '6' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[1]);
    await waitFor(() => expect(updateProfile).toHaveBeenCalledWith({ settings: { emergencyFundGoal: 6, emergencyFundAmount: null } }));
  });

  it('says so when a save fails instead of claiming success', async () => {
    updateProfile.mockResolvedValue(false);
    render(<AssumptionsSettings />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[1]);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save that setting');
  });
});

describe('Settings page shape (#201)', () => {
  const strip = (src: string) => src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const settings = strip(readFileSync(join(process.cwd(), 'src/app/settings/page.tsx'), 'utf8'));
  const accounts = strip(readFileSync(join(process.cwd(), 'src/app/accounts/page.tsx'), 'utf8'));
  const headings = [...settings.matchAll(/<h2 [^>]*className="text-sm[^"]*">\s*([^<]+?)\s*<\/h2>/g)].map((m) => m[1]);

  it('sections run in the issue order: Appearance, Income, Assumptions, Categories, Data, then sign out', () => {
    expect(headings).toEqual(['Appearance', 'Income sources', 'Assumptions', 'Categories', 'Category rules', 'Data', 'Account', 'Session', 'Danger Zone']);
    expect(settings).toContain('<IncomeSourcesSettings />');
    expect(settings).toContain('<AssumptionsSettings />');
    expect(settings).toContain('id="income-sources"');
    expect(settings).toContain('max-w-content');
  });

  it('no dead "Accounts & Budget" link row', () => {
    expect(settings).not.toContain('Accounts & Budget');
  });

  it('Accounts has one income editor fewer: it links to Settings instead', () => {
    for (const gone of ['addIncomeSource', 'updateIncomeSource', 'deleteIncomeSource', 'showIncomeModal', "key: 'income'"]) {
      expect([gone, accounts.includes(gone)]).toEqual([gone, false]);
    }
    expect(accounts).toContain('href="/settings#income-sources"');
  });
});
