'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import LogoMark from '@/components/LogoMark';
import { useAuth } from '@/context/AuthContext';
import {
  CreditCard,
  LogOut,
  Menu,
  X,
  Settings,
  ChevronDown,
  Sparkles,
} from 'lucide-react';
import { NAV_ITEMS, SECONDARY_ITEMS } from '@/lib/nav';
import DataChatSheet from '@/components/DataChatSheet';
import { onAsk } from '@/lib/ask';

export default function Navbar() {
  const { user, logout } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);
  const [isChatOpen, setIsChatOpen] = useState(false);
  // Set when something on the page asked on the owner's behalf; cleared when they
  // open the chat themselves, so the old question is not re-asked.
  const [chatSeed, setChatSeed] = useState<string | undefined>(undefined);

  // Anything on the page can ask on the owner's behalf — a Sankey node, an unmapped
  // group. The chat panel lives here, so the listener does too.
  useEffect(() => onAsk((question) => { setChatSeed(question); setIsChatOpen(true); }), []);

  // Single source of truth (src/lib/nav.ts) — BottomNav consumes the same list.
  const navItems = NAV_ITEMS;

  const isActive = (path: string) => pathname === path;

  const handleLogout = async () => {
    await logout();
    router.push('/login');
  };

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 bg-[var(--background)]/80 backdrop-blur-xl border-b border-[var(--border-color)]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">
          {/* Logo */}
          <Link href="/dashboard" className="flex items-center gap-3 group min-h-[44px] min-w-[44px]">
            <div className="w-9 h-9 rounded-card flex items-center justify-center group-hover:scale-105 transition-transform relative overflow-hidden">
              <LogoMark size={36} />
            </div>
            <div className="hidden sm:block">
              {/* UI-101: chrome carries no numbers — the budget lives on the screens
                  that compute it, not in a second copy up here. */}
              <span className="text-lg font-bold text-[var(--foreground)]">Cash<span style={{ color: 'var(--accent-secondary)' }}>Flow</span></span>
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
                  className={`flex items-center gap-2 px-4 min-h-[44px] rounded-control transition-all ${
                    isActive(item.href)
                      ? 'bg-[var(--accent-primary)] text-[#16181c]'
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
            <button
              onClick={() => { setChatSeed(undefined); setIsChatOpen(true); }}
              aria-label="Ask about your data"
              className="w-11 h-11 flex items-center justify-center rounded-control text-[var(--foreground-secondary)] hover:text-[var(--accent-primary)] hover:bg-[var(--background-tertiary)] transition-colors"
            >
              <Sparkles className="w-5 h-5" aria-hidden="true" />
            </button>

            {/* UI-101: the balance pill is gone — it was a SECOND computation of the
                dashboard's figure (two reducers, one number, guaranteed drift).
                Numbers live on screens; chrome navigates. */}

            {/* User Dropdown */}
            <div className="relative">
              <button
                onClick={() => setIsUserMenuOpen(!isUserMenuOpen)}
                className="flex items-center gap-3 px-3 min-h-[44px] rounded-control hover:bg-[var(--background-tertiary)] transition-colors"
              >
                <div className="w-8 h-8 rounded-pill bg-gradient-to-br from-[var(--accent-primary)] to-[var(--accent-secondary)] flex items-center justify-center text-[#16181c] font-semibold text-sm">
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
                  <div className="absolute right-0 mt-2 w-56 rounded-card bg-[var(--background-secondary)] border border-[var(--border-color)] shadow-lg z-20 overflow-hidden">
                    <div className="p-3 border-b border-[var(--border-color)]">
                      <p className="font-medium text-[var(--foreground)]">{user?.name}</p>
                      <p className="text-sm text-[var(--foreground-muted)]">{user?.email}</p>
                    </div>
                    <div className="p-2">
                      <Link
                        href="/settings"
                        onClick={() => setIsUserMenuOpen(false)}
                        className="flex items-center gap-3 px-3 min-h-[44px] rounded-control text-[var(--foreground-secondary)] hover:bg-[var(--background-tertiary)] hover:text-[var(--foreground)] transition-colors"
                      >
                        <Settings className="w-4 h-4" />
                        <span className="text-sm">Settings</span>
                      </Link>
                      <Link
                        href="/accounts"
                        onClick={() => setIsUserMenuOpen(false)}
                        className="flex items-center gap-3 px-3 min-h-[44px] rounded-control text-[var(--foreground-secondary)] hover:bg-[var(--background-tertiary)] hover:text-[var(--foreground)] transition-colors"
                      >
                        <CreditCard className="w-4 h-4" />
                        <span className="text-sm">Manage Accounts</span>
                      </Link>
                      {/* UI-101: interim home for the routes the FAB used to carry —
                          each disappears as UI-103/104 fold its body into a tab. */}
                      <div className="my-1 border-t border-[var(--border-color)]" />
                      {SECONDARY_ITEMS.map(({ href, label, icon: SecIcon }) => (
                        <Link
                          key={href}
                          href={href}
                          onClick={() => setIsUserMenuOpen(false)}
                          className="flex items-center gap-3 px-3 min-h-[44px] rounded-control text-[var(--foreground-secondary)] hover:bg-[var(--background-tertiary)] hover:text-[var(--foreground)] transition-colors"
                        >
                          <SecIcon className="w-4 h-4" />
                          <span className="text-sm">{label}</span>
                        </Link>
                      ))}
                    </div>
                    <div className="p-2 border-t border-[var(--border-color)]">
                      <button
                        onClick={() => {
                          setIsUserMenuOpen(false);
                          handleLogout();
                        }}
                        className="flex items-center gap-3 w-full px-3 min-h-[44px] rounded-control text-[var(--accent-danger)] hover:bg-[var(--accent-danger)]/10 transition-colors"
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

          {/* Mobile: chat + menu */}
          <div className="md:hidden flex items-center gap-1">
            <button
              onClick={() => { setChatSeed(undefined); setIsChatOpen(true); }}
              aria-label="Ask about your data"
              className="w-11 h-11 flex items-center justify-center rounded-control text-[var(--foreground-secondary)] hover:bg-[var(--background-tertiary)]"
            >
              <Sparkles className="w-6 h-6" aria-hidden="true" />
            </button>
            <button
              className="w-11 h-11 flex items-center justify-center rounded-control text-[var(--foreground-secondary)] hover:bg-[var(--background-tertiary)]"
              aria-label={isMobileMenuOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={isMobileMenuOpen}
              onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
            >
              {isMobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
            </button>
          </div>
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
                  className={`flex items-center gap-3 px-4 py-3 rounded-card transition-all ${
                    isActive(item.href)
                      ? 'bg-[var(--accent-primary)] text-[#16181c]'
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
                  <div className="w-10 h-10 rounded-pill bg-gradient-to-br from-[var(--accent-primary)] to-[var(--accent-secondary)] flex items-center justify-center text-white font-medium">
                    {user?.name?.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <p className="font-medium text-[var(--foreground)]">{user?.name}</p>
                    <p className="text-sm text-[var(--foreground-secondary)]">{user?.email}</p>
                  </div>
                </div>
              </div>
              
              {/* UI-101: interim home for the ex-FAB routes (die with UI-103/104) */}
              {SECONDARY_ITEMS.map(({ href, label, icon: SecIcon }) => (
                <Link
                  key={href}
                  href={href}
                  onClick={() => setIsMobileMenuOpen(false)}
                  className="flex items-center gap-3 px-4 py-3 rounded-card text-[var(--foreground-secondary)] hover:text-[var(--foreground)] hover:bg-[var(--background-tertiary)] transition-all"
                >
                  <SecIcon className="w-5 h-5" />
                  <span className="font-medium">{label}</span>
                </Link>
              ))}

              <Link
                href="/settings"
                onClick={() => setIsMobileMenuOpen(false)}
                className="flex items-center gap-3 px-4 py-3 rounded-card text-[var(--foreground-secondary)] hover:text-[var(--foreground)] hover:bg-[var(--background-tertiary)] transition-all"
              >
                <Settings className="w-5 h-5" />
                <span className="font-medium">Settings</span>
              </Link>
              
              <button
                onClick={() => {
                  setIsMobileMenuOpen(false);
                  handleLogout();
                }}
                className="flex items-center gap-3 w-full px-4 py-3 rounded-card text-[var(--accent-danger)] hover:bg-[var(--accent-danger)]/10 transition-all"
              >
                <LogOut className="w-5 h-5" />
                <span className="font-medium">Logout</span>
              </button>
            </div>
          </div>
        </div>
      )}

      <DataChatSheet open={isChatOpen} seed={chatSeed} onClose={() => setIsChatOpen(false)} />
    </nav>
  );
}
