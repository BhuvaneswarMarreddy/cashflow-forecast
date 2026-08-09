import { PaymentAccount } from '@/types';
import { isUnanchored } from '@/lib/accounts';

/**
 * Disclosure for totals that contain an account nobody ever anchored. Its balance is
 * net movement over the rows we hold, not a bank balance — so a total containing one
 * must not read as measured. Renders nothing when every account is anchored.
 */
export function UnanchoredNote({ accounts }: { accounts: readonly PaymentAccount[] }) {
  const n = accounts.filter(isUnanchored).length;
  if (n === 0) return null;
  return (
    <p className="text-xs text-[var(--foreground-muted)] mt-1">
      includes {n} unanchored account{n === 1 ? '' : 's'}
    </p>
  );
}
