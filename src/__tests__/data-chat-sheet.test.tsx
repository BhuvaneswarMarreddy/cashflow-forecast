import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import DataChatSheet from '@/components/DataChatSheet';
import { Transaction } from '@/types';

/**
 * The one thing this UI must never get wrong: a proposed rule is a PREVIEW.
 * Nothing reaches addRule() until Apply is pressed.
 */

const aiChat = jest.fn();
const addRule = jest.fn();

jest.mock('@/lib/callables', () => ({
  aiChat: (...args: unknown[]) => aiChat(...args),
  callableErrorMessage: () => 'AI request failed. Please try again.',
}));

const txn = (id: string, title: string, merchant: string): Transaction => ({
  id, title, merchant, amount: 42, type: 'expense', category: 'other',
  paymentMethod: 'visa', date: '2026-07-15',
});

const TRANSACTIONS = [
  txn('1', 'INSTACART*ORDER', 'Instacart'),
  txn('2', 'INSTACART SF', 'Instacart'),
  txn('3', 'SHELL OIL', 'Shell'),
];

jest.mock('@/context/TransactionContext', () => ({
  useTransactions: () => ({ transactions: TRANSACTIONS, addRule }),
}));

jest.mock('@/context/UserProfileContext', () => ({
  useUserProfile: () => ({ profile: { currency: 'USD', paymentAccounts: [] } }),
}));

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) { this.removeAttribute('open'); };
});

beforeEach(() => {
  aiChat.mockReset();
  addRule.mockReset();
});

const RULE_REPLY = {
  success: true,
  result: {
    action: 'create_rule',
    explanation: 'Got it — Instacart is Groceries.',
    rule: { match: { field: 'merchant', op: 'contains', value: 'Instacart' }, set: { category: 'groceries' } },
  },
};

const send = (text: string) => {
  fireEvent.change(screen.getByLabelText('Ask about your data'), { target: { value: text } });
  fireEvent.click(screen.getByLabelText('Send'));
};

describe('DataChatSheet', () => {
  it('previews a proposed rule with a match count and writes NOTHING until Apply', async () => {
    aiChat.mockResolvedValue(RULE_REPLY);
    addRule.mockResolvedValue({
      id: 'r1', createdAt: '2026-08-01T00:00:00.000Z', enabled: true,
      match: { field: 'merchant', op: 'contains', value: 'Instacart' },
      set: { category: 'groceries' },
    });

    render(<DataChatSheet open onClose={() => {}} />);
    send('anything from Instacart is Groceries');

    // Preview: the rule in English + only the rows it would CHANGE (Shell is untouched).
    expect(await screen.findByText('merchant contains "Instacart" → category Groceries')).toBeInTheDocument();
    expect(screen.getByText(/Matches 2 existing transactions/)).toBeInTheDocument();
    expect(screen.getByText('INSTACART*ORDER')).toBeInTheDocument();
    expect(screen.queryByText('SHELL OIL')).not.toBeInTheDocument();
    expect(addRule).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Apply'));

    await waitFor(() => expect(addRule).toHaveBeenCalledTimes(1));
    expect(addRule).toHaveBeenCalledWith({
      match: { field: 'merchant', op: 'contains', value: 'Instacart' },
      set: { category: 'groceries' },
      enabled: true,
    });
    expect(await screen.findByText(/^Saved —/)).toBeInTheDocument();
    expect(screen.queryByText('Apply')).not.toBeInTheDocument();
  });

  it('Cancel drops the proposal without saving it', async () => {
    aiChat.mockResolvedValue(RULE_REPLY);
    render(<DataChatSheet open onClose={() => {}} />);
    send('anything from Instacart is Groceries');

    fireEvent.click(await screen.findByText('Cancel'));
    expect(screen.queryByText(/Matches 2 existing/)).not.toBeInTheDocument();
    expect(addRule).not.toHaveBeenCalled();
  });

  it('renders a plain answer with no Apply button', async () => {
    aiChat.mockResolvedValue({ success: true, result: { action: 'answer', explanation: 'You spent $412 on food in July.' } });
    render(<DataChatSheet open onClose={() => {}} />);
    send('what did I spend on food in July?');

    expect(await screen.findByText('You spent $412 on food in July.')).toBeInTheDocument();
    expect(screen.queryByText('Apply')).not.toBeInTheDocument();
  });

  it('never offers to save a rule the validator rejected', async () => {
    // Invented category — parseChatAction returns null, so this is text, not an action.
    aiChat.mockResolvedValue({
      success: true,
      result: { action: 'create_rule', explanation: 'ok', rule: { match: { field: 'merchant', op: 'contains', value: 'X' }, set: { category: 'crypto' } } },
    });
    render(<DataChatSheet open onClose={() => {}} />);
    send('put X under crypto');

    expect(await screen.findByText(/couldn't turn that into a change/)).toBeInTheDocument();
    expect(screen.queryByText('Apply')).not.toBeInTheDocument();
  });

  it('surfaces callable failures as a message instead of throwing', async () => {
    aiChat.mockRejectedValue({ code: 'functions/resource-exhausted' });
    render(<DataChatSheet open onClose={() => {}} />);
    send('hello');
    expect(await screen.findByText('AI request failed. Please try again.')).toBeInTheDocument();
  });
});
