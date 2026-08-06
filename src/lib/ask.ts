/**
 * "Ask about this" — open the data chat with a question already phrased.
 *
 * The chat panel lives in Navbar and the things worth asking about (a Sankey node,
 * an unmapped group) are deep inside pages that render Navbar as a child. Rather
 * than lift chat state into a provider every page has to thread, this is a window
 * CustomEvent: Navbar listens, anything dispatches. Two functions, no plumbing.
 *
 * ponytail: a CustomEvent is invisible to React DevTools and untyped at the DOM
 * boundary — the cast below is the whole risk. If a third listener ever appears,
 * or a caller needs to know whether the panel actually opened, promote it to a
 * context then.
 */

export const ASK_EVENT = 'cashflow:ask';

/** Phrase the question for the owner and open the chat with it. */
/**
 * The deposits an income-source proposal would actually claim, and what they say
 * about pay size and cadence.
 *
 * The MODEL never supplies amount or frequency — it cannot count, and a wrong
 * frequency silently multiplies the owner's income (biweekly vs monthly is a
 * 2.17x error). The rows do: median deposit for the amount, median gap between
 * consecutive deposits for the cadence. Median, not mean, so one bonus or one
 * missed fortnight cannot move it.
 */
export function matchIncomeDeposits(
  transactions: ReadonlyArray<{ date: string; amount: number; type: string; title?: string; description?: string; merchant?: string }>,
  matchText: readonly string[]
): { count: number; total: number; amount: number; frequency: 'weekly' | 'biweekly' | 'monthly' | 'yearly'; latest?: string } {
  const needles = matchText.map((m) => m.toLowerCase()).filter(Boolean);
  const hay = (t: { title?: string; description?: string; merchant?: string }) =>
    `${t.title ?? ''} ${t.description ?? ''} ${t.merchant ?? ''}`.toLowerCase();
  const hits = transactions
    .filter((t) => t.type === 'income' && needles.some((n) => hay(t).includes(n)))
    .sort((a, b) => a.date.localeCompare(b.date));

  const median = (xs: number[]) => {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };
  const amount = Math.round(median(hits.map((t) => t.amount)) * 100) / 100;
  const gaps: number[] = [];
  for (let i = 1; i < hits.length; i += 1) {
    const days = (Date.parse(hits[i].date.slice(0, 10)) - Date.parse(hits[i - 1].date.slice(0, 10))) / 86_400_000;
    if (days > 0) gaps.push(days);
  }
  const gap = median(gaps);
  // Bands, not exact numbers: real paydays drift over weekends and holidays.
  const frequency = !gap ? 'monthly'
    : gap <= 10 ? 'weekly'
    : gap <= 20 ? 'biweekly'
    : gap <= 45 ? 'monthly'
    : 'yearly';
  return {
    count: hits.length,
    total: Math.round(hits.reduce((s, t) => s + t.amount, 0) * 100) / 100,
    amount,
    frequency,
    latest: hits.length ? hits[hits.length - 1].date.slice(0, 10) : undefined,
  };
}

export function askAbout(question: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(ASK_EVENT, { detail: question }));
}

/** Navbar subscribes. Returns the unsubscribe, so it drops straight into useEffect. */
export function onAsk(handler: (question: string) => void): () => void {
  const listener = (e: Event) => {
    const q = (e as CustomEvent).detail;
    if (typeof q === 'string' && q.trim()) handler(q);
  };
  window.addEventListener(ASK_EVENT, listener);
  return () => window.removeEventListener(ASK_EVENT, listener);
}

/** A row as these phrasers need it — anything with a date, an amount and a name. */
interface AskableRow {
  date: string;
  amount: number;
  merchant?: string;
  title?: string;
  sourceCategory?: string;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

/** Transactions carry a full ISO timestamp; a person reads a date. */
const dateOnly = (s: string) => (s || '').slice(0, 10);

/**
 * How many rows travel with the question. The owner asked the chat to go through a
 * 15-row node "one at a time" and it could not, because the question carried a COUNT and
 * a TOTAL and no rows — so the model asked the owner to type out the very transactions
 * the app was already showing them. Capped because this is prompt text, not a ledger
 * dump; past the cap the question says how many it left out rather than pretending.
 */
const MAX_ROWS = 25;

/** Distinct non-empty values, most-frequent first, capped. */
function topValues(rows: AskableRow[], pick: (r: AskableRow) => string | undefined, cap = 3): string[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const v = pick(r)?.trim();
    if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, cap).map(([v]) => v);
}

/**
 * The question the owner would have had to type after clicking a Sankey node.
 *
 * It states the facts the app already computed — count, total, date span, the
 * categories those rows carry — and then asks. Without the facts the model would
 * answer from the ledger summary's merchant list, which is keyed differently and
 * would quietly answer about a DIFFERENT set of rows than the one on screen.
 */
export function askAboutNode(label: string, rows: AskableRow[]): string {
  const total = rows.reduce((s, r) => s + (Number.isFinite(r.amount) ? r.amount : 0), 0);
  const dates = rows.map((r) => dateOnly(r.date)).filter(Boolean).sort();
  const cats = topValues(rows, (r) => r.sourceCategory);

  const shown = [...rows]
    .sort((a, b) => dateOnly(a.date).localeCompare(dateOnly(b.date)))
    .slice(0, MAX_ROWS);

  const headline = [
    `I clicked "${label}" on my Flow chart.`,
    `It is ${rows.length} transaction${rows.length === 1 ? '' : 's'} totalling ${usd(total)}`,
    dates.length ? `between ${dates[0]} and ${dates[dates.length - 1]}` : '',
    cats.length ? `, filed under ${cats.join(', ')}` : '',
    '.',
  ].filter(Boolean).join(' ').replace(/\s+([,.])/g, '$1');

  return [
    headline,
    '',
    rows.length > shown.length
      ? `Here are the first ${shown.length} of ${rows.length}:`
      : 'Here they are:',
    // The rows themselves, numbered, so "the third one" and "go one at a time" both mean
    // something. Without these the model can only talk about the total.
    ...shown.map((r, i) =>
      `${i + 1}. ${dateOnly(r.date)} · ${(r.merchant || r.title || 'unnamed').trim()} · ${usd(
        Number.isFinite(r.amount) ? r.amount : 0
      )}${r.sourceCategory ? ` · filed as ${r.sourceCategory}` : ''}`
    ),
    '',
    'What are these, and how should each be categorised? Work through them ONE AT A TIME:',
    'ask me about the first one only, wait for my answer, then move to the next.',
    'When I tell you what one is, propose the rule that files it that way.',
  ].join('\n');
}

/*
 * The review queue's own phraser is `askAboutItem()` in `review-queue.ts`, not here: it
 * needs the section copy, the candidate and the option labels, all of which live there.
 */

/** What the transaction phraser needs — id and account for neighbours, the rest for words. */
interface AskableTxn extends AskableRow {
  id: string;
  accountId?: string;
  type?: string;
  transferDirection?: 'in' | 'out';
  pending?: boolean;
  description?: string;
}

const rowLine = (t: AskableTxn) =>
  `${dateOnly(t.date)} · ${(t.merchant || t.title || 'unnamed').trim()} · ${usd(Number.isFinite(t.amount) ? t.amount : 0)}`;

/**
 * ONE transaction, clicked anywhere in the app, with enough of its surroundings
 * that the conversation can move: "when was this", "who was it to", "what came
 * next". The neighbours are the SAME ACCOUNT's adjacent rows — without them the
 * model can only repeat the row back; with them, "the next one" means something.
 */
export function askAboutTransaction(
  t: AskableTxn,
  accounts: readonly { id: string; name: string }[],
  all: readonly AskableTxn[]
): string {
  const accountName = accounts.find((a) => a.id === t.accountId)?.name ?? 'an account';
  const flow =
    t.type === 'transfer'
      ? t.transferDirection === 'in'
        ? `a transfer INTO ${accountName} — the money came FROM somewhere else`
        : `a transfer OUT of ${accountName} — the money went TO the counterparty`
      : t.type === 'income'
        ? `money arriving into ${accountName}`
        : `paid from ${accountName}`;

  const sameAccount = all
    .filter((x) => x.accountId === t.accountId)
    .sort((a, b) => dateOnly(a.date).localeCompare(dateOnly(b.date)) || a.id.localeCompare(b.id));
  const i = sameAccount.findIndex((x) => x.id === t.id);
  const before = i >= 0 ? sameAccount.slice(Math.max(0, i - 2), i) : [];
  const after = i >= 0 ? sameAccount.slice(i + 1, i + 3) : [];

  return [
    'I clicked one transaction:',
    `${rowLine(t)} — ${flow}${t.pending ? ' (still pending)' : ''}`,
    t.sourceCategory ? `My bank/export files it as: ${t.sourceCategory}` : '',
    t.description ? `Bank text: ${t.description.slice(0, 120)}` : '',
    '',
    before.length || after.length ? `Its neighbours on ${accountName}:` : '',
    ...before.map((x) => `  ${rowLine(x)}`),
    i >= 0 ? `> ${rowLine(t)}   <- this one` : '',
    ...after.map((x) => `  ${rowLine(x)}`),
    '',
    'Tell me about this transaction — which merchant, when, and where the money came from or went to.',
    'If I ask about "the next one" or "the one before", use the neighbours listed above.',
  ].filter(Boolean).join('\n');
}
