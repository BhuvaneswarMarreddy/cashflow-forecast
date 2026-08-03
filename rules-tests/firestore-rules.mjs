/**
 * firestore.rules executed against the Firestore emulator (SEC-RULES-001).
 *
 * The browser reads Firestore DIRECTLY in this app — there is no backend API in front of
 * most reads — so firestore.rules IS the access-control layer. Before this file it had
 * never been run against a rules engine.
 *
 * Run:  npm run test:rules
 *
 * OFFLINE ONLY. The project id is `demo-cashflow-rules`; the `demo-` prefix makes the
 * Firebase tooling refuse to reach a real backend even if credentials are present, and
 * emulators:exec pins FIRESTORE_EMULATOR_HOST. Nothing here can touch production.
 *
 * Deliberately NOT a jest file, and deliberately NOT named `*.test.*`:
 *   - next/jest's testMatch DOES pick up `*.test.mjs` (measured, not assumed), so the
 *     name has no `test`/`spec` segment and `npx jest` cannot collect it. It is passed
 *     to `node --test` by explicit path instead, which runs a file whatever its name.
 *   - tsconfig `include` lists the ts, tsx and mts globs but not mjs, so `npx tsc
 *     --noEmit` ignores it too.
 * So the existing 947-test jest suite and the tsc gate are untouched, and this suite
 * only ever runs when the emulator is up. It uses node:test — no framework to install.
 *
 * Every fixture is obviously synthetic: `*.invalid` emails, `ACME SYNTHETIC` merchants,
 * round amounts. No real merchant, account number or amount appears in this file.
 *
 * Tests named `BUG:` assert the rules' CURRENT behaviour and that behaviour is WRONG —
 * they are executable evidence of a defect, not an endorsement. See the report.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc, updateDoc } from 'firebase/firestore';

const RULES = fileURLToPath(new URL('../firestore.rules', import.meta.url));

const ALICE = 'uid_alice_synthetic';
const BOB = 'uid_bob_synthetic';

const LINK_ID = 'refund_of~txnSynthA~txnSynthB';
const CAND_ID = 'refund_match~txnSynthA~txnSynthB';
const T0 = '2020-01-01T00:00:00.000Z';

let testEnv;

const asAlice = () => testEnv.authenticatedContext(ALICE).firestore();
const asBob = () => testEnv.authenticatedContext(BOB).firestore();
const asAnon = () => testEnv.unauthenticatedContext().firestore();

// ---------------------------------------------------------------------------
// Synthetic fixtures, shaped from the real client writers
// ---------------------------------------------------------------------------

const profile = (uid) => ({
  uid,
  email: `${uid}@example.invalid`,
  displayName: 'Synthetic Tester',
  settings: { currency: 'USD', timezone: 'UTC', monthlyBudget: 0, notifications: true },
  metadata: { isOnboarded: false, lastLoginAt: T0, signUpMethod: 'password' },
});

/** The shape firestore.rules DEMANDS of an account. Note `balance`. */
const accountPerRules = (over = {}) => ({
  name: 'Synthetic Checking',
  type: 'bank_account',
  provider: 'other',
  balance: 0,
  isActive: true,
  color: '#000000',
  ...over,
});

/** The shape the APP actually writes — src/lib/firestore.ts `FirestoreAccount`. */
const accountPerApp = (over = {}) => ({
  name: 'Synthetic Checking',
  type: 'bank_account',
  provider: 'other',
  openingBalance: 0,
  openingDate: '2020-01-01',
  color: '#000000',
  isActive: true,
  ...over,
});

const income = (over = {}) => ({
  name: 'Synthetic Salary',
  amount: 1000,
  frequency: 'biweekly',
  isActive: true,
  ...over,
});

const txn = (over = {}) => ({
  title: 'SYNTHETIC TEST ROW',
  amount: 12.34,
  type: 'expense',
  category: 'other',
  paymentMethod: 'other',
  date: T0,
  ...over,
});

/** Exactly the four fields TransactionContext.addRule() writes. */
const mappingRule = (over = {}) => ({
  match: { field: 'merchant', op: 'contains', value: 'ACME SYNTHETIC' },
  set: { category: 'other' },
  createdAt: T0,
  enabled: true,
  ...over,
});

/** Exactly what firestore.ts setInflowReview() merges. */
const review = (transactionId, over = {}) => ({
  transactionId,
  state: 'confirmed',
  source: 'user',
  updatedAt: T0,
  ...over,
});

/** Exactly what relations-store.saveLink() merges. */
const link = (over = {}) => ({
  linkType: 'refund_of',
  sourceTransactionId: 'txnSynthA',
  targetTransactionId: 'txnSynthB',
  allocatedAmountCents: 1234,
  status: 'suggested',
  algorithmVersion: 'test-v1',
  createdAt: T0,
  updatedAt: T0,
  ...over,
});

/** Exactly what relations-store.saveReviewCandidate() merges. */
const candidate = (over = {}) => ({
  candidateId: 'refund_match~test-v1~txnSynthA~txnSynthB',
  candidateType: 'refund_match',
  algorithmVersion: 'test-v1',
  transactionIds: ['txnSynthA', 'txnSynthB'],
  status: 'unreviewed',
  score: 0.9,
  generatedAt: T0,
  ...over,
});

const family = (over = {}) => ({
  label: 'Synthetic Service',
  aliases: ['syntheticsvc'],
  createdAt: T0,
  updatedAt: T0,
  ...over,
});

/** Every document path the rules file names, seeded under Alice. */
const ALICE_DOCS = [
  ['accounts/acc1', ['users', ALICE, 'accounts', 'acc1'], accountPerRules],
  ['income/inc1', ['users', ALICE, 'income', 'inc1'], income],
  ['transactions/txnSynthA', ['users', ALICE, 'transactions', 'txnSynthA'], txn],
  ['rules/rule1', ['users', ALICE, 'rules', 'rule1'], mappingRule],
  ['reviews/txnSynthA', ['users', ALICE, 'reviews', 'txnSynthA'], () => review('txnSynthA')],
  ['links/<derived>', ['users', ALICE, 'links', LINK_ID], link],
  ['reviewCandidates/<identityKey>', ['users', ALICE, 'reviewCandidates', CAND_ID], candidate],
  ['serviceFamilies/fam1', ['users', ALICE, 'serviceFamilies', 'fam1'], family],
  ['budgets/b1', ['users', ALICE, 'budgets', 'b1'], () => ({ monthlyLimit: 100 })],
];

const ALICE_COLLECTIONS = [
  'accounts',
  'income',
  'transactions',
  'rules',
  'reviews',
  'links',
  'reviewCandidates',
  'serviceFamilies',
  'budgets',
];

async function seed() {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'users', ALICE), profile(ALICE));
    await setDoc(doc(db, 'users', BOB), profile(BOB));
    for (const [, path, make] of ALICE_DOCS) await setDoc(doc(db, ...path), make());
    // Live app collections that the rules file never mentions (see BUG C).
    await setDoc(doc(db, 'users', ALICE, 'plannedTransactions', 'pt1'), {
      title: 'Synthetic Planned',
      amount: 1,
      status: 'pending',
    });
  });
}

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'demo-cashflow-rules',
    firestore: { rules: readFileSync(RULES, 'utf8'), host: '127.0.0.1', port: 8780 },
  });
});

after(async () => {
  await testEnv?.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  await seed();
});

// ===========================================================================
// 1. An unauthenticated client can do nothing
// ===========================================================================

describe('1. unauthenticated', () => {
  it('cannot read a user profile', async () => {
    await assertFails(getDoc(doc(asAnon(), 'users', ALICE)));
  });

  it('cannot create a user profile', async () => {
    await assertFails(setDoc(doc(asAnon(), 'users', 'uid_drive_by'), profile('uid_drive_by')));
  });

  it('cannot delete a user profile', async () => {
    await assertFails(deleteDoc(doc(asAnon(), 'users', ALICE)));
  });

  for (const [label, path, make] of ALICE_DOCS) {
    it(`cannot read ${label}`, async () => {
      await assertFails(getDoc(doc(asAnon(), ...path)));
    });
    it(`cannot write ${label}`, async () => {
      await assertFails(setDoc(doc(asAnon(), ...path), make()));
    });
  }

  for (const c of ALICE_COLLECTIONS) {
    it(`cannot list ${c}`, async () => {
      await assertFails(getDocs(collection(asAnon(), 'users', ALICE, c)));
    });
  }

  it('cannot read or write an unmapped top-level collection', async () => {
    await assertFails(getDoc(doc(asAnon(), 'anything', 'x')));
    await assertFails(setDoc(doc(asAnon(), 'anything', 'x'), { a: 1 }));
  });
});

// ===========================================================================
// 2. User A cannot READ user B's data
// ===========================================================================

describe("2. cross-tenant reads (Bob against Alice's subtree)", () => {
  it("cannot read Alice's profile", async () => {
    await assertFails(getDoc(doc(asBob(), 'users', ALICE)));
  });

  for (const [label, path] of ALICE_DOCS) {
    it(`cannot read ${label}`, async () => {
      await assertFails(getDoc(doc(asBob(), ...path)));
    });
  }

  for (const c of ALICE_COLLECTIONS) {
    it(`cannot list ${c}`, async () => {
      await assertFails(getDocs(collection(asBob(), 'users', ALICE, c)));
    });
  }

  it('cannot list the users collection to enumerate tenants', async () => {
    await assertFails(getDocs(collection(asBob(), 'users')));
  });
});

// ===========================================================================
// 3. User A cannot WRITE into user B's subtree
// ===========================================================================

describe("3. cross-tenant writes (Bob into Alice's subtree)", () => {
  it("cannot overwrite Alice's profile", async () => {
    await assertFails(setDoc(doc(asBob(), 'users', ALICE), profile(ALICE)));
  });

  it("cannot update Alice's profile", async () => {
    await assertFails(updateDoc(doc(asBob(), 'users', ALICE), { displayName: 'pwned' }));
  });

  it("cannot delete Alice's profile", async () => {
    await assertFails(deleteDoc(doc(asBob(), 'users', ALICE)));
  });

  for (const [label, path, make] of ALICE_DOCS) {
    it(`cannot overwrite ${label}`, async () => {
      await assertFails(setDoc(doc(asBob(), ...path), make()));
    });
    it(`cannot merge into ${label}`, async () => {
      await assertFails(setDoc(doc(asBob(), ...path), make(), { merge: true }));
    });
    it(`cannot delete ${label}`, async () => {
      await assertFails(deleteDoc(doc(asBob(), ...path)));
    });
  }

  it("cannot create a NEW doc in Alice's transactions", async () => {
    await assertFails(setDoc(doc(asBob(), 'users', ALICE, 'transactions', 'planted'), txn()));
  });

  it("cannot create a NEW link in Alice's subtree", async () => {
    const id = 'refund_of~planted1~planted2';
    await assertFails(
      setDoc(doc(asBob(), 'users', ALICE, 'links', id), link({ sourceTransactionId: 'planted1', targetTransactionId: 'planted2' }))
    );
  });

  it("cannot create a NEW reviewCandidate in Alice's subtree", async () => {
    await assertFails(
      setDoc(doc(asBob(), 'users', ALICE, 'reviewCandidates', 'refund_match~p1~p2'), candidate({ transactionIds: ['p1', 'p2'] }))
    );
  });

  it("cannot create a NEW mapping rule in Alice's subtree", async () => {
    await assertFails(setDoc(doc(asBob(), 'users', ALICE, 'rules', 'planted'), mappingRule()));
  });

  it("cannot create a NEW review in Alice's subtree", async () => {
    await assertFails(setDoc(doc(asBob(), 'users', ALICE, 'reviews', 'planted'), review('planted')));
  });

  it('cannot forge auth by writing a uid field that names Alice', async () => {
    // The rule keys off request.auth.uid, never a document field. Prove it.
    await assertFails(setDoc(doc(asBob(), 'users', ALICE), { ...profile(ALICE), uid: BOB }));
  });
});

// ===========================================================================
// 4. The owner CAN do what the app actually does
// ===========================================================================

describe('4. legitimate owner operations', () => {
  it('creates their own profile', async () => {
    await testEnv.clearFirestore();
    await assertSucceeds(setDoc(doc(asAlice(), 'users', ALICE), profile(ALICE)));
  });

  it('reads their own profile', async () => {
    await assertSucceeds(getDoc(doc(asAlice(), 'users', ALICE)));
  });

  it('updates their own profile settings (updateUserProfile)', async () => {
    await assertSucceeds(
      updateDoc(doc(asAlice(), 'users', ALICE), { 'settings.monthlyBudget': 500, updatedAt: T0 })
    );
  });

  it('marks onboarding complete (metadata.isOnboarded)', async () => {
    await assertSucceeds(updateDoc(doc(asAlice(), 'users', ALICE), { 'metadata.isOnboarded': true }));
  });

  it('deletes their own profile', async () => {
    await assertSucceeds(deleteDoc(doc(asAlice(), 'users', ALICE)));
  });

  it('lists every one of their own collections', async () => {
    for (const c of ALICE_COLLECTIONS) {
      await assertSucceeds(getDocs(collection(asAlice(), 'users', ALICE, c)));
    }
  });

  it('creates an income source (addIncome)', async () => {
    await assertSucceeds(setDoc(doc(asAlice(), 'users', ALICE, 'income', 'inc2'), income()));
  });

  it('updates and deletes their income source', async () => {
    await assertSucceeds(updateDoc(doc(asAlice(), 'users', ALICE, 'income', 'inc1'), { isActive: false }));
    await assertSucceeds(deleteDoc(doc(asAlice(), 'users', ALICE, 'income', 'inc1')));
  });

  it('creates a transaction (addTransaction)', async () => {
    await assertSucceeds(setDoc(doc(asAlice(), 'users', ALICE, 'transactions', 'txnNew'), txn()));
  });

  it('creates a transfer row (Monarch transfer type)', async () => {
    await assertSucceeds(
      setDoc(doc(asAlice(), 'users', ALICE, 'transactions', 'txnXfer'), txn({ type: 'transfer', transferDirection: 'in' }))
    );
  });

  it('creates a $0.00 row — real exports contain fee reversals', async () => {
    await assertSucceeds(setDoc(doc(asAlice(), 'users', ALICE, 'transactions', 'txnZero'), txn({ amount: 0 })));
  });

  it('re-imports a row idempotently (addBulkTransactions merge-set on an existing id)', async () => {
    await assertSucceeds(
      setDoc(doc(asAlice(), 'users', ALICE, 'transactions', 'txnSynthA'), { ...txn(), updatedAt: T0 }, { merge: true })
    );
  });

  it('edits and deletes their own transaction', async () => {
    await assertSucceeds(updateDoc(doc(asAlice(), 'users', ALICE, 'transactions', 'txnSynthA'), { category: 'food' }));
    await assertSucceeds(deleteDoc(doc(asAlice(), 'users', ALICE, 'transactions', 'txnSynthA')));
  });

  it('creates a mapping rule (TransactionContext.addRule)', async () => {
    await assertSucceeds(setDoc(doc(asAlice(), 'users', ALICE, 'rules', 'rule2'), mappingRule()));
  });

  it('creates a mapping rule with the MAP-001 optional qualifiers', async () => {
    await assertSucceeds(
      setDoc(doc(asAlice(), 'users', ALICE, 'rules', 'rule3'), mappingRule({
        match: { field: 'title', op: 'equals', value: 'ACME SYNTHETIC', direction: 'outflow', accountId: 'acc1', onOrAfter: '2020-01-01' },
      }))
    );
  });

  it('toggles and deletes a mapping rule', async () => {
    await assertSucceeds(updateDoc(doc(asAlice(), 'users', ALICE, 'rules', 'rule1'), { enabled: false }));
    await assertSucceeds(deleteDoc(doc(asAlice(), 'users', ALICE, 'rules', 'rule1')));
  });

  it('writes an inflow review (setInflowReview merge)', async () => {
    await assertSucceeds(
      setDoc(doc(asAlice(), 'users', ALICE, 'reviews', 'txnSynthB'), review('txnSynthB', { meaning: 'gift' }), { merge: true })
    );
  });

  it('reopens a review by deleting it (deleteInflowReview)', async () => {
    await assertSucceeds(deleteDoc(doc(asAlice(), 'users', ALICE, 'reviews', 'txnSynthA')));
  });

  it('creates a link (relations-store.saveLink)', async () => {
    const id = 'card_payment_pair~txnSynthC~txnSynthD';
    await assertSucceeds(
      setDoc(doc(asAlice(), 'users', ALICE, 'links', id), link({
        linkType: 'card_payment_pair', sourceTransactionId: 'txnSynthC', targetTransactionId: 'txnSynthD',
      }), { merge: true })
    );
  });

  it('confirms a link (saveLink upsert onto the same derived id)', async () => {
    await assertSucceeds(
      setDoc(doc(asAlice(), 'users', ALICE, 'links', LINK_ID), link({ status: 'confirmed', confirmedAt: T0, confirmedBy: 'user' }), { merge: true })
    );
  });

  it('rejects a link — the suppression record', async () => {
    await assertSucceeds(updateDoc(doc(asAlice(), 'users', ALICE, 'links', LINK_ID), { status: 'rejected', updatedAt: T0 }));
  });

  it('creates a review candidate (saveReviewCandidate)', async () => {
    const id = 'duplicate_subscription~txnSynthC~txnSynthD';
    await assertSucceeds(
      setDoc(doc(asAlice(), 'users', ALICE, 'reviewCandidates', id), candidate({
        candidateType: 'duplicate_subscription', transactionIds: ['txnSynthC', 'txnSynthD'],
      }), { merge: true })
    );
  });

  it('records a decision on an EXISTING candidate (recordCandidateDecision merge)', async () => {
    // merge onto an existing doc: request.resource.data is the MERGED result, so the
    // required keys are still present even though this write only carries four fields.
    await assertSucceeds(
      setDoc(doc(asAlice(), 'users', ALICE, 'reviewCandidates', CAND_ID), {
        status: 'dismissed', reviewedBy: 'user', reviewedAt: T0, linkIds: [LINK_ID],
      }, { merge: true })
    );
  });

  it('creates and retires a service family', async () => {
    await assertSucceeds(setDoc(doc(asAlice(), 'users', ALICE, 'serviceFamilies', 'fam2'), family()));
    await assertSucceeds(deleteDoc(doc(asAlice(), 'users', ALICE, 'serviceFamilies', 'fam1')));
  });

  it('reads and writes their own budgets', async () => {
    await assertSucceeds(getDoc(doc(asAlice(), 'users', ALICE, 'budgets', 'b1')));
    await assertSucceeds(setDoc(doc(asAlice(), 'users', ALICE, 'budgets', 'b2'), { monthlyLimit: 1 }));
  });

  // ---- Legitimate operations the rules WRONGLY refuse -----------------------

  it('BUG A: the account payload the app actually writes is REJECTED', async () => {
    // src/lib/firestore.ts FirestoreAccount has `openingBalance`; the rule demands a
    // `balance` key that NOTHING in the codebase ever writes. Every account create
    // in the app is denied by these rules.
    await assertFails(setDoc(doc(asAlice(), 'users', ALICE, 'accounts', 'accNew'), accountPerApp()));
  });

  it('BUG B: a personal_loan account is REJECTED even with the rules-shaped payload', async () => {
    // AccountType includes 'personal_loan' and src/app/onboarding/page.tsx creates one.
    // The rule's type allowlist omits it.
    await assertFails(
      setDoc(doc(asAlice(), 'users', ALICE, 'accounts', 'accLoan'), accountPerRules({ type: 'personal_loan' }))
    );
  });

  it('BUG C: plannedTransactions is unreachable — no match block, deny-all catches it', async () => {
    // src/components/PlannedPaymentsPanel.tsx reads and writes this collection.
    await assertFails(getDocs(collection(asAlice(), 'users', ALICE, 'plannedTransactions')));
    await assertFails(getDoc(doc(asAlice(), 'users', ALICE, 'plannedTransactions', 'pt1')));
    await assertFails(
      setDoc(doc(asAlice(), 'users', ALICE, 'plannedTransactions', 'pt2'), { title: 'Synthetic Planned', amount: 1, status: 'pending' })
    );
  });

  it('BUG C: goals and reminders are unreachable too (deleteAllUserData sweeps them)', async () => {
    for (const c of ['goals', 'reminders']) {
      await assertFails(getDocs(collection(asAlice(), 'users', ALICE, c)));
      await assertFails(setDoc(doc(asAlice(), 'users', ALICE, c, 'x'), { name: 'Synthetic' }));
    }
  });

  it('an account create DOES succeed with the shape the rules demand', async () => {
    // Proves the rest of the account rule is sane, and isolates BUG A to the key name.
    await assertSucceeds(setDoc(doc(asAlice(), 'users', ALICE, 'accounts', 'accOk'), accountPerRules()));
  });
});

// ===========================================================================
// 5. Field-level invariants the rules claim to enforce
// ===========================================================================

describe('5a. profile invariants', () => {
  it('create requires uid/email/displayName/settings/metadata', async () => {
    await testEnv.clearFirestore();
    const { metadata, ...missing } = profile(ALICE);
    await assertFails(setDoc(doc(asAlice(), 'users', ALICE), missing));
  });

  it('create refuses a uid that is not the caller', async () => {
    await testEnv.clearFirestore();
    await assertFails(setDoc(doc(asAlice(), 'users', ALICE), profile(BOB)));
  });

  it('update cannot change uid', async () => {
    await assertFails(updateDoc(doc(asAlice(), 'users', ALICE), { uid: BOB }));
  });
});

describe('5b. account invariants', () => {
  const at = (id) => doc(asAlice(), 'users', ALICE, 'accounts', id);

  it('refuses a missing required key', async () => {
    const { isActive, ...missing } = accountPerRules();
    await assertFails(setDoc(at('a1'), missing));
  });

  it('refuses an unknown type', async () => {
    await assertFails(setDoc(at('a2'), accountPerRules({ type: 'crypto_wallet' })));
  });

  it('refuses an empty name', async () => {
    await assertFails(setDoc(at('a3'), accountPerRules({ name: '' })));
  });

  it('refuses a name over 100 chars', async () => {
    await assertFails(setDoc(at('a4'), accountPerRules({ name: 'S'.repeat(101) })));
  });

  it('refuses a non-numeric balance', async () => {
    await assertFails(setDoc(at('a5'), accountPerRules({ balance: '0' })));
  });

  it('accepts a negative balance (debt is owed, not invalid)', async () => {
    await assertSucceeds(setDoc(at('a6'), accountPerRules({ balance: -100 })));
  });
});

describe('5c. income invariants', () => {
  const at = (id) => doc(asAlice(), 'users', ALICE, 'income', id);

  it('refuses a missing required key', async () => {
    const { frequency, ...missing } = income();
    await assertFails(setDoc(at('i1'), missing));
  });

  it('refuses an unknown frequency', async () => {
    await assertFails(setDoc(at('i2'), income({ frequency: 'quarterly' })));
  });

  it('refuses an empty name', async () => {
    await assertFails(setDoc(at('i3'), income({ name: '' })));
  });

  it('refuses a non-numeric amount', async () => {
    await assertFails(setDoc(at('i4'), income({ amount: '1000' })));
  });
});

describe('5d. transaction invariants', () => {
  const at = (id) => doc(asAlice(), 'users', ALICE, 'transactions', id);

  it('refuses a missing required key', async () => {
    const { paymentMethod, ...missing } = txn();
    await assertFails(setDoc(at('t1'), missing));
  });

  it('refuses a negative amount', async () => {
    await assertFails(setDoc(at('t2'), txn({ amount: -1 })));
  });

  it('refuses an unknown type', async () => {
    await assertFails(setDoc(at('t3'), txn({ type: 'refund' })));
  });

  it('refuses an empty title', async () => {
    await assertFails(setDoc(at('t4'), txn({ title: '' })));
  });

  it('refuses a title over 200 chars', async () => {
    await assertFails(setDoc(at('t5'), txn({ title: 'S'.repeat(201) })));
  });

  it('refuses a non-numeric amount', async () => {
    await assertFails(setDoc(at('t6'), txn({ amount: '12.34' })));
  });

  it('HOLE: update re-validates nothing — a negative amount lands via update', async () => {
    // `allow update: if isOwner(userId)` only. The create-time amount >= 0 invariant,
    // the type allowlist and the title bound are all bypassable in one write.
    await assertSucceeds(
      updateDoc(at('txnSynthA'), { amount: -999999, type: 'not_a_type', title: 'S'.repeat(5000) })
    );
  });
});

describe('5e. mapping rule invariants', () => {
  const at = (id) => doc(asAlice(), 'users', ALICE, 'rules', id);

  it('refuses a missing required key', async () => {
    const { enabled, ...missing } = mappingRule();
    await assertFails(setDoc(at('r1'), missing));
  });

  it('refuses an unknown match.field', async () => {
    await assertFails(setDoc(at('r2'), mappingRule({ match: { field: 'category', op: 'contains', value: 'x' } })));
  });

  it('refuses an unknown match.op', async () => {
    await assertFails(setDoc(at('r3'), mappingRule({ match: { field: 'merchant', op: 'regex', value: 'x' } })));
  });

  it('refuses an EMPTY match.value — it would rewrite every row the user owns', async () => {
    await assertFails(setDoc(at('r4'), mappingRule({ match: { field: 'merchant', op: 'contains', value: '' } })));
  });

  it('refuses a match.value over 200 chars', async () => {
    await assertFails(setDoc(at('r5'), mappingRule({ match: { field: 'merchant', op: 'contains', value: 'S'.repeat(201) } })));
  });

  it('refuses a non-boolean enabled', async () => {
    await assertFails(setDoc(at('r6'), mappingRule({ enabled: 'yes' })));
  });

  it('HOLE: update re-validates nothing — an empty needle lands via update', async () => {
    await assertSucceeds(
      updateDoc(at('rule1'), { match: { field: 'merchant', op: 'contains', value: '' } })
    );
  });
});

describe('5f. inflow review invariants', () => {
  const at = (id) => doc(asAlice(), 'users', ALICE, 'reviews', id);

  it('refuses an unknown state', async () => {
    await assertFails(setDoc(at('txnSynthB'), review('txnSynthB', { state: 'maybe' })));
  });

  it('refuses a transactionId that is not the doc id', async () => {
    await assertFails(setDoc(at('txnSynthB'), review('txnSynthA')));
  });

  it('refuses an unknown source', async () => {
    await assertFails(setDoc(at('txnSynthB'), review('txnSynthB', { source: 'model' })));
  });

  it('refuses a merge that would leave the doc without state', async () => {
    await assertFails(setDoc(at('txnSynthC'), { transactionId: 'txnSynthC', source: 'user' }, { merge: true }));
  });
});

describe('5g. transaction link invariants', () => {
  const at = (id) => doc(asAlice(), 'users', ALICE, 'links', id);

  it('refuses a missing required key', async () => {
    const { algorithmVersion, ...missing } = link();
    await assertFails(setDoc(at('refund_of~a~b'), missing));
  });

  it('refuses a self-link', async () => {
    await assertFails(setDoc(at('refund_of~a~a'), link({ sourceTransactionId: 'a', targetTransactionId: 'a' })));
  });

  it('refuses an unknown linkType', async () => {
    await assertFails(setDoc(at('bribe_for~a~b'), link({ linkType: 'bribe_for', sourceTransactionId: 'a', targetTransactionId: 'b' })));
  });

  it('refuses an unknown status', async () => {
    await assertFails(setDoc(at('refund_of~a~b'), link({ sourceTransactionId: 'a', targetTransactionId: 'b', status: 'maybe' })));
  });

  it('refuses a FLOAT allocation — this is how a ledger drifts', async () => {
    await assertFails(setDoc(at('refund_of~a~b'), link({ sourceTransactionId: 'a', targetTransactionId: 'b', allocatedAmountCents: 12.34 })));
  });

  it('refuses a zero allocation', async () => {
    await assertFails(setDoc(at('refund_of~a~b'), link({ sourceTransactionId: 'a', targetTransactionId: 'b', allocatedAmountCents: 0 })));
  });

  it('refuses a negative allocation', async () => {
    await assertFails(setDoc(at('refund_of~a~b'), link({ sourceTransactionId: 'a', targetTransactionId: 'b', allocatedAmountCents: -1 })));
  });

  it('refuses an empty sourceTransactionId', async () => {
    await assertFails(setDoc(at('refund_of~~b'), link({ sourceTransactionId: '', targetTransactionId: 'b' })));
  });

  it('UPDATE re-asserts every create invariant: linkType is immutable', async () => {
    await assertFails(updateDoc(at(LINK_ID), { linkType: 'chargeback_for' }));
  });

  it('UPDATE re-asserts every create invariant: the endpoints are immutable', async () => {
    await assertFails(updateDoc(at(LINK_ID), { sourceTransactionId: 'somethingElse' }));
    await assertFails(updateDoc(at(LINK_ID), { targetTransactionId: 'somethingElse' }));
  });

  it('UPDATE re-asserts every create invariant: no float, no zero, no bad status', async () => {
    await assertFails(updateDoc(at(LINK_ID), { allocatedAmountCents: 12.5 }));
    await assertFails(updateDoc(at(LINK_ID), { allocatedAmountCents: 0 }));
    await assertFails(updateDoc(at(LINK_ID), { status: 'maybe' }));
  });

  it('DELETE is denied outright — a rejected link is the suppression record', async () => {
    await assertFails(deleteDoc(at(LINK_ID)));
  });
});

describe('5h. review candidate invariants', () => {
  const at = (id) => doc(asAlice(), 'users', ALICE, 'reviewCandidates', id);

  it('refuses a missing required key', async () => {
    const { score, ...missing } = candidate();
    await assertFails(setDoc(at('refund_match~a~b'), missing));
  });

  it('refuses an unknown candidateType', async () => {
    await assertFails(setDoc(at('vibes~a~b'), candidate({ candidateType: 'vibes' })));
  });

  it('refuses an unknown status', async () => {
    await assertFails(setDoc(at('refund_match~a~b'), candidate({ status: 'maybe' })));
  });

  it('refuses fewer than 2 transaction ids', async () => {
    await assertFails(setDoc(at('refund_match~a'), candidate({ transactionIds: ['a'] })));
  });

  it('refuses more than 13 transaction ids', async () => {
    const ids = Array.from({ length: 14 }, (_, i) => `txnSynth${i}`);
    await assertFails(setDoc(at('refund_match~many'), candidate({ transactionIds: ids })));
  });

  it('accepts exactly 13 transaction ids (the boundary)', async () => {
    const ids = Array.from({ length: 13 }, (_, i) => `txnSynth${i}`);
    await assertSucceeds(setDoc(at('refund_match~thirteen'), candidate({ transactionIds: ids })));
  });

  it('refuses a non-list transactionIds', async () => {
    await assertFails(setDoc(at('refund_match~a~b'), candidate({ transactionIds: 'a,b' })));
  });

  it('refuses a decision merge onto a candidate that does not exist yet', async () => {
    await assertFails(
      setDoc(at('refund_match~ghost1~ghost2'), { status: 'dismissed', reviewedBy: 'user', reviewedAt: T0 }, { merge: true })
    );
  });

  it('DELETE is denied outright — a decision is a record', async () => {
    await assertFails(deleteDoc(at(CAND_ID)));
  });
});

describe('5i. service family invariants', () => {
  const at = (id) => doc(asAlice(), 'users', ALICE, 'serviceFamilies', id);

  it('refuses a missing required key', async () => {
    const { aliases, ...missing } = family();
    await assertFails(setDoc(at('f1'), missing));
  });

  it('refuses an empty label', async () => {
    await assertFails(setDoc(at('f2'), family({ label: '' })));
  });

  it('refuses a label over 100 chars', async () => {
    await assertFails(setDoc(at('f3'), family({ label: 'S'.repeat(101) })));
  });

  it('refuses more than 50 aliases', async () => {
    await assertFails(setDoc(at('f4'), family({ aliases: Array.from({ length: 51 }, (_, i) => `syntheticsvc${i}`) })));
  });

  it('refuses a non-list aliases', async () => {
    await assertFails(setDoc(at('f5'), family({ aliases: 'syntheticsvc' })));
  });
});
