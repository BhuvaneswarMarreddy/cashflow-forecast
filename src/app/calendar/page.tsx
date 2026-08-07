/**
 * UI-103 — /calendar's month summaries duplicated /cashflow's bars, and its
 * one unique value (the per-day list) is now the tap-a-month drill-down inside
 * /forecast?tab=cashflow. The route survives as a redirect for old links.
 */
import { redirect } from 'next/navigation';

export default function CalendarRedirect() {
  redirect('/forecast?tab=cashflow');
}
