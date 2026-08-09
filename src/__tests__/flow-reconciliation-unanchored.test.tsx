/**
 * Round 4b Fix 3: the /flow reconcile table (`Does it add up?`) prints a per-account
 * Opening/In/Out/Now row for every account plus a `Net worth` total — the same shape
 * as Accounts' summary cards — with no disclosure at all. `accounts` (the array
 * `buildFlowGraph` iterates to build `reconciliation`) IS every row on this table and
 * IS the total, so the whole array is the correct — not excluding — scope here,
 * unlike Dashboard/Accounts where a single figure only covers a subset of the roster.
 *
 * Mount setup mirrors recovery-confirm.test.tsx / recovery-flow-view.test.tsx — the
 * established pattern in this repo for rendering a full FlowPage with mocked contexts.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
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

// Production's exact shape: one anchored bank account, one unanchored credit card.
const CHECKING: PaymentAccount = {
  id: 'demo-checking', name: 'Demo Checking', type: 'bank_account', provider: 'chase',
  openingBalance: 5000, openingDate: '2000-01-01', color: '#111', isActive: true,
};
const UNANCHORED_CARD: PaymentAccount = {
  id: 'demo-card', name: 'Demo Store Card', type: 'credit_card', provider: 'other',
  openingBalance: 0, openingDate: undefined, color: '#222', isActive: true,
};
const accounts: PaymentAccount[] = [CHECKING, UNANCHORED_CARD];

const LEDGER: Transaction[] = [
  { id: 'demo-purchase', title: 'Demo purchase', type: 'expense', category: 'shopping', paymentMethod: 'other', accountId: 'demo-card', date: '2026-02-01', amount: 300 } as Transaction,
];

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
  mockGetLinks.mockReset().mockResolvedValue([]);
  mockGetReviewCandidates.mockReset().mockResolvedValue([]);
  window.history.pushState({}, '', '/flow');
});

describe('FIX (round 4b Fix 3) — the reconcile table discloses an unanchored account behind its own total', () => {
  it('the "Does it add up?" table carries the disclosure — Net worth sums this exact roster', async () => {
    render(<FlowPage />);
    const heading = await screen.findByRole('heading', { name: 'Does it add up?' });
    const section = heading.closest('section') as HTMLElement;
    expect(section).toHaveTextContent('includes 1 unanchored account');
  });

  it('is never suppressed or blanked — the row for the unanchored card still shows its number', async () => {
    render(<FlowPage />);
    const heading = await screen.findByRole('heading', { name: 'Does it add up?' });
    const table = heading.closest('section')!.querySelector('table') as HTMLElement;
    expect(table).toHaveTextContent('Demo Store Card');
  });
});
