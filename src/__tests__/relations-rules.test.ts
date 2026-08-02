/**
 * FIN-RELATION-001 §11.3 — the firestore.rules trust boundary (F1–F8).
 *
 * WHAT THIS FILE DOES AND DOES NOT PROVE
 * ======================================
 * The spec asks for these eight assertions against the Firestore emulator. There is no
 * emulator configured in this repo, `@firebase/rules-unit-testing` is not installed, and
 * production IS the development environment — so a behavioural rules test would have to
 * either install an emulator (out of scope for this task) or point at production (never).
 *
 * What runs here instead, and what it is worth:
 *
 *  - **Runs, and is a real control:** the deployed `firestore.rules` text is parsed and
 *    each required constraint is asserted to be present in the right block, and the closed
 *    value sets in the rules are asserted to match the TypeScript constants byte for byte.
 *    This catches the regressions that actually happen — a widened `allow write`, a deleted
 *    `allow delete: if false`, a link type added to the model but not to the rules.
 *  - **Runs, and is a real control:** the client-side half of every invariant is asserted
 *    against the pure validator, which is the same predicate the store enforces.
 *  - **UNRUN — blocked on the missing emulator:** the rules ENGINE actually evaluating a
 *    request. Nothing here proves the deployed rules deny a second user's read, an
 *    unauthenticated write, or a float allocation *at the database*. Those require
 *    `@firebase/rules-unit-testing` + `firebase emulators:exec`, recorded as a blocker in
 *    docs/features/FIN-RELATION-001-COMPLETION.md.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { CANDIDATE_STATUSES, CANDIDATE_TYPES } from '@/lib/candidates';
import { LINK_STATUSES, LINK_TYPES, validateLink } from '@/lib/relations';

const RULES = readFileSync(join(process.cwd(), 'firestore.rules'), 'utf8');

/** The body of `match /<name>/{...} { … }`, brace-matched so nested blocks come along. */
function block(name: string): string {
  const start = RULES.indexOf(`match /${name}/{`);
  if (start < 0) throw new Error(`no match block for ${name} in firestore.rules`);
  let depth = 0;
  for (let i = RULES.indexOf('{', start); i < RULES.length; i++) {
    if (RULES[i] === '{') depth++;
    else if (RULES[i] === '}' && --depth === 0) return RULES.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces in the ${name} block`);
}

/** The value list inside `data.<field> in [ … ]`, whitespace-normalised. */
function closedSet(source: string, field: string): string[] {
  const m = new RegExp(`data\\.${field} in\\s*\\[([^\\]]*)\\]`).exec(source);
  if (!m) throw new Error(`no closed set for ${field}`);
  return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
}

const links = () => block('links');
const candidates = () => block('reviewCandidates');

const ref = (id: string, amountCents: number) => ({ id, amountCents });

describe('F1 the owner may read and write links and candidates under their own uid', () => {
  it('gates every allow on isOwner(userId)', () => {
    for (const source of [links(), candidates()]) {
      const allows = source.match(/allow [a-z, ]+: if [^;]+;/g) ?? [];
      expect(allows.length).toBeGreaterThanOrEqual(3);
      for (const a of allows) {
        expect(a.includes('isOwner(userId)') || a.includes('if false')).toBe(true);
      }
    }
    expect(links()).toMatch(/allow read: if isOwner\(userId\)/);
    expect(candidates()).toMatch(/allow read: if isOwner\(userId\)/);
  });
});

describe('F2 another signed-in user is denied', () => {
  it('has no allow in either block that is not conjoined with isOwner, and keeps the catch-all deny', () => {
    for (const source of [links(), candidates()]) {
      expect(source).not.toMatch(/allow [a-z, ]+: if true/);
      expect(source).not.toMatch(/allow [a-z, ]+: if isAuthenticated\(\)\s*;/);
    }
    expect(RULES).toMatch(/match \/\{document=\*\*\} \{\s*allow read, write: if false;/);
  });
});

describe('F3 an unauthenticated request is denied', () => {
  it('resolves isOwner through isAuthenticated, which requires request.auth', () => {
    expect(RULES).toMatch(/function isAuthenticated\(\)\s*\{\s*return request\.auth != null;/);
    expect(RULES).toMatch(/function isOwner\(userId\)\s*\{\s*return isAuthenticated\(\) && request\.auth\.uid == userId;/);
  });
});

describe('F4 a create missing any required field is denied', () => {
  it.each(['linkType', 'sourceTransactionId', 'targetTransactionId', 'allocatedAmountCents', 'status', 'algorithmVersion', 'createdAt', 'updatedAt'])(
    'requires %s on a link',
    (field) => {
      const hasAll = /keys\(\)\.hasAll\(\[([\s\S]*?)\]\)/.exec(links());
      expect(hasAll?.[1]).toContain(`'${field}'`);
    }
  );

  it.each(['candidateId', 'candidateType', 'algorithmVersion', 'transactionIds', 'status', 'score', 'generatedAt'])(
    'requires %s on a candidate',
    (field) => {
      const hasAll = /keys\(\)\.hasAll\(\[([\s\S]*?)\]\)/.exec(candidates());
      expect(hasAll?.[1]).toContain(`'${field}'`);
    }
  );
});

describe('F5 unknown linkType, status or candidateType is denied', () => {
  it('pins the rules closed sets to the TypeScript constants — one model, two enforcement points', () => {
    expect(closedSet(links(), 'linkType').sort()).toEqual([...LINK_TYPES].sort());
    expect(closedSet(links(), 'status').sort()).toEqual([...LINK_STATUSES].sort());
    expect(closedSet(candidates(), 'candidateType').sort()).toEqual([...CANDIDATE_TYPES].sort());
    expect(closedSet(candidates(), 'status').sort()).toEqual([...CANDIDATE_STATUSES].sort());
    // internal_transfer_leg is deliberately absent: matchTransfers() computes it live.
    expect(closedSet(links(), 'linkType')).not.toContain('internal_transfer_leg');
  });
});

describe('F6 allocatedAmountCents must be a positive integer', () => {
  it('is asserted as `is int` and `> 0` in the rules, on create and on update', () => {
    const occurrences = links().match(/allocatedAmountCents is int/g) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(2); // create + update
    expect((links().match(/allocatedAmountCents > 0/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('and the client validator agrees on 41.2, 0 and -100, and accepts 4120', () => {
    const ctx = { transactions: [ref('demo-credit', 6420), ref('demo-purchase', 6420)] };
    const draft = { linkType: 'refund_of' as const, sourceTransactionId: 'demo-credit', targetTransactionId: 'demo-purchase', status: 'suggested' as const, algorithmVersion: 'refund-match-v1' };
    for (const bad of [41.2, 0, -100]) {
      expect(validateLink({ ...draft, allocatedAmountCents: bad }, ctx)).toEqual({ ok: false, ruleId: 'V1' });
    }
    expect(validateLink({ ...draft, allocatedAmountCents: 4120 }, ctx)).toEqual({ ok: true });
  });
});

describe('F7 a self-link is denied at the rules layer, not only in the client', () => {
  it('carries the endpoint inequality in the rules block', () => {
    expect(links().replace(/\s+/g, ' ')).toContain(
      'request.resource.data.sourceTransactionId != request.resource.data.targetTransactionId'
    );
  });
});

describe('F8 an update cannot bypass validation, and delete is denied outright', () => {
  it('re-asserts the immutable fields on update', () => {
    const update = /allow update: if([\s\S]*?);/.exec(links())?.[1].replace(/\s+/g, ' ') ?? '';
    expect(update).toContain('request.resource.data.linkType == resource.data.linkType');
    expect(update).toContain('request.resource.data.sourceTransactionId == resource.data.sourceTransactionId');
    expect(update).toContain('request.resource.data.targetTransactionId == resource.data.targetTransactionId');
    expect(update).toContain('allocatedAmountCents is int');
    expect(update).toContain('allocatedAmountCents > 0');
    expect(update).toContain('status in');
  });

  it('denies delete on both collections — a rejected link IS the suppression record', () => {
    expect(links()).toMatch(/allow delete: if false;/);
    expect(candidates()).toMatch(/allow delete: if false;/);
  });

  it('caps candidate transactionIds at 2..13 at the database boundary', () => {
    const c = candidates().replace(/\s+/g, ' ');
    expect(c).toContain('transactionIds is list');
    expect(c).toContain('transactionIds.size() >= 2');
    expect(c).toContain('transactionIds.size() <= 13');
  });
});
