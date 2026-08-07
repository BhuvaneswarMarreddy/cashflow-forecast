/**
 * UI-112 — bank feeds hand us descriptions like
 * `PURCHASE 08/06 2C8MUM4AIHQ0CZN +XXXXX249889 WY`, and Home rendered them
 * verbatim. A list of shouting capitals is unreadable at a glance, which is the
 * one thing that list has to do.
 *
 * This deliberately does NOT try to extract a merchant name. Guessing that a
 * reference blob "is really Amazon" is a data problem (the BRAIN track), and a
 * wrong guess is worse than a shouty truth. All this does is stop the shouting
 * and keep the full string available to the caller for a title attribute.
 */

/** True when the text is mostly uppercase — i.e. a raw bank feed, not a name. */
function isShouting(text: string): boolean {
  const letters = text.replace(/[^A-Za-z]/g, '');
  if (letters.length < 4) return false;
  const upper = letters.replace(/[^A-Z]/g, '').length;
  return upper / letters.length >= 0.7;
}

/** Short words that are English, not acronyms — "KEEP THE CHANGE", not "KEEP THE". */
const SMALL_WORDS = new Set([
  'A', 'AN', 'AND', 'AS', 'AT', 'BY', 'FOR', 'FROM', 'IN', 'IS', 'IT', 'MY',
  'OF', 'ON', 'OR', 'THE', 'TO',
]);

/**
 * Recases one token. Anything that could be an identifier is returned verbatim —
 * a reference number is the only handle the owner has on a mystery charge, so it
 * must survive character-for-character.
 */
function recase(word: string): string {
  if (/[^A-Za-z0-9]/.test(word)) return word; // 08/06, +XXXXX249889 — punctuation means ID
  if (word.length >= 10 && /\d/.test(word) && /[A-Za-z]/.test(word)) return word; // 2C8MUM4AIHQ0CZN
  if (word.length <= 3 && word === word.toUpperCase() && !SMALL_WORDS.has(word)) {
    return word; // ACH, WY, LLC, HEB
  }
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/**
 * Display form of a transaction description. Returns the input unchanged when it
 * already looks like a human wrote it, so "Royal Biryani" and "On Inc" are never
 * touched.
 */
export function displayName(raw: string | undefined | null): string {
  const text = (raw ?? '').trim().replace(/\s+/g, ' ');
  if (!text || !isShouting(text)) return text;
  return text.split(' ').map(recase).join(' ');
}
