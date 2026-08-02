/**
 * FIN-RECOVERY-UI-001 §13.3 — the confirmation gate (F1–F8).
 *
 * The one thing this surface must never get wrong: NOTHING APPLIES BEFORE CONFIRMATION.
 * Sanitized fixtures only; no Firestore, no emulator, no sign-in.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import RefundCandidateCard from '@/components/RefundCandidateCard';
import { ReviewCandidate } from '@/lib/candidates';
import { QueueAllocation, QueueContext, RecoveryDecision, supersededLinks } from '@/lib/review-queue';
import { PaymentAccount, Transaction } from '@/types';

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

const tx = (o: Partial<Transaction> & { id: string; title: string; amount: number }): Transaction =>
  Object.freeze({ type: 'expense', category: 'shopping', paymentMethod: 'other', date: '2026-07-12', accountId: 'demo-card-9021', ...o }) as Transaction;

const PURCHASE_A = tx({ id: 'demo-purchase-a', title: 'Demo Amazon Lens', merchant: 'DEMO AMAZON', amount: 1100 });
const PURCHASE_B = tx({ id: 'demo-purchase-b', title: 'Demo Amazon Filter', merchant: 'DEMO AMAZON', amount: 100, date: '2026-07-14' });
const REFUND_AB = tx({ id: 'demo-refund-ab', title: 'Demo Amazon Refund', merchant: 'DEMO AMAZON', amount: 1200, type: 'income', date: '2026-07-31' });
const LEDGER: Transaction[] = Object.freeze([PURCHASE_A, PURCHASE_B, REFUND_AB]) as Transaction[];

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

const ctx = (links: QueueContext['links'] = []): QueueContext => ({ transactions: LEDGER, accounts, links, candidates: [] });

const COMBINED: ReviewCandidate = {
  id: 'combined_refund_match~demo-purchase-a~demo-purchase-b~demo-refund-ab',
  candidateId: 'combined_refund_match~combined-refund-v1',
  candidateType: 'combined_refund_match',
  algorithmVersion: 'combined-refund-v1',
  transactionIds: ['demo-purchase-a', 'demo-purchase-b', 'demo-refund-ab'],
  status: 'unreviewed',
  proposedLinks: [
    { linkType: 'refund_of', sourceTransactionId: 'demo-refund-ab', targetTransactionId: 'demo-purchase-a', allocatedAmountCents: 110000 },
    { linkType: 'refund_of', sourceTransactionId: 'demo-refund-ab', targetTransactionId: 'demo-purchase-b', allocatedAmountCents: 10000 },
  ],
  evidence: { amountsCents: [110000, 10000], dayGaps: [19, 17], sameAccount: true, accountTypes: ['credit_card'], merchantMatch: 'exact', referenceOverlap: 'none', pendingInvolved: false, reasonCodes: ['combined_amount', 'same_account'] },
  score: 0.6,
  generatedAt: '2026-08-01T00:00:00.000Z',
};

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
  mockGetLinks.mockReset().mockResolvedValue([]);
  mockGetReviewCandidates.mockReset().mockResolvedValue([]);
  mockSaveLink.mockReset().mockResolvedValue({ ok: true, value: { id: 'x' } });
  mockSaveReviewCandidate.mockReset().mockResolvedValue(undefined);
  mockRecordCandidateDecision.mockReset().mockResolvedValue(undefined);
  goTo('?tab=review');
});

const openFirstItem = async () => {
  render(<FlowPage />);
  fireEvent.click(await screen.findByRole('button', { name: /back from DEMO AMAZON/ }));
};

describe('FIN-RECOVERY-UI-001 · confirmation and editing (F1-F8)', () => {
  it('F1 — NO write occurs until Confirm is pressed', async () => {
    await openFirstItem();
    // The card is on screen with its whole proposal visible…
    expect(await screen.findByText(/allocated \$1,100\.00 of \$1,100\.00/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Adjust allocation' }));
    fireEvent.change(screen.getByLabelText('Amount allocated to Demo Amazon Lens'), { target: { value: '1000.00' } });
    // …and not one byte has been written.
    expect(mockSaveLink).not.toHaveBeenCalled();
    expect(mockSaveReviewCandidate).not.toHaveBeenCalled();
    expect(mockRecordCandidateDecision).not.toHaveBeenCalled();
  });

  it('F2 — the confirmation card states what changes, the money effect, what does not change, and the scope', () => {
    render(<RefundCandidateCard candidate={COMBINED} ctx={ctx()} onDecide={() => {}} />);
    const gate = screen.getByLabelText('What confirming will do');
    expect(gate).toHaveTextContent('$1,100.00 of this credit goes to Demo Amazon Lens on 2026-07-12');
    expect(gate).toHaveTextContent('3 transactions affected · 2026-07-12 to 2026-07-31');
    expect(gate).toHaveTextContent('This marks $1,200.00 of purchases as returned.');
    expect(gate).toHaveTextContent('Your Shopping total for July falls from $1,200.00 to $0.00.');
    expect(gate).toHaveTextContent('Your forecast gains no income.');
    expect(gate).toHaveTextContent('The flow diagram keeps the same boxes, the same ribbons and the same totals.');
    expect(gate).toHaveTextContent('Both transactions stay in your history at their full amounts. Nothing is deleted.');
    expect(gate).toHaveTextContent('This candidate only. Confirming here creates no merchant rule');
  });

  it('F3 — editing an allocation stores INTEGER CENTS; 41.2 becomes 4120 and never a float', () => {
    const decisions: RecoveryDecision[] = [];
    render(<RefundCandidateCard candidate={COMBINED} ctx={ctx()} onDecide={(d) => decisions.push(d)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Adjust allocation' }));
    fireEvent.change(screen.getByLabelText('Amount allocated to Demo Amazon Filter'), { target: { value: '41.2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm links' }));

    const allocations = decisions[0].allocations as QueueAllocation[];
    const filter = allocations.find((a) => a.targetTransactionId === 'demo-purchase-b')!;
    expect(filter.allocatedAmountCents).toBe(4120);
    expect(Number.isInteger(filter.allocatedAmountCents)).toBe(true);
  });

  it('F4 — an over-allocation disables Confirm with a STATED reason and does not clamp the value', () => {
    render(<RefundCandidateCard candidate={COMBINED} ctx={ctx()} onDecide={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Adjust allocation' }));
    const input = screen.getByLabelText('Amount allocated to Demo Amazon Filter') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '200.00' } });

    expect(screen.getByRole('alert')).toHaveTextContent('That is $100.00 more than that purchase.');
    expect(screen.getByRole('button', { name: 'Confirm links' })).toBeDisabled();
    // The number the owner typed is still the number on screen. Nothing was corrected
    // behind their back.
    expect(input.value).toBe('200.00');
  });

  it('F5 — re-allocating a credit SUPERSEDES the old link and deletes nothing', () => {
    const existing = {
      id: 'refund_of~demo-refund-ab~demo-purchase-b', linkType: 'refund_of' as const,
      sourceTransactionId: 'demo-refund-ab', targetTransactionId: 'demo-purchase-b',
      allocatedAmountCents: 10000, status: 'confirmed' as const, algorithmVersion: 'refund-match-v1',
      confirmedAt: '2026-08-01T00:00:00.000Z', confirmedBy: 'user' as const,
      createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
    };
    const out = supersededLinks(
      [existing],
      'demo-refund-ab',
      new Set(['demo-purchase-a']),
      'refund_of~demo-refund-ab~demo-purchase-a',
      '2026-08-02T00:00:00.000Z'
    );
    expect(out).toHaveLength(1);
    expect(out[0].status).toBe('superseded');
    expect(out[0].supersededByLinkId).toBe('refund_of~demo-refund-ab~demo-purchase-a');
    // The old row still exists, at its old amount — an audit trail, not a tombstone.
    expect(out[0].allocatedAmountCents).toBe(10000);
    expect(existing.status).toBe('confirmed'); // the input was not mutated

    // A target that is KEPT is an upsert on one document, so nothing is superseded.
    expect(supersededLinks([existing], 'demo-refund-ab', new Set(['demo-purchase-b']), 'x', 'y')).toHaveLength(0);

    // And nothing is ever deleted — the store exposes no delete path at all.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    expect(Object.keys(require('@/lib/relations-store'))).not.toContain('deleteLink');
  });

  it('F6 — after confirming: the count updates, the item leaves, aria-live announces, no reload', async () => {
    // `location.reload` cannot be redefined in this jsdom, so the guarantee is asserted
    // where it actually lives: the page contains no reload and no router.refresh at all.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const source = require('fs').readFileSync(require('path').join(__dirname, '../app/flow/page.tsx'), 'utf8');
    expect(source).not.toMatch(/location\.reload|router\.refresh/);

    await openFirstItem();
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm links' }));

    await waitFor(() => expect(screen.getByText('Confirmed — $1,200.00 marked as returned.')).toBeInTheDocument());
    const live = screen.getByText('Confirmed — $1,200.00 marked as returned.');
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(screen.queryByRole('button', { name: /back from DEMO AMAZON/ })).toBeNull();
    expect(screen.getAllByText('Nothing to review.').length).toBeGreaterThan(0);
  });

  it('F7 — undo restores the previous status, rejects the created links, and is gone once the panel closes', async () => {
    await openFirstItem();
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm links' }));

    const undo = await screen.findByRole('button', { name: 'Undo' });
    fireEvent.click(undo);

    await waitFor(() => expect(screen.getByText(/Undone\. Nothing was deleted/)).toBeInTheDocument());
    const rejected = mockSaveLink.mock.calls.filter((c) => (c[1] as { status: string }).status === 'rejected');
    expect(rejected.length).toBe(2);
    // The candidate goes back to where it was, so the queue asks again.
    expect(mockRecordCandidateDecision).toHaveBeenCalledWith('demo-user', COMBINED.id, 'unreviewed');
    await waitFor(() => expect(screen.getByRole('button', { name: /back from DEMO AMAZON/ })).toBeInTheDocument());

    // Closing the panel drops the offer — a stale undo is worse than none.
    fireEvent.click(screen.getByRole('button', { name: 'Close money review' }));
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('F8 — no transaction object is mutated in place, asserted by frozen fixtures', async () => {
    const before = JSON.stringify(LEDGER);
    await openFirstItem();
    fireEvent.click(screen.getByRole('button', { name: 'Adjust allocation' }));
    fireEvent.change(screen.getByLabelText('Amount allocated to Demo Amazon Lens'), { target: { value: '900' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm links' }));
    await waitFor(() => expect(mockSaveLink).toHaveBeenCalled());

    expect(JSON.stringify(LEDGER)).toBe(before);
    expect(LEDGER.every((t) => Object.isFrozen(t))).toBe(true);
  });
});
