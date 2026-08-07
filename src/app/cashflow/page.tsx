/**
 * UI-103 — /cashflow's body now lives at /forecast?tab=cashflow
 * (src/components/CashflowTab.tsx). The route survives as a redirect so
 * bookmarks and old links keep working.
 */
import { redirect } from 'next/navigation';

export default function CashflowRedirect() {
  redirect('/forecast?tab=cashflow');
}
