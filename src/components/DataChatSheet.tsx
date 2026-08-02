'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Send, Sparkles } from 'lucide-react';
import Sheet from '@/components/Sheet';
import { aiChat, callableErrorMessage } from '@/lib/callables';
import { parseChatAction } from '@/lib/chat-actions';
import { describeRule, rulePreview, MappingRule } from '@/lib/mapping-rules';
import { useTransactions } from '@/context/TransactionContext';
import { useUserProfile } from '@/context/UserProfileContext';
import { formatMoney } from '@/lib/money';
import { EXPENSE_CATEGORIES, displayCategory } from '@/types';

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

/**
 * The slice of '@/lib/chat-actions' this UI reads. The full validated union lives there;
 * we only need "did it propose a rule?" and "what do I show the user?".
 * ponytail: structural probe so a `create_rule` action works whether the rule arrives
 * nested (`{rule}`) or flat (`{match, set}`). Collapse to the real union type once
 * chat-actions.ts lands.
 */
type ChatReply = {
  explanation?: string;
  rule?: Partial<MappingRule>;
  match?: MappingRule['match'];
  set?: MappingRule['set'];
};

/** A proposed (unsaved) rule from a reply, normalised to a full MappingRule, or null. */
function proposedRule(reply: ChatReply | null): MappingRule | null {
  const r = reply?.rule ?? (reply?.match && reply?.set ? reply : null);
  if (!r?.match?.field || !r.match.value || !r.set) return null;
  return { id: 'draft', createdAt: '', enabled: true, match: r.match, set: r.set };
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** Set when the assistant proposed a rule — renders the preview card. */
  rule?: MappingRule;
  status?: 'pending' | 'applied';
}

export default function DataChatSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { transactions, addRule } = useTransactions();
  const { profile } = useUserProfile();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  // Compact context — never the whole ledger: what the model needs to name a category,
  // recognise a merchant, and answer a "how much did I spend on X" question.
  const context = useMemo(() => ({
    categories: EXPENSE_CATEGORIES.map((c) => ({ value: c.value, label: c.label })),
    merchants: Array.from(new Set(transactions.map((t) => t.merchant).filter(Boolean))).slice(0, 40),
    recent: transactions.slice(0, 20).map((t) => ({
      date: t.date, title: t.title, merchant: t.merchant,
      amount: t.amount, category: t.category, sourceCategory: t.sourceCategory,
    })),
  }), [transactions]);

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [messages, busy]);

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
      const reply = parseChatAction(await aiChat({ message, history, context })) as ChatReply | null;
      const rule = proposedRule(reply);
      setMessages((prev) => [...prev, rule
        ? mk('assistant', reply?.explanation || 'Here is the rule I understood:', { rule, status: 'pending' })
        : mk('assistant', reply?.explanation || "I couldn't turn that into a change. Try rephrasing it."),
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
      const saved = await addRule({ match: m.rule.match, set: m.rule.set, enabled: true });
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
    setMessages((prev) => prev.map((x) => (x.id === id ? { ...x, rule: undefined, status: undefined } : x)));

  return (
    <Sheet open={open} onClose={onClose} ariaLabel="Ask about your data" maxWidth="42rem" className="flex flex-col h-full max-h-[80vh] p-4 sm:p-6 gap-3">
      <div className="flex items-center gap-3 shrink-0">
        <Sparkles className="w-5 h-5 text-[var(--accent-primary)]" aria-hidden="true" />
        <div>
          <h2 className="text-lg font-semibold text-[var(--foreground)]">Ask about your data</h2>
          <p className="text-xs text-[var(--foreground-muted)]">Ask a question, or say how something should be categorised.</p>
        </div>
      </div>

      <div role="log" aria-live="polite" aria-label="Conversation" className="flex-1 overflow-y-auto space-y-3 pr-1">
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
              <p className="whitespace-pre-wrap">{m.text}</p>
              {m.rule && <RulePreviewCard rule={m.rule} pending={m.status === 'pending'} busy={busy} money={money} onApply={() => apply(m)} onCancel={() => dismiss(m.id)} />}
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

      <div className="flex items-end gap-2 shrink-0">
        <label htmlFor="data-chat-input" className="sr-only">Ask about your data</label>
        <textarea
          id="data-chat-input"
          rows={1}
          value={input}
          enterKeyHint="send"
          placeholder="e.g. Anything from Instacart is Groceries"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input); }
          }}
          className="input-field flex-1 min-h-[44px] max-h-32 resize-y py-3"
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
    </Sheet>
  );
}

/** The confirm gate: what the rule does, how many rows it changes, and up to 5 of them. */
function RulePreviewCard({ rule, pending, busy, money, onApply, onCancel }: {
  rule: MappingRule;
  pending: boolean;
  busy: boolean;
  money: (n: number) => string;
  onApply: () => void;
  onCancel: () => void;
}) {
  const { transactions } = useTransactions();
  const { matches, sample } = useMemo(() => rulePreview(rule, transactions), [rule, transactions]);

  return (
    <div className="mt-3 rounded-xl border border-[var(--border-color)] bg-[var(--background)] p-3">
      <p className="font-medium text-[var(--foreground)]">{describeRule(rule)}</p>
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
