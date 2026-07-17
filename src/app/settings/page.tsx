'use client';

import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { useUserProfile } from '@/context/UserProfileContext';
import { useTransactions } from '@/context/TransactionContext';
import Navbar from '@/components/Navbar';
import ExportButton from '@/components/ExportButton';
import {
  TrendingUp,
  User,
  Mail,
  Settings,
  Bell,
  Shield,
  Trash2,
  LogOut,
  ChevronRight,
  Save,
  Check,
  Download,
} from 'lucide-react';

export default function SettingsPage() {
  const { user, isAuthenticated, isLoading: authLoading, logout, updateUserProfile } = useAuth();
  const { profile, isLoading: profileLoading, updateProfile } = useUserProfile();
  const { transactions } = useTransactions();
  const router = useRouter();
  
  const [name, setName] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      router.push('/login');
    }
  }, [isAuthenticated, authLoading, router]);

  useEffect(() => {
    if (user?.name) {
      setName(user.name);
    }
  }, [user?.name]);

  if (authLoading || profileLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="bg-pattern" />
        <div className="animate-pulse-glow w-16 h-16 rounded-2xl bg-gradient-to-br from-[var(--accent-primary)] to-[var(--accent-secondary)] flex items-center justify-center">
          <TrendingUp className="w-8 h-8 text-white" />
        </div>
      </div>
    );
  }

  const handleSaveProfile = async () => {
    setIsSaving(true);
    try {
      await updateUserProfile(name);
      setSaveMessage('Profile updated successfully!');
      setTimeout(() => setSaveMessage(''), 3000);
    } catch (error) {
      setSaveMessage('Failed to update profile');
    } finally {
      setIsSaving(false);
    }
  };

  const handleLogout = async () => {
    await logout();
    router.push('/login');
  };

  const settingsSections = [
    {
      title: 'Account',
      items: [
        {
          icon: User,
          label: 'Profile Information',
          description: 'Update your name and personal details',
          action: 'profile',
          href: '',
        },
      ],
    },
    {
      title: 'Financial',
      items: [
        {
          icon: Settings,
          label: 'Accounts & Budget',
          description: 'Manage payment accounts, income, and budget',
          href: '/accounts',
        },
      ],
    },
    {
      title: 'Data',
      items: [
        {
          icon: Download,
          label: 'Export Data',
          description: 'Download all your data as Excel file',
          action: 'export',
          href: '',
        },
      ],
    },
  ];

  return (
    <div className="min-h-screen relative">
      <div className="bg-pattern" />
      <Navbar />
      
      <main className="pt-24 pb-12 px-4 sm:px-6 lg:px-8 max-w-3xl mx-auto relative z-10">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-[var(--foreground)]">Settings</h1>
          <p className="text-[var(--foreground-secondary)] mt-1">
            Manage your account and preferences
          </p>
        </div>

        {/* Profile Card */}
        <div className="glass-card p-6 mb-6">
          <div className="flex items-center gap-4 mb-6">
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-[var(--accent-primary)] to-[var(--accent-secondary)] flex items-center justify-center text-white text-2xl font-bold">
              {user?.name?.charAt(0).toUpperCase()}
            </div>
            <div>
              <h2 className="text-xl font-semibold text-[var(--foreground)]">{user?.name}</h2>
              <p className="text-[var(--foreground-secondary)]">{user?.email}</p>
            </div>
          </div>

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
                Display Name
              </label>
              <div className="relative">
                <User className="absolute left-[1.1rem] top-1/2 -translate-y-1/2 w-5 h-5 text-[var(--foreground-muted)]" />
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="input-field pl-[3.25rem]"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
                Email Address
              </label>
              <div className="relative">
                <Mail className="absolute left-[1.1rem] top-1/2 -translate-y-1/2 w-5 h-5 text-[var(--foreground-muted)]" />
                <input
                  type="email"
                  value={user?.email || ''}
                  disabled
                  className="input-field pl-[3.25rem] opacity-60 cursor-not-allowed"
                />
              </div>
              <p className="text-xs text-[var(--foreground-muted)] mt-1">
                Email cannot be changed
              </p>
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={handleSaveProfile}
                disabled={isSaving || name === user?.name}
                className="btn-primary flex items-center gap-2 disabled:opacity-50"
              >
                {isSaving ? (
                  <>Saving...</>
                ) : (
                  <>
                    <Save className="w-4 h-4" />
                    Save Changes
                  </>
                )}
              </button>
              {saveMessage && (
                <span className={`text-sm flex items-center gap-1 ${saveMessage.includes('success') ? 'text-[var(--accent-success)]' : 'text-[var(--accent-danger)]'}`}>
                  {saveMessage.includes('success') && <Check className="w-4 h-4" />}
                  {saveMessage}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Settings Sections */}
        {settingsSections.map((section) => (
          <div key={section.title} className="mb-6">
            <h3 className="text-sm font-medium text-[var(--foreground-muted)] uppercase tracking-wide mb-3">
              {section.title}
            </h3>
            <div className="glass-card overflow-hidden">
              {section.items.map((item, index) => {
                const Icon = item.icon;
                
                // Special handling for Export
                if ('action' in item && item.action === 'export') {
                  return (
                    <div key={item.label} className="p-4">
                      <ExportButton
                        profile={profile}
                        transactions={transactions}
                      />
                    </div>
                  );
                }
                
                return (
                  <button
                    key={item.label}
                    onClick={() => 'href' in item && item.href && router.push(item.href)}
                    className={`w-full flex items-center justify-between p-4 hover:bg-[var(--background-tertiary)] transition-colors ${
                      index !== section.items.length - 1 ? 'border-b border-[var(--border-color)]' : ''
                    }`}
                  >
                    <div className="flex items-center gap-4">
                      <div className="w-10 h-10 rounded-xl bg-[var(--background-tertiary)] flex items-center justify-center">
                        <Icon className="w-5 h-5 text-[var(--foreground-secondary)]" />
                      </div>
                      <div className="text-left">
                        <p className="font-medium text-[var(--foreground)]">{item.label}</p>
                        <p className="text-sm text-[var(--foreground-muted)]">{item.description}</p>
                      </div>
                    </div>
                    <ChevronRight className="w-5 h-5 text-[var(--foreground-muted)]" />
                  </button>
                );
              })}
            </div>
          </div>
        ))}

        {/* Danger Zone */}
        <div className="mt-8">
          <h3 className="text-sm font-medium text-[var(--accent-danger)] uppercase tracking-wide mb-3">
            Danger Zone
          </h3>
          <div className="glass-card p-4">
            <button
              onClick={handleLogout}
              className="w-full flex items-center justify-between p-4 rounded-xl hover:bg-[var(--accent-danger)]/10 transition-colors"
            >
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 rounded-xl bg-[var(--accent-danger)]/20 flex items-center justify-center">
                  <LogOut className="w-5 h-5 text-[var(--accent-danger)]" />
                </div>
                <div className="text-left">
                  <p className="font-medium text-[var(--accent-danger)]">Sign Out</p>
                  <p className="text-sm text-[var(--foreground-muted)]">Log out of your account</p>
                </div>
              </div>
              <ChevronRight className="w-5 h-5 text-[var(--accent-danger)]" />
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}

