/**
 * FIN-RECOVERY-UI-001 §13.5 — accessibility and page integrity (R1–R6).
 *
 * R1 is the one that matters most: `/flow` shipped React error #310 once, by adding a
 * hook below its early return. This suite renders the page unauthenticated AND
 * authenticated in the same file, which is exactly what makes that bug fail loudly.
 */

import fs from 'fs';
import path from 'path';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { PaymentAccount, Transaction } from '@/types';

const mockGetLinks = jest.fn();
const mockGetReviewCandidates = jest.fn();
const mockSaveLink = jest.fn();
const mockUpdateTransaction = jest.fn();
const mockAddTransaction = jest.fn();
const mockDeleteTransaction = jest.fn();

jest.mock('@/lib/relations-store', () => ({
  getLinks: (...a: unknown[]) => mockGetLinks(...a),
  getReviewCandidates: (...a: unknown[]) => mockGetReviewCandidates(...a),
  saveLink: (...a: unknown[]) => mockSaveLink(...a),
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

let AUTH = { isAuthenticated: true, isLoading: false, user: { id: 'demo-user' } as { id: string } | null };
let DESKTOP = true;

jest.mock('@/context/AuthContext', () => ({ useAuth: () => AUTH }));
jest.mock('@/context/TransactionContext', () => ({
  useTransactions: () => ({
    transactions: LEDGER,
    updateTransaction: mockUpdateTransaction,
    addTransaction: mockAddTransaction,
    deleteTransaction: mockDeleteTransaction,
  }),
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

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) { this.removeAttribute('open'); };
  window.scrollTo = jest.fn(); // jsdom has none; Sheet's iOS scroll lock calls it
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: query.includes('min-width') ? DESKTOP : false,
      media: query, onchange: null,
      addEventListener: jest.fn(), removeEventListener: jest.fn(),
      addListener: jest.fn(), removeListener: jest.fn(), dispatchEvent: jest.fn(),
    }),
  });
});

beforeEach(() => {
  AUTH = { isAuthenticated: true, isLoading: false, user: { id: 'demo-user' } };
  DESKTOP = true;
  mockGetLinks.mockReset().mockResolvedValue([]);
  mockGetReviewCandidates.mockReset().mockResolvedValue([]);
  mockSaveLink.mockReset().mockResolvedValue({ ok: true, value: { id: 'x' } });
  mockUpdateTransaction.mockReset();
  mockAddTransaction.mockReset();
  mockDeleteTransaction.mockReset();
  window.history.pushState({}, '', '/flow?tab=review');
});

const pageSource = () => fs.readFileSync(path.join(__dirname, '../app/flow/page.tsx'), 'utf8');

describe('FIN-RECOVERY-UI-001 · accessibility and page integrity (R1-R6)', () => {
  it('R1 — no hook-order violation: unauthenticated and authenticated in one suite', async () => {
    const errors: unknown[][] = [];
    const spy = jest.spyOn(console, 'error').mockImplementation((...args) => { errors.push(args); });

    AUTH = { isAuthenticated: false, isLoading: true, user: null };
    const loading = render(<FlowPage />);
    expect(loading.container).toBeEmptyDOMElement();
    loading.unmount();

    AUTH = { isAuthenticated: false, isLoading: false, user: null };
    const anon = render(<FlowPage />);
    expect(anon.container).toBeEmptyDOMElement();
    anon.unmount();

    AUTH = { isAuthenticated: true, isLoading: false, user: { id: 'demo-user' } };
    render(<FlowPage />);
    await screen.findByRole('heading', { name: 'Money flow' });

    const text = errors.flat().map(String).join('\n');
    expect(text).not.toMatch(/Rendered more hooks|Rendered fewer hooks|#310|change in the order of Hooks/);
    spy.mockRestore();

    // Structural: EVERY hook is above the early return that made #310 possible.
    const source = pageSource();
    const guard = source.indexOf('if (authLoading || !isAuthenticated) return null;');
    expect(guard).toBeGreaterThan(0);
    expect(source.slice(guard)).not.toMatch(/\buse(State|Effect|Memo|Callback|Ref|Context)\s*\(/);
  });

  it('R2 — the mobile path is the existing Sheet: dialog, Escape via onCancel, backdrop close', async () => {
    DESKTOP = false;
    render(<FlowPage />);
    const dialog = await screen.findByRole('dialog', { name: 'Money review' });
    expect(dialog.tagName).toBe('DIALOG');
    expect(dialog).toHaveAttribute('open');
    // The page never hand-rolls a second dialog primitive.
    expect(pageSource()).not.toMatch(/role="dialog"[\s\S]{0,80}Money review/);

    fireEvent(dialog, new Event('cancel', { bubbles: false, cancelable: true }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Money review' })).toBeNull());
  });

  it('R3 — every actionable element in the review surface meets the 44px minimum', async () => {
    render(<FlowPage />);
    const item = await screen.findByRole('button', { name: /back from DEMO AMAZON/ });
    fireEvent.click(item);

    const panel = screen.getByRole('region', { name: 'Money review' });
    const actionable = [
      ...panel.querySelectorAll('button'),
      ...panel.querySelectorAll('input'),
      ...panel.querySelectorAll('summary'),
      ...panel.querySelectorAll('label'),
    ];
    expect(actionable.length).toBeGreaterThan(5);
    for (const el of actionable) {
      // jsdom has no layout, so the guarantee is asserted where it is expressed: the
      // min-height utility, on every actionable node.
      expect(el.className).toMatch(/min-h-\[44px\]/);
    }
    // …and the entry chips on the Flow page itself.
    for (const chip of screen.getAllByRole('button', { name: /· \d+$/ })) {
      expect(chip.className).toMatch(/min-h-\[44px\]/);
    }
  });

  it('R4 — the queue is keyboard operable, with labelled controls and a visible input label', async () => {
    render(<FlowPage />);
    fireEvent.click(await screen.findByRole('button', { name: /back from DEMO AMAZON/ }));

    // Next/Previous are real, labelled buttons — not icons, not click-only regions.
    expect(screen.getByRole('button', { name: 'Previous item' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next item' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Adjust allocation' }));
    const input = screen.getByLabelText('Amount allocated to Demo Amazon Lens');
    expect(input).toHaveAttribute('type', 'number');
    expect(input).toHaveAttribute('inputMode', 'decimal');
    // The label is a real, visible <label> element, not a placeholder.
    const label = document.querySelector(`label[for="${input.id}"]`)!;
    expect(label).toBeInTheDocument();
    expect(label.className).not.toMatch(/sr-only|hidden/);

    // Focus is visible on every action.
    for (const button of screen.getByRole('region', { name: 'Money review' }).querySelectorAll('button')) {
      expect(button.className).toMatch(/focus-visible:outline|min-h-\[44px\]/);
    }
  });

  it('R5 — no transaction document is written by this task', async () => {
    render(<FlowPage />);
    fireEvent.click(await screen.findByRole('button', { name: /back from DEMO AMAZON/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm links' }));
    await waitFor(() => expect(mockSaveLink).toHaveBeenCalled());

    expect(mockUpdateTransaction).not.toHaveBeenCalled();
    expect(mockAddTransaction).not.toHaveBeenCalled();
    expect(mockDeleteTransaction).not.toHaveBeenCalled();
    // Structural: the page has no transaction-write call at all.
    expect(pageSource()).not.toMatch(/\b(updateTransaction|addTransaction|deleteTransaction|addBulkTransactions)\s*\(/);
  });

  it('R6 — reduced motion is respected and chart animation stays disabled', async () => {
    render(<FlowPage />);
    await screen.findByRole('heading', { name: 'Money flow' });
    const source = pageSource();
    // Every recharts series on this page opts out of animation, as it already did.
    expect(source.match(/isAnimationActive=\{false\}/g)!.length).toBeGreaterThanOrEqual(4);
    expect(source).not.toMatch(/isAnimationActive=\{true\}/);
    // The global reduced-motion escape hatch is intact.
    const css = fs.readFileSync(path.join(__dirname, '../app/globals.css'), 'utf8');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(css).toMatch(/animation-duration: 0\.01ms !important/);
  });
});
