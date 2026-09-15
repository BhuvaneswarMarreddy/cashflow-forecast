'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { NAV_ITEMS } from '@/lib/nav';

// Mobile-only primary navigation (thumb-reach). Same single source as the Navbar;
// only `tab: true` items appear here: four (UI spec B2).
const TABS = NAV_ITEMS.filter((n) => n.tab);

/** The tab that owns this path. Flow is Activity's picture of the same past, so it lights Activity. */
export function activeTabHref(pathname: string): string | undefined {
  const path = pathname === '/flow' || pathname.startsWith('/flow/') ? '/history' : pathname;
  return TABS.find(({ href }) => path === href || path.startsWith(href + '/'))?.href;
}

export default function BottomNav() {
  const current = activeTabHref(usePathname());
  return (
    <nav
      aria-label="Primary"
      className="md:hidden fixed bottom-0 inset-x-0 z-40 border-t border-[var(--border-color)] bg-[var(--background-secondary)]/95 backdrop-blur"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <ul className="flex items-stretch">
        {TABS.map(({ href, label, icon: Icon }) => {
          const active = href === current;
          return (
            <li key={href} className="flex-1">
              <Link
                href={href}
                aria-current={active ? 'page' : undefined}
                // Active is colour + weight + a top indicator, never colour alone (gold as
                // small text needs the weight: 4.9:1 on Paper, 7.7:1 on Midnight).
                className={`flex flex-col items-center justify-center gap-1 min-h-[56px] border-t-2 text-[11px] leading-none transition-colors ${
                  active
                    ? 'border-[var(--accent-primary)] font-semibold text-[var(--accent-primary)]'
                    : 'border-transparent font-medium text-[var(--foreground-secondary)] hover:text-[var(--foreground)]'
                }`}
              >
                <Icon className="w-5 h-5" aria-hidden="true" />
                <span>{label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
