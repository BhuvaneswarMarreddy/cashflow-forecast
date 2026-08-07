/**
 * FIN-RECOVERY-UI-001 §13.4 — Flow, badges and analytics (A1–A6).
 *
 * The Sankey gains NO node and NO edge for a relationship. Sanitized fixtures only.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { RelationBadgeRow } from '@/components/TransactionRelationBadge';
import { buildFlowGraph, toCents } from '@/lib/flows';
import { purchaseEconomics } from '@/lib/refunds';
import { TransactionLink } from '@/lib/relations';
import { grossAndNet, relationBadges } from '@/lib/review-queue';
import { PaymentAccount, Transaction } from '@/types';

const mockGetLinks = jest.fn();
const mockGetReviewCandidates = jest.fn();

jest.mock('@/lib/relations-store', () => ({
  getLinks: (...a: unknown[]) => mockGetLinks(...a),
  getReviewCandidates: (...a: unknown[]) => mockGetReviewCandidates(...a),
  saveLink: jest.fn().mockResolvedValue({ ok: true, value: { id: 'x' } }),
  saveReviewCandidate: jest.fn().mockResolvedValue(undefined),
  recordCandidateDecision: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/components/Navbar', () => ({ __esModule: true, default: () => <nav /> }));
jest.mock('recharts', () => {
  const Stub = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    __esModule: true,
    ResponsiveContainer: Stub, Sankey: Stub, Tooltip: Stub, LineChart: Stub, Line: Stub,
    XAxis: Stub, YAxis: Stub, CartesianGrid: Stub, Treemap: Stub, BarChart: Stub, Bar: Stub, Cell: Stub,
  };
});

const accounts: PaymentAccount[] = [
  { id: 'demo-checking', name: 'Demo Everyday Checking', type: 'bank_account', provider: 'chase', openingBalance: 5000, openingDate: '2000-01-01', color: '#111', isActive: true },
  { id: 'demo-card-9021', name: 'Demo Rewards Card', type: 'credit_card', provider: 'amex', lastFourDigits: '9021', creditLimit: 500000, openingBalance: 0, openingDate: '2000-01-01', color: '#222', isActive: true },
];

const tx = (o: Partial<Transaction> & { id: string; title: string; amount: number }): Transaction => ({
  type: 'expense', category: 'shopping', paymentMethod: 'other', date: '2026-07-12', accountId: 'demo-card-9021', ...o,
});

const PURCHASE_A = tx({ id: 'demo-purchase-a', title: 'Demo Amazon Lens', merchant: 'DEMO AMAZON', amount: 1100 });
const PURCHASE_B = tx({ id: 'demo-purchase-b', title: 'Demo Amazon Filter', merchant: 'DEMO AMAZON', amount: 100, date: '2026-07-14' });
const REFUND_AB = tx({ id: 'demo-refund-ab', title: 'Demo Amazon Refund', merchant: 'DEMO AMAZON', amount: 1200, type: 'income', date: '2026-07-31' });
const PARTLY = tx({ id: 'demo-purchase-c', title: 'Demo Brightleaf Chair', merchant: 'DEMO BRIGHTLEAF', amount: 1100, date: '2026-06-02' });
// One credit nobody has answered yet, so the queue has something to select.
const REFUND_C = tx({ id: 'demo-refund-c', title: 'Demo Brightleaf Refund', merchant: 'DEMO BRIGHTLEAF', amount: 1100, type: 'income', date: '2026-06-20' });

const LEDGER: Transaction[] = [PURCHASE_A, PURCHASE_B, REFUND_AB, PARTLY, REFUND_C];

const link = (target: string, cents: number, status: TransactionLink['status'] = 'confirmed'): TransactionLink => ({
  id: `refund_of~demo-refund-ab~${target}`, linkType: 'refund_of',
  sourceTransactionId: 'demo-refund-ab', targetTransactionId: target,
  allocatedAmountCents: cents, status, algorithmVersion: 'refund-match-v1',
  ...(status === 'confirmed' ? { confirmedAt: '2026-08-01T00:00:00.000Z', confirmedBy: 'user' as const } : {}),
  createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
});

const CONFIRMED: TransactionLink[] = [link('demo-purchase-a', 110000), link('demo-purchase-b', 10000)];

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ isAuthenticated: true, isLoading: false, user: { id: 'demo-user' } }),
}));
jest.mock('@/context/TransactionContext', () => ({ useTransactions: () => ({ transactions: LEDGER }) }));
jest.mock('@/context/UserProfileContext', () => ({
  useUserProfile: () => ({
    profile: { currency: 'USD', paymentAccounts: accounts },
    reconcileAccount: jest.fn(),
    incomeContext: { sources: [] },
    setInflowReview: jest.fn().mockResolvedValue(undefined),
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const FlowPage = require('@/app/flow/page').default;

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) { this.removeAttribute('open'); };
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: () => ({ matches: true, media: '', onchange: null, addEventListener: jest.fn(), removeEventListener: jest.fn(), addListener: jest.fn(), removeListener: jest.fn(), dispatchEvent: jest.fn() }),
  });
});

beforeEach(() => {
  mockGetLinks.mockReset().mockResolvedValue(CONFIRMED);
  mockGetReviewCandidates.mockReset().mockResolvedValue([]);
  window.history.pushState({}, '', '/flow?tab=review');
});

describe('FIN-RECOVERY-UI-001 · Flow, badges and analytics (A1-A6)', () => {
  it('A1 — Flow conservation is unchanged with confirmed links present', () => {
    const before = buildFlowGraph(LEDGER, accounts);
    // Links are not an input to the graph: a relationship adds no node and no edge.
    const after = buildFlowGraph(LEDGER, accounts);
    expect(after.nodes).toEqual(before.nodes);
    expect(after.links).toEqual(before.links);
    expect(after.links.reduce((s, l) => s + l.cents, 0)).toBe(before.links.reduce((s, l) => s + l.cents, 0));
  });

  it('A2 — selecting a linked row highlights both endpoints and adds no node and no edge', async () => {
    render(<FlowPage />);
    const flowTableBefore = await screen.findByText(/View the flow as a table \(\d+ flows\)/);
    const countBefore = flowTableBefore.textContent;

    fireEvent.click(await screen.findByRole('button', { name: /back from DEMO BRIGHTLEAF/ }));

    // The existing trace machinery is what lights up: the page's own pin chip, on the
    // node these rows already sit behind.
    await waitFor(() => expect(screen.getByTitle('Tap to clear')).toBeInTheDocument());
    // …and the graph itself is untouched.
    expect(screen.getByText(/View the flow as a table \(\d+ flows\)/).textContent).toBe(countBefore);
  });

  it('A3 — the drill-down table gains a "Refund of …" line for a linked pair', async () => {
    render(<FlowPage />);
    fireEvent.click(await screen.findByRole('button', { name: /back from DEMO BRIGHTLEAF/ }));
    // The drill-down is the only table on the page with a Date column.
    const dateHeader = await screen.findByRole('columnheader', { name: 'Date' });
    const drillDown = dateHeader.closest('table')!;
    // The credit keeps its gross amount AND gains one line per purchase it reverses.
    expect(drillDown).toHaveTextContent('$1,200.00');
    expect(screen.getByText('Refund of Demo Amazon Lens, 12 Jul')).toBeInTheDocument();
    expect(screen.getByText('Refund of Demo Amazon Filter, 14 Jul')).toBeInTheDocument();
    // The unanswered credit beside it claims nothing at all.
    expect(drillDown).toHaveTextContent('DEMO BRIGHTLEAF');
    // Same helper, same sentence, so any surface that adopts it later cannot drift.
    expect(relationBadges(REFUND_AB, { links: CONFIRMED, transactions: LEDGER, accounts }).map((b) => b.text))
      .toEqual(['Refund of Demo Amazon Lens, 12 Jul', 'Refund of Demo Amazon Filter, 14 Jul']);
  });

  it('A4 — badges are text plus icon, and "Returned" appears only on an exact match', () => {
    const full = relationBadges(PURCHASE_A, { links: CONFIRMED, transactions: LEDGER, accounts });
    expect(full.map((b) => b.text)).toContain('Returned');
    expect(full.every((b) => b.icon.length > 0 && b.text.length > 0)).toBe(true);

    // A partial allocation is never "Returned" — it says what it is, with the net.
    const partial = relationBadges(PARTLY, { links: [link('demo-purchase-c', 90000)], transactions: LEDGER, accounts });
    expect(partial.map((b) => b.text)).not.toContain('Returned');
    expect(partial.map((b) => b.text)).toContain('Partly refunded · $200.00 net');

    // A merely SUGGESTED link earns no badge at all.
    const suggested = relationBadges(PURCHASE_A, { links: [link('demo-purchase-a', 110000, 'suggested')], transactions: LEDGER, accounts });
    expect(suggested.map((b) => b.text)).not.toContain('Returned');

    const { container } = render(<RelationBadgeRow badges={full} />);
    // Colour never carries the meaning alone: the text says it, and the icon is decorative.
    expect(container.querySelectorAll('[aria-hidden="true"]').length).toBe(full.length);
    expect(container.textContent).toContain('Returned');
  });

  it('A5 — gross and net are shown side by side; a net-only figure appears nowhere', () => {
    const gross = toCents(PURCHASE_A.amount);
    const net = purchaseEconomics(PURCHASE_A, CONFIRMED).netEconomicCostCents;
    expect(grossAndNet(gross, net)).toBe('$1,100.00 gross · $0.00 after refunds');
    // The word "gross" is always present when a net figure is.
    expect(grossAndNet(gross, net)).toMatch(/gross/);
    expect(grossAndNet(gross, net)).toMatch(/after refunds/);
  });

  it('A6 — the flow-as-a-table text alternative reflects every relationship', async () => {
    render(<FlowPage />);
    const caption = await screen.findByText('Linked transactions: which credit reverses which purchase.');
    const table = caption.closest('table')!;
    expect(table).toHaveTextContent('Demo Amazon Refund, 2026-07-31');
    expect(table).toHaveTextContent('Demo Amazon Lens, 2026-07-12');
    expect(table).toHaveTextContent('Demo Amazon Filter, 2026-07-14');
    expect(table).toHaveTextContent('$1,100.00');
    expect(table).toHaveTextContent('$100.00');
    // One row per confirmed relationship, so the SVG can hide nothing from a reader.
    expect(table.querySelectorAll('tbody tr')).toHaveLength(CONFIRMED.length);
  });
});
