'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/context/AuthContext';
import { Mail, TrendingUp, ArrowRight, ArrowLeft, CheckCircle, KeyRound } from 'lucide-react';

export default function ForgotPasswordPage() {
  const { resetPassword } = useAuth();
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsSubmitting(true);

    const result = await resetPassword(email);
    
    if (result.success) {
      setSuccess(true);
    } else {
      setError(result.error || 'Failed to send reset email');
    }
    
    setIsSubmitting(false);
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 relative">
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
        </div>

        {/* Reset Card */}
        <div className="glass-card p-8 animate-fade-in-up delay-100">
          {success ? (
            <div className="text-center">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-[var(--accent-success)]/20 mb-4">
                <CheckCircle className="w-8 h-8 text-[var(--accent-success)]" />
              </div>
              <h2 className="text-2xl font-bold text-[var(--foreground)] mb-2">
                Check Your Email
              </h2>
              <p className="text-[var(--foreground-secondary)] mb-6">
                We&apos;ve sent a password reset link to <strong>{email}</strong>. 
                Please check your inbox and follow the instructions to reset your password.
              </p>
              <p className="text-sm text-[var(--foreground-muted)] mb-6">
                Didn&apos;t receive the email? Check your spam folder or try again.
              </p>
              <div className="space-y-3">
                <button
                  onClick={() => {
                    setSuccess(false);
                    setEmail('');
                  }}
                  className="btn-secondary w-full flex items-center justify-center gap-2"
                >
                  <ArrowLeft className="w-4 h-4" />
                  Try Another Email
                </button>
                <Link
                  href="/login"
                  className="btn-primary w-full flex items-center justify-center gap-2"
                >
                  Back to Login
                  <ArrowRight className="w-4 h-4" />
                </Link>
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-4 mb-6">
                <div className="w-12 h-12 rounded-xl bg-[var(--accent-warning)]/20 flex items-center justify-center">
                  <KeyRound className="w-6 h-6 text-[var(--accent-warning)]" />
                </div>
                <div>
                  <h2 className="text-2xl font-bold text-[var(--foreground)]">
                    Forgot Password?
                  </h2>
                  <p className="text-[var(--foreground-secondary)] text-sm">
                    Enter your email to receive a reset link
                  </p>
                </div>
              </div>

              {error && (
                <div className="mb-6 p-4 rounded-xl bg-[var(--accent-danger)]/10 border border-[var(--accent-danger)]/30 text-[var(--accent-danger)] text-sm">
                  {error}
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-5">
                <div>
                  <label className="block text-sm font-medium text-[var(--foreground-secondary)] mb-2">
                    Email Address
                  </label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--foreground-muted)] pointer-events-none" />
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="Enter your email address"
                      className="input-field pl-12"
                      required
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="btn-primary w-full flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isSubmitting ? (
                    'Sending...'
                  ) : (
                    <>
                      Send Reset Link
                      <ArrowRight className="w-4 h-4" />
                    </>
                  )}
                </button>
              </form>
            </>
          )}

          {!success && (
            <p className="mt-6 text-center text-[var(--foreground-secondary)]">
              Remember your password?{' '}
              <Link
                href="/login"
                className="text-[var(--accent-primary)] hover:text-[var(--accent-secondary)] font-medium transition-colors"
              >
                Sign in
              </Link>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
