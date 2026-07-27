'use client';

import React from 'react';
import { usePathname } from 'next/navigation';
import QuickAddFAB from './QuickAddFAB';
import BottomNav from './BottomNav';

// Pages with no app chrome (auth + onboarding are standalone full-screen flows)
const EXCLUDED_PAGES = ['/', '/login', '/signup', '/forgot-password', '/onboarding'];

export default function ClientLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  // Chrome (FAB + mobile bottom nav) shows on the authed app pages only
  const showChrome = !EXCLUDED_PAGES.includes(pathname);

  return (
    <>
      {children}
      {showChrome && <QuickAddFAB />}
      {showChrome && <BottomNav />}
    </>
  );
}

