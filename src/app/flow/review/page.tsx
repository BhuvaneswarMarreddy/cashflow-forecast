'use client';

/**
 * UI-105 — the review queue's own address. The queue's state still lives in
 * FlowPage (extracting it is #55); this route opens the page with the queue
 * up, so "review my flow" is a link, not a query-param secret.
 */
import FlowPage from '../page';

export default function FlowReviewPage() {
  return <FlowPage initialTab="review" />;
}
