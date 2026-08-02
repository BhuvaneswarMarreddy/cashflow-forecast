/**
 * Service identity — which statement lines are the same SERVICE.
 *
 * NO SERVICE IS SPECIAL-CASED HERE. There is no vendor name in this file, no bundled
 * registry, no logo set and no third-party merchant database. A family is seeded from
 * what the owner's own data contains, and the only shipped list is the generic-token
 * stoplist below — words that carry no identity in any language of billing descriptors.
 *
 * `COMMON_MERCHANTS` (src/types/index.ts) is deliberately NOT used: it is a colour and
 * category aid, and reusing it as identity would make identity depend on a colour table.
 *
 * Four rules, in cost order (FIN-DUPLICATE-001 §5.2):
 *
 *   1. normalizeMerchant() equality        free      automatic
 *   2. a confirmed alias                   one map   automatic
 *   3. token overlap                       small     PROPOSES a merge, never applies one
 *   4. anything else                       —         distinct families
 *
 * Rule 3 never merges silently. It is the model refusing to guess about money: the
 * proposal surfaces as `needs_more_information` with reason `alias_unconfirmed`, and
 * confirming it writes the alias into the family so the question is never asked twice.
 *
 * PURE module — no Firestore, no React, no I/O. Persistence is
 * `users/{uid}/serviceFamilies/{familyId}`, uid-scoped, and the aliases it holds are
 * merchant strings: they live only in the owner's documents and in memory, and are never
 * emitted in a diagnostic event or written into a ReviewCandidate's evidence.
 *
 * FIN-DUPLICATE-001 owns this file. FIN-REFUND-001 imports it read-only.
 */

import { normalizeMerchant } from './flows';

export interface ServiceFamily {
  /** Stable, derived from the first observed normalized merchant. Also the doc id. */
  id: string;
  /** Display only. */
  label: string;
  /** Normalized merchant strings the owner has confirmed belong to this family. */
  aliases: string[];
  createdAt: string; // ISO-8601
  updatedAt: string; // ISO-8601
}

/** How a row reached its family. `proposed` is a question, never an answer. */
export type AliasResolution = 'exact' | 'alias' | 'proposed';

export interface ServiceIdentity {
  normalizedMerchant: string;
  serviceFamilyId: string;
  resolution: AliasResolution;
  /** 0..1, an explainable ladder — never a model output. */
  confidence: number;
  /** Reason codes, never merchant text. */
  evidence: string[];
}

/**
 * Words that identify no service. Removing them before token comparison is what stops
 * "…SUBSCRIPTION" and "…MONTHLY" from making every recurring charge look related.
 * `COM` covers the URL/domain form, since a descriptor's domain splits into its own token.
 */
export const GENERIC_TOKENS: readonly string[] = [
  'SUBSCRIPTION', 'SUBSCR', 'MONTHLY', 'ANNUAL', 'PLUS', 'PRO', 'PREMIUM', 'INC', 'LLC', 'COM',
];

const GENERIC = new Set(GENERIC_TOKENS);

/** A 3-character token matches half the ledger; identity needs more than that. */
export const MIN_TOKEN_LENGTH = 4;

/** firestore.rules caps the stored list; the cap is enforced here, not silently trimmed. */
export const MAX_ALIASES = 50;

/** What a row needs to be identified. A candidate CSV row has no id yet, so not a Transaction. */
export type Identifiable = { merchant?: string; title?: string };

/** Bank feeds often carry no merchant at all, so the title is the fallback haystack. */
export const normalizedMerchantOf = (t: Identifiable): string =>
  normalizeMerchant(t.merchant || t.title || '');

/**
 * The family id. Derived, not random, so two runs over the same ledger agree without
 * anything having been persisted first — persistence exists for CONFIRMED ALIASES, not
 * for id stability.
 */
export function serviceFamilyId(normalizedMerchant: string): string {
  const slug = normalizedMerchant
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
  return slug || 'unidentified-service';
}

/** Identity-bearing tokens: long enough to mean something, and not a billing filler word. */
export function significantTokens(normalizedMerchant: string): string[] {
  return [
    ...new Set(
      normalizedMerchant
        .split(/[^A-Z0-9]+/)
        .filter((token) => token.length >= MIN_TOKEN_LENGTH && !GENERIC.has(token))
    ),
  ];
}

/** `Map<normalizedAlias, familyId>` — one O(1) lookup per row, built once per run. */
export function buildAliasIndex(families: readonly ServiceFamily[] = []): Map<string, string> {
  const index = new Map<string, string>();
  for (const family of families) {
    for (const alias of family.aliases) index.set(alias, family.id);
  }
  return index;
}

/**
 * Rules 1 and 2. Rule 3 is `proposeFamilyMerge` and runs between two FAMILIES, not on one
 * row; rule 4 is the absence of a match, which is why an unrecognised merchant simply
 * becomes its own family rather than being forced into someone else's.
 */
export function resolveServiceIdentity(
  t: Identifiable,
  families: readonly ServiceFamily[] | Map<string, string> = []
): ServiceIdentity {
  const normalizedMerchant = normalizedMerchantOf(t);
  const index = families instanceof Map ? families : buildAliasIndex(families);
  const own = serviceFamilyId(normalizedMerchant);
  const confirmed = index.get(normalizedMerchant);

  if (confirmed && confirmed !== own) {
    return {
      normalizedMerchant,
      serviceFamilyId: confirmed,
      resolution: 'alias',
      confidence: 0.9,
      evidence: ['confirmed_alias'],
    };
  }
  return {
    normalizedMerchant,
    serviceFamilyId: own,
    resolution: 'exact',
    confidence: 1,
    evidence: ['normalized_merchant'],
  };
}

/**
 * Rule 3 — token overlap between two normalized strings. PROPOSES; never applies.
 *
 * The whole value of this function is what it does NOT do: it returns a question, and the
 * caller is required to surface it as `needs_more_information`. Two families stay two
 * families until the owner says otherwise.
 */
export function proposeFamilyMerge(
  a: string,
  b: string
): { propose: boolean; sharedTokens: string[] } {
  if (a === b) return { propose: false, sharedTokens: [] };
  const left = new Set(significantTokens(a));
  const sharedTokens = significantTokens(b).filter((token) => left.has(token)).sort();
  return { propose: sharedTokens.length > 0, sharedTokens };
}

/** A new family, seeded from the owner's own data. Never from a shipped list. */
export function seedServiceFamily(normalizedMerchant: string, nowISO: string): ServiceFamily {
  return {
    id: serviceFamilyId(normalizedMerchant),
    label: normalizedMerchant,
    aliases: [normalizedMerchant],
    createdAt: nowISO,
    updatedAt: nowISO,
  };
}

/**
 * Record the owner's answer to a rule-3 proposal. Pure: returns the next document, and
 * returns the SAME reference when the alias is already known, so a no-op costs no write.
 */
export function confirmAlias(family: ServiceFamily, normalizedAlias: string, nowISO: string): ServiceFamily {
  if (!normalizedAlias) throw new Error('service identity: an empty alias');
  if (family.aliases.includes(normalizedAlias)) return family;
  if (family.aliases.length >= MAX_ALIASES) {
    throw new Error(`service identity: at most ${MAX_ALIASES} aliases per family`);
  }
  return { ...family, aliases: [...family.aliases, normalizedAlias], updatedAt: nowISO };
}
