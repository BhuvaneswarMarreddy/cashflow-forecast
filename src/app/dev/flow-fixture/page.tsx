/**
 * Development/Test-only fixture route: /dev/flow-fixture
 *
 * Server component, so the production check runs before any client code is sent.
 * In production this 404s exactly like a route that was never written.
 */

import { notFound } from 'next/navigation';
import { environment } from '@/lib/obs/events';
import FixtureFlow from './FixtureFlow';

export const dynamic = 'force-dynamic';

export default function DevFlowFixturePage() {
  const env = environment();
  if (env !== 'development' && env !== 'test') notFound();
  return <FixtureFlow />;
}
