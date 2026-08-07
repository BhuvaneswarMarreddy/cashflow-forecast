/**
 * UI-104 — /analytics' surviving value (spending pace, daily bars, top
 * merchants) lives at /history?tab=insights (src/components/InsightsTab.tsx);
 * everything else it showed duplicated /forecast?tab=cashflow. The route
 * survives as a redirect for old links.
 */
import { redirect } from 'next/navigation';

export default function AnalyticsRedirect() {
  redirect('/history?tab=insights');
}
