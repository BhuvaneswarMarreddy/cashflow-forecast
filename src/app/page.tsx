'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { useUserProfile } from '@/context/UserProfileContext';
import { TrendingUp } from 'lucide-react';

export default function Home() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const { isOnboarded, isLoading: profileLoading } = useUserProfile();
  const router = useRouter();
  const hasRedirected = useRef(false);

  useEffect(() => {
    // Don't redirect if already done
    if (hasRedirected.current) return;

    // Don't redirect if auth is still loading
    if (authLoading) return;

    // If not authenticated, go to login immediately
    if (!isAuthenticated) {
      hasRedirected.current = true;
      router.replace('/login');
      return;
    }

    // If profile is loading, give it a short window then proceed
    // With localStorage-first, this should be instant
    if (profileLoading) {
      // Short timeout - if profile hasn't loaded in 500ms, go to dashboard
      const timeout = setTimeout(() => {
        if (!hasRedirected.current) {
          hasRedirected.current = true;
          router.replace('/dashboard');
        }
      }, 500);
      return () => clearTimeout(timeout);
    }

    // Authenticated and profile loaded - decide where to go
    hasRedirected.current = true;
    if (!isOnboarded) {
      router.replace('/onboarding');
    } else {
      router.replace('/dashboard');
    }
  }, [isAuthenticated, isOnboarded, authLoading, profileLoading, router]);

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="bg-pattern" />
      <div className="animate-pulse-glow w-20 h-20 rounded-card bg-gradient-to-br from-[var(--accent-primary)] to-[var(--accent-secondary)] flex items-center justify-center">
        <TrendingUp className="w-10 h-10 text-white" />
      </div>
    </div>
  );
}
