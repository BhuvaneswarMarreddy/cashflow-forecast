'use client';

import React from 'react';
import { usePathname } from 'next/navigation';
import { environment } from '@/lib/obs/events';
import QuickAddFAB from './QuickAddFAB';
import BottomNav from './BottomNav';

/**
 * The signed-in app's own screens: the only paths that get the FAB and tab bar.
 *
 * An ALLOWLIST, not a denylist. The old list excluded auth pages and mounted chrome on
 * everything else, so a URL matching no screen showed Next's 404 with the gold FAB
 * and the tab bar still on top of it (UI spec A1). Exact paths, because
 * `/accounts/anything` is a 404 too. Every page.tsx is sorted into this list or
 * NO_CHROME_ROUTES by src/__tests__/system-surfaces.test.tsx, so a new screen
 * can't lose its tab bar by accident.
 */
export const CHROME_ROUTES = ['/dashboard', '/forecast', '/history', '/flow', '/flow/review', '/accounts', '/settings'];

/** Standalone full-screen flows, plus routes that only redirect. */
export const NO_CHROME_ROUTES = ['/', '/login', '/signup', '/forgot-password', '/onboarding', '/analytics', '/calendar', '/cashflow'];

/** The /dev fixtures render real screens in development and test, and 404 in production. */
const FIXTURE_PREFIX = '/dev/';

export function showsChrome(pathname: string): boolean {
  if (CHROME_ROUTES.includes(pathname)) return true;
  const env = environment();
  return pathname.startsWith(FIXTURE_PREFIX) && (env === 'development' || env === 'test');
}

export default function ClientLayout({ children }: { children: React.ReactNode }) {
  const showChrome = showsChrome(usePathname());

  return (
    <>
      {children}
      {showChrome && <QuickAddFAB />}
      {showChrome && <BottomNav />}
    </>
  );
}
