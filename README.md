# CashFlow Forecast

A personal-finance application that answers one question honestly: **where did my money actually go, and what happens to me in the next 90 days?**

**Live:** https://marreddy-cashflow.web.app · **Licence:** MIT

Built and operated solo against my own real bank data — four institutions, ~1,800 transactions, two years of history. That constraint shapes every decision in here: when a number is wrong, I am the one who notices, and the fix has to be at the root rather than the symptom.

---

## The problem this codebase is really about

Personal-finance apps are easy to build and hard to make *true*. The same $1,200 credit-card payment can plausibly be read as spending, as a transfer, or as both — and if two screens read it differently, the app has quietly lied to its user.

Three defects from this project's history, each found by tracing a single number a user questioned:

| Symptom | Root cause | Fix |
|---|---|---|
| Spending read **$357,639.72** over two years | Bank-provided rows carried no notion of transfers, so every card payment counted as spending *and* as the purchases it settled | A transfer means movement **between the owner's own accounts** — nothing else — matched on the provider's *detailed* category, never its broad one |
| Earned income lost **half its value** | The first version of that fix trusted the provider's `TRANSFER_IN` label, which it also applies to payroll ACH credits | 18 of 36 paychecks recovered; mistyped inflows also stopped bypassing the review queue |
| Monthly income off by **$723/month** | The biweekly→monthly formula (×26÷12) was hand-copied across five screens and drifted | One `monthlyIncomeOf()`; five copies deleted |

The architecture below exists to make that class of bug structurally hard.

---

## Four ideas that hold the system together

### 1. Classification is derived on read, never stored

No transaction document ever gains a computed category, meaning, or type. Provider description, amount, id and posted date are immutable; the owner's decisions live *beside* the row in `users/{uid}/reviews/{txnId}`.

This means re-classifying two years of history is a code change, not a migration — and a test asserts the invariant directly, comparing rows byte-for-byte before and after classification runs.

### 2. One interpretation, one total

`interpretTransaction()` is the single answer to "what is this row", returning direction, ledger meaning, financial meaning, and an explicit `counted | excluded` treatment for *each* total — income, expense, forecast, budget. Omission is never accidental.

`sumIncomeCents()` and `sumExpenseCents()` are the only income and spending totals any screen may compute, in integer cents, posted rows only.

> Before this existed, Flow/Analytics/History used the classifier while Calendar/Dashboard/Budgets/Export read the stored type — so a credit-card payment was a transfer on one screen and *both income and expense* on another.

### 3. The app does not guess money into existence

A deposit becomes **earned income** only when it matches an approved income source the owner configured, or the owner confirmed it. Not because it is large, recurring, called "deposit", arrived by Zelle, landed near payday, or was tagged "Paychecks" by an importer.

Everything else is an `unknown_inflow`: **real cash that moves the balance and counts for nothing** in income analytics or forecasts, and appears in a review queue that asks. Two or more matching sources also resolve to unknown — *"yours to decide, not ours to guess."*

Provider categories suggest. `users/{uid}/income` is authoritative.

### 4. The model proposes; the application writes

Every AI action goes through a **closed parser** into a fixed action set, renders as a confirmation card, and is applied only by a button press. The model cannot write to the ledger, cannot name an account (names resolve client-side against the real list, ambiguity renders no button), and cannot supply a figure: when it proposes an income source, the pay amount and cadence are derived from the deposits that actually match — median amount, median gap — because a wrong frequency multiplies income by 2.17×.

The parser rejects rather than truncates or clamps, and runs a prototype-pollution check before reading a single key.

---

## Architecture

```
Plaid (live, 3×/day)  ─┐
CSV / statements      ─┼─►  ingest ──►  Firestore (immutable rows)
Receipt scan          ─┘    │                    │
                            │                    ├─ reviews/   owner's decisions
                   fingerprint dedupe            ├─ income/    approved sources
                   never-guess matching          └─ rules/     mapping rules
                   balance anchoring                     │
                                                         ▼
                                        interpretTransaction()  ← the one engine
                                                         │
                        ┌────────────────┬───────────────┼─────────────┐
                        ▼                ▼               ▼             ▼
                   Flow (Sankey)    Forecast        Analytics      AI chat
```

**Stack:** Next.js 16 · React 19 · TypeScript · Firebase (Firestore, Auth, Hosting) · Cloud Functions in both TypeScript and Python · Recharts.

**Ingest** is multi-source and de-duplicating. The same real charge arriving from two providers with different identities is matched on a content fingerprint (account + signed cents, ±3 days, strictly one-to-one) and *enriches* the existing row rather than inserting a twin. Import ids are bijective and content-keyed, so re-importing a cumulative export overwrites instead of duplicating. An account match that is ambiguous demotes **all** its claimants rather than guessing.

**Balance anchoring** re-bases an account's opening balance from the bank's own figure, guarded four ways. It is dated to the balance's *own* timestamp, not to today — a stale balance stamped with a fresh date once put an account $2,000 wrong by going blind to the withdrawals in between.

**The money-flow graph** (`/flow`) turns the ledger into a conserving Sankey: every account node balances, and any residual is explained by a *named* stub rather than silently absorbed. Lanes keep a refund, a cashback credit and a card charge out of the column where paychecks live. The residual category states its own size (*"63 smaller categories"*) instead of hiding a quarter of spending behind the word "other".

How work moves through this repo — issues, dependencies, PRs, merge gates: **[CONTRIBUTING-PROCESS.md](CONTRIBUTING-PROCESS.md)**

Deeper detail: **[FLOW_ENGINE.md](FLOW_ENGINE.md)** · **[ARCHITECTURE.md](ARCHITECTURE.md)** · **[AI.md](AI.md)** · **[docs/DECISIONS.md](docs/DECISIONS.md)**

---

## Verification

**~1,300 tests across four runners**, because the money paths deserve more than one kind of proof:

| Suite | Count | What it protects |
|---|---|---|
| Web (Jest) | **1,068** | classification, flow graph, formatting, components |
| Firestore rules (emulator) | **~180** | per-user isolation, deny-by-default, shape on update |
| Python (`functions-sync`) | **87** | ingest mapping, sign conventions, dedupe, anchoring |
| Functions (Jest) | **28** | prompt construction, bounds, callable contracts |

Beyond count, three habits matter more:

- **Invariants are pinned against real exports**, not only synthetic fixtures — the CSV audit replay reconciles to the cent.
- **Every non-obvious rule carries the measurement that motivated it** in the source comment (`this cost $2,000`, `understated by $723/month`), so the next reader knows what breaks if they "simplify" it.
- **CI gates in order**, and what deliberately does *not* auto-deploy: Firestore rules ship by a human hand, because a bad ruleset locks you out of your own financial data and the rollback is a console visit, not a git revert.

```bash
npm install
cp .env.example .env.local     # see CONTRIBUTING.md
npm run dev                    # http://localhost:3000
npm test                       # web suite, incl. the CSV audit replay
npm run test:rules             # Firestore rules against the emulator
```

---

## Security posture

Read-only financial data, single-owner deployment, and a few rules held firmly:

- Bank credentials and access tokens live in Secret Manager and server-side documents the browser cannot read; the client only ever learns an institution's *name*.
- Sync status and credentials are deliberately **separate documents**, so a status write can never leak a token.
- Firestore rules are uid-scoped and deny-by-default, with document shape re-asserted on update.
- LLM calls sit behind authenticated callables with per-user daily limits — an earlier unauthenticated route was removed, and a post-deploy smoke test asserts it stays gone.

---

## Status and honest limitations

Working: live bank sync, two years of history, the flow graph, forecasting, the review queue, AI chat with confirmations, CSV/statement import for issuers no aggregator reaches (Apple Card, Synchrony).

Known gaps, stated plainly:

- Apple Card has **no** aggregator path anywhere — monthly statement import is the only route, by Apple's design.
- The forecast is deterministic (recurring detection + approved income), not probabilistic.
- Multi-currency is not modelled yet; the cross-border case (US + India) is designed but unbuilt.
- Built for one operator. The multi-tenant story — per-user provider credentials, onboarding, billing — is designed, not shipped.

---

*Author: Bhuvaneswar Marreddy · MIT licensed · built with [Claude Code](https://claude.com/claude-code)*
