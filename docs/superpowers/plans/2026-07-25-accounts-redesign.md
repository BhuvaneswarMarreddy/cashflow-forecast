# Accounts Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give accounts a user-defined drag-drop order (persisted), and replace manually-maintained balances with a dated opening-balance anchor + automatic derivation + a reconcile flow.

**Architecture:** Two independent features. **Ordering** stores a per-account `sortIndex` (batch-written, client-sorted). **Balances** rename `balance`→`openingBalance`, add `openingDate`, derive current balance in memory (`openingBalance ± net of transactions dated ≥ openingDate`), and add a per-account Reconcile action that re-anchors. Reconciliation stays the *independent sensor* that keeps the Flow page's missing-rows detector alive.

**Tech Stack:** Next.js 16, React 19, TypeScript, Firebase/Firestore, jest, dnd-kit, date-fns.

**Spec:** `docs/superpowers/specs/2026-07-25-accounts-redesign-design.md` — read it first.

## Global Constraints
- Branch: create `feat/accounts-redesign` off `feat/transfer-type-monarch-ingest`. Commit per task. **Never push** — the owner pushes.
- Deploy only via `npm run deploy` (gate: tsc + full jest + react-hooks scan). Never bypass.
- Money math in **integer cents** where summing ledgers; dollars only at render.
- Date comparisons are `yyyy-MM-dd` string compares (`t.date.split('T')[0]`), never Date instants (IST timezone).
- The 232 existing tests must stay green after every task: `npm test`.
- **Ordering (Phase A) ships first and has zero dependency on the balance work.**
- Reconcile is **anchor-only** (Phase C). Audit-mode adjustment rows are Phase D — do not build unless asked.
- Migration anchors every account at **today**, never earliest-transaction.

## File map
- `src/types/index.ts` — `PaymentAccount`: rename `balance`→`openingBalance`, add `openingDate`, `sortIndex?`; add derived `currentBalance?`.
- `src/lib/firestore.ts` — `FirestoreAccount` same field changes; `getAccounts` unchanged (client-sorts).
- `src/lib/forecast.ts` — `deriveAccountBalance` (openingDate gate), `withDerivedBalances` (un-neuter, attach `currentBalance`).
- `src/lib/accounts.ts` (NEW) — `sortAccounts`, `reindex`, `reconcile` pure helpers.
- `src/context/UserProfileContext.tsx` — `reorderPaymentAccounts`, `reconcileAccount`; memoize derived accounts.
- `src/components/Navbar.tsx` — use memoized derived accounts (perf).
- `src/components/AccountsList.tsx` (NEW) — dnd-kit sortable list extracted from the accounts page.
- `src/app/accounts/page.tsx` — use `AccountsList`; Reconcile button replaces "set balance".
- `src/context/TransactionContext.tsx` — two-leg delete guard.
- `scripts/migrate_opening_balance.py` (NEW) — one-time anchor migration.
- Tests: `src/__tests__/accounts.test.ts`, `src/__tests__/derive-balance.test.ts`.

---

# PHASE A — Drag-and-drop ordering (ship first)

### Task A1: `sortIndex` on types + `sortAccounts`/`reindex` helpers

**Files:**
- Modify: `src/types/index.ts` (PaymentAccount), `src/lib/firestore.ts` (FirestoreAccount)
- Create: `src/lib/accounts.ts`, `src/__tests__/accounts.test.ts`

**Interfaces:**
- Produces: `sortAccounts(accounts): PaymentAccount[]`, `reindex(orderedIds, accounts): Array<{id, sortIndex}>`.

- [ ] **Step 1: Add the field to both types**

In `src/types/index.ts`, in `PaymentAccount` after `isActive: boolean;` add:
```ts
  sortIndex?: number; // user-defined display order; undefined sorts to the end
```
In `src/lib/firestore.ts`, in `FirestoreAccount` after `isActive: boolean;` add the same line.

- [ ] **Step 2: Write the failing test** — create `src/__tests__/accounts.test.ts`:

```ts
import { PaymentAccount } from '@/types';
import { sortAccounts, reindex } from '@/lib/accounts';

const a = (o: Partial<PaymentAccount> & { id: string }): PaymentAccount => ({
  name: o.id, type: 'bank_account', provider: 'chase', openingBalance: 0,
  openingDate: '2026-01-01', color: '#000', isActive: true, ...o,
} as PaymentAccount);

describe('sortAccounts', () => {
  it('orders by sortIndex, undefined to the end tie-broken by name', () => {
    const out = sortAccounts([
      a({ id: 'z', sortIndex: 2 }), a({ id: 'a' }), a({ id: 'm', sortIndex: 0 }), a({ id: 'b' }),
    ]);
    expect(out.map((x) => x.id)).toEqual(['m', 'z', 'a', 'b']);
  });
});

describe('reindex', () => {
  it('assigns contiguous indices in the given id order, skipping unknown ids', () => {
    const accts = [a({ id: 'a' }), a({ id: 'b' }), a({ id: 'c' })];
    expect(reindex(['c', 'a', 'b'], accts)).toEqual([
      { id: 'c', sortIndex: 0 }, { id: 'a', sortIndex: 1 }, { id: 'b', sortIndex: 2 },
    ]);
    expect(reindex(['c', 'ghost', 'a'], accts).map((x) => x.id)).toEqual(['c', 'a']);
  });
});
```

Note: the test already uses `openingBalance`/`openingDate` — those fields land in Task B1. To keep Phase A independent, in **this** task add them as optional in the helper cast only; the real rename is B1. Simplest: in `src/types/index.ts` this task, ALSO add `openingBalance?: number; openingDate?: string;` as optional additions (keep existing `balance` for now). B1 completes the rename. This lets Phase A compile and ship first.

- [ ] **Step 3: Run to verify fail** — `npx jest accounts.test` → FAIL (`@/lib/accounts` missing).

- [ ] **Step 4: Implement** — create `src/lib/accounts.ts`:

```ts
import { PaymentAccount } from '@/types';

const BIG = Number.MAX_SAFE_INTEGER;

/** Stable order: sortIndex asc; undefined sorts to the end; ties broken by name. */
export function sortAccounts(accounts: PaymentAccount[]): PaymentAccount[] {
  return [...accounts].sort((x, y) => {
    const ix = x.sortIndex ?? BIG, iy = y.sortIndex ?? BIG;
    return ix !== iy ? ix - iy : x.name.localeCompare(y.name);
  });
}

/** New contiguous sortIndex for each id in orderedIds that exists in accounts. */
export function reindex(orderedIds: string[], accounts: PaymentAccount[]): Array<{ id: string; sortIndex: number }> {
  const known = new Set(accounts.map((a) => a.id));
  return orderedIds.filter((id) => known.has(id)).map((id, i) => ({ id, sortIndex: i }));
}
```

- [ ] **Step 5: Run to verify pass** — `npx jest accounts.test` → PASS.

- [ ] **Step 6: Commit**
```bash
git checkout -b feat/accounts-redesign   # first task only
git add src/types/index.ts src/lib/firestore.ts src/lib/accounts.ts src/__tests__/accounts.test.ts
git commit -m "feat: sortIndex field + sortAccounts/reindex helpers"
```

---

### Task A2: `reorderPaymentAccounts` context method (optimistic + batch write)

**Files:**
- Modify: `src/context/UserProfileContext.tsx`, `src/lib/firestore.ts`

**Interfaces:**
- Consumes: `reindex` (A1).
- Produces: context `reorderPaymentAccounts(orderedIds: string[]): Promise<void>`; `firestoreService.updateAccountsBatch(userId, updates: Array<{id, sortIndex}>)`.

- [ ] **Step 1: Add the batch writer** — in `src/lib/firestore.ts`, near `updateAccount`, add:

```ts
export async function updateAccountsBatch(
  userId: string,
  updates: Array<{ id: string; sortIndex: number }>
): Promise<void> {
  if (updates.length === 0) return;
  const batch = writeBatch(db);
  for (const u of updates) {
    batch.update(doc(db, 'users', userId, 'accounts', u.id), { sortIndex: u.sortIndex, updatedAt: serverTimestamp() });
  }
  await batch.commit();
}
```
Ensure `writeBatch` is imported from `firebase/firestore` (add to the existing import if missing).

- [ ] **Step 2: Add the context method** — in `UserProfileContext.tsx`, after `updatePaymentAccount` (~line 324), add:

```ts
  const reorderPaymentAccounts = async (orderedIds: string[]) => {
    if (!profile || !user?.id) return;
    const prev = profile.paymentAccounts;
    const byId = new Map(prev.map((a) => [a.id, a]));
    const reordered = orderedIds.map((id) => byId.get(id)).filter(Boolean) as typeof prev;
    const updates = reindex(orderedIds, prev);
    const withIdx = reordered.map((a, i) => ({ ...a, sortIndex: i }));
    const next = { ...profile, paymentAccounts: withIdx };
    setProfile(next);
    saveLocalProfile(user.id, next);
    try {
      await firestoreService.updateAccountsBatch(user.id, updates);
      setIsFirestoreOnline(true);
    } catch (err) {
      console.error('Failed to persist account order:', err);
      setIsFirestoreOnline(false);
      // offline is tolerated (local order persists); only roll back a real failure
      if (!(err as { code?: string })?.code?.includes('unavailable')) {
        setProfile({ ...profile, paymentAccounts: prev });
        saveLocalProfile(user.id, { ...profile, paymentAccounts: prev });
      }
    }
  };
```
Add `reorderPaymentAccounts` to the context type (line ~13-20), import `reindex` from `@/lib/accounts`, and add it to the Provider `value` (~line 459).

- [ ] **Step 3: Sort on read** — in `syncFromFirestore`, where `paymentAccounts: accounts` is set into `fullProfile` (~line 103), wrap with `sortAccounts(accounts)`; import `sortAccounts`. Do the same in the `seeded` profile branch (~line 127).

- [ ] **Step 4: Verify** — `npx tsc --noEmit` clean; `npm test` green (232).

- [ ] **Step 5: Commit**
```bash
git add src/context/UserProfileContext.tsx src/lib/firestore.ts
git commit -m "feat: reorderPaymentAccounts — optimistic reorder + batch sortIndex write"
```

---

### Task A3: dnd-kit sortable Accounts list (desktop + mobile + keyboard)

**Files:**
- Create: `src/components/AccountsList.tsx`
- Modify: `src/app/accounts/page.tsx:430-520` (replace the `profile.paymentAccounts.map(...)` account rows with `<AccountsList>`), `package.json`

**Interfaces:**
- Consumes: `reorderPaymentAccounts` (A2), `sortAccounts` (A1).

- [ ] **Step 1: Install dnd-kit**
```bash
npm install @dnd-kit/core @dnd-kit/sortable @dnd-kit/modifiers
```
Expected: three packages added, no peer-dep errors on React 19.

- [ ] **Step 2: Create `src/components/AccountsList.tsx`**

```tsx
'use client';
import React from 'react';
import { DndContext, PointerSensor, KeyboardSensor, useSensor, useSensors, closestCenter, DragOverlay } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, useSortable, sortableKeyboardCoordinates, arrayMove } from '@dnd-kit/sortable';
import { restrictToVerticalAxis, restrictToParentElement } from '@dnd-kit/modifiers';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical } from 'lucide-react';
import { PaymentAccount } from '@/types';

function Row({ account, index, count, render }: {
  account: PaymentAccount; index: number; count: number;
  render: (a: PaymentAccount) => React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: account.id });
  return (
    <div ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }}
      className="flex items-stretch gap-2">
      <button
        {...attributes} {...listeners}
        aria-label={`Reorder ${account.name}, currently ${index + 1} of ${count}`}
        className="flex items-center px-1 text-[var(--foreground-muted)] hover:text-[var(--foreground)] cursor-grab active:cursor-grabbing rounded-md"
        style={{ touchAction: 'none', WebkitTouchCallout: 'none', userSelect: 'none' }}>
        <GripVertical className="w-4 h-4" />
      </button>
      <div className="flex-1">{render(account)}</div>
    </div>
  );
}

export default function AccountsList({ accounts, onReorder, renderRow }: {
  accounts: PaymentAccount[];
  onReorder: (orderedIds: string[]) => void;
  renderRow: (a: PaymentAccount) => React.ReactNode;
}) {
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(PointerSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  if (accounts.length < 2) return <div className="space-y-3">{accounts.map((a) => <div key={a.id}>{renderRow(a)}</div>)}</div>;
  const ids = accounts.map((a) => a.id);
  const active = accounts.find((a) => a.id === activeId) || null;
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis, restrictToParentElement]}
      onDragStart={(e) => setActiveId(String(e.active.id))}
      onDragEnd={(e) => {
        setActiveId(null);
        const { active, over } = e;
        if (over && active.id !== over.id) {
          onReorder(arrayMove(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id))));
        }
      }}
      onDragCancel={() => setActiveId(null)}
      accessibility={{ announcements: {
        onDragStart: ({ active }) => `Picked up ${active.id}`,
        onDragOver: ({ active, over }) => over ? `${active.id} moved over ${over.id}` : '',
        onDragEnd: ({ active, over }) => over ? `Dropped ${active.id} onto ${over.id}` : `Dropped ${active.id}`,
        onDragCancel: ({ active }) => `Reorder of ${active.id} cancelled`,
      } }}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <div className="space-y-3">
          {accounts.map((a, i) => <Row key={a.id} account={a} index={i} count={accounts.length} render={renderRow} />)}
        </div>
      </SortableContext>
      <DragOverlay>{active ? <div className="opacity-90 scale-[1.02]">{renderRow(active)}</div> : null}</DragOverlay>
    </DndContext>
  );
}
```

- [ ] **Step 3: Wire into the accounts page** — in `src/app/accounts/page.tsx`, import `AccountsList` and `reorderPaymentAccounts` (from `useUserProfile()`). Replace the account-rows `{profile.paymentAccounts.map((account) => ( … ))}` block (~430-520) with:
```tsx
<AccountsList
  accounts={profile.paymentAccounts}
  onReorder={reorderPaymentAccounts}
  renderRow={(account) => ( /* the existing single-account row JSX, unchanged */ )}
/>
```
Move the existing per-account row markup verbatim into `renderRow`.

- [ ] **Step 4: Reduced-motion** — in `src/app/globals.css` append:
```css
@media (prefers-reduced-motion: reduce) { [data-dnd-draggable] { transition: none !important; } }
```

- [ ] **Step 5: Build + manual check**

Run: `npx tsc --noEmit && npm test && npm run build` → all green.
Manual (`npm run dev`, `/accounts`):
- Drag a handle on desktop → row moves, others slide, order persists after reload.
- Mobile emulation: quick swipe scrolls; long-press then drag reorders.
- Keyboard: Tab to a handle, Space, ArrowDown, Space → row moved; Esc mid-drag cancels.
- Single account: no handles, no crash.

- [ ] **Step 6: Commit**
```bash
git add src/components/AccountsList.tsx src/app/accounts/page.tsx src/app/globals.css package.json package-lock.json
git commit -m "feat: drag-and-drop account ordering (dnd-kit, keyboard + touch + SR)"
```

**→ Phase A is independently shippable here. Deploy with `npm run deploy` if desired.**

---

# PHASE B — Balance schema + derivation

### Task B1: rename `balance`→`openingBalance`, add `openingDate`; derive-balance tests

**Files:**
- Modify: `src/types/index.ts`, `src/lib/firestore.ts`
- Create: `src/__tests__/derive-balance.test.ts`

**Interfaces:**
- Produces: `PaymentAccount.openingBalance: number`, `.openingDate: string`, derived `.currentBalance?: number`.

- [ ] **Step 1: Change the types.** In `src/types/index.ts` `PaymentAccount`: replace `balance: number;` with:
```ts
  openingBalance: number;   // balance AT openingDate (cash +, debt = amount owed)
  openingDate: string;      // ISO yyyy-MM-dd; net is summed from here forward
  currentBalance?: number;  // DERIVED in memory by withDerivedBalances; never stored
```
Remove the `openingBalance?`/`openingDate?` optional lines added in A1 (now required). In `src/lib/firestore.ts` `FirestoreAccount`: replace `balance: number;` with `openingBalance: number;` and add `openingDate: string;` (do NOT add `currentBalance` — never stored).

- [ ] **Step 2: Write the failing test** — `src/__tests__/derive-balance.test.ts`:

```ts
import { PaymentAccount, Transaction } from '@/types';
import { deriveAccountBalance } from '@/lib/forecast';

const acct = (o: Partial<PaymentAccount> & { id: string }): PaymentAccount => ({
  name: o.id, type: 'bank_account', provider: 'chase', openingBalance: 0,
  openingDate: '2026-01-01', color: '#000', isActive: true, ...o,
} as PaymentAccount);
const tx = (o: Partial<Transaction> & { id: string; amount: number }): Transaction => ({
  title: o.id, type: 'expense', category: 'other', paymentMethod: 'bank-transfer',
  date: '2026-02-01', ...o,
} as Transaction);

describe('deriveAccountBalance with opening anchor', () => {
  const bank = acct({ id: 'b', openingBalance: 1000, openingDate: '2026-02-01' });
  it('cash: opening + net of rows dated >= openingDate', () => {
    const txns = [
      tx({ id: 'i', amount: 200, type: 'income', accountId: 'b', date: '2026-02-10' }),
      tx({ id: 'e', amount: 50, type: 'expense', accountId: 'b', date: '2026-02-11' }),
      tx({ id: 'old', amount: 999, type: 'expense', accountId: 'b', date: '2026-01-15' }), // pre-anchor, ignored
    ];
    expect(deriveAccountBalance(bank, txns)).toBe(1000 + 200 - 50);
  });
  it('debt: opening - net; a payment lowers owed, a purchase raises it', () => {
    const card = acct({ id: 'c', type: 'credit_card', provider: 'amex', openingBalance: 500, openingDate: '2026-02-01' });
    const txns = [
      tx({ id: 'buy', amount: 100, type: 'expense', accountId: 'c', date: '2026-02-05' }),
      tx({ id: 'pay', amount: 300, type: 'transfer', transferDirection: 'in', accountId: 'c', date: '2026-02-06' }),
    ];
    // owed = 500 - (payment 300 - purchase 100) = 500 - 200 = 300
    expect(deriveAccountBalance(card, txns)).toBe(300);
  });
  it('debt can go negative (credit balance) and is not clamped', () => {
    const card = acct({ id: 'c', type: 'credit_card', provider: 'amex', openingBalance: 100, openingDate: '2026-02-01' });
    const txns = [tx({ id: 'pay', amount: 300, type: 'transfer', transferDirection: 'in', accountId: 'c', date: '2026-02-06' })];
    expect(deriveAccountBalance(card, txns)).toBe(-200);
  });
});
```

- [ ] **Step 3: Run to verify fail** — `npx jest derive-balance` → FAIL (still uses `account.balance`, and today ignores openingDate).

- [ ] **Step 4:** implemented in Task B2 (they share the forecast.ts edit). Proceed to B2, then return and run this test.

- [ ] **Step 5: Commit (types only)**
```bash
git add src/types/index.ts src/lib/firestore.ts src/__tests__/derive-balance.test.ts
git commit -m "refactor: openingBalance/openingDate fields + derive-balance tests (red)"
```

---

### Task B2: fix `deriveAccountBalance`, un-neuter+memoize `withDerivedBalances`, fix the rename fallout

**Files:**
- Modify: `src/lib/forecast.ts:39-66`, and every site the compiler flags.

- [ ] **Step 1: Rewrite `deriveAccountBalance`** (forecast.ts:39-54):

```ts
export function deriveAccountBalance(account: PaymentAccount, transactions: Transaction[]): number {
  const todayKey = format(new Date(), 'yyyy-MM-dd');
  const openingKey = account.openingDate || '0000-00-00';
  const isDebt = account.type === 'credit_card' || account.type === 'personal_loan';
  const net = transactions.reduce((sum, t) => {
    if (t.accountId !== account.id) return sum;
    const day = t.date.split('T')[0];
    if (day > todayKey) return sum;      // future = forecast
    if (day < openingKey) return sum;    // pre-anchor = already inside openingBalance
    return sum + (isPositive(t, [account]) ? t.amount : -t.amount);
  }, 0);
  const opening = account.openingBalance || 0;
  return isDebt ? opening - net : opening + net;
}
```

- [ ] **Step 2: Un-neuter + prepare to memoize** `withDerivedBalances` (forecast.ts:63):

```ts
/**
 * Attaches a DERIVED currentBalance to each account (openingBalance ± net since
 * openingDate). currentBalance is the everyday hero number; openingBalance/openingDate
 * are the stored anchor set by reconcile. Callers that show "current" read
 * currentBalance; callers that show/edit the anchor read openingBalance.
 * Callers must memoize — this is O(accounts x transactions).
 */
export function withDerivedBalances(accounts: PaymentAccount[], transactions: Transaction[]): PaymentAccount[] {
  return accounts.map((a) => ({ ...a, currentBalance: deriveAccountBalance(a, transactions) }));
}
```

- [ ] **Step 3: Run tsc, fix every flagged site by this rule.**

Run: `npx tsc --noEmit` — it lists every reader of the old `balance`. Apply:
- **Anchor semantics** (editing/showing the opening figure, migrations, forecast events that consume the opening): use `openingBalance`.
- **Current/hero balance** (net-worth tiles, the big number on a row, the Navbar total): use `currentBalance ?? openingBalance` on an account that came through `withDerivedBalances`.
Known sites (apply the rule, with code):
  - `src/lib/forecast.ts:942` `amount: -(account.balance || 0)` → `-(account.openingBalance || 0)`.
  - `src/lib/flows.ts:15` `signedRealNowCents`: keep reading the anchor — change `toCents(a.balance)` → `toCents(a.currentBalance ?? a.openingBalance)` (Flow reconciliation compares the derived current against summed transactions; using currentBalance keeps net worth right, and reconcile drift remains the independent signal).
  - `src/components/Navbar.tsx:58` — see Step 4 (memoize).
  - `src/app/accounts/page.tsx:481` big number → `account.currentBalance ?? account.openingBalance`; `:153` edit form seed → `account.openingBalance`; `:487` the "set balance to est" button is removed in Phase C (leave until then or stub `openingBalance: est`).
  - Any `AddTransactionModal`/onboarding writes that set `balance:` on a new account → set `openingBalance` + `openingDate: format(new Date(),'yyyy-MM-dd')`.

- [ ] **Step 4: Memoize the two hottest callers.**
  - `Navbar.tsx:56-62`: wrap in `useMemo`:
    ```ts
    const totalBalance = React.useMemo(() =>
      withDerivedBalances(profile?.paymentAccounts || [], transactions).reduce((sum, acc) =>
        (acc.type === 'credit_card' || acc.type === 'personal_loan')
          ? sum - (acc.currentBalance ?? acc.openingBalance)
          : sum + (acc.currentBalance ?? acc.openingBalance), 0),
      [profile?.paymentAccounts, transactions]);
    ```
  - `accounts/page.tsx:302` `derivedAccounts` → wrap in `useMemo(() => withDerivedBalances(profile?.paymentAccounts || [], transactions), [profile?.paymentAccounts, transactions])`.

- [ ] **Step 5: Run derive-balance test + full suite** — `npx jest derive-balance` PASS; `npm test` 232+ green; `npx tsc --noEmit` clean; `npm run build` succeeds.

- [ ] **Step 6: Commit**
```bash
git add -A src/lib/forecast.ts src/lib/flows.ts src/components/Navbar.tsx src/app/accounts/page.tsx
git commit -m "feat: derive current balance from openingBalance + dated net (memoized)"
```

---

### Task B3: one-time anchor migration

**Files:**
- Create: `scripts/migrate_opening_balance.py`

- [ ] **Step 1: Write the migration** (mirrors `scripts/fsadmin.py` helpers — `find_uid`, `list_sub`, `commit`, `NAMEBASE`):

```python
#!/usr/bin/env python3
"""One-time: anchor every account at TODAY. openingBalance = current stored balance,
openingDate = today. Idempotent: skips accounts that already have openingDate."""
import sys, datetime
sys.path.insert(0, 'scripts')
from fsadmin import find_uid, list_sub, commit, NAMEBASE

EMAIL = 'bhuvaneswar.marreddy@gmail.com'
TODAY = datetime.date.today().isoformat()
APPLY = '--apply' in sys.argv

uid = find_uid(EMAIL)
accts = list_sub(uid, 'accounts')
writes = []
for d in accts:
    f = d['fields']
    if 'openingDate' in f:
        continue  # already anchored
    bal = f.get('balance', {})
    val = bal.get('doubleValue') or bal.get('integerValue') or 0
    name = d['name']
    writes.append({'update': {
        'name': name,
        'fields': {'openingBalance': {'doubleValue': float(val)}, 'openingDate': {'stringValue': TODAY}},
    }, 'updateMask': {'fieldPaths': ['openingBalance', 'openingDate']}})
    print(f"  anchor {f.get('name',{}).get('stringValue','?')}: openingBalance={val} openingDate={TODAY}")

print(f"\n{len(writes)} accounts to anchor" + ("" if APPLY else " (DRY RUN — pass --apply)"))
if APPLY and writes:
    commit(writes)
    print("done")
```
(If `fsadmin.commit`/`NAMEBASE` signatures differ, adapt — it must send a Firestore `:commit` with `update` writes carrying an `updateMask`.)

- [ ] **Step 2: Dry-run then apply**
```bash
firebase projects:list --non-interactive >/dev/null   # refresh token
python3 scripts/migrate_opening_balance.py             # dry run — inspect
python3 scripts/migrate_opening_balance.py --apply
```
Expected: each account prints `openingBalance=<its current balance> openingDate=<today>`; re-running shows `0 accounts to anchor`.

- [ ] **Step 3: Commit**
```bash
git add scripts/migrate_opening_balance.py
git commit -m "chore: one-time migration anchoring accounts at today's balance"
```

---

# PHASE C — Reconcile flow (anchor-only)

### Task C1: `reconcile` pure helper + tests

**Files:**
- Modify: `src/lib/accounts.ts`, `src/__tests__/accounts.test.ts`

**Interfaces:**
- Produces: `reconcile(account, enteredCurrent, derivedCurrent, todayISO): { driftCents, reanchor?: {openingBalance, openingDate} }`.

- [ ] **Step 1: Write the failing test** (append to `accounts.test.ts`):

```ts
import { reconcile } from '@/lib/accounts';
describe('reconcile', () => {
  const bank = a({ id: 'b', type: 'bank_account', openingBalance: 1000, openingDate: '2026-02-01' });
  it('no drift → no re-anchor', () => {
    expect(reconcile(bank, 1150, 1150, '2026-03-01')).toEqual({ driftCents: 0 });
  });
  it('drift → re-anchor to the entered balance at today', () => {
    const r = reconcile(bank, 1200, 1150, '2026-03-01');
    expect(r.driftCents).toBe(5000);
    expect(r.reanchor).toEqual({ openingBalance: 1200, openingDate: '2026-03-01' });
  });
});
```

- [ ] **Step 2: fail** — `npx jest accounts.test -t reconcile` → FAIL.

- [ ] **Step 3: Implement** (append to `src/lib/accounts.ts`):

```ts
export function reconcile(
  account: PaymentAccount, enteredCurrent: number, derivedCurrent: number, todayISO: string
): { driftCents: number; reanchor?: { openingBalance: number; openingDate: string } } {
  const driftCents = Math.round((enteredCurrent - derivedCurrent) * 100);
  if (driftCents === 0) return { driftCents: 0 };
  return { driftCents, reanchor: { openingBalance: enteredCurrent, openingDate: todayISO } };
}
```

- [ ] **Step 4: pass** — `npx jest accounts.test` → PASS.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: reconcile helper (drift + re-anchor)"`

---

### Task C2: `reconcileAccount` context method + Reconcile UI

**Files:**
- Modify: `src/context/UserProfileContext.tsx`, `src/app/accounts/page.tsx`

**Interfaces:**
- Consumes: `reconcile` (C1), `updatePaymentAccount` (existing), derived `currentBalance`.
- Produces: context `reconcileAccount(id, enteredCurrent): Promise<number>` (returns driftCents).

- [ ] **Step 1: Context method** — after `updatePaymentAccount`, add:

```ts
  const reconcileAccount = async (id: string, enteredCurrent: number): Promise<number> => {
    if (!profile) return 0;
    const acc = profile.paymentAccounts.find((a) => a.id === id);
    if (!acc) return 0;
    const derived = deriveAccountBalance(acc, transactions); // needs transactions in scope
    const today = format(new Date(), 'yyyy-MM-dd');
    const { driftCents, reanchor } = reconcile(acc, enteredCurrent, derived, today);
    if (reanchor) await updatePaymentAccount(id, reanchor);
    return driftCents;
  };
```
Import `reconcile` from `@/lib/accounts`, `deriveAccountBalance` from `@/lib/forecast`, `format` from `date-fns`; bring `transactions` into the provider (via `useTransactions()`), add `reconcileAccount` to the type and Provider value.

- [ ] **Step 2: Replace the "set balance" button with Reconcile** — in `accounts/page.tsx`, remove the `est`-based `updatePaymentAccount(account.id, { balance: est })` button (~485-487). In its place render a **Reconcile** button opening a small prompt/modal: input "Your real balance now", on submit call `reconcileAccount(account.id, value)`; toast `drift === 0 ? 'Reconciled — nothing changed' : 'Reconciled — balance updated'`. Show `openingDate` as "anchored {date}" and, if available, "last reconciled {n} days ago".

- [ ] **Step 3: Onboarding/add-account** — where new accounts are created, seed `openingBalance` = the balance the user types and `openingDate = format(new Date(),'yyyy-MM-dd')`.

- [ ] **Step 4: Verify** — `npx tsc --noEmit && npm test && npm run build` green. Manual: reconcile with a different number → balance jumps to it, openingDate = today; reconcile with the same number → "nothing changed".

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: per-account Reconcile action (re-anchor)"`

---

### Task C3: two-leg transfer delete guard

**Files:**
- Modify: `src/context/TransactionContext.tsx` (deleteTransaction), `src/lib/transfers.ts` (reuse `matchTransfers`)

- [ ] **Step 1: Test** — add to `src/__tests__/transfers.test.ts` a case: given two matched legs, a helper `pairedLegId(txId, transactions, accounts)` returns the counterpart id (or null).

```ts
import { pairedLegId } from '@/lib/transfers';
it('finds the counterpart leg of a matched transfer', () => {
  const accts = [/* two bank accounts */]; const txns = [/* out leg + in leg, matchable */];
  expect(pairedLegId('outLegId', txns, accts)).toBe('inLegId');
  expect(pairedLegId('nonTransferId', txns, accts)).toBeNull();
});
```

- [ ] **Step 2: fail** — `npx jest transfers -t counterpart` → FAIL.

- [ ] **Step 3: Implement `pairedLegId`** in `transfers.ts` using `matchTransfers`: find the pair containing `txId`, return the other leg's id, else null.

- [ ] **Step 4:** In `deleteTransaction` (TransactionContext), before deleting a row whose `classifyTransaction === 'transfer'`, call `pairedLegId`; if a counterpart exists, prompt "This is one leg of a transfer between your accounts. Delete both legs?" — on confirm delete both; on decline delete only the clicked one (document that this desyncs derived balances until reconcile).

- [ ] **Step 5: pass + suite** — `npm test` green.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat: warn/delete-both on removing one leg of a paired transfer"`

---

### Task C4: wire the Flow gap node to reconcile

**Files:**
- Modify: `src/app/flow/page.tsx` (reconciliation table / ⚠ rows)

- [ ] **Step 1:** In the "Does it add up?" table, for a row with `verdict === 'missing-rows'`, add a **Reconcile** button that calls `reconcileAccount(accountId, <prompted real balance>)`. Copy: "⚠ off by {gap} — reconcile to fix."
- [ ] **Step 2:** Verify manually on `/flow`; `npm test && npm run build` green.
- [ ] **Step 3: Commit** — `git add -A && git commit -m "feat: reconcile straight from the Flow missing-rows node"`

**→ Phase C shippable. Deploy via `npm run deploy`.**

---

# PHASE D — Audit-mode adjustments (DEFERRED — build only if owner asks)

Add `Transaction.isAdjustment?: boolean`; a reconcile option (b) that writes a dated
`recon_{accountId}_{date}` transaction closing the drift instead of re-anchoring; exclude
`isAdjustment` rows from every income/expense/budget/flow-category rollup (they are balance
truth, not spending) while still summing them into `deriveAccountBalance`. Not planned in
detail — revisit with its own tasks when prioritized.

---

## Plan Self-Review (applied)
- **Spec coverage:** ordering (A1–A3), store-vs-derive + memoize (B2 Step 4), CSV interaction (derivation is automatic — no code, covered by B2 + derive tests), reconcile/drift/re-anchor (C1–C2), opening/adjustments coexistence (anchor-only C; adjustments D), DB changes + migration (B1, B3), two-leg delete (C3), Flow wiring (C4), all ordering a11y/mobile/edge cases (A3), concurrency ceiling (accepted, A2 offline handling). Gap: none blocking; audit-mode intentionally deferred (D).
- **Type consistency:** `openingBalance`/`openingDate`/`currentBalance?`/`sortIndex?` used identically in A1, B1, B2, C1, C2; `reorderPaymentAccounts(orderedIds)`, `reconcileAccount(id, enteredCurrent)→driftCents`, `reconcile(...)→{driftCents,reanchor?}`, `sortAccounts`, `reindex`, `pairedLegId` names consistent across tasks.
- **Placeholders:** the rename sweep (B2 Step 3) is a mechanical refactor with an explicit decision rule + the known non-obvious sites in code; `renderRow` in A3 reuses the existing row JSX verbatim (not re-authored to avoid drift).
- **Ordering-first:** A1–A3 depend on nothing in B/C and are shippable alone (A1 adds `openingBalance?`/`openingDate?` as optional so Phase A compiles before B1 makes them required).
