'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, LineChart, GitBranch, CreditCard, History } from 'lucide-react';

// Mobile-only primary navigation (thumb-reach). The full route set stays in the top
// Navbar/drawer on md+; these five are the most-used. Kept in sync with Navbar.navItems.
const TABS = [
  { href: '/dashboard', label: 'Overview', icon: LayoutDashboard },
  { href: '/forecast', label: 'Forecast', icon: LineChart },
  { href: '/flow', label: 'Flow', icon: GitBranch },
  { href: '/accounts', label: 'Accounts', icon: CreditCard },
  { href: '/history', label: 'History', icon: History },
];

export default function BottomNav() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Primary"
      className="md:hidden fixed bottom-0 inset-x-0 z-40 border-t border-[var(--border-color)] bg-[var(--background-secondary)]/95 backdrop-blur"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <ul className="flex items-stretch">
        {TABS.map(({ href, label, icon: Icon }) => {
          const active = pathname === href;
          return (
            <li key={href} className="flex-1">
              <Link
                href={href}
                aria-current={active ? 'page' : undefined}
                className={`flex flex-col items-center justify-center gap-0.5 min-h-[56px] text-[10px] font-medium transition-colors ${
                  active
                    ? 'text-[var(--accent-primary)]'
                    : 'text-[var(--foreground-secondary)] hover:text-[var(--foreground)]'
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
