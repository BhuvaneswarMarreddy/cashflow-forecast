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
import { sanitizeAssumedSpend } from '@/lib/profile-settings';
import { matchIncomeDeposits } from '@/lib/ask';
import { deriveAccountBalance, monthlyAverages } from '@/lib/forecast';
import { addBill } from '@/lib/firestore';
import { BillFrequency, PAYMENT_METHODS } from '@/lib/bills';
import type { IncomeContext } from '@/lib/classify';
import { PaymentAccount, Transaction, displayCategory } from '@/types';

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
  /** Set when the assistant proposed an approved income source. */
  income?: { name: string; matchText: string[] };
  /** FIN-SPEND-001 (#133): set when the assistant proposed a runway spend override. */
  spend?: { amount: number };
  /** #10/#14: set when the assistant proposed recording a bill. */
  bill?: {
    vendor: string;
    amount: number;
    frequency: BillFrequency;
    dueDay?: number;
    /** Defect 1 fix: the anchor that lets billUpcomingEvents actually project this
     *  bill — see resolveBillAnchor below. */
    nextDueDate?: string;
    accountName?: string;
    endDate?: string;
    installmentsRemaining?: number;
    nonNegotiable?: boolean;
  };
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

/**
 * accountName -> paymentMethodId, same exact-then-unique-substring algorithm as
 * resolveAccount, run against the bundled PAYMENT_METHODS registry (bills.ts)
 * instead of the owner's live account list — the register is a fixed set of
 * institutions, not accounts.
 *
 * No name given at all (the model never mentioned one) is NOT the same as an
 * unresolvable name: recording a bill still needs SOME paymentMethodId (the
 * schema requires it), so an absent name defaults to 'manual' rather than
 * blocking the whole proposal. A name that WAS given and matches nothing still
 * resolves to null — unresolvable, not a guess — exactly resolveAccount's contract.
 */
export function resolveBillPaymentMethod(name: string | undefined): string | null {
  if (!name || !name.trim()) return 'manual';
  const n = name.trim().toLowerCase();
  const entries = Object.entries(PAYMENT_METHODS);
  const exact = entries.filter(([, m]) => m.label.trim().toLowerCase() === n);
  if (exact.length === 1) return exact[0][0];
  const contains = entries.filter(([, m]) => m.label.toLowerCase().includes(n));
  return contains.length === 1 ? contains[0][0] : null;
}

/**
 * Defect 1: a chat-recorded bill never got a Bill.anchorDate, so `billUpcomingEvents`
 * (bills.ts) silently produced ZERO Upcoming events for weekly/biweekly
 * (`projectWeeklyish` requires anchorDate outright) and quarterly/semiannual/annual
 * (`projectMonthlyish`'s periodMonths>1 branch requires anchorDate too, to pin WHICH
 * months in the cycle qualify — an autopayDay alone, even an explicit one, can never
 * say that). `nextDueDate` is the fix's input: it becomes anchorDate directly, and its
 * day-of-month becomes autopayDay whenever dueDay itself is absent.
 *
 * Returns null exactly when the cadence needs an anchor `billUpcomingEvents` can use
 * and nothing supplies one — the card then renders words, not a broken Apply, same
 * contract as resolveAccount/resolveBillPaymentMethod. monthly is the one cadence that
 * never blocks: no autopayDay at all is "varies" (see Bill.autopayDay's doc comment),
 * an existing, intentional state — not something this defect needs to newly forbid.
 */
export function resolveBillAnchor(proposal: {
  frequency: BillFrequency;
  dueDay?: number;
  nextDueDate?: string;
}): { autopayDay?: number; anchorDate?: string } | null {
  const dayFromNextDueDate = proposal.nextDueDate ? Number(proposal.nextDueDate.slice(8, 10)) : undefined;
  const autopayDay = proposal.dueDay ?? dayFromNextDueDate;

  if (proposal.frequency === 'weekly' || proposal.frequency === 'biweekly') {
    return proposal.nextDueDate ? { anchorDate: proposal.nextDueDate } : null;
  }
  if (proposal.frequency === 'monthly') {
    return { autopayDay };
  }
  // quarterly/semiannual/annual: nextDueDate is the ONLY source of anchorDate.
  return proposal.nextDueDate ? { autopayDay, anchorDate: proposal.nextDueDate } : null;
}

export default function DataChatSheet({ open, onClose, seed }: {
  open: boolean;
  onClose: () => void;
  /** A question to ask on open — set when the owner clicked a specific node or group. */
  seed?: string;
}) {
  const { transactions, addRule } = useTransactions();
  const { profile, reconcileAccount, addIncomeSource, incomeContext, updateProfile } = useUserProfile();
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

  // FIN-SPEND-001 (#133): the derived 6-month average — the SAME basis Home and
  // Forecast use — so the spend proposal card can show what the owner's number
  // would replace. account TYPE is all monthlyAverages consults here, so the raw
  // profile list (no balance derivation) is exactly as correct and one step
  // cheaper than deriving balances just to throw them away.
  const derivedMonthlySpend = useMemo(
    () => monthlyAverages(transactions, profile?.paymentAccounts ?? [], 6, incomeContext).spending,
    [transactions, profile?.paymentAccounts, incomeContext]
  );
  const currentMonthlySpend = sanitizeAssumedSpend(profile?.settings?.assumedMonthlySpend) ?? derivedMonthlySpend;

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
          : reply?.action === 'set_income_source'
            ? mk('assistant', reply.reason, {
                income: { name: reply.name, matchText: reply.matchText },
                status: 'pending',
              })
          : reply?.action === 'set_monthly_spend'
            ? mk('assistant', reply.reason, {
                spend: { amount: reply.amount },
                status: 'pending',
              })
          : reply?.action === 'record_bill'
            ? mk('assistant', reply.reason, {
                bill: {
                  vendor: reply.vendor,
                  amount: reply.amount,
                  frequency: reply.frequency,
                  dueDay: reply.dueDay,
                  nextDueDate: reply.nextDueDate,
                  accountName: reply.accountName,
                  endDate: reply.endDate,
                  installmentsRemaining: reply.installmentsRemaining,
                  nonNegotiable: reply.nonNegotiable,
                },
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
      // #130: addRule resolves { rule, changed } now — `changed` is the server's
      // real count (functions/src/decisions.ts), not the client-side preview
      // rulePreview() showed before Apply was pressed.
      const result = await addRule(m.rule);
      setMessages((prev) => [
        ...prev.map((x) => (x.id === m.id ? { ...x, status: 'applied' as const } : x)),
        mk('assistant', result
          ? `Saved — ${describeRule(result.rule)}. ${result.changed.transactionsMatched} existing transaction${
              result.changed.transactionsMatched === 1 ? '' : 's'
            } changed; it applies to every future one too.`
          : 'Sign in to save rules.'),
      ]);
    } catch (e) {
      // Not an AI failure — a decision that didn't save — so this is NOT the
      // default "AI request failed" wording.
      setMessages((prev) => [...prev, mk('assistant', callableErrorMessage(e, 'That rule could not be saved. Please try again.'))]);
    } finally {
      setBusy(false);
    }
  };

  const dismiss = (id: string) =>
    setMessages((prev) => prev.map((x) => (x.id === id ? { ...x, rule: undefined, balance: undefined, income: undefined, spend: undefined, bill: undefined, status: undefined } : x)));

  /** THE one path from a balance proposal to the store — a button press, same
   *  reconcile() the accounts screen used before its manual knob was removed. */
  const applyBalance = async (m: ChatMessage) => {
    if (!m.balance || busy) return;
    const account = resolveAccount(m.balance.accountName, profile?.paymentAccounts ?? []);
    if (!account) return;
    setBusy(true);
    try {
      // `account` is the RAW profile record — currentOf() falls back to openingBalance,
      // which is 0 for an unanchored account (src/types/index.ts:193 — currentBalance
      // is only ever attached in memory by withDerivedBalances, never here). Passing
      // that through would have recorded a DriftObservation.derivedCents of 0 for an
      // account with real transaction history: a fabricated drift, not a measurement.
      // deriveAccountBalance() computes the real number reconcile() is documented to record.
      const derived = deriveAccountBalance(account, transactions, incomeContext);
      await reconcileAccount(account.id, m.balance.balance, derived);
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

  /** Income proposal -> an APPROVED SOURCE. amount/frequency come from the rows
   *  that match, never from the model — see matchIncomeDeposits(). */
  const applyIncome = async (m: ChatMessage) => {
    if (!m.income || busy) return;
    const stats = matchIncomeDeposits(transactions, m.income.matchText);
    if (!stats.count) return;
    setBusy(true);
    try {
      await addIncomeSource({
        name: m.income.name,
        amount: stats.amount,
        frequency: stats.frequency,
        isActive: true,
        matchAliases: m.income.matchText,
      });
      setMessages((prev) => [
        ...prev.map((x) => (x.id === m.id ? { ...x, status: 'applied' as const } : x)),
        mk('assistant', `Saved — ${stats.count} deposit${stats.count === 1 ? '' : 's'} now count as income from ${m.income!.name}, about ${formatMoney(stats.amount, profile?.currency, 2)} ${stats.frequency}.`),
      ]);
    } catch {
      setMessages((prev) => [...prev, mk('assistant', 'That could not be saved. Please try again.')]);
    } finally {
      setBusy(false);
    }
  };

  /**
   * FIN-SPEND-001 (#133). Same settings-write helper FIN-PENDING-001 uses
   * (updateProfile -> toFirestoreSettings -> updateUserSettings) — one round
   * trip, no new write path. `null`, not omission: Firestore drops an
   * `undefined` key from the write outright, so "Back to derived" (below)
   * would silently fail to clear a previously-set override if it sent one.
   */
  const applySpend = async (m: ChatMessage) => {
    if (!m.spend || busy) return;
    setBusy(true);
    try {
      await updateProfile({ settings: { assumedMonthlySpend: m.spend.amount } });
      setMessages((prev) => [
        ...prev.map((x) => (x.id === m.id ? { ...x, status: 'applied' as const } : x)),
        mk('assistant', `Saved — runway now assumes ${formatMoney(m.spend!.amount, profile?.currency, 2)} a month, until you clear it.`),
      ]);
    } catch {
      setMessages((prev) => [...prev, mk('assistant', 'That could not be saved. Please try again.')]);
    } finally {
      setBusy(false);
    }
  };

  /**
   * #10/#14. record_bill -> a Bill row (src/lib/bills.ts) via addBill(). accountName
   * resolves to a paymentMethodId CLIENT-side (resolveBillPaymentMethod) exactly like
   * applyBalance resolves an account — an unresolvable name renders no button, so this
   * never fires with a null paymentMethodId. migrationStatus/lifecycleStatus mirror
   * BillForm's own "Add manually" defaults (BillsTab.tsx) — this is a manually
   * recorded row, not an audited-migration one.
   */
  const applyBill = async (m: ChatMessage) => {
    if (!m.bill || busy || !profile?.id) return;
    const paymentMethodId = resolveBillPaymentMethod(m.bill.accountName);
    if (!paymentMethodId) return;
    // Defect 1: mirrors the card's own gate (BillProposalCard, below) — the Apply
    // button is never rendered without an anchor, so this is unreachable in practice.
    const anchor = resolveBillAnchor(m.bill);
    if (!anchor) return;
    setBusy(true);
    try {
      await addBill(profile.id, {
        vendor: m.bill.vendor,
        amount: m.bill.amount,
        frequency: m.bill.frequency,
        autopayDay: anchor.autopayDay,
        anchorDate: anchor.anchorDate,
        paymentMethodId,
        migrationStatus: 'to-review',
        lifecycleStatus: 'active',
        nonNegotiable: m.bill.nonNegotiable,
        endDate: m.bill.endDate,
        installmentsRemaining: m.bill.installmentsRemaining,
        source: 'manual',
      });
      setMessages((prev) => [
        ...prev.map((x) => (x.id === m.id ? { ...x, status: 'applied' as const } : x)),
        mk('assistant', `Saved — ${m.bill!.vendor} now shows in Upcoming and Bills, ${formatMoney(m.bill!.amount, profile?.currency, 2)} ${m.bill!.frequency}.`),
      ]);
    } catch {
      setMessages((prev) => [...prev, mk('assistant', 'That could not be saved. Please try again.')]);
    } finally {
      setBusy(false);
    }
  };

  /** The "Back to derived" affordance: clears the override regardless of what
   *  amount was proposed — an alternative to Apply, not a variant of it. */
  const clearSpend = async (m: ChatMessage) => {
    if (busy) return;
    setBusy(true);
    try {
      await updateProfile({ settings: { assumedMonthlySpend: null } });
      setMessages((prev) => [
        ...prev.map((x) => (x.id === m.id ? { ...x, status: 'applied' as const } : x)),
        mk('assistant', 'Saved — runway is back to your derived 6-month average.'),
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
        className="hidden sm:block absolute left-0 top-0 h-full w-2 -ml-1 cursor-col-resize rounded-pill
          hover:bg-[var(--accent-primary)]/30 focus-visible:bg-[var(--accent-primary)]/40
          focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)]"
      />
      <div className="flex items-start gap-3 shrink-0">
        <Sparkles className="w-5 h-5 text-[var(--accent-primary)] mt-1" aria-hidden="true" />
        <div className="flex-1 min-w-0">
          <h2 className="text-lg font-semibold text-[var(--foreground)]">Ask about your data</h2>
          <p className="text-xs text-[var(--foreground-muted)]">Ask a question, or say how something should be categorised.</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close chat"
          className="shrink-0 w-11 h-11 -mt-1 -mr-1 flex items-center justify-center rounded-control text-[var(--foreground-muted)] hover:text-[var(--foreground)] hover:bg-[var(--background-tertiary)] transition-colors"
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
                  className="min-h-[44px] text-left px-4 py-2 rounded-card border border-[var(--border-color)] bg-[var(--background-secondary)] text-sm text-[var(--foreground-secondary)] hover:text-[var(--foreground)] hover:bg-[var(--background-tertiary)] transition-colors"
                >
                  {ex}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) => (
          <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
            <div className={`max-w-[85%] rounded-card px-4 py-3 text-sm leading-relaxed ${
              m.role === 'user'
                ? 'bg-[var(--accent-primary)]/15 text-[var(--foreground)]'
                : 'bg-[var(--background-secondary)] border border-[var(--border-color)] text-[var(--foreground-secondary)]'
            }`}>
              <p className="whitespace-pre-wrap break-words">{m.text}</p>
              {m.rule && <RulePreviewCard rule={m.rule} pending={m.status === 'pending'} busy={busy} money={money} onApply={() => apply(m)} onCancel={() => dismiss(m.id)} />}
              {m.income && (
                <IncomeProposalCard
                  proposal={m.income}
                  transactions={transactions}
                  currency={profile?.currency}
                  pending={m.status === 'pending'}
                  busy={busy}
                  onApply={() => applyIncome(m)}
                  onCancel={() => dismiss(m.id)}
                />
              )}
              {m.balance && (
                <BalanceProposalCard
                  proposal={m.balance}
                  currency={profile?.currency}
                  accounts={profile?.paymentAccounts ?? []}
                  transactions={transactions}
                  incomeContext={incomeContext}
                  pending={m.status === 'pending'}
                  busy={busy}
                  money={money}
                  onApply={() => applyBalance(m)}
                  onCancel={() => dismiss(m.id)}
                />
              )}
              {m.spend && (
                <SpendProposalCard
                  proposal={m.spend}
                  currentAmount={currentMonthlySpend}
                  currentIsOverride={sanitizeAssumedSpend(profile?.settings?.assumedMonthlySpend) != null}
                  currency={profile?.currency}
                  pending={m.status === 'pending'}
                  busy={busy}
                  onApply={() => applySpend(m)}
                  onClear={() => clearSpend(m)}
                  onCancel={() => dismiss(m.id)}
                />
              )}
              {m.bill && (
                <BillProposalCard
                  proposal={m.bill}
                  currency={profile?.currency}
                  pending={m.status === 'pending'}
                  busy={busy}
                  onApply={() => applyBill(m)}
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
  currency?: string;
  money: (n: number) => string;
  onApply: () => void;
  onCancel: () => void;
}) {
  const { transactions } = useTransactions();
  const draft = useMemo(() => asDraft(rule), [rule]);
  const { matches, sample } = useMemo(() => rulePreview(draft, transactions), [draft, transactions]);

  return (
    <div className="mt-3 rounded-card border border-[var(--border-color)] bg-[var(--background)] p-3">
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
            <li key={t.id} className="py-2 flex items-center gap-3 text-xs">
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
          <button type="button" onClick={onCancel} disabled={busy} className="min-h-[44px] px-4 text-sm rounded-card border border-[var(--border-color)] text-[var(--foreground-secondary)] hover:bg-[var(--background-tertiary)] transition-colors disabled:opacity-50">Cancel</button>
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
/**
 * "Those deposits are my paycheck" — shown BEFORE anything is saved, with the
 * count and total of the rows it would claim. The owner is confirming a fact
 * about their own money, so the card states the evidence rather than asserting
 * a conclusion: how many deposits matched, how much they add up to, and the
 * pay size and cadence DERIVED from them (never from the model).
 */
function IncomeProposalCard({ proposal, transactions, currency, pending, busy, onApply, onCancel }: {
  proposal: { name: string; matchText: string[] };
  transactions: Transaction[];
  currency?: string;
  pending: boolean;
  busy: boolean;
  onApply: () => void;
  onCancel: () => void;
}) {
  const stats = matchIncomeDeposits(transactions, proposal.matchText);
  const m2 = (n: number) => formatMoney(n, currency, 2);
  if (!stats.count) {
    return (
      <p className="mt-3 text-xs text-[var(--foreground-muted)]">
        Nothing in your deposits matches &ldquo;{proposal.matchText.join('", "')}&rdquo;, so there is
        nothing to approve yet. Tell me the wording that appears on the bank line.
      </p>
    );
  }
  return (
    <div className="mt-3 rounded-card border border-[var(--border-color)] bg-[var(--background)] p-3">
      <p className="font-medium text-[var(--foreground)]">
        {`Count ${stats.count} deposit${stats.count === 1 ? '' : 's'} as income from ${proposal.name}`}
      </p>
      <p className="mt-1 text-xs text-[var(--foreground-muted)] tabular-nums">
        {`${m2(stats.total)} in total · about ${m2(stats.amount)} ${stats.frequency}`}
        {stats.latest ? ` · latest ${stats.latest}` : ''}
      </p>
      {pending && (
        <div className="mt-3 flex gap-2">
          <button
            onClick={onApply}
            disabled={busy}
            className="btn-primary min-h-[44px] px-3 text-sm disabled:opacity-60"
          >
            Yes, that&apos;s my paycheck
          </button>
          <button
            onClick={onCancel}
            disabled={busy}
            className="btn-secondary min-h-[44px] px-3 text-sm disabled:opacity-60"
          >
            No
          </button>
        </div>
      )}
    </div>
  );
}

function BalanceProposalCard({ proposal, currency, accounts, transactions, incomeContext, pending, busy, money, onApply, onCancel }: {
  proposal: { accountName: string; balance: number };
  accounts: readonly PaymentAccount[];
  transactions: Transaction[];
  incomeContext: IncomeContext;
  pending: boolean;
  busy: boolean;
  currency?: string;
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
  const m2 = (n: number) => formatMoney(n, currency, 2);
  // #83 round 4a Defect 3: `account` is the RAW profile record, so currentOf(account)
  // falls back to openingBalance — 0 for an unanchored account, regardless of real
  // transaction history. applyBalance() (below) already measures the write against
  // deriveAccountBalance(); showing currentOf() here instead let the card read
  // "balance $0.00 → $900.00" for an account the write actually reconciles against
  // $850 — the confirmation and the write disagreeing about the number being moved,
  // which is exactly what FIN-SETTLEMENT-003 (the confirmation must show the figure
  // actually being moved) rules out.
  const derived = deriveAccountBalance(account, transactions, incomeContext);
  return (
    <div className="mt-3 rounded-card border border-[var(--border-color)] bg-[var(--background)] p-3">
      <p className="font-medium text-[var(--foreground)]">
        {`Set ${account.name} — ${label} ${m2(Math.abs(derived))} → ${m2(proposal.balance)}`}
      </p>
      <p className="text-xs text-[var(--foreground-muted)] mt-1">
        Re-anchors as of today. Every screen derives from it. No transaction is changed.
      </p>
      {pending ? (
        <div className="flex gap-2 mt-3">
          <button type="button" onClick={onApply} disabled={busy} className="btn-primary min-h-[44px] px-4 text-sm disabled:opacity-50">Apply</button>
          <button type="button" onClick={onCancel} disabled={busy} className="min-h-[44px] px-4 text-sm rounded-card border border-[var(--border-color)] text-[var(--foreground-secondary)] hover:bg-[var(--background-tertiary)] transition-colors disabled:opacity-50">Cancel</button>
        </div>
      ) : (
        <p className="mt-3 text-xs text-[var(--accent-success)]">Applied</p>
      )}
    </div>
  );
}

/**
 * FIN-SPEND-001 (#133). Before -> after, both figures EXPLICITLY labelled —
 * the accuracy rule this whole feature exists for: an overridden figure must
 * never read as derived, and once applied it must never read as anything else
 * either. "Back to derived" is a third choice, not a variant of Apply: the
 * owner can reject the proposed number and still clear whatever override was
 * already active, in the same click.
 */
function SpendProposalCard({ proposal, currentAmount, currentIsOverride, currency, pending, busy, onApply, onClear, onCancel }: {
  proposal: { amount: number };
  currentAmount: number;
  currentIsOverride: boolean;
  currency?: string;
  pending: boolean;
  busy: boolean;
  onApply: () => void;
  onClear: () => void;
  onCancel: () => void;
}) {
  // ONE template string (not JSX interpolation), always 2 decimals — same
  // convention as BalanceProposalCard's m2, for the same reason: this is a
  // figure the owner is confirming, not an approximate display number.
  const m2 = (n: number) => formatMoney(n, currency, 2);
  return (
    <div className="mt-3 rounded-card border border-[var(--border-color)] bg-[var(--background)] p-3">
      <p className="font-medium text-[var(--foreground)]">
        {`Runway spend assumption — ${m2(currentAmount)} (${currentIsOverride ? 'your assumption' : 'derived'}) → ${m2(proposal.amount)} (your assumption)`}
      </p>
      <p className="text-xs text-[var(--foreground-muted)] mt-1">
        Replaces the derived 6-month average everywhere runway is shown, until you clear it.
      </p>
      {pending ? (
        <div className="flex gap-2 flex-wrap mt-3">
          <button type="button" onClick={onApply} disabled={busy} className="btn-primary min-h-[44px] px-4 text-sm disabled:opacity-50">Apply</button>
          <button type="button" onClick={onClear} disabled={busy} className="min-h-[44px] px-4 text-sm rounded-card border border-[var(--border-color)] text-[var(--foreground-secondary)] hover:bg-[var(--background-tertiary)] transition-colors disabled:opacity-50">Back to derived</button>
          <button type="button" onClick={onCancel} disabled={busy} className="min-h-[44px] px-4 text-sm rounded-card border border-[var(--border-color)] text-[var(--foreground-secondary)] hover:bg-[var(--background-tertiary)] transition-colors disabled:opacity-50">Cancel</button>
        </div>
      ) : (
        <p className="mt-3 text-xs text-[var(--accent-success)]">Applied</p>
      )}
    </div>
  );
}

/**
 * #10/#14. What's about to be recorded: vendor, per-payment amount, cadence, the
 * resolved payment method (or the "couldn't match" text + no button, same contract
 * as BalanceProposalCard), and the end condition if any. DISPLAY ONLY is not this
 * card's job to say — it is Bills/Upcoming's, everywhere those numbers are shown.
 */
function BillProposalCard({ proposal, currency, pending, busy, onApply, onCancel }: {
  proposal: {
    vendor: string;
    amount: number;
    frequency: BillFrequency;
    dueDay?: number;
    nextDueDate?: string;
    accountName?: string;
    endDate?: string;
    installmentsRemaining?: number;
    nonNegotiable?: boolean;
  };
  currency?: string;
  pending: boolean;
  busy: boolean;
  onApply: () => void;
  onCancel: () => void;
}) {
  // Always 2 decimals — a figure the owner is confirming, same convention as
  // BalanceProposalCard/SpendProposalCard's m2.
  const m2 = (n: number) => formatMoney(n, currency, 2);
  const paymentMethodId = resolveBillPaymentMethod(proposal.accountName);

  if (!paymentMethodId) {
    return (
      <p className="mt-3 text-xs text-[var(--foreground-muted)]">
        I couldn&apos;t match &ldquo;{proposal.accountName}&rdquo; to one of your payment methods, so nothing is offered.
      </p>
    );
  }

  // Defect 1: weekly/biweekly/quarterly/semiannual/annual need an anchor
  // billUpcomingEvents can use; neither a dueDay nor an absent nextDueDate supplies
  // one. Same no-button contract as the paymentMethodId check above — never offer
  // an Apply that would record a bill silently missing from Upcoming.
  const anchor = resolveBillAnchor(proposal);
  if (!anchor) {
    return (
      <p className="mt-3 text-xs text-[var(--foreground-muted)]">
        I don&apos;t have a next due date for a {proposal.frequency} bill, so it can&apos;t show a schedule in Upcoming yet — tell me when the next payment is due.
      </p>
    );
  }

  const methodLabel = PAYMENT_METHODS[paymentMethodId]?.label;

  const end = proposal.endDate
    ? `ends ${proposal.endDate}`
    : proposal.installmentsRemaining
      ? `${proposal.installmentsRemaining} payment${proposal.installmentsRemaining === 1 ? '' : 's'} left`
      : null;

  return (
    <div className="mt-3 rounded-card border border-[var(--border-color)] bg-[var(--background)] p-3">
      <p className="font-medium text-[var(--foreground)]">
        {`Record ${proposal.vendor} — ${m2(proposal.amount)} ${proposal.frequency}${anchor.autopayDay ? ` (day ${anchor.autopayDay})` : ''}`}
      </p>
      <p className="text-xs text-[var(--foreground-muted)] mt-1">
        {[methodLabel, anchor.anchorDate ? `next ${anchor.anchorDate}` : null, end, proposal.nonNegotiable ? 'locked — reserved first in every plan' : null]
          .filter(Boolean)
          .join(' · ')}
      </p>
      {pending ? (
        <div className="flex gap-2 mt-3">
          <button type="button" onClick={onApply} disabled={busy} className="btn-primary min-h-[44px] px-4 text-sm disabled:opacity-50">Apply</button>
          <button type="button" onClick={onCancel} disabled={busy} className="min-h-[44px] px-4 text-sm rounded-card border border-[var(--border-color)] text-[var(--foreground-secondary)] hover:bg-[var(--background-tertiary)] transition-colors disabled:opacity-50">Cancel</button>
        </div>
      ) : (
        <p className="mt-3 text-xs text-[var(--accent-success)]">Applied</p>
      )}
    </div>
  );
}
