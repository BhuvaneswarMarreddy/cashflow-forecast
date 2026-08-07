/**
 * Development/Test-only fixture route: /dev/activity-fixture
 *
 * Server component, so the production check runs before any client code is sent.
 * In production this 404s exactly like a route that was never written.
 */

import { notFound } from 'next/navigation';
import { environment } from '@/lib/obs/events';
import FixtureActivity from './FixtureActivity';

export const dynamic = 'force-dynamic';

export default function DevActivityFixturePage() {
  const env = environment();
  if (env !== 'development' && env !== 'test') notFound();
  return <FixtureActivity />;
}
