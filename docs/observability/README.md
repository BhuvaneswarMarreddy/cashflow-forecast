# Observability

One trace id answers "why does this number say what it says" for the Accounts page:
what the user did, which code ran, which data source answered, how many records
contributed, when the bank feed last landed, and what the browser actually showed.

OBS-001 built the reusable foundation and proved it through the Accounts flow only.

## Architecture

The app has no server tier for Accounts — the browser reads Firestore through the
Firebase SDK. The trace follows the real path rather than a pretend one:

```
GET /accounts
  │  src/middleware.ts  — continues an inbound `traceparent`, mints one if absent,
  │                       returns X-Trace-Id + Server-Timing: traceparent
  ▼
AccountsPage (src/app/accounts/page.tsx)
  │  useAccountsObservability() reads the document's trace from Server-Timing and
  │  CONTINUES it → Accounts.PageViewed, Accounts.LoadStarted
  ▼
UserProfileContext.syncFromFirestore()        span: UserProfile.SyncFromFirestore  (service)
  ├── firestore.getAccounts()                 span: Firestore.GetAccounts          (repository)
  └── firestore.getTransactions()             span: Firestore.GetTransactions      (repository)
  ▼
withDerivedBalances() + the summary reducers  span: Accounts.Summarize             (calculation)
  ▼
accountsSummaryProvenance()                   event: Accounts.ProvenanceComputed
  ▼
UI renders → Accounts.LoadCompleted / Accounts.LoadFailed
  ▼
batched POST /api/diagnostics/trace  (dev/test only) — a real HTTP hop carrying
  the same `traceparent`, so the backend holds evidence under the same trace id
  ▼
GET /api/diagnostics/trace?traceId=…  → the whole operation, correlated
```

### Why not OpenTelemetry

`@opentelemetry/*` plus an exporter is ~8 packages and a collector, and none of it can
instrument the client-side Firestore reads that *are* this flow. We use the **W3C
trace-context wire format** — `traceparent`, 16-byte trace id, 8-byte span id — in ~70
lines with no new runtime dependency. Ids stay compatible, so swapping in a real OTel
exporter later is a sink change, not a re-instrumentation.

## Files

| File | Role |
|---|---|
| `src/lib/obs/trace.ts` | W3C trace context, span start/end, sanitized error typing |
| `src/lib/obs/events.ts` | Structured event model, level gate, bounded ring buffer, batched shipping |
| `src/lib/obs/redact.ts` | The one redactor. Every sink calls it |
| `src/lib/obs/provenance.ts` | Explains the Accounts totals without changing them |
| `src/lib/obs/sync-metadata.ts` | Allow-list projection of `meta/simplefinSync` and `meta/monarchSync` |
| `src/lib/obs/store.ts` | Bounded dev-only trace store (50 traces × 200 events) |
| `src/lib/obs/useAccountsObservability.ts` | The Accounts vertical slice |
| `src/lib/obs/fixtures.ts` | Sanitized fixture data. Invented numbers only |
| `src/middleware.ts` | Trace continuation + `X-Trace-Id` |
| `src/app/api/diagnostics/trace/route.ts` | Dev/test-only ingest + retrieval |
| `src/app/dev/accounts-fixture/` | Dev/test-only fixture route (see isolation, below) |
| `src/components/AccountsDiagnostics.tsx` | The provenance panel |
| `scripts/diagnostics/export-trace.mjs` | Diagnostic bundle exporter |

## Event types

Every event is a `DiagEvent` (`src/lib/obs/events.ts`) with queryable properties — never
a free-text message. Not every field is populated by every event.

`timestamp, environment, application, eventName, eventCategory, severity, traceId,
spanId, parentSpanId, requestId, sessionId, userIdHash, route, component, endpoint,
operation, service, repository, dataSource, durationMs, resultStatus, recordCount,
lastSyncAt, calculationName, calculationVersion, metadata`

Categories: `activity` (a meaningful user action), `span` (a timed boundary),
`request` (a server-side receipt), `provenance` (a calculation explanation),
`diagnostic`.

### Accounts events

| Event | Emitted when |
|---|---|
| `Accounts.PageViewed` | `/accounts` opens |
| `Accounts.LoadStarted` | the load begins |
| `Accounts.LoadCompleted` | data settled — carries `recordCount`, `dataSource`, `lastSyncAt`, `cacheStatus` |
| `Accounts.LoadFailed` | the transaction load errored — carries a sanitized `errorType` |
| `Accounts.ProvenanceComputed` | the summary was explained |
| `Accounts.RefreshClicked` / `RefreshCompleted` / `RefreshFailed` | the "Refresh from banks" button |
| `Accounts.AccountSelected`, `Accounts.FilterChanged` | meaningful selection/filtering |
| `Accounts.DiagnosticExplanationOpened` | the provenance panel is opened |
| `Accounts.AddSkipped` / `Accounts.AddFailed` | an account write could not proceed |

Deliberately **not** logged: mouse movement, scrolling, keystrokes, renders, framework
lifecycle. One click produces one trace, not one trace per internal method.

### Spans

| Span | Layer |
|---|---|
| `Accounts.Render` | page |
| `Accounts.Summarize` | calculation (`AccountsSummary v1`) |
| `UserProfile.SyncFromFirestore` | application service |
| `Firestore.GetAccounts`, `Firestore.GetTransactions` | repository |
| `Firestore.AddAccount`, `Firestore.CreateUserProfile` | repository (writes) |
| `Diagnostics.Ingested` | backend endpoint |

## Provenance

`accountsSummaryProvenance()` explains six displayed metrics — `BankBalance`,
`CreditUsed`, `TotalDebt`, `NetWorth`, `AvailableCredit`, `AccountCount` — each with:

```
metric, displayedValue, calculationName, calculationVersion, asOf, lastSourceSync,
includedAccountCount, includedAccountTypes, includedAccounts[{id,type,maskedLabel}],
excludedAccountCount, exclusionReasons, pendingDataTreatment, dataSource,
cacheStatus, staleness, traceId
```

It **re-applies the page's own filters and reducers** and reports what they did. It does
not change, correct or improve any financial result. Where the application cannot
currently explain something, the `limitations` array says so rather than inventing an
answer:

- Inactive accounts are excluded at the **repository** (`getAccounts()` queries
  `isActive == true`), not by the calculation, so `excludedAccountCount` counts type
  exclusions only.
- `lastSourceSync` is **derived**: the authoritative `meta/monarchSync.lastSuccess` is a
  top-level document the browser cannot read. We use the newest `updatedAt` written by
  the sync's balance re-anchor, else the newest bank-feed transaction date, and label
  which one was used in `lastSyncSource`.
- `AvailableCredit` omits cards with no `creditLimit` rather than treating a missing
  limit as zero — matching the page.

Provenance describes the ledger **as it currently behaves**, including known defects
(card-payment double counting, pending-as-posted, etc.). Fixing those is FIN-001's job;
observability must not quietly paper over them.

### Not covered: earned income

The Accounts page also renders **Monthly Income** and **Monthly Budget**. They still have
no per-metric provenance row, and the reason is recorded in `limitations` rather than
left implicit. What has changed is *the rule they follow*.

**Before FIN-INCOME-001** (recorded here for anyone reading an older trace):
`monthlyAverages()` preferred rows whose `sourceCategory` was the literal string
`'Paychecks'` — or whose text matched `/payroll|paycheck/i` — and **fell back to summing
every income-classified row** over the trailing 6 months. A refund, a shared-expense
reimbursement, a Zelle transfer from a friend or a one-off deposit could all land in
"Monthly Income".

**Now:** `monthlyAverages()` (`src/lib/forecast.ts`) counts a row only when
`interpretTransaction()` resolves its `financialMeaning` to `earned_income` — meaning it
matched an **active approved source** in `users/{uid}/income`, or the owner confirmed it
in `users/{uid}/reviews`. There is no provider-category branch left. Every other credit
is an `unknown_inflow`: it moves the account balance (it is real money) and is excluded
from every income total, forecast income event and recurring-income estimate. With no
approved source configured, Monthly Income is **0** — the honest answer, with the
unexplained credits listed by `selectInflowReviewQueue()` rather than silently counted.

Earned-income provenance rows can now be written against that taxonomy
(`FINANCIAL_MEANINGS`, `src/types/index.ts`); the work simply has not been done yet.

`selectInflowReviewQueue()` emits `InflowReview.QueueBuilt` at `debug` — queue size,
scanned count, approved-source count and per-reason counts. No amount, title or
transaction id, matching the rule below.

## Sync metadata

`meta/simplefinSync` contains an `accessUrl` credential and `meta/monarchSync` contains a
session token. `safeSyncProjection()` (`src/lib/obs/sync-metadata.ts`) is the only
sanctioned way to look at either. It is an **allow-list**: source, last success, last
attempt, status, numeric counters, sanitized error summary, staleness — plus
`withheldFields`, which names what it dropped so the omission is visible. A new secret
field added upstream is dropped by default.

## Redaction

One module, `src/lib/obs/redact.ts`, used by every sink and by the exporter.

- **Keys** (case/format-insensitive, recursive): `authorization, cookie, set-cookie,
  accessUrl, simplefinAccessUrl, apiKey, token, secret, password, connectionString,
  credentials, session, ssn, email, address`, plus anything ending in
  `token`/`secret`/`password`/`apikey`/`accessurl`/`connectionstring`.
- **Masked, not destroyed**: `accountNumber, cardNumber, routingNumber, iban, pan,
  lastFourDigits` → `****1234`.
- **Value patterns** regardless of key: URLs with `user:pass@`, connection strings,
  `Bearer`/`Basic` values, JWTs, `AIza…`, `sk-…`, SSNs, 12–19 digit runs, and sensitive
  query-string parameters.
- Arrays capped at 50, depth capped at 8, cycles collapse to `[Circular]`, `Error`
  reduces to `{name, sanitized message}`.

Errors are recorded by **type** (`error.code` or class name), never by message.

## Where the logs are

| Environment | Sink |
|---|---|
| `next dev` | Browser console (`[obs] {json}`) + in-memory ring buffer + `POST /api/diagnostics/trace` |
| Jest | Ring buffer only (console silent, no network) |
| Production | **Nothing.** `emit()` returns null, the endpoint 404s, the fixture route 404s |

Production is off by default. Set `NEXT_PUBLIC_OBS_LEVEL` (`debug|info|warn|error|off`)
to change the level; `NEXT_PUBLIC_OBS_ENV` overrides the environment name.

## How to find a trace

1. Open `/accounts` in `npm run dev`.
2. Expand the **Diagnostics** panel — the trace id is in its summary line. (Or run
   `window.__OBS__.traceId` in the console, or read the `X-Trace-Id` response header.)
3. `curl "http://127.0.0.1:3000/api/diagnostics/trace?traceId=<id>" | jq`

That returns the correlated events, a layer summary, and the provenance payload.
`GET /api/diagnostics/trace` with no id lists the trace ids currently held.

The store is in-memory and bounded (50 traces); restarting the dev server clears it.
Export anything you want to keep.

## Export a diagnostic bundle

```bash
npm run diag:export -- <traceId>                 # → diagnostic-bundles/<traceId>/
npm run diag:export -- <traceId> --out some/dir --base http://127.0.0.1:3000
```

```
diagnostic-bundles/<traceId>/
  manifest.json          application, environment, git commit/branch, run name,
                         generated timestamp, trace ids, artifact paths,
                         redaction status, known missing evidence
  trace-summary.json
  frontend-events.jsonl
  backend-events.jsonl
  provenance.json
  network-summary.json
  console-summary.txt
  screenshots/
  playwright-trace/
```

The exporter re-redacts everything it copies (it does not trust the producer), refuses
output paths outside the repository or inside `src/`, `e2e/`, `scripts/`, `docs/` or a
dotfile directory, and **exits non-zero if the finished bundle still matches a secret
pattern**. Missing evidence is listed in the manifest rather than silently omitted.

`diagnostic-bundles/`, `test-results/` and `playwright-report/` are gitignored.

## Run Playwright

```bash
npm run test:e2e          # headless; starts `next dev` itself
npm run test:e2e:ui       # interactive
npx playwright show-report
```

The test opens the fixture route, asserts the UI↔API↔backend correlation, captures
console/network/screenshot evidence, and writes it to
`test-results/observability/<traceId>/` for the exporter. It prints:

```
Primary Trace ID: <trace-id>
Diagnostic Artifact: test-results/observability/<trace-id>
```

Trace is retained on failure/retry, screenshot on failure (`playwright.config.ts`).

## Production/Test isolation — read this before changing the E2E test

There is **one Firebase project, and production is also the development environment**.
`npm run dev` talks to live Firestore. There is no emulator.

So the automated test must never sign in or read real data. Isolation is at the **React
context boundary**, which sits above the Firebase SDK: `/dev/accounts-fixture` supplies
`AuthContext`, `UserProfileContext` and `TransactionContext` directly, so
`UserProfileProvider` never mounts, `syncFromFirestore` never runs, and there is no code
path from that page to the live project. Authentication is untouched — the route simply
does not use it, and 404s outside development/test.

The test also asserts a tripwire: zero requests to `firestore.googleapis.com`,
`identitytoolkit.googleapis.com`, `cloudfunctions.net` or `bridge.simplefin.org`.

**Manual-only:** validating the real `/accounts` page against real data. Do that by hand
(see the OBS-001 completion report), and never commit or upload the screenshots.

## Remaining console logging (reported, not cleaned up)

OBS-001 replaced the PII console logging **on the Accounts path only**
(`firestore.addAccount`, `firestore.createUserProfile`,
`UserProfileContext.addPaymentAccount` — which between them printed the full account
payload, the full profile document and the user's email). A whole-repository cleanup was
out of scope. What is left, by risk:

| Location | What it prints | Risk |
|---|---|---|
| `src/context/TransactionContext.tsx:210` | the **entire transaction object** — title, amount, merchant | **High** — the largest remaining browser-console PII leak |
| `src/context/AuthContext.tsx:152` | `{ name, email }` on signup | High |
| `src/app/signup/page.tsx:56` | `{ name, email }` on submit | High |
| `src/lib/firestore.ts` (~50 calls) | ids, paths, error codes; no payloads remain on the Accounts path | Medium — noisy, and unconditional in production |
| `src/context/TransactionContext.tsx` (16 more) | operation progress + error objects | Medium |
| `src/lib/firebase.ts`, panels, modals (~25) | connection status, caught errors | Low |

All of it runs **unconditionally in production**, unlike `emit()`. The mechanical fix is
to route these through `emit()`, which is level-gated and redacted. Recommended as its
own task (see the OBS-002 recommendation in the completion report).

## CI

There is no CI system in this repository. Rather than invent one, OBS-001 documents the
exact job in [OBS-001-CI-PROPOSAL.md](OBS-001-CI-PROPOSAL.md). No deployment path was
modified.

## Performance

- `emit()` is synchronous, allocation-light, and returns immediately when the level gate
  is closed — which it is in production.
- Network shipping is batched (20 events or 1s) with `keepalive`, never awaited by the
  page, and wrapped in a catch: a diagnostics sink must not break the page it observes.
- One event per span, on `end()` — a start event doubles volume and adds nothing.
- Buffers are bounded: 300 events in the browser ring, 50 traces × 200 events on the
  server. Arrays in payloads are capped at 50, object depth at 8.
- Spans sit on **boundaries** (page, service, repository, calculation), not on every
  method. The Accounts load adds roughly 6–10 events.
- Nothing serializes a financial object: counts, types, ids and aggregates only.

**Production recommendation:** leave `NEXT_PUBLIC_OBS_LEVEL` unset (diagnostics off). If
you ever need production signal, set it to `warn` or `error` and add a real sink — do
not send `debug` from a browser to a synchronous remote logger.

## Instrumenting another page

See [ADDING-A-TRACEABLE-FLOW.md](ADDING-A-TRACEABLE-FLOW.md).
