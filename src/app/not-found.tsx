import Link from 'next/link';
import LogoMark from '@/components/LogoMark';

/**
 * UI spec A1. Replaces Next's stock white 404. ClientLayout only mounts the tab bar
 * and FAB on real app screens, so this page stands alone like login does.
 */
export default function NotFound() {
  return (
    <main className="min-h-screen flex items-center justify-center px-4 relative">
      <div className="bg-pattern" />
      <div className="relative z-10 w-full max-w-sm rounded-card border border-[var(--border-color)] bg-[var(--background-secondary)] p-6 text-center">
        <LogoMark size={36} className="mx-auto" />
        <h1 className="mt-4 text-2xl font-[family-name:var(--font-display)] text-[var(--foreground)]">
          Page not found
        </h1>
        <p className="mt-2 text-sm text-[var(--foreground-secondary)]">
          That link does not exist in CashFlow.
        </p>
        <Link href="/dashboard" className="btn-primary mt-6 flex w-full min-h-[44px] items-center justify-center">
          Go home
        </Link>
      </div>
    </main>
  );
}
