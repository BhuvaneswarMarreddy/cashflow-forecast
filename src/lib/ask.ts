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
