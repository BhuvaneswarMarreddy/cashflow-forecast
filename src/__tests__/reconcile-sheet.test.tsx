/**
 * INV-1 Fix 3: reconcile() has always computed a DriftObservation; nothing ever
 * showed the owner what it found. ReconcileSheet is where the owner is already
 * standing (the confirm button they just pressed), so the result of THAT
 * reconciliation — not a generic "Saved" — must appear here.
 *
 * FIN-SETTLEMENT-003: this only reads the object onConfirm already resolved with.
 * No assertion here touches a store, a fetch, or a second write path.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import ReconcileSheet from '@/components/ReconcileSheet';

beforeAll(() => {
  // jsdom has no real <dialog> support; every Sheet-using test in this repo stubs it.
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) { this.removeAttribute('open'); };
});

function renderSheet(resolved: { driftCents: number; status: 'PASS' | 'VIOLATION' | 'STALE_INPUT' | 'NOT_APPLICABLE'; failed?: true }) {
  const onConfirm = jest.fn().mockResolvedValue(resolved);
  const onClose = jest.fn();
  render(
    <ReconcileSheet
      accountName="Chase Checking"
      inputLabel="real balance right now"
      derivedCurrent={100}
      currency="USD"
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
  return { onConfirm, onClose };
}

async function confirm() {
  fireEvent.click(screen.getByRole('button', { name: /Confirm|Re-anchor/ }));
  // The result panel replaces the "Balance" input; wait for that swap.
  await waitFor(() => expect(screen.queryByLabelText('Balance')).not.toBeInTheDocument());
}

describe('ReconcileSheet surfaces the reconcile result (INV-1)', () => {
  it('PASS: reassures the balance already matched, does not read as an error', async () => {
    renderSheet({ driftCents: 0, status: 'PASS' });
    await confirm();
    const text = screen.getByText(/match/i).textContent ?? '';
    expect(text.toLowerCase()).not.toMatch(/error|fail|warning/);
  });

  it('VIOLATION: shows the exact drift in dollars, integer cents formatted correctly', async () => {
    renderSheet({ driftCents: 12345, status: 'VIOLATION' }); // $123.45, not $12345.00
    await confirm();
    expect(screen.getByText(/\$123\.45/)).toBeInTheDocument();
  });

  it('VIOLATION: reads as a recorded fact, never as a failure or warning', async () => {
    renderSheet({ driftCents: 12345, status: 'VIOLATION' });
    await confirm();
    const panel = screen.getByRole('status');
    expect(panel.textContent?.toLowerCase()).not.toMatch(/error|fail(ed)?|warning|invalid/);
  });

  it('STALE_INPUT: says plainly that the difference cannot be attributed with confidence', async () => {
    renderSheet({ driftCents: -500, status: 'STALE_INPUT' });
    await confirm();
    expect(screen.getByText(/\$5\.00/)).toBeInTheDocument();
    const panel = screen.getByRole('status');
    expect(panel.textContent?.toLowerCase()).toMatch(/sync|stale|confiden/);
  });

  it('NOT_APPLICABLE: says there was no prior claim to compare against', async () => {
    renderSheet({ driftCents: 0, status: 'NOT_APPLICABLE' });
    await confirm();
    const panel = screen.getByRole('status');
    expect(panel.textContent?.toLowerCase()).toMatch(/no starting balance|nothing to compare|first/);
  });

  it('does not auto-close on confirm — the owner reads the result, then dismisses it', async () => {
    const { onClose } = renderSheet({ driftCents: 0, status: 'PASS' });
    await confirm();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Done/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // #83 round 4a Defect 4: reconcileAccount's two guard clauses (no profile / account
  // not found) reuse NOT_APPLICABLE's shape for a call that never even ran — no
  // observation, nothing written. Before `failed` existed, this rendered the
  // NOT_APPLICABLE copy below verbatim: "it's now anchored to $X" for a write that
  // never happened. `failed: true` must override that regardless of `status`.
  it('failed: true means the call never ran — must not claim an anchor that was never written', async () => {
    renderSheet({ driftCents: 0, status: 'NOT_APPLICABLE', failed: true });
    await confirm();
    const panel = screen.getByRole('status');
    expect(panel.textContent?.toLowerCase()).not.toMatch(/anchored/);
    expect(panel.textContent?.toLowerCase()).toMatch(/couldn.?t|try again/);
  });
});
