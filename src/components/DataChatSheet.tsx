'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, Send, Sparkles, X } from 'lucide-react';
import { aiChat, callableErrorMessage } from '@/lib/callables';
import { parseChatAction, buildChatContext, explanationOf, fallbackText } from '@/lib/chat-actions';
import { describeRule, rulePreview, MappingRule, NewMappingRule } from '@/lib/mapping-rules';
import { useTransactions } from '@/context/TransactionContext';
import { useUserProfile } from '@/context/UserProfileContext';
import { formatMoney } from '@/lib/money';
import { currentOf } from '@/lib/accounts';
import { PaymentAccount, displayCategory } from '@/types';

/**
 * "Ask about your data" — the owner types plain English ("anything from Instacart is
 * Groceries") and the AI answers or proposes a mapping rule. NOTHING is written until
 * Apply is pressed: a proposed rule renders as a preview card showing exactly how many
 * existing rows it would change, and only then does it reach Firestore via addRule().
 */

const EXAMPLES = [
  'Anything from Instacart is Groceries',
  'Royal Biryani House is Dining',
  'What did I spend on food in July?',
];

/** A proposal is previewed, not saved — rulePreview() wants a whole MappingRule. */
const asDraft = (rule: NewMappingRule): MappingRule =>
  ({ id: 'draft', createdAt: '', ...rule });

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** Set when the assistant proposed a rule — renders the preview card. */
  rule?: NewMappingRule;
  /** Set when the assistant proposed a balance re-anchor — renders that card. */
  balance?: { accountName: string; balance: number };
  status?: 'pending' | 'applied';
}

/**
 * The account the proposal names, resolved against the owner's REAL list — exact
 * name first, then a unique substring. Anything ambiguous or unknown resolves to
 * null and the card renders words instead of a button: the model chose the name,
 * so the model's spelling is never trusted with a write.
 */
export function resolveAccount(name: string, accounts: readonly PaymentAccount[]): PaymentAccount | null {
  const n = name.trim().toLowerCase();
  if (!n) return null;
  const exact = accounts.filter((a) => a.name.trim().toLowerCase() === n);
  if (exact.length === 1) return exact[0];
  const contains = accounts.filter((a) => a.name.toLowerCase().includes(n));
  return contains.length === 1 ? contains[0] : null;
}

export default function DataChatSheet({ open, onClose, seed }: {
  open: boolean;
  onClose: () => void;
  /** A question to ask on open — set when the owner clicked a specific node or group. */
  seed?: string;
}) {
  const { transactions, addRule } = useTransactions();
  const { profile, reconcileAccount } = useUserProfile();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  // ---- resizable rail (desktop only; the mobile bottom sheet keeps its CSS) ----
  // `null` = the stylesheet default. A number is the owner's chosen width, persisted so
  // the rail opens at the size they left it. CSS caps mobile with `width:auto !important`,
  // so this inline width can only ever act on the >=640px rail.
  const RAIL_DEFAULT_PX = 416; // 26rem — the CSS default, the baseline for keyboard steps
  const [railWidth, setRailWidth] = useState<number | null>(() => {
    if (typeof window === 'undefined') return null;
    const saved = Number(window.localStorage.getItem('chat-rail-width'));
    if (!Number.isFinite(saved) || saved < 320) return null;
    // Re-clamp to THIS window: a width saved on a wide monitor must not reopen wider
    // than the screen it is on, with its own resize handle off-screen.
    return Math.min(saved, Math.max(360, Math.floor(window.innerWidth * 0.8)));
  });
  useEffect(() => {
    if (railWidth === null) window.localStorage.removeItem('chat-rail-width');
    else window.localStorage.setItem('chat-rail-width', String(railWidth));
  }, [railWidth]);

  /** Never narrower than the input row, never wider than 80% of the window. */
  const clampWidth = (w: number) =>
    Math.min(Math.max(Math.round(w), 320), Math.max(360, Math.floor(window.innerWidth * 0.8)));

  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    // Capture routes every move to the handle even when the pointer outruns it,
    // which a fast drag always does. Optional-chained: jsdom has no capture API.
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.buttons !== 1) return; // moves only count while the button is down
    setRailWidth(clampWidth(window.innerWidth - e.clientX));
  };
  const onHandleKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // The left edge: ArrowLeft pushes it left (wider), ArrowRight pulls it right.
    if (e.key === 'ArrowLeft') setRailWidth((w) => clampWidth((w ?? RAIL_DEFAULT_PX) + 24));
    else if (e.key === 'ArrowRight') setRailWidth((w) => clampWidth((w ?? RAIL_DEFAULT_PX) - 24));
    else if (e.key === 'Home') setRailWidth(null);
    else return;
    e.preventDefault();
  };

  // Compact context — never the whole ledger. buildChatContext owns the size caps,
  // so the prompt can't quietly grow into every row the owner has ever had.
  const context = useMemo(
    () => buildChatContext(transactions, profile?.paymentAccounts ?? []),
    [transactions, profile?.paymentAccounts]
  );

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [messages, busy]);

  // <dialog> gave Esc for free; a docked panel has to ask.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // A seeded question — the owner clicked a specific thing (a Sankey node, an
  // unmapped group) and the caller phrased the question for them. Asked once per
  // distinct seed, so re-opening the panel does not re-ask and burn a call.
  const askedSeed = useRef<string | null>(null);
  useEffect(() => {
    if (!open || !seed || askedSeed.current === seed) return;
    askedSeed.current = seed;
    setMessages([]);
    void send(seed);
    // `send` is recreated every render; depending on it would re-fire the seed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, seed]);

  const money = (n: number) => formatMoney(n, profile?.currency);
  const mk = (role: ChatMessage['role'], text: string, extra?: Partial<ChatMessage>): ChatMessage =>
    ({ id: `m${seq.current++}`, role, text, ...extra });

  const send = async (raw: string) => {
    const message = raw.trim();
    if (!message || busy) return;
    setInput('');
    const history = messages.map((m) => ({ role: m.role, content: m.text }));
    setMessages((prev) => [...prev, mk('user', message)]);
    setBusy(true);
    try {
      // `result` is raw model output — parseChatAction is the trust boundary, and
      // returns null for anything it can't vouch for (never a half-valid rule).
      const data = await aiChat({ message, history, context });
      const reply = parseChatAction(data?.result);
      // The recovery actions (FIN-RELATION-001 §7.3) carry `reason`, not `explanation`,
      // and have no card here yet — FIN-RECOVERY-UI-001 owns that surface. Until then
      // they fall through to the same "couldn't turn that into a change" line.
      // A refused payload still usually SAYS something. Showing the words costs nothing
      // and keeps a conversation going; the rule inside it is still refused.
      const explanation = explanationOf(reply) ?? fallbackText(data?.result);
      setMessages((prev) => [...prev,
        reply?.action === 'create_rule'
          ? mk('assistant', reply.explanation, { rule: reply.rule, status: 'pending' })
          : reply?.action === 'set_account_balance'
            ? mk('assistant', reply.reason, {
                balance: { accountName: reply.accountName, balance: reply.balance },
                status: 'pending',
              })
            : mk('assistant', explanation
              || "I got a reply I couldn't read. Try saying it as a rule — for example “Turo is Travel”."),
      ]);
    } catch (e) {
      setMessages((prev) => [...prev, mk('assistant', callableErrorMessage(e))]);
    } finally {
      setBusy(false);
    }
  };

  const apply = async (m: ChatMessage) => {
    if (!m.rule || busy) return;
    setBusy(true);
    try {
      const saved = await addRule(m.rule);
      setMessages((prev) => [
        ...prev.map((x) => (x.id === m.id ? { ...x, status: 'applied' as const } : x)),
        mk('assistant', saved
          ? `Saved — ${describeRule(saved)}. It applies to your existing transactions and every future one.`
          : 'Sign in to save rules.'),
      ]);
    } catch (e) {
      setMessages((prev) => [...prev, mk('assistant', callableErrorMessage(e))]);
    } finally {
      setBusy(false);
    }
  };

  const dismiss = (id: string) =>
    setMessages((prev) => prev.map((x) => (x.id === id ? { ...x, rule: undefined, balance: undefined, status: undefined } : x)));

  /** THE one path from a balance proposal to the store — a button press, same
   *  reconcile() the accounts screen used before its manual knob was removed. */
  const applyBalance = async (m: ChatMessage) => {
    if (!m.balance || busy) return;
    const account = resolveAccount(m.balance.accountName, profile?.paymentAccounts ?? []);
    if (!account) return;
    setBusy(true);
    try {
      await reconcileAccount(account.id, m.balance.balance, currentOf(account));
      setMessages((prev) => [
        ...prev.map((x) => (x.id === m.id ? { ...x, status: 'applied' as const } : x)),
        mk('assistant', `Saved — ${account.name} reads ${formatMoney(m.balance!.balance, profile?.currency, 2)} as of today. No transaction changed.`),
      ]);
    } catch {
      setMessages((prev) => [...prev, mk('assistant', 'That could not be saved. Please try again.')]);
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return createPortal(
    // Docked, NOT a modal: the owner keeps reading the page they asked about while
    // the answer arrives, so this deliberately does not use Sheet's <dialog>. No
    // focus trap and no body-scroll lock for the same reason — both would fight the
    // "keep working alongside it" behaviour. Esc still closes (handler above).
    //
    // PORTALED to <body>, load-bearing: this component mounts inside Navbar, whose
    // backdrop-filter makes the nav the containing block for position:fixed
    // descendants — rendered in place, the rail pins itself INSIDE the 64px bar.
    // Layout lives in .chat-rail (globals.css): right rail >=640px, bottom sheet below.
    <aside
      role="complementary"
      aria-label="Ask about your data"
      className="chat-rail p-4 sm:p-5 gap-3"
      style={railWidth !== null ? { width: `${railWidth}px` } : undefined}
    >
      {/* The resize handle — the whole left edge. Drag it, or focus it and use the
          arrow keys; Home (or double-click) returns to the default width. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize chat panel"
        aria-valuemin={320}
        aria-valuenow={railWidth ?? RAIL_DEFAULT_PX}
        tabIndex={0}
        onPointerDown={startDrag}
        onPointerMove={onDrag}
        onKeyDown={onHandleKey}
        onDoubleClick={() => setRailWidth(null)}
        className="hidden sm:block absolute left-0 top-0 h-full w-2 -ml-1 cursor-col-resize rounded-full
          hover:bg-[var(--accent-primary)]/30 focus-visible:bg-[var(--accent-primary)]/40
          focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)]"
      />
      <div className="flex items-start gap-3 shrink-0">
        <Sparkles className="w-5 h-5 text-[var(--accent-primary)] mt-0.5" aria-hidden="true" />
        <div className="flex-1 min-w-0">
          <h2 className="text-lg font-semibold text-[var(--foreground)]">Ask about your data</h2>
          <p className="text-xs text-[var(--foreground-muted)]">Ask a question, or say how something should be categorised.</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close chat"
          className="shrink-0 w-11 h-11 -mt-1 -mr-1 flex items-center justify-center rounded-lg text-[var(--foreground-muted)] hover:text-[var(--foreground)] hover:bg-[var(--background-tertiary)] transition-colors"
        >
          <X className="w-5 h-5" aria-hidden="true" />
        </button>
      </div>

      <div role="log" aria-live="polite" aria-label="Conversation" className="flex-1 min-h-0 overflow-y-auto space-y-3 pr-1">
        {messages.length === 0 && (
          <div className="pt-4">
            <p className="text-sm text-[var(--foreground-muted)] mb-2">Try:</p>
            <div className="flex flex-col gap-2">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  type="button"
                  onClick={() => send(ex)}
                  className="min-h-[44px] text-left px-4 py-2 rounded-xl border border-[var(--border-color)] bg-[var(--background-secondary)] text-sm text-[var(--foreground-secondary)] hover:text-[var(--foreground)] hover:bg-[var(--background-tertiary)] transition-colors"
                >
                  {ex}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) => (
          <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
            <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
              m.role === 'user'
                ? 'bg-[var(--accent-primary)]/15 text-[var(--foreground)]'
                : 'bg-[var(--background-secondary)] border border-[var(--border-color)] text-[var(--foreground-secondary)]'
            }`}>
              <p className="whitespace-pre-wrap break-words">{m.text}</p>
              {m.rule && <RulePreviewCard rule={m.rule} pending={m.status === 'pending'} busy={busy} money={money} onApply={() => apply(m)} onCancel={() => dismiss(m.id)} />}
              {m.balance && (
                <BalanceProposalCard
                  proposal={m.balance}
                  accounts={profile?.paymentAccounts ?? []}
                  pending={m.status === 'pending'}
                  busy={busy}
                  money={money}
                  onApply={() => applyBalance(m)}
                  onCancel={() => dismiss(m.id)}
                />
              )}
            </div>
          </div>
        ))}

        {busy && (
          <p className="flex items-center gap-2 text-sm text-[var(--foreground-muted)]">
            <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> Thinking…
          </p>
        )}
        <div ref={endRef} />
      </div>

      <div className="flex items-end gap-2 shrink-0 pt-1">
        <label htmlFor="data-chat-input" className="sr-only">Message</label>
        {/* Short placeholder on purpose: the long example sentence wrapped inside the
            44px single-line box, clipping mid-word behind a scrollbar. The example
            phrasings already live on the Try buttons above. */}
        <textarea
          id="data-chat-input"
          rows={1}
          value={input}
          enterKeyHint="send"
          placeholder="Ask about your data…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input); }
          }}
          className="input-field flex-1 min-h-[44px] max-h-32 resize-y py-3 leading-snug overflow-hidden focus:overflow-y-auto"
        />
        <button
          type="button"
          onClick={() => send(input)}
          disabled={busy || !input.trim()}
          aria-label="Send"
          className="btn-primary min-w-[44px] min-h-[44px] flex items-center justify-center px-4 disabled:opacity-50"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Send className="w-4 h-4" aria-hidden="true" />}
        </button>
      </div>
    </aside>,
    document.body
  );
}

/** The confirm gate: what the rule does, how many rows it changes, and up to 5 of them. */
function RulePreviewCard({ rule, pending, busy, money, onApply, onCancel }: {
  rule: NewMappingRule;
  pending: boolean;
  busy: boolean;
  money: (n: number) => string;
  onApply: () => void;
  onCancel: () => void;
}) {
  const { transactions } = useTransactions();
  const draft = useMemo(() => asDraft(rule), [rule]);
  const { matches, sample } = useMemo(() => rulePreview(draft, transactions), [draft, transactions]);

  return (
    <div className="mt-3 rounded-xl border border-[var(--border-color)] bg-[var(--background)] p-3">
      <p className="font-medium text-[var(--foreground)]">{describeRule(draft)}</p>
      {/* Counts are the "what would this do?" preview — meaningless once applied,
          because `transactions` already has the rule folded in. */}
      {pending && (
        <p className="text-xs text-[var(--foreground-muted)] mt-1">
          Matches {matches} existing transaction{matches === 1 ? '' : 's'}
          {matches === 0 && ' — it will still apply to future ones'}
        </p>
      )}

      {pending && sample.length > 0 && (
        <ul role="list" className="mt-2 divide-y divide-[var(--border-color)] border-t border-[var(--border-color)]">
          {sample.map((t) => (
            <li key={t.id} className="py-1.5 flex items-center gap-3 text-xs">
              <span className="flex-1 min-w-0 truncate text-[var(--foreground-secondary)]">{t.title}</span>
              <span className="text-[var(--foreground-muted)] shrink-0">{displayCategory(t)}</span>
              <span className="tabular-nums text-[var(--foreground)] shrink-0">{money(t.amount)}</span>
            </li>
          ))}
        </ul>
      )}

      {pending ? (
        <div className="flex gap-2 mt-3">
          <button type="button" onClick={onApply} disabled={busy} className="btn-primary min-h-[44px] px-4 text-sm disabled:opacity-50">Apply</button>
          <button type="button" onClick={onCancel} disabled={busy} className="min-h-[44px] px-4 text-sm rounded-xl border border-[var(--border-color)] text-[var(--foreground-secondary)] hover:bg-[var(--background-tertiary)] transition-colors disabled:opacity-50">Cancel</button>
        </div>
      ) : (
        <p className="mt-3 text-xs text-[var(--accent-success)]">Applied</p>
      )}
    </div>
  );
}

/**
 * The confirm gate for a balance re-anchor: current -> new, in the owner's own
 * numbers, and what does NOT change. An unknown or ambiguous account name gets
 * words and no button — the model picked the name, the owner's list decides.
 */
function BalanceProposalCard({ proposal, accounts, pending, busy, money, onApply, onCancel }: {
  proposal: { accountName: string; balance: number };
  accounts: readonly PaymentAccount[];
  pending: boolean;
  busy: boolean;
  money: (n: number) => string;
  onApply: () => void;
  onCancel: () => void;
}) {
  const account = resolveAccount(proposal.accountName, accounts);
  if (!account) {
    return (
      <p className="mt-3 text-xs text-[var(--foreground-muted)]">
        I couldn&apos;t match &ldquo;{proposal.accountName}&rdquo; to exactly one of your accounts, so nothing is offered.
        Your accounts: {accounts.map((a) => a.name).join(', ') || '(none)'}.
      </p>
    );
  }
  const isDebt = account.type === 'credit_card' || account.type === 'personal_loan';
  const label = isDebt ? 'you owe' : 'balance';
  // ONE template string (not JSX interpolation), and always 2 decimals: a balance
  // is the cents-exact number the owner just read off their bank.
  const m2 = (n: number) => formatMoney(n, undefined, 2);
  return (
    <div className="mt-3 rounded-xl border border-[var(--border-color)] bg-[var(--background)] p-3">
      <p className="font-medium text-[var(--foreground)]">
        {`Set ${account.name} — ${label} ${m2(Math.abs(currentOf(account)))} → ${m2(proposal.balance)}`}
      </p>
      <p className="text-xs text-[var(--foreground-muted)] mt-1">
        Re-anchors as of today. Every screen derives from it. No transaction is changed.
      </p>
      {pending ? (
        <div className="flex gap-2 mt-3">
          <button type="button" onClick={onApply} disabled={busy} className="btn-primary min-h-[44px] px-4 text-sm disabled:opacity-50">Apply</button>
          <button type="button" onClick={onCancel} disabled={busy} className="min-h-[44px] px-4 text-sm rounded-xl border border-[var(--border-color)] text-[var(--foreground-secondary)] hover:bg-[var(--background-tertiary)] transition-colors disabled:opacity-50">Cancel</button>
        </div>
      ) : (
        <p className="mt-3 text-xs text-[var(--accent-success)]">Applied</p>
      )}
    </div>
  );
}
