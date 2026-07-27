import {
  LayoutDashboard, LineChart, BarChart3, GitBranch, History, CreditCard, PieChart,
  type LucideIcon,
} from 'lucide-react';

/**
 * The one nav list (D1). Navbar renders all items; BottomNav renders `tab: true`.
 * Every shipped screen must appear here — an unlisted route is unreachable.
 */
export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Show in the mobile bottom tab bar (max 5). */
  tab: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { href: '/dashboard', label: 'Overview', icon: LayoutDashboard, tab: true },
  { href: '/forecast', label: 'Forecast', icon: LineChart, tab: true },
  { href: '/flow', label: 'Flow', icon: GitBranch, tab: true },
  { href: '/accounts', label: 'Accounts', icon: CreditCard, tab: true },
  { href: '/history', label: 'History', icon: History, tab: true },
  { href: '/cashflow', label: 'Cashflow', icon: BarChart3, tab: false },
  { href: '/analytics', label: 'Analytics', icon: PieChart, tab: false },
];
