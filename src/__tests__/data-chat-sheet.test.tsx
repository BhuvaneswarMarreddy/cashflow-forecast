import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import DataChatSheet from '@/components/DataChatSheet';
import { applyMappingRules, rulePreview, MappingRule } from '@/lib/mapping-rules';
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

const reconcileAccount = jest.fn().mockResolvedValue(0);
const MOCK_ACCOUNTS = [
  { id: 'acct-chase', name: 'CHASE SAVINGS', type: 'bank_account', provider: 'chase', openingBalance: 2600.97, openingDate: '2026-08-02', color: '#111', isActive: true },
  { id: 'acct-adv', name: 'Advantage Savings', type: 'bank_account', provider: 'other', openingBalance: 45.52, openingDate: '2026-08-02', color: '#222', isActive: true },
  { id: 'acct-apple', name: 'Apple Card', type: 'credit_card', provider: 'apple', openingBalance: 2068.93, openingDate: '2026-08-02', color: '#333', isActive: true },
];
jest.mock('@/context/UserProfileContext', () => ({
  useUserProfile: () => ({ profile: { currency: 'USD', paymentAccounts: MOCK_ACCOUNTS }, reconcileAccount }),
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
    rule: { match: { field: 'merchant', op: 'contains', value: 'Instacart' }, set: { category: 'food', sourceCategory: 'Groceries' } },
  },
};

const send = (text: string) => {
  fireEvent.change(screen.getByLabelText('Message'), { target: { value: text } });
  fireEvent.click(screen.getByLabelText('Send'));
};

describe('DataChatSheet', () => {
  it('portals the rail to <body> — inside the navbar it pins to the 64px bar', () => {
    // The nav has backdrop-filter, which makes it the containing block for
    // position:fixed descendants. Rendered in place, the rail anchored itself
    // INSIDE the bar with its contents spilling out transparently. That shipped;
    // this is the assertable half of the fix (jsdom cannot see layout).
    const { container } = render(<div style={{ backdropFilter: 'blur(4px)' }}>
      <DataChatSheet open onClose={() => {}} />
    </div>);
    const rail = screen.getByRole('complementary', { name: 'Ask about your data' });
    expect(rail.parentElement).toBe(document.body);
    expect(container.querySelector('aside')).toBeNull();
  });

  it('previews a proposed rule with a match count and writes NOTHING until Apply', async () => {
    aiChat.mockResolvedValue(RULE_REPLY);
    addRule.mockResolvedValue({
      id: 'r1', createdAt: '2026-08-01T00:00:00.000Z', enabled: true,
      match: { field: 'merchant', op: 'contains', value: 'Instacart' },
      set: { category: 'food', sourceCategory: 'Groceries' },
    });

    render(<DataChatSheet open onClose={() => {}} />);
    send('anything from Instacart is Groceries');

    // Preview: the rule in English + only the rows it would CHANGE (Shell is untouched).
    expect(await screen.findByText('merchant contains "Instacart" → category Food & Dining, label "Groceries"')).toBeInTheDocument();
    expect(screen.getByText(/Matches 2 existing transactions/)).toBeInTheDocument();
    expect(screen.getByText('INSTACART*ORDER')).toBeInTheDocument();
    expect(screen.queryByText('SHELL OIL')).not.toBeInTheDocument();
    expect(addRule).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Apply'));

    await waitFor(() => expect(addRule).toHaveBeenCalledTimes(1));
    expect(addRule).toHaveBeenCalledWith({
      match: { field: 'merchant', op: 'contains', value: 'Instacart' },
      set: { category: 'food', sourceCategory: 'Groceries' },
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

    // The RULE is refused — no Apply button, nothing reaches the store. What the model
    // SAID survives, because throwing the words away with the rule is what left the
    // owner staring at "I couldn't turn that into a change" on a clear instruction.
    expect(await screen.findByText('ok')).toBeInTheDocument();
    expect(screen.queryByText('Apply')).not.toBeInTheDocument();
  });

  it('surfaces callable failures as a message instead of throwing', async () => {
    aiChat.mockRejectedValue({ code: 'functions/resource-exhausted' });
    render(<DataChatSheet open onClose={() => {}} />);
    send('hello');
    expect(await screen.findByText('AI request failed. Please try again.')).toBeInTheDocument();
  });
});

/**
 * Settings shows how many rows each SAVED rule matches. It can't use rulePreview() —
 * that counts rows a rule would CHANGE, and `transactions` already has every enabled
 * rule folded in, so an active rule scores 0. Locks the probe settings/page.tsx uses.
 */
describe('saved-rule match count (settings/page.tsx probe)', () => {
  const rule: MappingRule = {
    id: 'r', createdAt: '', enabled: true,
    match: { field: 'merchant', op: 'contains', value: 'Instacart' },
    set: { category: 'food' },
  };
  const applied = TRANSACTIONS.map((t) =>
    t.merchant === 'Instacart' ? { ...t, category: 'food' as const } : t);

  it('rulePreview reports 0 once the rule is already applied — hence the probe', () => {
    expect(rulePreview(rule, applied).matches).toBe(0);
  });

  it('a sentinel-set probe still counts every matching row', () => {
    const probe = [{ ...rule, set: { merchant: ' ' } }];
    expect(applied.filter((t) => applyMappingRules(t, probe) !== t)).toHaveLength(2);
  });
});

describe('the rail resizes from its left edge', () => {
  beforeEach(() => window.localStorage.removeItem('chat-rail-width'));
  const rail = () => screen.getByRole('complementary', { name: 'Ask about your data' });
  const handle = () => screen.getByRole('separator', { name: 'Resize chat panel' });

  it('dragging the handle sets the width from the pointer, clamped at both ends', () => {
    render(<DataChatSheet open onClose={() => {}} />);
    // jsdom has no PointerEvent; a MouseEvent with the pointermove TYPE carries the
    // buttons/clientX the handler reads and still reaches React's listener.
    const move = (init: MouseEventInit) =>
      fireEvent(handle(), new MouseEvent('pointermove', { bubbles: true, ...init }));
    // jsdom window is 1024 wide. Pointer at x=700 → 324px rail.
    move({ buttons: 1, clientX: 700 });
    expect(rail().style.width).toBe('324px');
    // Pointer nearly at the right edge → clamped to the 320px floor, not 14px.
    move({ buttons: 1, clientX: 1010 });
    expect(rail().style.width).toBe('320px');
    // Pointer far left → clamped to 80% of the window, not the whole screen.
    move({ buttons: 1, clientX: 10 });
    expect(rail().style.width).toBe('819px');
    // A move with NO button held is a hover, not a drag.
    move({ buttons: 0, clientX: 500 });
    expect(rail().style.width).toBe('819px');
  });

  it('arrow keys resize from the keyboard and the width persists', () => {
    render(<DataChatSheet open onClose={() => {}} />);
    // ArrowLeft pushes the left edge left: default 416 + 24.
    fireEvent.keyDown(handle(), { key: 'ArrowLeft' });
    expect(rail().style.width).toBe('440px');
    fireEvent.keyDown(handle(), { key: 'ArrowRight' });
    expect(rail().style.width).toBe('416px');
    expect(window.localStorage.getItem('chat-rail-width')).toBe('416');
  });

  it('double-click (and Home) return to the stylesheet default', () => {
    window.localStorage.setItem('chat-rail-width', '500');
    render(<DataChatSheet open onClose={() => {}} />);
    expect(rail().style.width).toBe('500px'); // the saved size survived a reopen
    fireEvent.doubleClick(handle());
    expect(rail().style.width).toBe('');
    expect(window.localStorage.getItem('chat-rail-width')).toBeNull();
  });
});

describe('the balance proposal card', () => {
  const proposal = (accountName: string, balance = 600.97) => ({
    success: true,
    result: { action: 'set_account_balance', accountName, balance, reason: `You said ${accountName} is ${balance}.` },
  });

  it('shows current → new and writes ONLY on Apply', async () => {
    aiChat.mockResolvedValue(proposal('CHASE SAVINGS'));
    render(<DataChatSheet open onClose={() => {}} />);
    send('chase savings is actually 600.97');

    expect(await screen.findByText('Set CHASE SAVINGS — balance $2,600.97 → $600.97')).toBeInTheDocument();
    expect(reconcileAccount).not.toHaveBeenCalled(); // proposing is not applying

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await screen.findByText(/Saved — CHASE SAVINGS reads \$600\.97 as of today/);
    expect(reconcileAccount).toHaveBeenCalledWith('acct-chase', 600.97, 2600.97);
  });

  it('an ambiguous name gets words and NO button — the model never picks the account', async () => {
    // Two accounts contain "savings"; the model's vague name must not resolve.
    aiChat.mockResolvedValue(proposal('savings'));
    render(<DataChatSheet open onClose={() => {}} />);
    send('savings is 100');

    expect(await screen.findByText(/couldn't match .savings. to exactly one of your accounts/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
  });

  it('a debt account is phrased as what you OWE', async () => {
    aiChat.mockResolvedValue(proposal('Apple Card', 2405));
    render(<DataChatSheet open onClose={() => {}} />);
    send('i owe 2405 on the apple card');
    expect(await screen.findByText('Set Apple Card — you owe $2,068.93 → $2,405.00')).toBeInTheDocument();
  });
});
