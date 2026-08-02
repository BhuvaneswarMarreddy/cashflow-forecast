/**
 * FIN-RECOVERY-UI-001 §13.1 — the queue and the `?tab=` contract (Q1–Q7).
 *
 * Sanitized fixtures only. No Firestore, no emulator, no sign-in, no provider call.
 */

import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { PaymentAccount, Transaction } from '@/types';
import { CANDIDATE_STATUSES, ReviewCandidate } from '@/lib/candidates';
import { INFLOW_REVIEW_STATES, QUEUE_STATES, buildReviewQueue, queueBadgeLabel, queueCounts, queueStateOfCandidate, queueStateOfReview, statusesOfQueueState } from '@/lib/review-queue';

const mockGetLinks = jest.fn();
const mockGetReviewCandidates = jest.fn();
const mockSaveLink = jest.fn();
const mockSaveReviewCandidate = jest.fn();
const mockRecordCandidateDecision = jest.fn();

jest.mock('@/lib/relations-store', () => ({
  getLinks: (...a: unknown[]) => mockGetLinks(...a),
  getReviewCandidates: (...a: unknown[]) => mockGetReviewCandidates(...a),
  saveLink: (...a: unknown[]) => mockSaveLink(...a),
  saveReviewCandidate: (...a: unknown[]) => mockSaveReviewCandidate(...a),
  recordCandidateDecision: (...a: unknown[]) => mockRecordCandidateDecision(...a),
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
  { id: 'demo-card-9021', name: 'Demo Rewards Card', type: 'credit_card', provider: 'amex', lastFourDigits: '9021', creditLimit: 500000, openingBalance: 0, openingDate: '2000-01-01', color: '#222', isActive: true },
];

const tx = (o: Partial<Transaction> & { id: string; title: string; amount: number }): Transaction => ({
  type: 'expense', category: 'shopping', paymentMethod: 'other', date: '2026-07-12', accountId: 'demo-card-9021', ...o,
});

const LEDGER: Transaction[] = [
  tx({ id: 'demo-purchase-a', title: 'Demo Amazon Lens', merchant: 'DEMO AMAZON', amount: 1100 }),
  tx({ id: 'demo-purchase-b', title: 'Demo Amazon Filter', merchant: 'DEMO AMAZON', amount: 100, date: '2026-07-14' }),
  tx({ id: 'demo-refund-ab', title: 'Demo Amazon Refund', merchant: 'DEMO AMAZON', amount: 1200, type: 'income', date: '2026-07-31' }),
];

let LEDGER_FOR_PAGE: Transaction[] = LEDGER;

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ isAuthenticated: true, isLoading: false, user: { id: 'demo-user' } }),
}));
jest.mock('@/context/TransactionContext', () => ({
  useTransactions: () => ({ transactions: LEDGER_FOR_PAGE }),
}));
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

const goTo = (search: string) => window.history.pushState({}, '', `/flow${search}`);

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) { this.removeAttribute('open'); };
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: () => ({ matches: true, media: '', onchange: null, addEventListener: jest.fn(), removeEventListener: jest.fn(), addListener: jest.fn(), removeListener: jest.fn(), dispatchEvent: jest.fn() }),
  });
});

beforeEach(() => {
  LEDGER_FOR_PAGE = LEDGER;
  mockGetLinks.mockReset().mockResolvedValue([]);
  mockGetReviewCandidates.mockReset().mockResolvedValue([]);
  mockSaveLink.mockReset().mockResolvedValue({ ok: true, value: { id: 'x' } });
  mockSaveReviewCandidate.mockReset().mockResolvedValue(undefined);
  mockRecordCandidateDecision.mockReset().mockResolvedValue(undefined);
  goTo('');
});

const candidate = (o: Partial<ReviewCandidate> & Pick<ReviewCandidate, 'id' | 'status'>): ReviewCandidate => ({
  candidateId: 'c~v1', candidateType: 'refund_match', algorithmVersion: 'refund-match-v1',
  transactionIds: ['demo-purchase-a', 'demo-refund-ab'], proposedLinks: [],
  evidence: { amountsCents: [], dayGaps: [], sameAccount: true, accountTypes: [], merchantMatch: 'exact', referenceOverlap: 'none', pendingInvolved: false, reasonCodes: [] },
  score: 0.5, generatedAt: '2026-08-01T00:00:00.000Z', ...o,
});

describe('FIN-RECOVERY-UI-001 · queue and routing (Q1-Q7)', () => {
  it('Q1 — only ?tab=review renders the review surface; every other value leaves Flow unchanged', async () => {
    goTo('?tab=review');
    const { unmount } = render(<FlowPage />);
    expect(await screen.findByRole('heading', { name: 'Money review' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Money flow' })).toBeInTheDocument();
    unmount();

    for (const search of ['', '?tab=flow', '?tab=transactions', '?tab=insights', '?tab=not-a-tab']) {
      goTo(search);
      const view = render(<FlowPage />);
      await waitFor(() => expect(screen.getByRole('heading', { name: 'Money flow' })).toBeInTheDocument());
      expect(screen.queryByRole('heading', { name: 'Money review' })).toBeNull();
      view.unmount();
    }
  });

  it('Q2 — zero-count chips are hidden, and an empty queue says "Nothing to review."', async () => {
    render(<FlowPage />);
    // The demo ledger produces exactly one combined-refund candidate…
    expect(await screen.findByRole('button', { name: /Refunds to match · 1/ })).toBeInTheDocument();
    // …and no chip exists for any section with no items.
    expect(screen.queryByText(/Duplicate subscriptions ·/)).toBeNull();
    expect(screen.queryByText(/Unknown card credits ·/)).toBeNull();

    LEDGER_FOR_PAGE = [];
    render(<FlowPage />);
    expect(await screen.findAllByText('Nothing to review.')).toHaveLength(1);
  });

  it('Q3 — the state alignment table round-trips in both directions', () => {
    // Every candidate status maps to exactly one queue state, or out of the queue.
    for (const status of CANDIDATE_STATUSES) {
      const queueState = queueStateOfCandidate(status);
      if (['confirmed', 'dismissed', 'intentional'].includes(status)) {
        expect(queueState).toBeNull();
        continue;
      }
      expect(QUEUE_STATES).toContain(queueState);
      expect(statusesOfQueueState(queueState!).candidateStatus).toBe(status);
    }
    // Every FIN-REVIEW-002 review state maps the same way…
    for (const state of INFLOW_REVIEW_STATES) {
      const queueState = queueStateOfReview(state);
      if (state === 'confirmed' || state === 'dismissed') {
        expect(queueState).toBeNull();
        continue;
      }
      expect(QUEUE_STATES).toContain(queueState);
      expect(statusesOfQueueState(queueState!).reviewState).toBe(state);
    }
    // …and the two gaps are `null`, never invented.
    expect(statusesOfQueueState('needs_attention').candidateStatus).toBeNull();
    expect(statusesOfQueueState('needs_more_information').reviewState).toBeNull();
  });

  it('Q4 — ordering is deterministic across shuffled inputs', () => {
    const candidates = [
      candidate({ id: 'k-suggested', status: 'suggested', score: 0.9, generatedAt: '2026-01-01T00:00:00.000Z' }),
      candidate({ id: 'k-more-info', status: 'needs_more_information', score: 0.99, generatedAt: '2026-01-01T00:00:00.000Z' }),
      candidate({ id: 'k-unreviewed-hi', status: 'unreviewed', score: 0.8, generatedAt: '2026-01-02T00:00:00.000Z' }),
      candidate({ id: 'k-unreviewed-lo', status: 'unreviewed', score: 0.2, generatedAt: '2026-01-01T00:00:00.000Z' }),
    ];
    const expected = ['k-unreviewed-hi', 'k-unreviewed-lo', 'k-suggested', 'k-more-info'];
    const shuffles = [candidates, [...candidates].reverse(), [candidates[2], candidates[0], candidates[3], candidates[1]]];
    for (const order of shuffles) {
      const keys = buildReviewQueue({ transactions: LEDGER, accounts, links: [], candidates: order }).map((i) => i.key);
      expect(keys).toEqual(expected);
    }
  });

  it('Q5 — terminal-status items never appear in the queue', () => {
    const terminal = (['confirmed', 'dismissed', 'intentional'] as const).map((status) => candidate({ id: `k-${status}`, status }));
    const open = candidate({ id: 'k-open', status: 'unreviewed' });
    const queue = buildReviewQueue({ transactions: LEDGER, accounts, links: [], candidates: [...terminal, open] });
    expect(queue.map((i) => i.key)).toEqual(['k-open']);
  });

  it('Q6 — the count is the queue length and the accessible name reads "Flow, N items to review"', async () => {
    const queue = buildReviewQueue({ transactions: LEDGER, accounts, links: [], candidates: [candidate({ id: 'k1', status: 'unreviewed' }), candidate({ id: 'k2', status: 'suggested' })] });
    expect(queueCounts(queue).total).toBe(queue.length);
    expect(queueBadgeLabel(2)).toBe('Flow, 2 items to review');
    expect(queueBadgeLabel(1)).toBe('Flow, 1 item to review');

    render(<FlowPage />);
    expect(await screen.findByRole('button', { name: 'Flow, 1 item to review' })).toHaveTextContent('Needs Review · 1');
  });

  it('Q7 — confirming updates the count in the same pass, with NO refetch', async () => {
    goTo('?tab=review');
    render(<FlowPage />);
    const openButton = await screen.findByRole('button', { name: 'Flow, 1 item to review' });
    expect(openButton).toBeInTheDocument();
    const readsBefore = mockGetReviewCandidates.mock.calls.length;

    fireEvent.click(await screen.findByRole('button', { name: /back from DEMO AMAZON/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm links' }));

    // Both the chip strip and the panel drop to empty in the same pass.
    await waitFor(() => expect(screen.getAllByText('Nothing to review.')).toHaveLength(2));
    // The queue recomputed from state the click already changed — nothing was re-read.
    expect(mockGetReviewCandidates.mock.calls.length).toBe(readsBefore);
    expect(mockGetLinks.mock.calls.length).toBe(1);
  });
});
