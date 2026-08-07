/**
 * UI-101 — the FAB is ONE action. Its predecessor was a six-item menu
 * (2 actions + 4 navigation links) behind a grid icon; the design audit and
 * the owner both called it: navigation must not hide inside an add button.
 * The ex-menu routes' app-wide reachability now lives in the Navbar menus
 * (pinned by chrome-contract.test.ts) until UI-103/104 retire the routes.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import QuickAddFAB from '@/components/QuickAddFAB';

let modalOpen: boolean | undefined;
jest.mock('@/components/AddTransactionModal', () => (props: { isOpen: boolean }) => {
  modalOpen = props.isOpen;
  return null;
});

describe('QuickAddFAB', () => {
  beforeEach(() => {
    modalOpen = undefined;
  });

  it('is a single button named for the one thing it does', () => {
    render(<QuickAddFAB />);
    expect(screen.getByRole('button', { name: 'Add transaction' })).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('never renders navigation links', () => {
    render(<QuickAddFAB />);
    fireEvent.click(screen.getByRole('button', { name: 'Add transaction' }));
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });

  it('opens the add-transaction modal on tap', () => {
    render(<QuickAddFAB />);
    expect(modalOpen).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Add transaction' }));
    expect(modalOpen).toBe(true);
  });
});
