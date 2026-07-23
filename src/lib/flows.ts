/**
 * Flow-graph math for the /flow page. Everything here is integer CENTS —
 * dollars exist only at the render layer. Pure functions, no React.
 */
import { PaymentAccount, Transaction } from '@/types';
import { isPositive } from './classify';

export const toCents = (n: number) => Math.round(n * 100);
export const day = (iso: string) => iso.slice(0, 10);

export const isDebtAccount = (a?: PaymentAccount) =>
  a?.type === 'credit_card' || a?.type === 'personal_loan';

export const signedRealNowCents = (a: PaymentAccount) =>
  isDebtAccount(a) ? -toCents(a.balance) : toCents(a.balance);

export const signedCents = (t: Transaction, accounts: PaymentAccount[]) =>
  (isPositive(t, accounts) ? 1 : -1) * toCents(t.amount);

/** Account balance at the END of `endDay`, rolled back from the user-entered balance. */
export function balanceAtEndOfDay(
  a: PaymentAccount, transactions: Transaction[], accounts: PaymentAccount[], endDay: string
): number {
  let later = 0;
  for (const t of transactions) {
    if (t.accountId === a.id && day(t.date) > endDay) later += signedCents(t, accounts);
  }
  return signedRealNowCents(a) - later;
}

// --- person extraction (statement shapes discovered in the real CSVs) ---
const REMITLY = /rmtly|remitly/i;
// bac\w{5,}: Chase glues a BACxxxx confirmation token straight after the name.
const ZELLE = /zelle\s+(?:payment\s+|transfer\s+)?(?:to|from)[:\s]+([a-z .'’-]+?)(?=\s+(?:conf|jpm|bac\w{5,}|for\b|\d)|;|$)/i;
const BOFA_ALT = /zelle transfer conf# \w+;\s*(.+)$/i;

export function personFrom(text: string | undefined): string | null {
  if (!text) return null;
  if (REMITLY.test(text)) return 'REMITLY';
  const m = ZELLE.exec(text) ?? BOFA_ALT.exec(text);
  if (!m) return null;
  let name = m[1]
    .replace(/\s*for\s*".*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.;'-]+$/, '')
    .trim()
    .toUpperCase();
  const parts = name.split(' ').filter(Boolean);
  if (parts.length >= 3) name = `${parts[0]} ${parts[parts.length - 1]}`;
  return name || null;
}

export const isSelfPerson = (name: string) =>
  /BHUVANESWAR|MARREDDY/.test(name) || name === 'ME';

export const displayPerson = (name: string) =>
  name === 'REMITLY'
    ? 'Sent to India (Remitly)'
    : name.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

// ============================================================
// buildFlowGraph — the Sankey data + reconciliation
// ============================================================
import { classifyTransaction, isReward } from './classify';
import { matchTransfers } from './transfers';
import { displayCategory } from '@/types';
import type { FlowColorKey } from './palette';

export interface FlowNode { id: string; label: string; kind: FlowColorKey }
export interface FlowLink {
  source: string; target: string; cents: number;
  grossForwardCents?: number; grossReverseCents?: number;
}
export interface BetweenRow { from: string; to: string; moves: number; cents: number }
export interface ReconRow {
  accountId: string; name: string;
  openingCents: number; inCents: number; outCents: number; closingCents: number;
  gapCents: number; verdict: 'opening' | 'pre-export-debt' | 'missing-rows' | 'flat';
}
export interface FlowGraph {
  nodes: FlowNode[]; links: FlowLink[];
  reconciliation: ReconRow[]; between: BetweenRow[];
}

const TOP_CATEGORIES = 8;
const TOP_PEOPLE = 5;

export function buildFlowGraph(
  transactions: Transaction[],
  accounts: PaymentAccount[],
  period: { start?: string; end?: string } = {}
): FlowGraph {
  const start = period.start ?? '0000-00-00';
  const end = period.end ?? '9999-12-31';
  const rows = transactions.filter((t) => day(t.date) >= start && day(t.date) <= end);
  const byId = new Map(accounts.map((a) => [a.id, a]));

  const nodes = new Map<string, FlowNode>();
  const links = new Map<string, FlowLink>();
  const node = (id: string, label: string, kind: FlowColorKey) => {
    if (!nodes.has(id)) nodes.set(id, { id, label, kind });
    return id;
  };
  const link = (source: string, target: string, cents: number) => {
    if (cents <= 0) return;
    const k = `${source}→${target}`;
    const l = links.get(k);
    if (l) l.cents += cents;
    else links.set(k, { source, target, cents });
  };

  for (const a of accounts) {
    node(`acct:${a.id}`, a.name,
      a.type === 'credit_card' ? 'card' : a.type === 'personal_loan' ? 'loan' : 'bank');
  }

  // --- transfers: pair, gross matrix, hub-or-direct nets ---
  const { pairs, unmatchedOut, unmatchedIn } = matchTransfers(rows, accounts);
  const gross = new Map<string, { moves: number; cents: number }>();
  const strayLegs: Transaction[] = [];
  for (const p of pairs) {
    if (!p.fromAccountId || !p.toAccountId) { strayLegs.push(p.out, p.inbound); continue; }
    const k = `${p.fromAccountId}|${p.toAccountId}`;
    const g = gross.get(k) ?? { moves: 0, cents: 0 };
    g.moves += 1; g.cents += toCents(p.amount);
    gross.set(k, g);
  }
  const between: BetweenRow[] = [...gross.entries()].map(([k, g]) => {
    const [from, to] = k.split('|');
    return { from, to, moves: g.moves, cents: g.cents };
  }).sort((a, b) => b.cents - a.cents);

  const hubNet = new Map<string, number>(); // +cents = net sender into hub
  const done = new Set<string>();
  for (const [k, g] of gross) {
    const [fromId, toId] = k.split('|');
    if (done.has(`${toId}|${fromId}`)) continue;
    done.add(k);
    const rev = gross.get(`${toId}|${fromId}`);
    const net = g.cents - (rev?.cents ?? 0);
    if (net === 0) continue;
    const [srcId, dstId, cents, fwd, back] = net > 0
      ? ([fromId, toId, net, g.cents, rev?.cents ?? 0] as const)
      : ([toId, fromId, -net, rev!.cents, g.cents] as const);
    const src = byId.get(srcId), dst = byId.get(dstId);
    const bothBanks = src && dst && !isDebtAccount(src) && !isDebtAccount(dst);
    const backwards = src && dst && isDebtAccount(src) && !isDebtAccount(dst);
    if (bothBanks || backwards) {
      hubNet.set(srcId, (hubNet.get(srcId) ?? 0) + cents);
      hubNet.set(dstId, (hubNet.get(dstId) ?? 0) - cents);
    } else {
      links.set(`acct:${srcId}→acct:${dstId}`, {
        source: `acct:${srcId}`, target: `acct:${dstId}`,
        cents, grossForwardCents: fwd, grossReverseCents: back,
      });
    }
  }
  if ([...hubNet.values()].some((v) => v !== 0)) node('hub', '⇄ between accounts', 'hub');
  for (const [id, v] of hubNet) {
    if (v > 0) link(`acct:${id}`, 'hub', v);
    else if (v < 0) link('hub', `acct:${id}`, -v);
  }

  // --- income / expense / unmatched legs: accumulate, then materialize top-N ---
  const catCents = new Map<string, Map<string, number>>();  // category -> accNode -> cents
  const sent = new Map<string, Map<string, number>>();       // person -> accNode -> cents
  const recv = new Map<string, Map<string, number>>();
  const add = (m: Map<string, Map<string, number>>, key: string, accNode: string, cents: number) => {
    const inner = m.get(key) ?? new Map<string, number>();
    inner.set(accNode, (inner.get(accNode) ?? 0) + cents);
    m.set(key, inner);
  };
  const accNodeOf = (t: Transaction, dir: 'in' | 'out') => {
    const a = t.accountId ? byId.get(t.accountId) : undefined;
    if (a) return `acct:${a.id}`;
    return dir === 'in'
      ? node('unlinked-in', 'Unlinked (in)', 'stub')
      : node('unlinked-out', 'Unlinked (out)', 'stub');
  };

  for (const t of rows) {
    const cls = classifyTransaction(t, accounts);
    if (cls === 'transfer') continue; // handled via the matchTransfers partition
    const cents = toCents(t.amount);
    const person = personFrom(t.description ?? t.title);
    if (cls === 'income') {
      const an = accNodeOf(t, 'in');
      if (person && !isSelfPerson(person)) { add(recv, person, an, cents); continue; }
      const a = t.accountId ? byId.get(t.accountId) : undefined;
      const src = isDebtAccount(a)
        ? node(isReward(t) ? 'rewards' : 'refunds', isReward(t) ? 'Rewards' : 'Refunds', 'source')
        : node(`inc:${t.sourceCategory ?? 'Other income'}`, t.sourceCategory ?? 'Other income', 'source');
      link(src, an, cents);
    } else {
      const an = accNodeOf(t, 'out');
      if (person && isSelfPerson(person)) { link(an, node('self-ext-out', 'Self & external (unpaired)', 'stub'), cents); continue; }
      if (person) { add(sent, person, an, cents); continue; }
      add(catCents, displayCategory(t), an, cents);
    }
  }
  // stray pair legs (dangling accountId) rejoin the unmatched pools by direction
  const strayOut = strayLegs.filter((t) => (t.transferDirection ?? (isPositive(t, accounts) ? 'in' : 'out')) === 'out');
  const strayIn = strayLegs.filter((t) => !strayOut.includes(t));
  for (const t of [...unmatchedOut, ...strayOut]) {
    const cents = toCents(t.amount);
    const an = accNodeOf(t, 'out');
    const person = personFrom(t.description ?? t.title);
    if (person && !isSelfPerson(person)) add(sent, person, an, cents);
    else link(an, node('self-ext-out', 'Self & external (unpaired)', 'stub'), cents);
  }
  for (const t of [...unmatchedIn, ...strayIn]) {
    const cents = toCents(t.amount);
    const an = accNodeOf(t, 'in');
    const person = personFrom(t.description ?? t.title);
    if (person && !isSelfPerson(person)) add(recv, person, an, cents);
    else link(node('self-ext-in', 'Self & external (unpaired in)', 'stub'), an, cents);
  }

  // categories: top-8 named, rest merged
  const catTotals = [...catCents.entries()]
    .map(([c, m]) => [c, [...m.values()].reduce((s, v) => s + v, 0)] as const)
    .sort((a, b) => b[1] - a[1]);
  const namedCats = new Set(catTotals.slice(0, TOP_CATEGORIES).map(([c]) => c));
  for (const [cat, m] of catCents) {
    const id = namedCats.has(cat) ? node(`cat:${cat}`, cat, 'category') : node('cat:other', 'Other spending', 'category');
    for (const [an, cents] of m) link(an, id, cents);
  }

  // people: Remitly always named; top-5 others named; rest folded
  const vol = new Map<string, number>();
  for (const m of [sent, recv]) for (const [p, inner] of m)
    vol.set(p, (vol.get(p) ?? 0) + [...inner.values()].reduce((s, v) => s + v, 0));
  const named = new Set(
    [...vol.entries()].filter(([p]) => p !== 'REMITLY')
      .sort((a, b) => b[1] - a[1]).slice(0, TOP_PEOPLE).map(([p]) => p)
  );
  if (vol.has('REMITLY')) named.add('REMITLY');
  const personNode = (p: string, dir: 'in' | 'out') => {
    if (!named.has(p)) return node(`person-${dir}:others`, 'Others (people)', 'person');
    return node(`person-${dir}:${p}`, displayPerson(p), 'person');
  };
  for (const [p, inner] of recv) for (const [an, cents] of inner) link(personNode(p, 'in'), an, cents);
  for (const [p, inner] of sent) for (const [an, cents] of inner) link(an, personNode(p, 'out'), cents);

  // --- balancing stubs + reconciliation (verified against all 9 real accounts) ---
  const reconciliation: ReconRow[] = [];
  for (const a of accounts) {
    const id = `acct:${a.id}`;
    let inC = 0, outC = 0;
    for (const l of links.values()) {
      if (l.target === id) inC += l.cents;
      if (l.source === id) outC += l.cents;
    }
    const residual = inC - outC;
    const closing = balanceAtEndOfDay(a, transactions, accounts, end);
    const opening = closing - residual;
    const bank = !isDebtAccount(a);
    const plausible = bank ? opening >= 0 : opening <= 0;
    let verdict: ReconRow['verdict'];
    let gap = 0;
    if (plausible) {
      if (opening > 0) link(node('opening', 'Opening balance', 'source'), id, opening);
      const r2 = residual + Math.max(opening, 0);
      if (r2 > 0) link(id, bank ? node('held', 'Held today', 'stub') : node('debt-down', 'Pre-export debt paid down', 'stub'), r2);
      else if (r2 < 0) link(node('debt-up', 'Card balance ↑ (new debt)', 'source'), id, -r2);
      verdict = opening === 0 ? 'flat' : bank ? 'opening' : 'pre-export-debt';
    } else {
      gap = Math.abs(opening);
      verdict = 'missing-rows';
      if (bank) {
        link(id, node('held', 'Held today', 'stub'), Math.max(closing, 0));
        link(id, node('missing-out', '⚠ Missing from export', 'warning'), gap);
      } else {
        link(node('missing-in', '⚠ Missing from export (in)', 'warning'), id, gap);
        link(node('debt-up', 'Card balance ↑ (new debt)', 'source'), id, Math.max(-closing, 0));
      }
    }
    reconciliation.push({
      accountId: a.id, name: a.name,
      openingCents: opening, inCents: inC, outCents: outC, closingCents: closing,
      gapCents: gap, verdict,
    });
  }

  // drop nodes that ended up with no links (defensive; recharts rejects islands)
  const used = new Set<string>();
  for (const l of links.values()) { used.add(l.source); used.add(l.target); }
  return {
    nodes: [...nodes.values()].filter((n) => used.has(n.id)),
    links: [...links.values()],
    reconciliation, between,
  };
}
