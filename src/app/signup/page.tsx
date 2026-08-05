'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';
import { Mail, Lock, User, TrendingUp, ArrowRight, Eye, EyeOff, CheckCircle } from 'lucide-react';

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

export default function SignupPage() {
  const { signup, signInWithGoogle, isAuthenticated, isLoading } = useAuth();
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [status, setStatus] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);

  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      router.push('/forecast');
    }
  }, [isAuthenticated, isLoading, router]);

  const passwordRequirements = [
    { label: 'At least 8 characters', met: password.length >= 8 },
    { label: 'Contains a number', met: /\d/.test(password) },
    { label: 'Contains a letter', met: /[a-zA-Z]/.test(password) },
  ];

  const isPasswordValid = passwordRequirements.every((req) => req.met);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setStatus('');


    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    if (!isPasswordValid) {
      setError('Please meet all password requirements');
      return;
    }

    setIsSubmitting(true);
    setStatus('Creating your account...');

    const result = await signup(name, email, password);
    
    if (result.success) {
      setSuccess('Account created successfully! Redirecting...');
      setStatus('');
      setTimeout(() => router.push('/forecast'), 1000);
    } else {
      setError(result.error || 'Signup failed. Please try again.');
      setStatus('');
    }
    
    setIsSubmitting(false);
  };

  const handleGoogleSignIn = async () => {
    setError('');
    setSuccess('');
    setStatus('');
    setIsGoogleLoading(true);
    setStatus('Connecting to Google...');

    const result = await signInWithGoogle();
    
    if (result.success) {
      setSuccess('Signed in with Google! Redirecting...');
      setStatus('');
      setTimeout(() => router.push('/forecast'), 1000);
    } else {
      setError(result.error || 'Google sign-in failed. Please try again.');
      setStatus('');
    }
    
    setIsGoogleLoading(false);
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse-glow w-16 h-16 rounded-2xl bg-gradient-to-br from-[var(--accent-primary)] to-[var(--accent-secondary)] flex items-center justify-center">
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
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-[var(--accent-primary)] to-[var(--accent-secondary)] mb-4 animate-float">
            <TrendingUp className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-3xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-[var(--accent-primary)] to-[var(--accent-secondary)]">
            CashFlow
          </h1>
          <p className="text-[var(--foreground-secondary)] mt-2">
            Start tracking your finances today
          </p>
        </div>

        {/* Signup Card */}
        <div className="glass-card p-8 animate-fade-in-up delay-100">
          <h2 className="text-2xl font-bold text-[var(--foreground)] mb-6">
            Create Account
          </h2>

          {/* Status Message */}
          {status && (
            <div role="alert" className="mb-6 p-4 rounded-xl bg-[var(--accent-primary)]/10 border border-[var(--accent-primary)]/30 text-[var(--accent-primary)] text-sm flex items-center gap-3">
              <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin flex-shrink-0" />
              {status}
            </div>
          )}

          {/* Success Message */}
          {success && (
            <div role="alert" className="mb-6 p-4 rounded-xl bg-[var(--accent-success)]/10 border border-[var(--accent-success)]/30 text-[var(--accent-success)] text-sm flex items-center gap-3">
              <CheckCircle className="w-4 h-4 flex-shrink-0" />
              {success}
            </div>
          )}

          {/* Error Message */}
          {error && (
            <div role="alert" className="mb-6 p-4 rounded-xl bg-[var(--accent-danger)]/10 border border-[var(--accent-danger)]/30 text-[var(--accent-danger)] text-sm">
              ⚠️ {error}
            </div>
          )}

          {/* Google Sign In Button */}
          <button
            type="button"
            onClick={handleGoogleSignIn}
            disabled={isGoogleLoading || isSubmitting}
            className="w-full flex items-center justify-center gap-3 py-3.5 px-4 rounded-xl bg-white text-gray-800 font-medium hover:bg-gray-50 transition-all disabled:opacity-50 disabled:cursor-not-allowed mb-6 border border-gray-200 shadow-sm"
          >
            {isGoogleLoading ? (
              <div className="w-5 h-5 border-2 border-gray-300 border-t-gray-800 rounded-full animate-spin" />
            ) : (
              <GoogleIcon />
            )}
            {isGoogleLoading ? 'Signing up...' : 'Continue with Google'}
          </button>

          {/* Divider */}
          <div className="relative mb-6">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-[var(--border-color)]" />
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="px-4 bg-[var(--background-secondary)] text-[var(--foreground-muted)]">
                or sign up with email
              </span>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label htmlFor="signup-name" className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
                Full Name
              </label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--foreground-muted)] pointer-events-none" />
                <input
                  id="signup-name"
                  name="name"
                  type="text"
                  autoComplete="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Enter your full name"
                  className="input-field pl-12"
                  required
                />
              </div>
            </div>

            <div>
              <label htmlFor="signup-email" className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
                Email Address
              </label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--foreground-muted)] pointer-events-none" />
                <input
                  id="signup-email"
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
              <label htmlFor="signup-password" className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
                Password
              </label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--foreground-muted)] pointer-events-none" />
                <input
                  id="signup-password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Create a secure password"
                  className="input-field pl-12 pr-12"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  aria-pressed={showPassword}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--foreground-muted)] hover:text-[var(--foreground)] transition-colors"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              
              {/* Password requirements */}
              {password && (
                <div className="mt-3 space-y-2">
                  {passwordRequirements.map((req, index) => (
                    <div key={index} className="flex items-center gap-2 text-sm">
                      <CheckCircle
                        className={`w-4 h-4 ${
                          req.met ? 'text-[var(--accent-success)]' : 'text-[var(--foreground-muted)]'
                        }`}
                      />
                      <span
                        className={
                          req.met ? 'text-[var(--accent-success)]' : 'text-[var(--foreground-muted)]'
                        }
                      >
                        {req.label}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <label htmlFor="signup-confirm-password" className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
                Confirm Password
              </label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--foreground-muted)] pointer-events-none" />
                <input
                  id="signup-confirm-password"
                  name="confirmPassword"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  enterKeyHint="go"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Confirm your password"
                  className="input-field pl-12"
                  required
                />
              </div>
              {confirmPassword && password !== confirmPassword && (
                <p className="mt-2 text-sm text-[var(--accent-danger)]">
                  Passwords do not match
                </p>
              )}
            </div>

            <button
              type="submit"
              disabled={isSubmitting || !isPasswordValid || isGoogleLoading}
              className="btn-primary w-full flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSubmitting ? (
                'Creating account...'
              ) : (
                <>
                  Create Account
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>

          <p className="mt-6 text-center text-[var(--foreground-secondary)]">
            Already have an account?{' '}
            <Link
              href="/login"
              className="text-[var(--accent-primary)] hover:text-[var(--accent-secondary)] font-medium transition-colors"
            >
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </main>
  );
}
