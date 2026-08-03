/**
 * The four screens that left the nav bar must stay reachable. They sat at the bottom
 * of /flow — one page — and now ride the app-wide FAB. nav.ts owns the list, so a
 * screen added there must appear here without a second edit; that is the property
 * worth testing, not the markup.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import QuickAddFAB from '@/components/QuickAddFAB';
import { SECONDARY_ITEMS } from '@/lib/nav';

jest.mock('next/navigation', () => ({ usePathname: () => '/dashboard' }));
jest.mock('@/components/AddTransactionModal', () => () => null);
jest.mock('@/components/ReceiptScannerModal', () => () => null);

describe('QuickAddFAB', () => {
  const open = () => {
    render(<QuickAddFAB />);
    fireEvent.click(screen.getByRole('button', { name: /Add a transaction, scan a receipt/i }));
  };

  it('hides every view link until opened', () => {
    render(<QuickAddFAB />);
    for (const item of SECONDARY_ITEMS) {
      expect(screen.queryByRole('link', { name: item.label })).not.toBeInTheDocument();
    }
  });

  it('offers every SECONDARY_ITEM, pointing at its real href', () => {
    open();
    expect(SECONDARY_ITEMS.length).toBeGreaterThan(0);
    for (const item of SECONDARY_ITEMS) {
      expect(screen.getByRole('link', { name: item.label })).toHaveAttribute('href', item.href);
    }
  });

  it('keeps the two actions alongside the links', () => {
    open();
    expect(screen.getByText('Add Expense')).toBeInTheDocument();
    expect(screen.getByText('Scan Receipt')).toBeInTheDocument();
  });

  it('marks the current page so the menu says where you are', () => {
    // usePathname is mocked to /dashboard, which is a PRIMARY destination — so no
    // secondary link should claim to be current.
    open();
    for (const item of SECONDARY_ITEMS) {
      expect(screen.getByRole('link', { name: item.label })).not.toHaveAttribute('aria-current');
    }
  });
});
