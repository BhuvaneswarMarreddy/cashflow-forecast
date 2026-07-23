'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { useUserProfile } from '@/context/UserProfileContext';
import { useTransactions } from '@/context/TransactionContext';
import { withDerivedBalances } from '@/lib/forecast';
import {
  LayoutDashboard,
  Calendar,
  CreditCard,
  LogOut,
  TrendingUp,
  Menu,
  X,
  Settings,
  User,
  ChevronDown,
  LineChart,
  History,
  BarChart3,
  GitBranch,
} from 'lucide-react';

export default function Navbar() {
  const { user, logout } = useAuth();
  const { profile } = useUserProfile();
  const { transactions } = useTransactions();
  const pathname = usePathname();
  const router = useRouter();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);

  // Core navigation: Focused on what helps users decide TODAY
  // Forecast is primary - it answers "Can I spend this?"
  // Analytics removed from primary nav - it's backward-looking, not decision-focused
  const navItems = [
    { href: '/forecast', label: 'Forecast', icon: LineChart },
    { href: '/cashflow', label: 'Cashflow', icon: BarChart3 },
    { href: '/flow', label: 'Flow', icon: GitBranch },
    { href: '/dashboard', label: 'Overview', icon: LayoutDashboard },
    { href: '/history', label: 'History', icon: History },
    { href: '/accounts', label: 'Accounts', icon: CreditCard },
  ];

  const isActive = (path: string) => pathname === path;

  const handleLogout = async () => {
    await logout();
    router.push('/login');
  };

  // Calculate total balance across all accounts, from balances derived off linked
  // transactions (opening balance + past effects) rather than the stored opening figure.
  const totalBalance = withDerivedBalances(profile?.paymentAccounts || [], transactions).reduce((sum, acc) => {
    // Cards AND loans are debt (balance = what you owe), so they subtract from net worth.
    if (acc.type === 'credit_card' || acc.type === 'personal_loan') {
      return sum - acc.balance;
    }
    return sum + acc.balance;
  }, 0);

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 bg-[var(--background)]/80 backdrop-blur-xl border-b border-[var(--border-color)]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">
          {/* Logo */}
          <Link href="/dashboard" className="flex items-center gap-3 group">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center group-hover:scale-105 transition-transform relative overflow-hidden">
              <Image
                src="/logos/logo-icon-v2.png"
                alt="CashFlow Forecast"
                width={36}
                height={36}
                className="object-contain"
                priority
                unoptimized
              />
            </div>
            <div className="hidden sm:block">
              <span className="text-lg font-bold text-[var(--foreground)]">CashFlow</span>
              {profile?.monthlyBudget ? (
                <p className="text-xs text-[var(--foreground-muted)]">
                  Budget: ${profile.monthlyBudget.toLocaleString()}/mo
                </p>
              ) : null}
            </div>
          </Link>

          {/* Desktop Navigation */}
          <div className="hidden md:flex items-center gap-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-all ${
                    isActive(item.href)
                      ? 'bg-[var(--accent-primary)] text-white'
                      : 'text-[var(--foreground-secondary)] hover:text-[var(--foreground)] hover:bg-[var(--background-tertiary)]'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  <span className="font-medium text-sm">{item.label}</span>
                </Link>
              );
            })}
          </div>

          {/* Right Side - User Menu */}
          <div className="hidden md:flex items-center gap-4">
            {/* Balance Display */}
            {profile?.paymentAccounts && profile.paymentAccounts.length > 0 && (
              <div className="text-right px-4 py-2 rounded-lg bg-[var(--background-tertiary)]">
                <p className="text-xs text-[var(--foreground-muted)]">Net Balance</p>
                <p className={`font-semibold ${totalBalance >= 0 ? 'text-[var(--accent-success)]' : 'text-[var(--accent-danger)]'}`}>
                  ${Math.abs(totalBalance).toLocaleString()}
                </p>
              </div>
            )}

            {/* User Dropdown */}
            <div className="relative">
              <button
                onClick={() => setIsUserMenuOpen(!isUserMenuOpen)}
                className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-[var(--background-tertiary)] transition-colors"
              >
                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[var(--accent-primary)] to-[var(--accent-secondary)] flex items-center justify-center text-white font-medium text-sm">
                  {user?.name?.charAt(0).toUpperCase()}
                </div>
                <div className="text-left hidden lg:block">
                  <p className="text-sm font-medium text-[var(--foreground)] line-clamp-1">
                    {user?.name}
                  </p>
                  <p className="text-xs text-[var(--foreground-muted)] line-clamp-1">
                    {user?.email}
                  </p>
                </div>
                <ChevronDown className={`w-4 h-4 text-[var(--foreground-muted)] transition-transform ${isUserMenuOpen ? 'rotate-180' : ''}`} />
              </button>

              {/* Dropdown Menu */}
              {isUserMenuOpen && (
                <>
                  <div 
                    className="fixed inset-0 z-10" 
                    onClick={() => setIsUserMenuOpen(false)}
                  />
                  <div className="absolute right-0 mt-2 w-56 rounded-xl bg-[var(--background-secondary)] border border-[var(--border-color)] shadow-lg z-20 overflow-hidden">
                    <div className="p-3 border-b border-[var(--border-color)]">
                      <p className="font-medium text-[var(--foreground)]">{user?.name}</p>
                      <p className="text-sm text-[var(--foreground-muted)]">{user?.email}</p>
                    </div>
                    <div className="p-2">
                      <Link
                        href="/settings"
                        onClick={() => setIsUserMenuOpen(false)}
                        className="flex items-center gap-3 px-3 py-2 rounded-lg text-[var(--foreground-secondary)] hover:bg-[var(--background-tertiary)] hover:text-[var(--foreground)] transition-colors"
                      >
                        <Settings className="w-4 h-4" />
                        <span className="text-sm">Settings</span>
                      </Link>
                      <Link
                        href="/accounts"
                        onClick={() => setIsUserMenuOpen(false)}
                        className="flex items-center gap-3 px-3 py-2 rounded-lg text-[var(--foreground-secondary)] hover:bg-[var(--background-tertiary)] hover:text-[var(--foreground)] transition-colors"
                      >
                        <CreditCard className="w-4 h-4" />
                        <span className="text-sm">Manage Accounts</span>
                      </Link>
                    </div>
                    <div className="p-2 border-t border-[var(--border-color)]">
                      <button
                        onClick={() => {
                          setIsUserMenuOpen(false);
                          handleLogout();
                        }}
                        className="flex items-center gap-3 w-full px-3 py-2 rounded-lg text-[var(--accent-danger)] hover:bg-[var(--accent-danger)]/10 transition-colors"
                      >
                        <LogOut className="w-4 h-4" />
                        <span className="text-sm">Logout</span>
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Mobile Menu Button */}
          <button
            className="md:hidden p-2 rounded-lg text-[var(--foreground-secondary)] hover:bg-[var(--background-tertiary)]"
            onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
          >
            {isMobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
          </button>
        </div>
      </div>

      {/* Mobile Menu */}
      {isMobileMenuOpen && (
        <div className="md:hidden border-t border-[var(--border-color)] bg-[var(--background)]">
          <div className="px-4 py-4 space-y-2">
            {navItems.map((item) => {
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setIsMobileMenuOpen(false)}
                  className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${
                    isActive(item.href)
                      ? 'bg-[var(--accent-primary)] text-white'
                      : 'text-[var(--foreground-secondary)] hover:text-[var(--foreground)] hover:bg-[var(--background-tertiary)]'
                  }`}
                >
                  <Icon className="w-5 h-5" />
                  <span className="font-medium">{item.label}</span>
                </Link>
              );
            })}
            
            <div className="pt-4 mt-4 border-t border-[var(--border-color)]">
              <div className="px-4 py-2 mb-2">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[var(--accent-primary)] to-[var(--accent-secondary)] flex items-center justify-center text-white font-medium">
                    {user?.name?.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <p className="font-medium text-[var(--foreground)]">{user?.name}</p>
                    <p className="text-sm text-[var(--foreground-secondary)]">{user?.email}</p>
                  </div>
                </div>
              </div>
              
              <Link
                href="/settings"
                onClick={() => setIsMobileMenuOpen(false)}
                className="flex items-center gap-3 px-4 py-3 rounded-xl text-[var(--foreground-secondary)] hover:text-[var(--foreground)] hover:bg-[var(--background-tertiary)] transition-all"
              >
                <Settings className="w-5 h-5" />
                <span className="font-medium">Settings</span>
              </Link>
              
              <button
                onClick={() => {
                  setIsMobileMenuOpen(false);
                  handleLogout();
                }}
                className="flex items-center gap-3 w-full px-4 py-3 rounded-xl text-[var(--accent-danger)] hover:bg-[var(--accent-danger)]/10 transition-all"
              >
                <LogOut className="w-5 h-5" />
                <span className="font-medium">Logout</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </nav>
  );
}
