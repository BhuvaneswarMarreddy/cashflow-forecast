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
  isDebtAccount(a) ? -toCents(currentOf(a)) : toCents(currentOf(a));

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
import { classifyTransaction, isReward, isRefund } from './classify';
import { matchTransfers } from './transfers';
import { displayCategory } from '@/types';
import type { FlowColorKey } from './palette';
import { currentOf } from '@/lib/accounts';

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
  nodeTxnIds: Record<string, string[]>; // node id -> transaction ids behind it (drill-down)
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
  // A leg naming an external person (Zelle/Remitly) is by definition NOT an internal
  // move — keep it away from the pairer, which otherwise false-pairs it with any
  // unrelated same-amount leg inside the 4-day window (cost the audit exactly $2,000).
  const externalPersonLeg = (t: Transaction) => {
    const p = personFrom(t.description ?? t.title);
    return p !== null && !isSelfPerson(p);
  };
  const { pairs, unmatchedOut, unmatchedIn } = matchTransfers(
    rows.filter((t) => !(classifyTransaction(t, accounts) === 'transfer' && externalPersonLeg(t))),
    accounts
  );
  const personTransferLegs = rows.filter(
    (t) => classifyTransaction(t, accounts) === 'transfer' && externalPersonLeg(t)
  );
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
  // Parallel to the cent maps: which transaction ids landed at each category/person key,
  // and (for income sources / stubs) directly at a node id — powers the /flow drill-down.
  const catTxns = new Map<string, string[]>();
  const sentTxns = new Map<string, string[]>();
  const recvTxns = new Map<string, string[]>();
  const nodeTxns = new Map<string, string[]>();
  const pushId = (m: Map<string, string[]>, key: string, id: string) => {
    const a = m.get(key); if (a) a.push(id); else m.set(key, [id]);
  };
  const tagTxn = (nodeId: string, id: string) => pushId(nodeTxns, nodeId, id);
  const accNodeOf = (t: Transaction, dir: 'in' | 'out') => {
    const a = t.accountId ? byId.get(t.accountId) : undefined;
    if (a) return `acct:${a.id}`;
    return dir === 'in'
      ? node('unlinked-in', 'No account tagged (in)', 'stub')
      : node('unlinked-out', 'No account tagged (out)', 'stub');
  };

  for (const t of rows) {
    const cls = classifyTransaction(t, accounts);
    if (cls === 'transfer') continue; // handled via the matchTransfers partition
    const cents = toCents(t.amount);
    const person = personFrom(t.description ?? t.title);
    if (cls === 'income') {
      const an = accNodeOf(t, 'in');
      if (person && !isSelfPerson(person)) { add(recv, person, an, cents); pushId(recvTxns, person, t.id); continue; }
      const a = t.accountId ? byId.get(t.accountId) : undefined;
      // A refund is not income (owner rule) — on a bank it must reach the same 'refunds'
      // node a card refund does, so the story nets it out of spending instead of counting
      // it as money in.
      const src = isDebtAccount(a)
        ? node(isReward(t) ? 'rewards' : 'refunds', isReward(t) ? 'Rewards' : 'Refunds', 'source')
        : isRefund(t)
          ? node('refunds', 'Refunds', 'source')
          : node(`inc:${t.sourceCategory ?? 'Other income'}`, t.sourceCategory ?? 'Other income', 'source');
      link(src, an, cents);
      tagTxn(src, t.id);
    } else {
      const an = accNodeOf(t, 'out');
      if (person && isSelfPerson(person)) { link(an, node('self-ext-out', 'Other money out', 'stub'), cents); tagTxn('self-ext-out', t.id); continue; }
      if (person) { add(sent, person, an, cents); pushId(sentTxns, person, t.id); continue; }
      add(catCents, displayCategory(t), an, cents); pushId(catTxns, displayCategory(t), t.id);
    }
  }
  // stray pair legs (dangling accountId) and the person legs excluded from pairing
  // rejoin the unmatched pools by direction
  const looseLegs = [...strayLegs, ...personTransferLegs];
  const strayOut = looseLegs.filter((t) => (t.transferDirection ?? (isPositive(t, accounts) ? 'in' : 'out')) === 'out');
  const strayIn = looseLegs.filter((t) => !strayOut.includes(t));
  for (const t of [...unmatchedOut, ...strayOut]) {
    const cents = toCents(t.amount);
    const an = accNodeOf(t, 'out');
    const person = personFrom(t.description ?? t.title);
    if (person && !isSelfPerson(person)) { add(sent, person, an, cents); pushId(sentTxns, person, t.id); }
    else { link(an, node('self-ext-out', 'Other money out', 'stub'), cents); tagTxn('self-ext-out', t.id); }
  }
  for (const t of [...unmatchedIn, ...strayIn]) {
    const cents = toCents(t.amount);
    const an = accNodeOf(t, 'in');
    const person = personFrom(t.description ?? t.title);
    if (person && !isSelfPerson(person)) { add(recv, person, an, cents); pushId(recvTxns, person, t.id); }
    else { link(node('self-ext-in', 'Other money in', 'stub'), an, cents); tagTxn('self-ext-in', t.id); }
  }

  // categories: top-8 named, rest merged
  const catTotals = [...catCents.entries()]
    .map(([c, m]) => [c, [...m.values()].reduce((s, v) => s + v, 0)] as const)
    .sort((a, b) => b[1] - a[1]);
  const namedCats = new Set(catTotals.slice(0, TOP_CATEGORIES).map(([c]) => c));
  for (const [cat, m] of catCents) {
    const id = namedCats.has(cat) ? node(`cat:${cat}`, cat, 'category') : node('cat:other', 'Other spending', 'category');
    for (const [an, cents] of m) link(an, id, cents);
    for (const tid of catTxns.get(cat) ?? []) tagTxn(id, tid); // merges into cat:other follow for free
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
  for (const [p, inner] of recv) { const id = personNode(p, 'in'); for (const [an, cents] of inner) link(id, an, cents); for (const tid of recvTxns.get(p) ?? []) tagTxn(id, tid); }
  for (const [p, inner] of sent) { const id = personNode(p, 'out'); for (const [an, cents] of inner) link(an, id, cents); for (const tid of sentTxns.get(p) ?? []) tagTxn(id, tid); }

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
      if (opening > 0) link(node('opening', 'Starting balance', 'source'), id, opening);
      const r2 = residual + Math.max(opening, 0);
      if (r2 > 0) link(id, bank ? node('held', 'Still in your accounts', 'stub') : node('debt-down', 'Paid down existing balance', 'stub'), r2);
      else if (r2 < 0) link(node('debt-up', 'New card charges', 'source'), id, -r2);
      verdict = opening === 0 ? 'flat' : bank ? 'opening' : 'pre-export-debt';
    } else {
      gap = Math.abs(opening);
      verdict = 'missing-rows';
      if (bank) {
        link(id, node('missing-out', '⚠ Not in your data yet', 'warning'), gap);
        // Hold the real closing so the node balances. A positive balance stays in the
        // account; a rare overdrawn (negative) balance is an inflow — clamping it to zero
        // (the old bug) left |closing| of outflow with no source and broke conservation.
        if (closing >= 0) link(id, node('held', 'Still in your accounts', 'stub'), closing);
        else link(node('overdrawn', '⚠ Overdrawn (negative balance)', 'warning'), id, -closing);
      } else {
        link(node('missing-in', '⚠ Not in your data yet', 'warning'), id, gap);
        // A normal card owes (negative closing → new-debt inflow); an overpaid card holds a
        // positive balance that must LEAVE the node as held, else sources exceed sinks.
        if (closing <= 0) link(node('debt-up', 'New card charges', 'source'), id, -closing);
        else link(id, node('held', 'Still in your accounts', 'stub'), closing);
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
    nodeTxnIds: Object.fromEntries(nodeTxns),
  };
}

// ============================================================
// detectRecurring — the four rules exist because each killed a
// verified false result on the real data (see design spec).
// ============================================================
export interface RecurringItem {
  merchant: string;
  cadence: 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'yearly';
  medianCents: number; monthlyCents: number;
  occurrences: number; firstSeen: string; lastSeen: string; active: boolean;
  /** The account most of this merchant's charges hit (autopay source). */
  accountId: string | null;
  /** Next expected charge: lastSeen + the observed median gap. */
  nextDue: string;
  /** In-band gap ratio (0..1): how regular the cadence actually is. */
  confidence: number;
}

const BANDS: Array<[RecurringItem['cadence'], number, number, number]> = [
  ['weekly', 6, 8, 4.33], ['biweekly', 12, 16, 2.17], ['monthly', 26, 35, 1],
  ['quarterly', 80, 100, 1 / 3], ['yearly', 350, 380, 1 / 12],
];

export const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : Math.round((s[n / 2 - 1] + s[n / 2]) / 2);
};
export const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

// Strip #…/*… suffixes and TRAILING digit runs only — "650 INDUSTRIES" is a real brand.
export const normalizeMerchant = (s: string) =>
  s.toUpperCase().replace(/[#*]\S*/g, '').replace(/\s+\d{3,}$/, '').replace(/\s+/g, ' ').trim();

export function detectRecurring(
  transactions: Transaction[], accounts: PaymentAccount[], todayISO: string
): RecurringItem[] {
  const groups = new Map<string, Transaction[]>();
  for (const t of transactions) {
    if (classifyTransaction(t, accounts) !== 'expense') continue;
    const m = normalizeMerchant(t.merchant || t.title);
    if (!m) continue;
    const g = groups.get(m);
    if (g) g.push(t); else groups.set(m, [t]);
  }
  const out: RecurringItem[] = [];
  for (const [merchant, txs] of groups) {
    const dates = [...new Set(txs.map((t) => day(t.date)))].sort();
    if (dates.length < 3) continue;                                  // rule 1: unique days
    const amts = txs.map((t) => toCents(t.amount));
    const med = median(amts);
    if (med < 500) continue;                                         // rule 3: >= $5
    if (median(amts.map((a) => Math.abs(a - med))) > med * 0.25) continue;
    const gaps = dates.slice(1).map((d, i) => daysBetween(dates[i], d));
    const mg = median(gaps);
    const band = BANDS.find(([, lo, hi]) => mg >= lo && mg <= hi);
    if (!band) continue;
    const [cadence, lo, hi, mult] = band;
    const inBand = gaps.filter((g) => g >= lo && g <= hi).length / gaps.length;
    if (inBand < 0.6) continue; // rule 2
    const lastSeen = dates[dates.length - 1];
    const acctCount = new Map<string, number>();
    for (const t of txs) if (t.accountId) acctCount.set(t.accountId, (acctCount.get(t.accountId) ?? 0) + 1);
    out.push({
      merchant, cadence, medianCents: med, monthlyCents: Math.round(med * mult),
      occurrences: dates.length, firstSeen: dates[0], lastSeen,
      // Active = seen within ~1.5 of its own cycle length, not a flat 45 days — else a
      // healthy quarterly/yearly subscription reads as lapsed and drops off the /mo total.
      active: daysBetween(lastSeen, day(todayISO)) <= hi * 1.5,
      accountId: [...acctCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
      nextDue: new Date(Date.parse(`${lastSeen}T00:00:00Z`) + mg * 86_400_000).toISOString().slice(0, 10),
      confidence: inBand,
    });
  }
  return out.sort((a, b) => b.monthlyCents - a.monthlyCents);
}

// ============================================================
// projectNetWorth — "at this rate": trailing 6 full calendar
// months of (income − expenses − net person outflow).
// ============================================================
export function projectNetWorth(
  transactions: Transaction[], accounts: PaymentAccount[], todayISO: string, months = 12
): { monthlyRateCents: number; startCents: number; points: Array<{ month: string; cents: number }> } {
  const currentMonth = day(todayISO).slice(0, 7);
  const monthKey = (offsetFromCurrent: number) => {
    const [y, m] = currentMonth.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + offsetFromCurrent, 1));
    return d.toISOString().slice(0, 7);
  };
  const window = new Set([-6, -5, -4, -3, -2, -1].map(monthKey));

  let net = 0;
  const personLeg = (t: Transaction) => {
    const p = personFrom(t.description ?? t.title);
    return p !== null && !isSelfPerson(p);
  };
  // person legs never enter the pairer (same false-pair guard as buildFlowGraph)
  const isPersonTransfer = (t: Transaction) =>
    classifyTransaction(t, accounts) === 'transfer' && personLeg(t);
  const { unmatchedOut, unmatchedIn } = matchTransfers(
    transactions.filter((t) => !isPersonTransfer(t)), accounts
  );
  const personLegs = transactions.filter(isPersonTransfer);
  for (const t of transactions) {
    if (!window.has(day(t.date).slice(0, 7))) continue;
    const cls = classifyTransaction(t, accounts);
    if (cls === 'income') net += toCents(t.amount);
    else if (cls === 'expense') net -= toCents(t.amount);
  }
  const outLegs = [...unmatchedOut.filter(personLeg),
    ...personLegs.filter((t) => (t.transferDirection ?? (isPositive(t, accounts) ? 'in' : 'out')) === 'out')];
  const inLegs = [...unmatchedIn.filter(personLeg),
    ...personLegs.filter((t) => (t.transferDirection ?? (isPositive(t, accounts) ? 'in' : 'out')) === 'in')];
  for (const t of outLegs) if (window.has(day(t.date).slice(0, 7))) net -= toCents(t.amount);
  for (const t of inLegs) if (window.has(day(t.date).slice(0, 7))) net += toCents(t.amount);

  const monthlyRateCents = Math.round(net / 6);
  const startCents = accounts.reduce((s, a) => s + signedRealNowCents(a), 0);
  const points = Array.from({ length: months + 1 }, (_, i) => ({
    month: monthKey(i), cents: startCents + monthlyRateCents * i,
  }));
  return { monthlyRateCents, startCents, points };
}
