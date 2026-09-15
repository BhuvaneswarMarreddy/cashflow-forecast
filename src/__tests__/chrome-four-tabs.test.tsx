/**
 * UI spec Phase B — four thumb tabs, and Add off the Accounts tab.
 *
 * The lies these pin: five tabs plus a gold FAB parked at bottom-20 right-4, on top of
 * the Accounts tab; a 10px tab label whose only "you are here" signal was gold text
 * (fails contrast as small type on Paper); and on /flow no tab lit at all, because
 * Flow was compared by exact path.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { NAV_ITEMS } from '@/lib/nav';

let mockPath = '/dashboard';
jest.mock('next/navigation', () => ({ usePathname: () => mockPath }));

let modalOpen: boolean | undefined;
jest.mock('@/components/AddTransactionModal', () => (props: { isOpen: boolean }) => {
  modalOpen = props.isOpen;
  return null;
});

import BottomNav, { activeTabHref } from '@/components/BottomNav';
import QuickAddFAB from '@/components/QuickAddFAB';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('nav.ts (B1)', () => {
  it('has exactly four thumb tabs, in question order', () => {
    expect(NAV_ITEMS.filter((n) => n.tab).map((n) => n.label)).toEqual(['Home', 'Forecast', 'Activity', 'Accounts']);
  });

  it('keeps Flow as a route (desktop nav) without a tab', () => {
    const flow = NAV_ITEMS.find((n) => n.href === '/flow');
    expect(flow).toBeDefined();
    expect(flow!.tab).toBe(false);
  });

  it('Activity links to Flow, so a phone can still reach it', () => {
    const history = read('src/app/history/page.tsx');
    expect(history).toMatch(/href="\/flow"[\s\S]{0,300}View as flow/);
  });
});

describe('BottomNav (B2)', () => {
  const renderAt = (path: string) => {
    mockPath = path;
    return render(<BottomNav />);
  };

  it('renders four links', () => {
    renderAt('/dashboard');
    expect(within(screen.getByRole('navigation', { name: 'Primary' })).getAllByRole('link')).toHaveLength(4);
  });

  it.each([
    ['/flow', 'Activity'],
    ['/flow/review', 'Activity'],
    ['/history', 'Activity'],
    ['/accounts', 'Accounts'],
    ['/forecast', 'Forecast'],
    ['/dashboard', 'Home'],
  ])('on %s exactly one tab is current: %s', (path, label) => {
    renderAt(path);
    const current = screen.getAllByRole('link').filter((l) => l.getAttribute('aria-current') === 'page');
    expect(current.map((l) => l.textContent)).toEqual([label]);
  });

  it('does not light Activity for a path that only starts with "flow"', () => {
    expect(activeTabHref('/flowers')).toBeUndefined();
  });

  it('marks the active tab with weight and a top indicator, not colour alone, at 11px', () => {
    renderAt('/accounts');
    const active = screen.getByRole('link', { name: 'Accounts' });
    expect(active.className).toContain('font-semibold');
    expect(active.className).toContain('border-t-2');
    expect(active.className).toContain('border-[var(--accent-primary)]');
    for (const link of screen.getAllByRole('link')) {
      expect(link.className).toContain('text-[11px]');
      expect(link.className).not.toContain('text-[10px]');
    }
  });
});

describe('Add transaction (B3)', () => {
  beforeEach(() => { modalOpen = undefined; });

  it('the corner FAB exists only from md up, where there is no tab bar', () => {
    render(<QuickAddFAB />);
    const fab = screen.getByRole('button', { name: 'Add transaction' });
    expect(fab.className).toContain('hidden md:flex');
    expect(fab.className).toContain('bottom-6 right-6');
    expect(fab.className).not.toContain('bottom-20');
  });

  it('phones get a 44px header button that opens the same modal', () => {
    render(<QuickAddFAB variant="header" />);
    const add = screen.getByRole('button', { name: 'Add transaction' });
    expect(add.className).toContain('md:hidden');
    expect(add.className).toContain('w-11 h-11');
    fireEvent.click(add);
    expect(modalOpen).toBe(true);
  });

  it('the Navbar carries the phone Add', () => {
    expect(read('src/components/Navbar.tsx')).toContain('<QuickAddFAB variant="header" />');
  });

  it('no screen still pads for the old phone FAB', () => {
    for (const page of ['dashboard', 'forecast', 'history', 'accounts', 'flow']) {
      expect([page, read(`src/app/${page}/page.tsx`).includes('pb-40')]).toEqual([page, false]);
    }
  });
});
