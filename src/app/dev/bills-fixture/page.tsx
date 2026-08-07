/**
 * Development/Test-only fixture route: /dev/bills-fixture
 *
 * Renders the Bills register (BILLS-001) with the starter-audit seed as fixture
 * data — no auth, no Firestore. Same production posture as /dev/accounts-fixture:
 * server component, 404s outside development/test.
 */

import { notFound } from 'next/navigation';
import { environment } from '@/lib/obs/events';
import FixtureBills from './FixtureBills';

export const dynamic = 'force-dynamic';

export default function DevBillsFixturePage() {
  const env = environment();
  if (env !== 'development' && env !== 'test') notFound();
  return <FixtureBills />;
}
