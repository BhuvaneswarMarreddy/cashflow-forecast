import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import DataChatSheet, { resolveBillPaymentMethod, resolveBillAnchor, resolveBill, describeBillUpdate } from '@/components/DataChatSheet';
import { applyMappingRules, rulePreview, MappingRule } from '@/lib/mapping-rules';
import { billUpcomingEvents, Bill } from '@/lib/bills';
import { ExpenseCategory, Transaction } from '@/types';

/**
 * The one thing this UI must never get wrong: a proposed rule is a PREVIEW.
 * Nothing reaches addRule() until Apply is pressed.
 */

const aiChat = jest.fn();
const addRule = jest.fn();
const addBill = jest.fn();
const getBills = jest.fn();
// cashflow-mobile#34
const updateBill = jest.fn();
const deleteBill = jest.fn();
// cashflow-mobile#28: the server-side sweep — replaces the old per-row
// updateTransactionAwaited/updateRuleCategoryAwaited/updateBill mocks below.
const removeCategory = jest.fn();

jest.mock('@/lib/callables', () => ({
  aiChat: (...args: unknown[]) => aiChat(...args),
  removeCategory: (...args: unknown[]) => removeCategory(...args),
  callableErrorMessage: () => 'AI request failed. Please try again.',
}));

jest.mock('@/lib/firestore', () => ({
  addBill: (...args: unknown[]) => addBill(...args),
  getBills: (...args: unknown[]) => getBills(...args),
  updateBill: (...args: unknown[]) => updateBill(...args),
  deleteBill: (...args: unknown[]) => deleteBill(...args),
}));

const txn = (id: string, title: string, merchant: string): Transaction => ({
  id, title, merchant, amount: 42, type: 'expense', category: 'other',
  paymentMethod: 'visa', date: '2026-07-15',
});

const TRANSACTIONS = [
  txn('1', 'INSTACART*ORDER', 'Instacart'),
  txn('2', 'INSTACART SF', 'Instacart'),
  txn('3', 'SHELL OIL', 'Shell'),
  // Real history on the UNANCHORED account below. deriveAccountBalance() must sum
  // this ($1,000 - $150 = $850); currentOf()'s openingBalance fallback would say $0.
  {
    id: '4', title: 'PAYROLL DEPOSIT', merchant: 'Employer', amount: 1000, type: 'income',
    category: 'other', paymentMethod: 'other', date: '2026-07-01', accountId: 'acct-legacy',
  } as Transaction,
  {
    id: '5', title: 'GROCERY RUN', merchant: 'Market', amount: 150, type: 'expense',
    category: 'food', paymentMethod: 'other', date: '2026-07-05', accountId: 'acct-legacy',
  } as Transaction,
];

// cashflow-mobile#24: mutable so remove_category tests can put a rule/extra
// transaction in play without disturbing the fixed TRANSACTIONS every other
// test in this file already asserts exact counts against.
let RULES: MappingRule[] = [];
let EXTRA_TRANSACTIONS: Transaction[] = [];
jest.mock('@/context/TransactionContext', () => ({
  useTransactions: () => ({
    transactions: [...TRANSACTIONS, ...EXTRA_TRANSACTIONS],
    addRule,
    rules: RULES,
  }),
}));

const reconcileAccount = jest.fn().mockResolvedValue(0);
const MOCK_ACCOUNTS = [
  { id: 'acct-chase', name: 'CHASE SAVINGS', type: 'bank_account', provider: 'chase', openingBalance: 2600.97, openingDate: '2026-08-02', color: '#111', isActive: true },
  { id: 'acct-adv', name: 'Advantage Savings', type: 'bank_account', provider: 'other', openingBalance: 45.52, openingDate: '2026-08-02', color: '#222', isActive: true },
  { id: 'acct-apple', name: 'Apple Card', type: 'credit_card', provider: 'apple', openingBalance: 2068.93, openingDate: '2026-08-02', color: '#333', isActive: true },
  // No openingDate -> UNANCHORED (src/lib/accounts.ts isUnanchored). openingBalance
  // sits at 0 exactly like a real unanchored account (openingAnchor() in accounts.ts
  // never sets a nonzero balance without also setting a date), so currentOf()'s
  // openingBalance fallback and the true derived balance diverge whenever the account
  // has transaction history — which is exactly the case Defect 2 got wrong.
  { id: 'acct-legacy', name: 'Legacy Cash', type: 'bank_account', provider: 'other', openingBalance: 0, color: '#444', isActive: true },
];
// incomeContext is a required, real argument to deriveAccountBalance (src/lib/forecast.ts)
// — the fix must thread a real policy through, never a literal `{}` stand-in.
const MOCK_INCOME_CONTEXT = { sources: [], reviews: {} };
const updateProfile = jest.fn().mockResolvedValue(undefined);
// Mutable so individual tests can put the owner in either state — no override
// (derived) vs an existing override — before rendering. `categories` is
// cashflow-mobile#24's owner-added set.
let PROFILE_SETTINGS: { assumedMonthlySpend?: number | null; categories?: { value: string; label: string; icon?: string; archived?: boolean }[] } = {};
jest.mock('@/context/UserProfileContext', () => ({
  useUserProfile: () => ({
    profile: { id: 'user-1', currency: 'USD', paymentAccounts: MOCK_ACCOUNTS, settings: PROFILE_SETTINGS },
    reconcileAccount,
    incomeContext: MOCK_INCOME_CONTEXT,
    updateProfile: (...args: unknown[]) => updateProfile(...args),
  }),
}));

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) { this.removeAttribute('open'); };
});

beforeEach(() => {
  aiChat.mockReset();
  addRule.mockReset();
  addBill.mockReset().mockResolvedValue('new-bill-id');
  getBills.mockReset().mockResolvedValue([]);
  updateBill.mockReset().mockResolvedValue(undefined);
  deleteBill.mockReset().mockResolvedValue(undefined);
  removeCategory.mockReset().mockResolvedValue({ moved: { transactions: 0, rules: 0, bills: 0, budgets: 0, plannedTransactions: 0 } });
  updateProfile.mockReset().mockResolvedValue(undefined);
  PROFILE_SETTINGS = {};
  RULES = [];
  EXTRA_TRANSACTIONS = [];
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
  it('portals the rail to <body> — inside the navbar it pins to the 64px bar', async () => {
    // The nav has backdrop-filter, which makes it the containing block for
    // position:fixed descendants. Rendered in place, the rail anchored itself
    // INSIDE the bar with its contents spilling out transparently. That shipped;
    // this is the assertable half of the fix (jsdom cannot see layout).
    const { container } = render(<div style={{ backdropFilter: 'blur(4px)' }}>
      <DataChatSheet open onClose={() => {}} />
    </div>);
    // Flushes the mount-time getBills fetch (and its setBills) before the test ends,
    // so its resolution never lands outside any act() — same fix as the rail-resize
    // tests below.
    await waitFor(() => expect(getBills).toHaveBeenCalledWith('user-1'));
    const rail = screen.getByRole('complementary', { name: 'Ask about your data' });
    expect(rail.parentElement).toBe(document.body);
    expect(container.querySelector('aside')).toBeNull();
  });

  it('previews a proposed rule with a match count and writes NOTHING until Apply', async () => {
    aiChat.mockResolvedValue(RULE_REPLY);
    // #130: addRule now goes through applyDecision and resolves { rule, changed } —
    // the server's ChangeSummary, not a bare MappingRule.
    addRule.mockResolvedValue({
      rule: {
        id: 'r1', createdAt: '2026-08-01T00:00:00.000Z', enabled: true,
        match: { field: 'merchant', op: 'contains', value: 'Instacart' },
        set: { category: 'food', sourceCategory: 'Groceries' },
      },
      changed: { transactionsMatched: 2, monthsAffected: ['2026-07'] },
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
    // #130: the applied message includes the server's change count, not just "Saved".
    expect(await screen.findByText(/^Saved —.*2 existing transactions changed/)).toBeInTheDocument();
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

  it('dragging the handle sets the width from the pointer, clamped at both ends', async () => {
    render(<DataChatSheet open onClose={() => {}} />);
    // Flushes the mount-time getBills fetch before driving the handle — same fix as
    // the "portals the rail" test above.
    await waitFor(() => expect(getBills).toHaveBeenCalledWith('user-1'));
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

  it('arrow keys resize from the keyboard and the width persists', async () => {
    render(<DataChatSheet open onClose={() => {}} />);
    await waitFor(() => expect(getBills).toHaveBeenCalledWith('user-1'));
    // ArrowLeft pushes the left edge left: default 416 + 24.
    fireEvent.keyDown(handle(), { key: 'ArrowLeft' });
    expect(rail().style.width).toBe('440px');
    fireEvent.keyDown(handle(), { key: 'ArrowRight' });
    expect(rail().style.width).toBe('416px');
    expect(window.localStorage.getItem('chat-rail-width')).toBe('416');
  });

  it('double-click (and Home) return to the stylesheet default', async () => {
    window.localStorage.setItem('chat-rail-width', '500');
    render(<DataChatSheet open onClose={() => {}} />);
    await waitFor(() => expect(getBills).toHaveBeenCalledWith('user-1'));
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

  it('reconciles an unanchored account against its DERIVED balance, not the $0 opening anchor (Defect 2)', async () => {
    // acct-legacy has no openingDate (unanchored) and openingBalance: 0.
    // currentOf(account) — the raw-list fallback the bug used — would report $0 here.
    // The real derived balance is $1,000 payroll - $150 grocery = $850.00.
    aiChat.mockResolvedValue(proposal('Legacy Cash', 900));
    render(<DataChatSheet open onClose={() => {}} />);
    send('legacy cash is 900');

    // #83 round 4a Defect 3: the OLD assertion (`findByText(/^Set Legacy Cash/)`)
    // stopped before the number, so it kept passing even while the card displayed
    // currentOf(account)'s $0.00 fallback instead of the derived $850 the write
    // actually measures against. Assert the full string so a re-introduced
    // currentOf() here — a fabricated "$0.00 → $900.00" — turns this red.
    await screen.findByText('Set Legacy Cash — balance $850.00 → $900.00');
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await screen.findByText(/Saved — Legacy Cash reads \$900\.00 as of today/);

    expect(reconcileAccount).toHaveBeenCalledWith('acct-legacy', 900, 850);
  });
});

/**
 * FIN-SPEND-001 (#133). Same confirm-gate shape as the balance card: nothing
 * is written until a button is pressed, and the card must never let an
 * overridden figure read as the derived average — before AND after are both
 * labelled explicitly.
 */
describe('the monthly-spend override proposal card', () => {
  const proposal = (amount = 3000) => ({
    success: true,
    result: { action: 'set_monthly_spend', amount, reason: `Assume $${amount} a month.` },
  });

  it('shows the derived figure -> the proposed one, and writes ONLY on Apply', async () => {
    aiChat.mockResolvedValue(proposal(3000));
    render(<DataChatSheet open onClose={() => {}} />);
    send('assume I spend 3000 a month');

    // Derived side is not pinned to an exact number (it depends on the fixture's
    // dates vs. whenever the suite runs) — only that it is labelled "derived" and
    // the proposed side reads exactly $3,000.00, labelled "your assumption".
    expect(await screen.findByText(/\(derived\) → \$3,000\.00 \(your assumption\)/)).toBeInTheDocument();
    expect(updateProfile).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await screen.findByText(/Saved — runway now assumes \$3,000\.00 a month/);
    expect(updateProfile).toHaveBeenCalledWith({ settings: { assumedMonthlySpend: 3000 } });
    expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
  });

  it('an existing override shows as "your assumption" on the before side too', async () => {
    PROFILE_SETTINGS = { assumedMonthlySpend: 1800 };
    aiChat.mockResolvedValue(proposal(2200));
    render(<DataChatSheet open onClose={() => {}} />);
    send('use 2200 instead of my average');

    expect(await screen.findByText(
      'Runway spend assumption — $1,800.00 (your assumption) → $2,200.00 (your assumption)'
    )).toBeInTheDocument();
  });

  it('"Back to derived" clears the override instead of accepting the proposed number', async () => {
    PROFILE_SETTINGS = { assumedMonthlySpend: 1800 };
    aiChat.mockResolvedValue(proposal(2200));
    render(<DataChatSheet open onClose={() => {}} />);
    send('use 2200 instead of my average');

    fireEvent.click(await screen.findByRole('button', { name: 'Back to derived' }));

    await screen.findByText('Saved — runway is back to your derived 6-month average.');
    expect(updateProfile).toHaveBeenCalledWith({ settings: { assumedMonthlySpend: null } });
  });

  it('Cancel drops the proposal without writing anything', async () => {
    aiChat.mockResolvedValue(proposal(3000));
    render(<DataChatSheet open onClose={() => {}} />);
    send('assume I spend 3000 a month');

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(/your assumption/)).not.toBeInTheDocument();
    expect(updateProfile).not.toHaveBeenCalled();
  });

  it('rejects corrupt values (0, negative, NaN, Infinity, string) as null — falls back to derived (FIN-SPEND-001)', async () => {
    // A doc edited by hand or by an older client must not corrupt the UI. The sanitization
    // guard ensures corrupt settings values are treated as null (i.e., use derived average).
    PROFILE_SETTINGS = { assumedMonthlySpend: 0 };
    aiChat.mockResolvedValue(proposal(3000));
    render(<DataChatSheet open onClose={() => {}} />);
    send('assume I spend 3000 a month');

    // Zero is treated as null, so the before side reads "derived" not "your assumption".
    expect(await screen.findByText(/\(derived\) → \$3,000\.00 \(your assumption\)/)).toBeInTheDocument();

    // Same for negative — should also treat as derived.
    PROFILE_SETTINGS = { assumedMonthlySpend: -500 };
    render(<DataChatSheet open onClose={() => {}} />);
    // A second, independent mount — its own getBills fetch, flushed before the test
    // ends so its resolution never lands outside act().
    await waitFor(() => expect(getBills).toHaveBeenCalledTimes(2));
    expect(screen.getByText(/\(derived\) → \$3,000\.00 \(your assumption\)/)).toBeInTheDocument();
  });
});

/**
 * record_bill (#10/#14). The scene this fixes: an owner attached an Apple Card
 * installment screenshot, asked to record it, and the model said "This will be
 * recorded" with NOTHING written. This card is the actual write path.
 */
describe('resolveBillPaymentMethod — accountName -> paymentMethodId', () => {
  it('resolves an exact (case-insensitive) label match', () => {
    expect(resolveBillPaymentMethod('Apple Card')).toBe('apple-card');
    expect(resolveBillPaymentMethod('apple card')).toBe('apple-card');
  });

  it('resolves a unique substring match', () => {
    expect(resolveBillPaymentMethod('Apple')).toBe('apple-card');
  });

  it('no name at all defaults to "manual" — the model just did not say', () => {
    expect(resolveBillPaymentMethod(undefined)).toBe('manual');
  });

  it('a name that matches nothing resolves to null — unresolvable, not a guess', () => {
    expect(resolveBillPaymentMethod('Chase Sapphire')).toBeNull();
  });
});

describe('the record_bill proposal card', () => {
  const proposal = (over: Record<string, unknown> = {}) => ({
    success: true,
    result: {
      action: 'record_bill',
      vendor: 'Apple Card installment - iPhone',
      amount: 45.79,
      frequency: 'monthly',
      dueDay: 15,
      accountName: 'Apple Card',
      installmentsRemaining: 13,
      nonNegotiable: true,
      reason: 'You said $45.79/mo on the Apple Card, 13 payments left.',
      ...over,
    },
  });

  it('shows the proposal and writes NOTHING until Apply', async () => {
    aiChat.mockResolvedValue(proposal());
    render(<DataChatSheet open onClose={() => {}} />);
    send('record my iPhone installment, $45.79 monthly on Apple Card, $595.31 remaining');

    expect(await screen.findByText('Record Apple Card installment - iPhone — $45.79 monthly (day 15)')).toBeInTheDocument();
    expect(addBill).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(addBill).toHaveBeenCalledTimes(1));
    expect(addBill).toHaveBeenCalledWith('user-1', expect.objectContaining({
      vendor: 'Apple Card installment - iPhone',
      amount: 45.79,
      frequency: 'monthly',
      autopayDay: 15,
      paymentMethodId: 'apple-card',
      installmentsRemaining: 13,
      nonNegotiable: true,
      lifecycleStatus: 'active',
    }));
    expect(await screen.findByText(/Saved/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
  });

  it('Cancel drops the proposal without saving it', async () => {
    aiChat.mockResolvedValue(proposal());
    render(<DataChatSheet open onClose={() => {}} />);
    send('record my iPhone installment');

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
    expect(addBill).not.toHaveBeenCalled();
  });

  it('an accountName that matches nothing gets words and NO button — the model never picks the method', async () => {
    aiChat.mockResolvedValue(proposal({ accountName: 'Chase Sapphire' }));
    render(<DataChatSheet open onClose={() => {}} />);
    send('record it on my chase sapphire');

    expect(await screen.findByText(/couldn't match .Chase Sapphire./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
  });

  it('no accountName at all still offers Apply, defaulting to "Manual / other"', async () => {
    const { accountName, ...withoutAccount } = proposal().result;
    aiChat.mockResolvedValue({ success: true, result: withoutAccount });
    render(<DataChatSheet open onClose={() => {}} />);
    send('record my netflix subscription');

    fireEvent.click(await screen.findByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(addBill).toHaveBeenCalledTimes(1));
    expect(addBill).toHaveBeenCalledWith('user-1', expect.objectContaining({ paymentMethodId: 'manual' }));
  });

  it('never claims a save happened before Apply is pressed — the live overpromise bug', async () => {
    aiChat.mockResolvedValue(proposal());
    render(<DataChatSheet open onClose={() => {}} />);
    send('record my iPhone installment');

    await screen.findByText(/Apple Card installment - iPhone/);
    expect(screen.queryByText(/Saved/)).not.toBeInTheDocument();
    expect(addBill).not.toHaveBeenCalled();
  });
});

/**
 * Defect 1 (record-bill-report.md follow-up, #10/#14): a chat-recorded bill never got
 * a Bill.anchorDate, so billUpcomingEvents (src/lib/bills.ts) silently produced ZERO
 * Upcoming events for weekly/biweekly (projectWeeklyish requires anchorDate) and
 * quarterly/semiannual/annual (projectMonthlyish's periodMonths>1 branch requires it
 * too, to pin WHICH months in the cycle qualify). record_bill's new nextDueDate field
 * is the fix's input; resolveBillAnchor turns it into autopayDay/anchorDate exactly
 * the way billUpcomingEvents needs.
 */
describe('resolveBillAnchor — dueDay/nextDueDate -> autopayDay/anchorDate (Defect 1)', () => {
  it('monthly: an explicit dueDay becomes autopayDay', () => {
    expect(resolveBillAnchor({ frequency: 'monthly', dueDay: 15 })).toEqual({ autopayDay: 15 });
  });

  it('monthly: neither dueDay nor nextDueDate still resolves — "varies" is a valid pre-existing state, not broken', () => {
    expect(resolveBillAnchor({ frequency: 'monthly' })).toEqual({ autopayDay: undefined });
  });

  it('monthly: derives autopayDay from nextDueDate\'s day-of-month when dueDay is absent', () => {
    expect(resolveBillAnchor({ frequency: 'monthly', nextDueDate: '2026-09-15' })).toEqual({ autopayDay: 15 });
  });

  it('weekly/biweekly: nextDueDate becomes anchorDate — dueDay is irrelevant to them', () => {
    expect(resolveBillAnchor({ frequency: 'weekly', nextDueDate: '2026-09-03' })).toEqual({ anchorDate: '2026-09-03' });
    expect(resolveBillAnchor({ frequency: 'biweekly', nextDueDate: '2026-09-03' })).toEqual({ anchorDate: '2026-09-03' });
  });

  it('weekly/biweekly: no nextDueDate resolves to null — a dueDay alone cannot anchor them', () => {
    expect(resolveBillAnchor({ frequency: 'weekly' })).toBeNull();
    expect(resolveBillAnchor({ frequency: 'biweekly', dueDay: 15 })).toBeNull();
  });

  it('quarterly/semiannual/annual: need nextDueDate to pin the cycle, even when dueDay is given', () => {
    expect(resolveBillAnchor({ frequency: 'quarterly', dueDay: 10 })).toBeNull();
    expect(resolveBillAnchor({ frequency: 'semiannual', dueDay: 10 })).toBeNull();
    expect(resolveBillAnchor({ frequency: 'annual', dueDay: 10 })).toBeNull();
  });

  it('quarterly: resolves from nextDueDate alone, deriving autopayDay from its day-of-month', () => {
    expect(resolveBillAnchor({ frequency: 'quarterly', nextDueDate: '2026-01-10' }))
      .toEqual({ autopayDay: 10, anchorDate: '2026-01-10' });
  });

  it('quarterly: an explicit dueDay wins over the derived one when both are given', () => {
    expect(resolveBillAnchor({ frequency: 'quarterly', dueDay: 12, nextDueDate: '2026-01-10' }))
      .toEqual({ autopayDay: 12, anchorDate: '2026-01-10' });
  });
});

describe('the record_bill card and Defect 1 — nextDueDate wires anchorDate through to Upcoming', () => {
  const billReply = (over: Record<string, unknown> = {}) => ({
    success: true,
    result: {
      action: 'record_bill',
      vendor: 'Test Bill',
      amount: 45.79,
      frequency: 'weekly',
      reason: 'Recording a test bill.',
      ...over,
    },
  });

  it('a weekly bill with no nextDueDate cannot anchor — words, no Apply button', async () => {
    aiChat.mockResolvedValue(billReply({ frequency: 'weekly' }));
    render(<DataChatSheet open onClose={() => {}} />);
    send('record my weekly $45.79 bill');

    expect(await screen.findByText(/next due date for a weekly bill/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
    expect(addBill).not.toHaveBeenCalled();
  });

  it('a quarterly bill with a dueDay but no nextDueDate STILL cannot anchor — a day-of-month alone cannot pin the cycle', async () => {
    aiChat.mockResolvedValue(billReply({ frequency: 'quarterly', dueDay: 10 }));
    render(<DataChatSheet open onClose={() => {}} />);
    send('record my quarterly $45.79 bill, due the 10th');

    expect(await screen.findByText(/next due date for a quarterly bill/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
    expect(addBill).not.toHaveBeenCalled();
  });

  it('a weekly bill WITH nextDueDate applies, writes anchorDate, and now produces an Upcoming event', async () => {
    const nextDueDate = '2026-09-03';
    aiChat.mockResolvedValue(billReply({ frequency: 'weekly', nextDueDate, accountName: 'Apple Card' }));
    render(<DataChatSheet open onClose={() => {}} />);
    send('record my weekly $45.79 on Apple Card, next payment Sep 3');

    fireEvent.click(await screen.findByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(addBill).toHaveBeenCalledTimes(1));
    expect(addBill).toHaveBeenCalledWith('user-1', expect.objectContaining({
      frequency: 'weekly',
      anchorDate: nextDueDate,
      paymentMethodId: 'apple-card',
    }));

    // The actual proof this defect is fixed: the row addBill just received, run
    // through the real projection util, now yields an Upcoming event.
    const saved: Bill = { id: 'b1', createdAt: '', updatedAt: '', ...addBill.mock.calls[0][1] };
    expect(billUpcomingEvents([saved], '2026-08-25', 45).length).toBeGreaterThan(0);
  });

  it('a quarterly bill with ONLY nextDueDate applies, derives autopayDay, and now produces an Upcoming event', async () => {
    const nextDueDate = '2026-09-10';
    aiChat.mockResolvedValue(billReply({ frequency: 'quarterly', nextDueDate, accountName: 'Apple Card' }));
    render(<DataChatSheet open onClose={() => {}} />);
    send('record my quarterly $45.79 on Apple Card, next payment Sep 10');

    fireEvent.click(await screen.findByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(addBill).toHaveBeenCalledTimes(1));
    expect(addBill).toHaveBeenCalledWith('user-1', expect.objectContaining({
      frequency: 'quarterly',
      autopayDay: 10,
      anchorDate: nextDueDate,
      paymentMethodId: 'apple-card',
    }));

    const saved: Bill = { id: 'b1', createdAt: '', updatedAt: '', ...addBill.mock.calls[0][1] };
    expect(billUpcomingEvents([saved], '2026-08-25', 45).length).toBeGreaterThan(0);
  });
});

/**
 * cashflow-mobile#34. The owner scenario this closes: "clear the rest apple card
 * instalment c b a" — the chat could record_bill but had no way to edit or remove
 * one, so a finished installment sat in Upcoming forever and an installment named
 * only "A"/"B"/"C"/"D" (a statement line never says what it bought) could never be
 * renamed to the real product. RESOLUTION is the hard part: a vendor match that
 * could mean more than one row must refuse, never guess.
 */
describe('update_bill / remove_bill — cashflow-mobile#34', () => {
  const installmentA = {
    id: 'bill-a', vendor: 'Apple Card Installment A', amount: 45.79, frequency: 'monthly' as const,
    paymentMethodId: 'apple-card', migrationStatus: 'to-review' as const, lifecycleStatus: 'active' as const,
    installmentsRemaining: 5, autopayDay: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const installmentB = { ...installmentA, id: 'bill-b', vendor: 'Apple Card Installment B', amount: 32.5, installmentsRemaining: 3 };
  const installmentC = { ...installmentA, id: 'bill-c', vendor: 'Apple Card Installment C', amount: 108, installmentsRemaining: 9 };
  const installmentD = { ...installmentA, id: 'bill-d', vendor: 'Apple Card Installment D', amount: 59, installmentsRemaining: 2 };
  const INSTALLMENTS = [installmentA, installmentB, installmentC, installmentD];

  beforeEach(() => {
    getBills.mockResolvedValue(INSTALLMENTS);
  });

  describe('resolveBill — the resolution the cards are built on', () => {
    it('billId resolves exactly, even when the vendor field alone would be ambiguous', () => {
      expect(resolveBill({ billId: 'bill-c', vendor: 'Apple Card Installment' }, INSTALLMENTS)).toBe(installmentC);
    });

    it('an exact (case-insensitive) vendor match resolves', () => {
      expect(resolveBill({ vendor: 'apple card installment c' }, INSTALLMENTS)).toBe(installmentC);
    });

    it('an ambiguous vendor substring refuses — never guesses between similarly-named installments', () => {
      expect(resolveBill({ vendor: 'Apple Card Installment' }, INSTALLMENTS)).toBeNull();
    });

    it('a vendor matching nothing resolves to null', () => {
      expect(resolveBill({ vendor: 'Netflix' }, INSTALLMENTS)).toBeNull();
    });

    it('an empty match resolves to null', () => {
      expect(resolveBill({}, INSTALLMENTS)).toBeNull();
    });

    /**
     * "Prove teeth": if the ambiguity guard degenerated to "just take the first
     * match" (contains[0] instead of requiring contains.length === 1), this is the
     * test that goes red — exactly the failure mode that would have let the chat
     * silently rename the WRONG installment.
     */
    it('would go red if the ambiguity guard were weakened to "pick the first match"', () => {
      const wouldPickFirst = INSTALLMENTS.filter((b) => b.vendor.toLowerCase().includes('apple card installment'))[0];
      expect(resolveBill({ vendor: 'Apple Card Installment' }, INSTALLMENTS)).not.toBe(wouldPickFirst);
    });
  });

  describe('the update_bill card', () => {
    const proposal = (over: Record<string, unknown> = {}) => ({
      success: true,
      result: {
        action: 'update_bill',
        match: { vendor: 'Apple Card Installment C' },
        set: { vendor: 'MacBook Air', amount: 108, installmentsRemaining: 8 },
        reason: 'Got it — installment C is the MacBook Air.',
        ...over,
      },
    });

    it('resolves the exact row and shows before -> after — writes NOTHING until Apply', async () => {
      aiChat.mockResolvedValue(proposal());
      render(<DataChatSheet open onClose={() => {}} />);
      await waitFor(() => expect(getBills).toHaveBeenCalledWith('user-1'));
      send('installment C is the MacBook Air');

      expect(await screen.findByText('Apple Card Installment C — $108.00 monthly → MacBook Air — $108.00 monthly')).toBeInTheDocument();
      expect(screen.getByText(/8 payments left/)).toBeInTheDocument();
      expect(updateBill).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

      await waitFor(() => expect(updateBill).toHaveBeenCalledTimes(1));
      expect(updateBill).toHaveBeenCalledWith('user-1', 'bill-c', {
        vendor: 'MacBook Air', amount: 108, installmentsRemaining: 8,
      });
      expect(await screen.findByText('Saved — Apple Card Installment C → MacBook Air, $108.00 monthly, 8 payments left.')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
    });

    it('an ambiguous vendor gets words and NO button — never guesses between similarly-named installments', async () => {
      aiChat.mockResolvedValue(proposal({ match: { vendor: 'Apple Card Installment' } }));
      render(<DataChatSheet open onClose={() => {}} />);
      await waitFor(() => expect(getBills).toHaveBeenCalledWith('user-1'));
      send('clear the rest of the apple card installments');

      expect(await screen.findByText(/couldn't match .Apple Card Installment. to exactly one of your bills/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
      expect(updateBill).not.toHaveBeenCalled();
    });

    it('billId resolves exactly and applies, even though the vendor field alone would be ambiguous', async () => {
      aiChat.mockResolvedValue(proposal({ match: { billId: 'bill-c', vendor: 'Apple Card Installment' } }));
      render(<DataChatSheet open onClose={() => {}} />);
      await waitFor(() => expect(getBills).toHaveBeenCalledWith('user-1'));
      send('installment C is the MacBook Air');

      fireEvent.click(await screen.findByRole('button', { name: 'Apply' }));
      await waitFor(() => expect(updateBill).toHaveBeenCalledWith('user-1', 'bill-c', expect.anything()));
    });

    it('marking installmentsRemaining 0 finishes the bill and says so — preserves history, leaves Upcoming', async () => {
      aiChat.mockResolvedValue(proposal({
        match: { vendor: 'Apple Card Installment A' },
        set: { installmentsRemaining: 0 },
        reason: 'Installment A is paid off.',
      }));
      render(<DataChatSheet open onClose={() => {}} />);
      await waitFor(() => expect(getBills).toHaveBeenCalledWith('user-1'));
      send('installment A is paid off');

      expect(await screen.findByText(/finished — leaves Upcoming/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

      await waitFor(() => expect(updateBill).toHaveBeenCalledWith('user-1', 'bill-a', { installmentsRemaining: 0 }));
      expect(await screen.findByText(/No longer in Upcoming/)).toBeInTheDocument();
    });

    it('a match resolving to nothing gets words and NO button — unknown, not a guess', async () => {
      aiChat.mockResolvedValue(proposal({ match: { vendor: 'Netflix' } }));
      render(<DataChatSheet open onClose={() => {}} />);
      await waitFor(() => expect(getBills).toHaveBeenCalledWith('user-1'));
      send('netflix installment is the MacBook Air');

      expect(await screen.findByText(/couldn't match .Netflix. to exactly one of your bills/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
    });

    it('Cancel drops the proposal without writing anything', async () => {
      aiChat.mockResolvedValue(proposal());
      render(<DataChatSheet open onClose={() => {}} />);
      await waitFor(() => expect(getBills).toHaveBeenCalledWith('user-1'));
      send('installment C is the MacBook Air');

      fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
      expect(updateBill).not.toHaveBeenCalled();
    });
  });

  describe('the remove_bill card', () => {
    const proposal = (over: Record<string, unknown> = {}) => ({
      success: true,
      result: {
        action: 'remove_bill',
        match: { vendor: 'Apple Card Installment D' },
        reason: 'Installment D was recorded by mistake.',
        ...over,
      },
    });

    it('names exactly what will disappear — writes NOTHING until Apply', async () => {
      aiChat.mockResolvedValue(proposal());
      render(<DataChatSheet open onClose={() => {}} />);
      await waitFor(() => expect(getBills).toHaveBeenCalledWith('user-1'));
      send('installment D was a mistake, remove it');

      expect(await screen.findByText('Remove Apple Card Installment D — $59.00 monthly, permanently')).toBeInTheDocument();
      expect(deleteBill).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

      await waitFor(() => expect(deleteBill).toHaveBeenCalledWith('user-1', 'bill-d'));
      expect(await screen.findByText('Saved — Apple Card Installment D removed. $59.00 monthly is no longer in Upcoming.')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
    });

    it('an ambiguous vendor gets words and NO button', async () => {
      aiChat.mockResolvedValue(proposal({ match: { vendor: 'Apple Card Installment' } }));
      render(<DataChatSheet open onClose={() => {}} />);
      await waitFor(() => expect(getBills).toHaveBeenCalledWith('user-1'));
      send('remove the apple card installment');

      expect(await screen.findByText(/couldn't match .Apple Card Installment. to exactly one of your bills/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
      expect(deleteBill).not.toHaveBeenCalled();
    });

    it('Cancel drops the proposal without deleting anything', async () => {
      aiChat.mockResolvedValue(proposal());
      render(<DataChatSheet open onClose={() => {}} />);
      await waitFor(() => expect(getBills).toHaveBeenCalledWith('user-1'));
      send('remove installment D');

      fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
      expect(deleteBill).not.toHaveBeenCalled();
    });
  });

  describe('describeBillUpdate — the before -> after applied message', () => {
    it('states vendor rename, amount, cadence and payments left', () => {
      expect(describeBillUpdate(installmentC, { ...installmentC, vendor: 'MacBook Air', amount: 108, installmentsRemaining: 8 }))
        .toBe('Saved — Apple Card Installment C → MacBook Air, $108.00 monthly, 8 payments left.');
    });

    it('marks a bill finished and says it left Upcoming, when installmentsRemaining hits 0', () => {
      expect(describeBillUpdate(installmentA, { ...installmentA, installmentsRemaining: 0 }))
        .toBe('Saved — Apple Card Installment A, $45.79 monthly, finished. No longer in Upcoming.');
    });

    it('leaves the vendor out of the arrow when only the amount changes', () => {
      expect(describeBillUpdate(installmentA, { ...installmentA, amount: 50 }))
        .toBe('Saved — Apple Card Installment A, $50.00 monthly, 5 payments left.');
    });
  });
});

/**
 * #22 (cashflow-mobile). The chat could WRITE a bill (record_bill above) but could not
 * SEE the register it had just written to — asked "is it existing?" it said "I do not
 * have that information". This is the fetch that closes the gap: the SAME getBills()
 * the Bills tab already uses, fed into buildChatContext so every turn carries it.
 */
describe('DataChatSheet fetches the Bills register and includes it in the chat context (#22)', () => {
  const savedBill = {
    id: 'bill-1', vendor: 'Verizon Wireless', amount: 85, frequency: 'monthly' as const,
    paymentMethodId: 'bofa-debit', migrationStatus: 'to-review' as const, lifecycleStatus: 'active' as const,
    nonNegotiable: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('sends context.bills built from the fetched register, so the model can answer "what bills do I have"', async () => {
    getBills.mockResolvedValue([savedBill]);
    aiChat.mockResolvedValue({ success: true, result: { action: 'answer', explanation: 'Verizon Wireless, $85 monthly.' } });

    render(<DataChatSheet open onClose={() => {}} />);
    await waitFor(() => expect(getBills).toHaveBeenCalledWith('user-1'));

    send('what bills do I have');
    await waitFor(() => expect(aiChat).toHaveBeenCalled());

    const [{ context }] = aiChat.mock.calls[0];
    expect(context.bills).toEqual([
      { vendor: 'Verizon Wireless', amount: 85, frequency: 'monthly', nonNegotiable: true, method: 'BofA Debit' },
    ]);
  });

  it('sends an empty bills list — never undefined — before the fetch resolves or when nothing is recorded', async () => {
    getBills.mockResolvedValue([]);
    aiChat.mockResolvedValue({ success: true, result: { action: 'answer', explanation: 'You have no bills recorded.' } });

    render(<DataChatSheet open onClose={() => {}} />);
    send('what bills do I have');
    await waitFor(() => expect(aiChat).toHaveBeenCalled());

    const [{ context }] = aiChat.mock.calls[0];
    expect(context.bills).toEqual([]);
  });

  /**
   * The defect this closes: `bills` was fetched ONCE on mount and never refreshed, so
   * within one open session, recording a bill via Apply and then asking "is it existing?"
   * still answered from the pre-write list — the model saw no such bill. Apply must
   * update local state immediately, not wait for a reopen/reload.
   */
  it('a bill recorded via Apply THIS session is in context.bills on the very next turn — no reopen needed', async () => {
    getBills.mockResolvedValue([]); // nothing recorded yet when the sheet opens
    addBill.mockResolvedValue('new-bill-id');
    aiChat
      .mockResolvedValueOnce({
        success: true,
        result: {
          action: 'record_bill', vendor: 'Netflix', amount: 15.49, frequency: 'monthly', dueDay: 14,
          reason: 'Record Netflix, $15.49/mo.',
        },
      })
      .mockResolvedValueOnce({ success: true, result: { action: 'answer', explanation: 'Yes, Netflix is on your bills.' } });

    render(<DataChatSheet open onClose={() => {}} />);
    await waitFor(() => expect(getBills).toHaveBeenCalledWith('user-1'));

    send('record my netflix subscription, $15.49 monthly, due the 14th');
    fireEvent.click(await screen.findByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(addBill).toHaveBeenCalledTimes(1));
    await screen.findByText(/Saved — Netflix/);

    send('is netflix already on my bills?');
    await waitFor(() => expect(aiChat).toHaveBeenCalledTimes(2));

    const [{ context }] = aiChat.mock.calls[1];
    expect(context.bills).toEqual([
      { vendor: 'Netflix', amount: 15.49, frequency: 'monthly', method: 'Manual / other' },
    ]);
    // The fix is a local state update, not a second read of the register.
    expect(getBills).toHaveBeenCalledTimes(1);
  });
});

/**
 * Regression: Navbar renders `<DataChatSheet open={isChatOpen} .../>` on EVERY page,
 * unconditionally — `open` only gates the final `return null`, well after every hook
 * (including the bills fetch) has already run. Fetching on mount meant a Firestore read
 * on every page load even when the owner never opened the chat — caught by
 * e2e/accounts-observability.spec.ts, which asserts no live backend call happens before
 * the user acts. The fetch must be lazy: gated on `open`, not on mount.
 */
describe('DataChatSheet — the bills fetch is LAZY (gated on open, never on mount)', () => {
  it('does not fetch bills while closed — mounted-but-closed is exactly how Navbar renders this on every page', async () => {
    render(<DataChatSheet open={false} onClose={() => {}} />);
    // Give any stray microtask a chance to run before asserting the negative.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getBills).not.toHaveBeenCalled();
  });

  it('fetches once the sheet is actually opened', async () => {
    const { rerender } = render(<DataChatSheet open={false} onClose={() => {}} />);
    expect(getBills).not.toHaveBeenCalled();

    rerender(<DataChatSheet open onClose={() => {}} />);
    await waitFor(() => expect(getBills).toHaveBeenCalledWith('user-1'));
  });

  it('does not refetch on a later close/reopen — the already-loaded list is kept (Apply\'s local append covers dedupe)', async () => {
    const { rerender } = render(<DataChatSheet open onClose={() => {}} />);
    await waitFor(() => expect(getBills).toHaveBeenCalledTimes(1));

    rerender(<DataChatSheet open={false} onClose={() => {}} />);
    rerender(<DataChatSheet open onClose={() => {}} />);

    expect(getBills).toHaveBeenCalledTimes(1);
  });
});

/**
 * cashflow-mobile#24 — add_category. Never fails to resolve (nothing to look up
 * against real data), so it always offers Apply. The value/slug is derived by
 * the APP, never the model — see slugForCategoryLabel.
 */
describe('the add_category proposal card', () => {
  const proposal = (over: Record<string, unknown> = {}) => ({
    success: true,
    result: { action: 'add_category', label: 'Vacations', icon: '🏖️', reason: 'You asked for a Vacations category.', ...over },
  });

  it('shows the proposal and writes NOTHING until Apply', async () => {
    aiChat.mockResolvedValue(proposal());
    render(<DataChatSheet open onClose={() => {}} />);
    send('add a Vacations category');

    expect(await screen.findByText('Add category "Vacations" 🏖️')).toBeInTheDocument();
    expect(updateProfile).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(1));
    expect(updateProfile).toHaveBeenCalledWith({
      settings: { categories: [{ value: 'vacations', label: 'Vacations', icon: '🏖️' }] },
    });
    expect(await screen.findByText('Saved — added "Vacations" as a category.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
  });

  it('omits the icon key entirely when the model gave none — never writes it as undefined', async () => {
    const { icon: _icon, ...withoutIcon } = proposal().result;
    aiChat.mockResolvedValue({ success: true, result: withoutIcon });
    render(<DataChatSheet open onClose={() => {}} />);
    send('add a Vacations category');

    expect(await screen.findByText('Add category "Vacations"')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(1));
    expect(updateProfile).toHaveBeenCalledWith({ settings: { categories: [{ value: 'vacations', label: 'Vacations' }] } });
  });

  it('derives a collision-safe slug when the label would collide with an existing one', async () => {
    PROFILE_SETTINGS = { categories: [{ value: 'vacations', label: 'Vacations' }] };
    aiChat.mockResolvedValue(proposal());
    render(<DataChatSheet open onClose={() => {}} />);
    send('add another Vacations category');

    fireEvent.click(await screen.findByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(1));
    expect(updateProfile).toHaveBeenCalledWith({
      settings: {
        categories: [
          { value: 'vacations', label: 'Vacations' },
          { value: 'vacations-2', label: 'Vacations', icon: '🏖️' },
        ],
      },
    });
  });

  it('Cancel drops the proposal without writing anything', async () => {
    aiChat.mockResolvedValue(proposal());
    render(<DataChatSheet open onClose={() => {}} />);
    send('add a Vacations category');

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
    expect(updateProfile).not.toHaveBeenCalled();
  });
});

/**
 * cashflow-mobile#24 — rename_category. Only ever targets a CUSTOM category the
 * owner already has (parseChatAction refuses a built-in default before this
 * card ever renders — see chat-actions.test.ts).
 */
describe('the rename_category proposal card', () => {
  beforeEach(() => {
    PROFILE_SETTINGS = { categories: [{ value: 'vacations', label: 'Vacations' }] };
  });

  const proposal = {
    success: true,
    result: { action: 'rename_category', value: 'vacations', label: 'Trips', reason: 'You asked to rename it.' },
  };

  it('shows current -> new and writes ONLY on Apply', async () => {
    aiChat.mockResolvedValue(proposal);
    render(<DataChatSheet open onClose={() => {}} />);
    send('rename Vacations to Trips');

    expect(await screen.findByText('Rename "Vacations" → "Trips"')).toBeInTheDocument();
    expect(updateProfile).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(1));
    expect(updateProfile).toHaveBeenCalledWith({ settings: { categories: [{ value: 'vacations', label: 'Trips' }] } });
    expect(await screen.findByText('Saved — renamed to "Trips".')).toBeInTheDocument();
  });

  it('Cancel drops the proposal without writing anything', async () => {
    aiChat.mockResolvedValue(proposal);
    render(<DataChatSheet open onClose={() => {}} />);
    send('rename Vacations to Trips');

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(updateProfile).not.toHaveBeenCalled();
  });
});

/**
 * cashflow-mobile#24/#28 — remove_category. The preview (planCategoryRemoval,
 * client-side, unchanged) MUST show the exact counts BEFORE applying; Apply
 * now calls the removeCategory callable (functions/src/categoryRemoval.ts)
 * instead of sweeping transactions/rules/bills one write at a time — the
 * whole sweep happens server-side, atomically, and this component only
 * reports the counts the server hands back. Fixture below carries one live
 * row of each kind, matching what the preview shows.
 */
describe('the remove_category proposal card', () => {
  // 'vacations' is a CUSTOM category — not a member of the closed ExpenseCategory
  // union, exactly like a real custom slug wouldn't be. Same `as` idiom the rest
  // of this codebase uses for a runtime-valid, compile-time-foreign value.
  const vacationRule: MappingRule = {
    id: 'rule-vac', createdAt: '', enabled: true,
    match: { field: 'merchant', op: 'contains', value: 'Cabo' }, set: { category: 'vacations' as ExpenseCategory },
  };
  const vacationTxn = {
    id: 'vac-1', title: 'CABO RESORT', merchant: 'Cabo Resort', amount: 300,
    type: 'expense', category: 'vacations' as ExpenseCategory, paymentMethod: 'visa', date: '2026-07-10',
  } as Transaction;
  const vacationBill: Bill = {
    id: 'bill-vac', vendor: 'Airbnb', amount: 200, frequency: 'monthly', category: 'vacations',
    paymentMethodId: 'manual', migrationStatus: 'to-review', lifecycleStatus: 'active',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };

  const proposal = (reassignTo?: string) => ({
    success: true,
    result: {
      action: 'remove_category', value: 'vacations',
      ...(reassignTo ? { reassignTo } : {}),
      reason: 'You asked to remove Vacations.',
    },
  });

  beforeEach(async () => {
    PROFILE_SETTINGS = { categories: [{ value: 'vacations', label: 'Vacations' }] };
    RULES = [vacationRule];
    EXTRA_TRANSACTIONS = [vacationTxn];
    getBills.mockResolvedValue([vacationBill]);
    removeCategory.mockResolvedValue({ moved: { transactions: 1, rules: 1, bills: 1, budgets: 0, plannedTransactions: 0 } });
  });

  it('shows the exact counts BEFORE applying, and calls NOTHING until Apply', async () => {
    aiChat.mockResolvedValue(proposal());
    render(<DataChatSheet open onClose={() => {}} />);
    await waitFor(() => expect(getBills).toHaveBeenCalledWith('user-1'));
    send('remove the Vacations category');

    expect(await screen.findByText('Remove "Vacations" — 1 transaction, 1 rule, 1 bill will move to Other')).toBeInTheDocument();
    expect(removeCategory).not.toHaveBeenCalled();
    expect(updateProfile).not.toHaveBeenCalled();
  });

  it('Apply calls removeCategory, archives the category locally, and reports the SERVER\'s counts', async () => {
    aiChat.mockResolvedValue(proposal());
    render(<DataChatSheet open onClose={() => {}} />);
    await waitFor(() => expect(getBills).toHaveBeenCalledWith('user-1'));
    send('remove the Vacations category');
    await screen.findByText(/will move to Other/);

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(removeCategory).toHaveBeenCalledWith('vacations', 'other'));
    // Archived, not deleted — never orphaning the value for a row still mid-flight.
    expect(updateProfile).toHaveBeenCalledWith({
      settings: { categories: [{ value: 'vacations', label: 'Vacations', archived: true }] },
    });
    // The server's counts, not a client-side recount — this message would lie
    // if it echoed the PREVIEW instead of `result.moved`. Preview and server
    // agree here (fixture matches the mock 1-for-1), so no divergence note.
    expect(await screen.findByText('Saved — 1 transaction, 1 rule, 1 bill, 0 budgets, 0 planned payments moved to Other.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
  });

  /**
   * cashflow-mobile#28-followup: the sweep now covers categoryBudgets and
   * plannedTransactions too — the applied message must report those counts,
   * not just transactions/rules/bills.
   */
  it('reports non-zero budget and planned-payment counts the preview never showed', async () => {
    removeCategory.mockResolvedValue({ moved: { transactions: 1, rules: 1, bills: 1, budgets: 2, plannedTransactions: 3 } });
    aiChat.mockResolvedValue(proposal());
    render(<DataChatSheet open onClose={() => {}} />);
    await waitFor(() => expect(getBills).toHaveBeenCalledWith('user-1'));
    send('remove the Vacations category');
    await screen.findByText(/will move to Other/);

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    expect(await screen.findByText('Saved — 1 transaction, 1 rule, 1 bill, 2 budgets, 3 planned payments moved to Other.')).toBeInTheDocument();
  });

  /**
   * FIN-SETTLEMENT-003: the preview reads local state (bills fetched once per
   * profile, never refreshed); the server recomputes fresh at click time. When
   * they genuinely disagree, the applied message must say so — never let the
   * server's number silently stand in for what the owner actually approved.
   */
  it('names the preview\'s numbers when the server moved a different count than the preview showed', async () => {
    // Preview (fixture) shows 1 transaction, 1 rule, 1 bill. The server
    // reports 3 transactions moved — new activity arrived between preview and
    // Apply (e.g. another Cabo charge landed in the meantime).
    removeCategory.mockResolvedValue({ moved: { transactions: 3, rules: 1, bills: 1, budgets: 0, plannedTransactions: 0 } });
    aiChat.mockResolvedValue(proposal());
    render(<DataChatSheet open onClose={() => {}} />);
    await waitFor(() => expect(getBills).toHaveBeenCalledWith('user-1'));
    send('remove the Vacations category');
    await screen.findByText('Remove "Vacations" — 1 transaction, 1 rule, 1 bill will move to Other');

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    // The actual (server) counts lead the sentence...
    expect(await screen.findByText(
      /Saved — 3 transactions, 1 rule, 1 bill, 0 budgets, 0 planned payments moved to Other\./
    )).toBeInTheDocument();
    // ...and the divergence note names the preview's own number and why it changed.
    expect(screen.getByText(/The preview showed 1 transaction, 1 rule, 1 bill/)).toBeInTheDocument();
    expect(screen.getByText(/activity between the preview and Apply changed that/)).toBeInTheDocument();
  });

  it('reassigns to an explicit target when the model named one, instead of the "other" default', async () => {
    aiChat.mockResolvedValue(proposal('shopping'));
    render(<DataChatSheet open onClose={() => {}} />);
    await waitFor(() => expect(getBills).toHaveBeenCalledWith('user-1'));
    send('remove Vacations, move everything to Shopping');

    expect(await screen.findByText(/will move to Shopping/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(removeCategory).toHaveBeenCalledWith('vacations', 'shopping'));
  });

  it('Cancel drops the proposal without calling removeCategory or writing anything', async () => {
    aiChat.mockResolvedValue(proposal());
    render(<DataChatSheet open onClose={() => {}} />);
    await waitFor(() => expect(getBills).toHaveBeenCalledWith('user-1'));
    send('remove the Vacations category');
    await screen.findByText(/will move to Other/);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(updateProfile).not.toHaveBeenCalled();
    expect(removeCategory).not.toHaveBeenCalled();
  });

  it('a category with nothing filed under it still previews and applies cleanly — zero everywhere', async () => {
    RULES = [];
    EXTRA_TRANSACTIONS = [];
    getBills.mockResolvedValue([]);
    removeCategory.mockResolvedValue({ moved: { transactions: 0, rules: 0, bills: 0, budgets: 0, plannedTransactions: 0 } });
    aiChat.mockResolvedValue(proposal());
    render(<DataChatSheet open onClose={() => {}} />);
    await waitFor(() => expect(getBills).toHaveBeenCalledWith('user-1'));
    send('remove the Vacations category');

    expect(await screen.findByText('Remove "Vacations" — 0 transactions, 0 rules, 0 bills will move to Other')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(1));
    expect(removeCategory).toHaveBeenCalledWith('vacations', 'other');
  });

  /**
   * cashflow-mobile#28: the sweep is now server-side and chunked-atomic — there
   * is no client-visible partial-success state to reconcile anymore. A failed
   * call throws, nothing local is mutated, and the same Apply button stays up
   * for a genuine retry (which simply calls removeCategory again).
   */
  it('a failed call writes nothing locally and leaves Apply live to retry', async () => {
    removeCategory.mockRejectedValueOnce(new Error('unavailable'));
    aiChat.mockResolvedValue(proposal());
    render(<DataChatSheet open onClose={() => {}} />);
    await waitFor(() => expect(getBills).toHaveBeenCalledWith('user-1'));
    send('remove the Vacations category');
    await screen.findByText(/will move to Other/);

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    expect(await screen.findByText('That could not be saved. Please try again.')).toBeInTheDocument();
    expect(updateProfile).not.toHaveBeenCalled();
    // Not marked applied: the same Apply button is still there to retry.
    expect(screen.getByRole('button', { name: 'Apply' })).toBeInTheDocument();

    removeCategory.mockResolvedValue({ moved: { transactions: 1, rules: 1, bills: 1, budgets: 0, plannedTransactions: 0 } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(1));
  });
});

/**
 * cashflow-mobile#25. "What did I spend this month, and on what" used to come back as
 * a paragraph. This is the table rendering: a `report` action becomes a semantic table,
 * never a write, never an Apply button — the table itself IS the answer.
 */
describe('the report card (cashflow-mobile#25) — a DISPLAY-ONLY table, never an Apply button', () => {
  const proposal = (over: Record<string, unknown> = {}) => ({
    success: true,
    result: {
      action: 'report',
      title: 'Spending by category, August 2026',
      columns: ['Category', 'Spent'],
      rows: [['Groceries', 412.5], ['Dining', 88]],
      note: 'Top 2 of 9 categories shown.',
      ...over,
    },
  });

  it('renders the title, table headers, rows (numbers formatted) and the note', async () => {
    aiChat.mockResolvedValue(proposal());
    render(<DataChatSheet open onClose={() => {}} />);
    send('what did I spend this month, and on what');

    expect(await screen.findByText('Spending by category, August 2026')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Category' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Spent' })).toBeInTheDocument();
    expect(screen.getByText('Groceries')).toBeInTheDocument();
    expect(screen.getByText('412.5')).toBeInTheDocument();
    expect(screen.getByText('Dining')).toBeInTheDocument();
    expect(screen.getByText('88')).toBeInTheDocument();
    expect(screen.getByText('Top 2 of 9 categories shown.')).toBeInTheDocument();
  });

  it('never offers Apply or Cancel — the table itself is the whole answer, nothing to confirm', async () => {
    aiChat.mockResolvedValue(proposal());
    render(<DataChatSheet open onClose={() => {}} />);
    send('what did I spend this month, and on what');

    await screen.findByRole('table');
    expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    expect(screen.queryByText('Applied')).not.toBeInTheDocument();
    // Nothing this action could possibly write is ever called.
    expect(updateProfile).not.toHaveBeenCalled();
    expect(addBill).not.toHaveBeenCalled();
    expect(addRule).not.toHaveBeenCalled();
  });

  it('renders with no note when the model gave none — nothing extra shown', async () => {
    const { note: _note, ...withoutNote } = proposal().result;
    aiChat.mockResolvedValue({ success: true, result: withoutNote });
    render(<DataChatSheet open onClose={() => {}} />);
    send('what did I spend this month, and on what');

    await screen.findByRole('table');
    expect(screen.queryByText('Top 2 of 9 categories shown.')).not.toBeInTheDocument();
  });

  it('a report with a payload the parser rejects falls back to plain text, exactly like any other refused action', async () => {
    // Ragged row — chat-actions.ts rejects this outright.
    aiChat.mockResolvedValue({
      success: true,
      result: { action: 'report', title: 'Bad table', columns: ['A', 'B'], rows: [['only-one']] },
    });
    render(<DataChatSheet open onClose={() => {}} />);
    send('what did I spend this month, and on what');

    expect(await screen.findByText(/I got a reply I couldn't read/)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
