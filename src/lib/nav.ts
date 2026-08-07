import {
  LayoutDashboard, LineChart, GitBranch, History, CreditCard,
  type LucideIcon,
} from 'lucide-react';

/**
 * Four primary destinations, organised by the question's tense (UX-IA-001).
 *
 *   Overview   now     "Am I OK right now?"
 *   Forecast   later   "Will I be OK?"
 *   Flow       past    "Where did it actually go?"
 *   Accounts   —       "What do I own and owe?"
 *
 * There were seven, and four of them — History, Analytics, Cashflow, Calendar — are
 * float re-derivations of the same `transactions` array that Flow already reads in
 * integer cents. That is why a total on one screen can disagree with the same total
 * on another. They are SECONDARY now: reached from inside the primary four, never
 * from the nav bar. /calendar was in no list at all and reachable only by URL.
 *
 * Every shipped screen must appear in one of these two lists — a route in neither is
 * unreachable.
 */
export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Show in the mobile bottom tab bar (max 5). */
  tab: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { href: '/dashboard', label: 'Home', icon: LayoutDashboard, tab: true },
  { href: '/forecast', label: 'Forecast', icon: LineChart, tab: true },
  { href: '/history', label: 'Activity', icon: History, tab: true },
  { href: '/flow', label: 'Flow', icon: GitBranch, tab: true },
  { href: '/accounts', label: 'Accounts', icon: CreditCard, tab: true },
];

/**
 * Reached from Flow, which owns the past ledger. Still their own routes, so existing
 * links and bookmarks keep working; folding their bodies into Flow tabs is the next
 * step and deletes the duplicate float arithmetic along with them.
 */
/**
 * UI-103/104 retired the four secondary routes: analytics, cashflow and
 * calendar are redirects into tabs now, and history is the primary Activity
 * destination. Kept as an (empty) list so the Navbar's interim rendering and
 * the chrome contract stay stable; delete outright when nothing imports it.
 */
export const SECONDARY_ITEMS: NavItem[] = [];
