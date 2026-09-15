/**
 * UI-104 folded /analytics into Activity as an Insights tab; tonight's queue (#196)
 * made Activity the list only. Its surviving value (spending pace, top merchants) is
 * "where did it go", which is Flow's question (#199), so old links land there.
 */
import { redirect } from 'next/navigation';

export default function AnalyticsRedirect() {
  redirect('/flow');
}
