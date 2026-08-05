/**
 * FIN-FLOW-002 — the SIMPLE view of /flow: the same FlowGraph, regrouped into the
 * owner's four-step story — money in → your banks → where it leaves (cards, Remitly,
 * Zelle) → what it bought.
 *
 * NOTHING is recomputed and nothing is dropped: every link keeps its cents, every
 * node keeps its transaction ids, they are only MERGED under fewer names. The
 * detailed graph stays one toggle away, and anything that reasons about raw lane
 * ids (the story tiles, the review-queue feed) must read the DETAILED graph —
 * grouping renames ids, and a prefix test like `person-in:` finds nothing here.
 *
 * PURE module, LEAF like flow-lanes.ts: types from flows.ts, the residual label
 * from flow-lanes.ts, nothing else.
 */
import type { FlowGraph, FlowLink, FlowNode } from '@/lib/flows';
import { residualCategoryLabel } from '@/lib/flow-lanes';
import type { FlowColorKey } from '@/lib/palette';

/** Simple keeps this many category lanes; the rest fold into the self-counting residual. */
export const SIMPLE_TOP_CATEGORIES = 12;

const GROUPS: Array<{ test: (id: string) => boolean; id: string; label: string; kind: FlowColorKey }> = [
  { test: (id) => id.startsWith('person-in:'), id: 'simple:people-in', label: 'From people', kind: 'person' },
  // Remitly is a channel of its own — folding it into "people" would hide the
  // single biggest outflow this ledger has.
  { test: (id) => id.startsWith('person-out:') && id !== 'person-out:REMITLY', id: 'simple:people-out', label: 'Zelle to people', kind: 'person' },
  { test: (id) => id === 'refunds' || id === 'rewards' || id === 'card-credit-unexplained', id: 'simple:money-back', label: 'Money back & rewards', kind: 'credit' },
  { test: (id) => id === 'self-ext-in' || id === 'cardpay-in', id: 'simple:in-unpaired', label: 'Transfers in · other side missing', kind: 'stub' },
  { test: (id) => id === 'self-ext-out' || id === 'cardpay-out', id: 'simple:out-unpaired', label: 'Transfers out · other side missing', kind: 'stub' },
];

export function simplifyFlowGraph(g: FlowGraph): FlowGraph {
  // Which categories keep a lane of their own, measured by money into them.
  const catIn = new Map<string, number>();
  for (const l of g.links) {
    if (l.target.startsWith('cat:') && l.target !== 'cat:other')
      catIn.set(l.target, (catIn.get(l.target) ?? 0) + l.cents);
  }
  const keep = new Set(
    [...catIn.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, SIMPLE_TOP_CATEGORIES).map(([id]) => id)
  );
  // The detailed graph's residual already states its size in its label; the simple
  // fold adds to that count rather than hiding it.
  const prevResidual = g.nodes.find((n) => n.id === 'cat:other');
  const prevCount = prevResidual ? Number(prevResidual.label.match(/^(\d+) smaller categor/)?.[1] ?? 1) : 0;
  const foldedCount = prevCount + [...catIn.keys()].filter((id) => !keep.has(id)).length;

  const identity = (n: FlowNode): FlowNode => {
    const grp = GROUPS.find((x) => x.test(n.id));
    if (grp) return { id: grp.id, label: grp.label, kind: grp.kind };
    if (n.id === 'cat:other' || (n.id.startsWith('cat:') && !keep.has(n.id)))
      return { id: 'cat:other', label: residualCategoryLabel(foldedCount), kind: 'category' };
    return n;
  };
  const mapped = new Map(g.nodes.map((n) => [n.id, identity(n)]));

  const nodes = new Map<string, FlowNode>();
  for (const n of mapped.values()) if (!nodes.has(n.id)) nodes.set(n.id, n);

  const links = new Map<string, FlowLink>();
  for (const l of g.links) {
    const source = mapped.get(l.source)?.id ?? l.source;
    const target = mapped.get(l.target)?.id ?? l.target;
    if (source === target) continue; // two grouped lanes must not produce a self-loop
    const k = `${source}→${target}`;
    const prior = links.get(k);
    if (prior) {
      prior.cents += l.cents;
      // gross forward/reverse are PER-PAIR figures; they do not survive a merge
      delete prior.grossForwardCents;
      delete prior.grossReverseCents;
    } else {
      links.set(k, { ...l, source, target });
    }
  }

  const nodeTxnIds: Record<string, string[]> = {};
  for (const [id, ids] of Object.entries(g.nodeTxnIds)) {
    const nid = mapped.get(id)?.id ?? id;
    (nodeTxnIds[nid] ??= []).push(...ids);
  }

  // reconciliation, between, netting and person-expense figures are about the LEDGER,
  // not the drawing — they pass through untouched.
  return { ...g, nodes: [...nodes.values()], links: [...links.values()], nodeTxnIds };
}
