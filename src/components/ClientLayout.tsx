'use client';

import React from 'react';
import { usePathname } from 'next/navigation';
import QuickAddFAB from './QuickAddFAB';

// Pages where FAB should NOT show
const EXCLUDED_PAGES = ['/', '/login', '/signup', '/forgot-password', '/onboarding'];

export default function ClientLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  
  // Check if FAB should be shown
  const showFAB = !EXCLUDED_PAGES.includes(pathname);

  return (
    <>
      {children}
      {showFAB && <QuickAddFAB />}
    </>
  );
}

