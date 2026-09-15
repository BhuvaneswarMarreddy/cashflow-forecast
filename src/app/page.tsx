'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { useUserProfile } from '@/context/UserProfileContext';
import LoadingScreen from '@/components/LoadingScreen';

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
    <LoadingScreen />
  );
}
