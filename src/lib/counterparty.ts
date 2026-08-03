/**
 * WHO a row is with — the counterparty extractor.
 *
 * Lifted out of `flows.ts` unchanged by FIN-SETTLEMENT-003 for one reason: `classify.ts`
 * has to ask "does this row name an external counterparty?" and `flows.ts` imports
 * `classify.ts`. A cycle between the classifier and the flow math is not a thing to leave
 * lying around in a money path, so the shared half moved down here. `flows.ts` re-exports
 * all three names, so every existing import site is untouched.
 *
 * PURE: regexes and string work. No accounts, no I/O, no dependency on any other module.
 */

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

/**
 * Does this row name a party OUTSIDE the owner's own accounts?
 *
 * The ONE definition, so `signalOf()` (which groups the queue), `interpretTransaction()`
 * (which decides whether a confirmation may override a provider transfer) and any future
 * caller cannot drift apart on who counts as a counterparty. Description first, then
 * title — the statement line carries the name, the merchant column usually carries the
 * transport ("Zelle", "Remitly").
 */
export const namesExternalCounterparty = (
  t: { title?: string; description?: string }
): boolean => {
  const p = personFrom(t.description) ?? personFrom(t.title);
  return p !== null && !isSelfPerson(p);
};
