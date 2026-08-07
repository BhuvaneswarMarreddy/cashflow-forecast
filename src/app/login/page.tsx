'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { Mail, Lock, TrendingUp, ArrowRight, Eye, EyeOff } from 'lucide-react';

// Google Icon Component
const GoogleIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" xmlns="http://www.w3.org/2000/svg">
    <g transform="matrix(1, 0, 0, 1, 0, 0)">
      <path fill="#EA4335" d="M12 5.04c1.65 0 3.08.55 4.23 1.63l3.14-3.14C17.46 1.69 14.96.5 12 .5 7.39.5 3.43 3.16 1.55 7.04l3.66 2.84C6.16 7.17 8.83 5.04 12 5.04z"/>
      <path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58l3.66 2.84c2.14-1.97 3.76-4.89 3.76-8.66z"/>
      <path fill="#FBBC05" d="M5.21 14.12c-.32-.94-.5-1.95-.5-2.99 0-1.04.18-2.05.5-2.99L1.55 5.3C.56 7.26 0 9.55 0 12s.56 4.74 1.55 6.7l3.66-2.84z"/>
      <path fill="#34A853" d="M12 23.5c3.03 0 5.57-1 7.43-2.73l-3.66-2.84c-1.01.68-2.31 1.08-3.77 1.08-3.17 0-5.84-2.13-6.79-4.98l-3.66 2.84C3.43 20.84 7.39 23.5 12 23.5z"/>
    </g>
  </svg>
);

export default function LoginPage() {
  const { login, signInWithGoogle, isAuthenticated, isLoading } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);

  // Redirect to Forecast - the core decision-making screen
  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      router.push('/forecast');
    }
  }, [isAuthenticated, isLoading, router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsSubmitting(true);

    const result = await login(email, password);
    
    if (result.success) {
      router.push('/forecast');
    } else {
      setError(result.error || 'Login failed');
    }
    
    setIsSubmitting(false);
  };

  const handleGoogleSignIn = async () => {
    setError('');
    setIsGoogleLoading(true);

    const result = await signInWithGoogle();
    
    if (result.success) {
      router.push('/forecast');
    } else {
      setError(result.error || 'Google sign-in failed');
    }
    
    setIsGoogleLoading(false);
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse-glow w-16 h-16 rounded-card bg-gradient-to-br from-[var(--accent-primary)] to-[var(--accent-secondary)] flex items-center justify-center">
          <TrendingUp className="w-8 h-8 text-white" />
        </div>
      </div>
    );
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-4 relative">
      {/* Background pattern */}
      <div className="bg-pattern" />

      <div className="w-full max-w-md relative z-10">
        {/* Logo */}
        <div className="text-center mb-8 animate-fade-in-up">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-card bg-gradient-to-br from-[var(--accent-primary)] to-[var(--accent-secondary)] mb-4 animate-float">
            <TrendingUp className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-3xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-[var(--accent-primary)] to-[var(--accent-secondary)]">
            CashFlow
          </h1>
          <p className="text-[var(--foreground-secondary)] mt-2">
            Track expenses, forecast your future
          </p>
        </div>

        {/* Login Card */}
        <div className="glass-card p-8 animate-fade-in-up delay-100">
          <h2 className="text-2xl font-bold text-[var(--foreground)] mb-6">
            Welcome Back
          </h2>

          {error && (
            <div role="alert" className="mb-6 p-4 rounded-card bg-[var(--accent-danger)]/10 border border-[var(--accent-danger)]/30 text-[var(--accent-danger)] text-sm">
              {error}
            </div>
          )}

          {/* Google Sign In Button */}
          <button
            type="button"
            onClick={handleGoogleSignIn}
            disabled={isGoogleLoading || isSubmitting}
            className="w-full flex items-center justify-center gap-3 py-3.5 px-4 rounded-card bg-white text-gray-800 font-medium hover:bg-gray-50 transition-all disabled:opacity-50 disabled:cursor-not-allowed mb-6 border border-gray-200 shadow-sm"
          >
            {isGoogleLoading ? (
              <div className="w-5 h-5 border-2 border-gray-300 border-t-gray-800 rounded-pill animate-spin" />
            ) : (
              <GoogleIcon />
            )}
            {isGoogleLoading ? 'Signing in...' : 'Continue with Google'}
          </button>

          {/* Divider */}
          <div className="relative mb-6">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-[var(--border-color)]" />
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="px-4 bg-[var(--background-secondary)] text-[var(--foreground-muted)]">
                or sign in with email
              </span>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label htmlFor="login-email" className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
                Email Address
              </label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--foreground-muted)] pointer-events-none" />
                <input
                  id="login-email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="input-field pl-12"
                  required
                />
              </div>
            </div>

            <div>
              <div className="flex justify-between items-center mb-2">
                <label htmlFor="login-password" className="text-sm font-medium text-[var(--foreground-secondary)]">
                  Password
                </label>
                <Link
                  href="/forgot-password"
                  className="text-sm text-[var(--accent-primary)] hover:text-[var(--accent-secondary)] transition-colors"
                >
                  Forgot password?
                </Link>
              </div>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--foreground-muted)] pointer-events-none" />
                <input
                  id="login-password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  enterKeyHint="go"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password"
                  className="input-field pl-12 pr-12"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  aria-pressed={showPassword}
                  className="absolute right-0 top-1/2 -translate-y-1/2 min-h-[44px] min-w-[44px] flex items-center justify-center text-[var(--foreground-muted)] hover:text-[var(--foreground)] transition-colors"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={isSubmitting || isGoogleLoading}
              className="btn-primary w-full flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSubmitting ? (
                'Signing in...'
              ) : (
                <>
                  Sign In
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>

          <p className="mt-6 text-center text-[var(--foreground-secondary)]">
            Don&apos;t have an account?{' '}
            <Link
              href="/signup"
              className="text-[var(--accent-primary)] hover:text-[var(--accent-secondary)] font-medium transition-colors"
            >
              Sign up
            </Link>
          </p>
        </div>

        {/* Demo hint */}
        <p className="text-center text-[var(--foreground-muted)] text-sm mt-6 animate-fade-in-up delay-300">
          New here? Create an account to get started with sample data.
        </p>
      </div>
    </main>
  );
}
