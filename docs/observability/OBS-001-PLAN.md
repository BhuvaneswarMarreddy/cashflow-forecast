# OBS-001 — Plan: End-to-end diagnostic observability for the Accounts flow

Baseline commit: `534a44c` · Branch: `feat/obs-001-accounts-observability` · Worktree: `../cashflow-forecast-obs-001`

## 1. What the repository actually is

| Question | Answer |
|---|---|
| Frontend | Next.js 16 App Router, React 19, `'use client'` pages, Tailwind v4 |
| Backend | **There is no application server for Accounts.** Firebase client SDK talks to Firestore directly from the browser |
| API style | Firestore SDK reads + Firebase **callables** (`sync_now`, `aiChat`, `aiDecision`, `parseReceipt`). Two Next.js route handlers exist (`/api/ai/decision`, `/api/parse-receipt`) but are not in the Accounts flow |
| Auth | Firebase Auth (email/password + Google popup), `AuthContext` |
| Accounts page | [src/app/accounts/page.tsx](src/app/accounts/page.tsx) at route `/accounts` |
| Accounts "service" | [src/context/UserProfileContext.tsx](src/context/UserProfileContext.tsx) → `syncFromFirestore()` |
| Accounts "repository" | [src/lib/firestore.ts](src/lib/firestore.ts) → `getAccounts()`, `getTransactions()` |
| Cache | `localStorage` (`cashflow_profile_<uid>`, `cashflow_transactions_<uid>`) is read **first**, Firestore refills in the background |
| SimpleFIN / Monarch | Python Cloud Functions in [functions-sync/](functions-sync/), invoked by the `sync_now` callable via [src/lib/sync-client.ts](src/lib/sync-client.ts). Only on the explicit "Refresh from banks" button |
| Calculation | `withDerivedBalances()` ([src/lib/forecast.ts](src/lib/forecast.ts)) then five reducers inline in `page.tsx:341-358` |

### Existing observability — essentially none

- No structured logging. ~120 ad-hoc `console.log('📝 [Firestore] …')` calls, some of which **print full document bodies** (`firestore.ts:259`, `firestore.ts:397`).
- No OpenTelemetry, no Application Insights, no Serilog equivalent, no `ActivitySource` equivalent.
- No correlation IDs, no request logging, no browser telemetry, no audit-event interface, no redaction, no health check, no diagnostic page.
- Python sync function has a local `log()` accumulator returned to the caller; not correlated with anything on the web side.

### Existing testing

- Jest 30 + Testing Library, jsdom, 24 suites under `src/__tests__/`. Firebase is mocked in `jest.setup.js`.
- **No Playwright / Cypress / Selenium.** No browser artifacts, no test-auth helper, no sanitized financial fixture beyond in-test literals.

### Existing CI/CD

- **None.** No `.github/`, no GitLab/Azure/Jenkins/Circle config. Deployment is manual: `npm run deploy` → `scripts/predeploy.sh` + `firebase deploy --only hosting`.

## 2. Consequences for the required architecture

The required flow assumes a server tier owning the Accounts read. This app does not have one — the browser *is* the client of the data store. So the flow is implemented honestly as:

```
/accounts route opened
  → browser starts a W3C trace (traceparent) for the page operation
  → Accounts.PageViewed / Accounts.LoadStarted
  → service span   : UserProfile.syncFromFirestore
  → repository span: firestore.getAccounts / firestore.getTransactions (record counts, cache-vs-server)
  → calculation    : AccountsSummary v1 (withDerivedBalances + the five reducers)
  → sanitized provenance summary
  → Accounts.LoadCompleted, UI renders, trace id exposed to the DOM + window
  → browser ships the sanitized event batch, carrying `traceparent`, to a
    DEV/TEST-ONLY route handler  → real HTTP hop, real backend evidence
  → Playwright reads X-Trace-Id, screenshots, console + network, then queries the
    same trace id back out of the diagnostics endpoint
```

Two genuine server-side pieces exist and are used:

1. **`src/middleware.ts`** — runs for every request (document + API). Continues an inbound `traceparent`, mints one when absent, echoes `X-Trace-Id` + `traceparent` on the response. This is the "backend receives the same trace context / response exposes a safe trace id" requirement, framework-native.
2. **`src/app/api/diagnostics/trace/route.ts`** — Development/Test only. `POST` ingests sanitized events; `GET ?traceId=` returns the correlated bundle. Returns `404` in Production and is proven so by a test.

Firebase SDK calls cannot carry a `traceparent` header (the SDK owns its transport). They are recorded as client spans under the same trace id; documented as a known limitation, not hidden.

### Why not OpenTelemetry

`@opentelemetry/*` + `@vercel/otel` would add ~8 packages and a collector, and would still not reach the browser-side Firestore path that *is* the Accounts flow. We use the **W3C trace-context wire format** (`traceparent`, 16-byte trace id, 8-byte span id) with a ~70-line implementation and no new runtime dependency, so a later swap to a real OTel exporter keeps the same ids. Recorded as `ponytail:` debt in `src/lib/obs/trace.ts`.

## 3. Proposed implementation

| File | Purpose |
|---|---|
| `src/lib/obs/redact.ts` | Centralized redaction: key list, value patterns, `maskAccountNumber` |
| `src/lib/obs/trace.ts` | W3C trace context: id generation, `traceparent` parse/format, span start/end |
| `src/lib/obs/events.ts` | Structured `DiagEvent` model, bounded ring buffer, level gate, batched dev-only shipping |
| `src/lib/obs/provenance.ts` | `accountsSummaryProvenance()` — read-only explanation of the five displayed totals |
| `src/lib/obs/store.ts` | Bounded server-side trace store (dev/test only) |
| `src/lib/obs/useAccountsObservability.ts` | The Accounts page hook: lifecycle events + spans + provenance |
| `src/middleware.ts` | Trace continuation + `X-Trace-Id` response header |
| `src/app/api/diagnostics/trace/route.ts` | Dev/test-only ingest + retrieval endpoint |
| `src/components/AccountsDiagnostics.tsx` | Dev-only disclosure rendering provenance + trace id |
| `src/app/accounts/page.tsx` | Call the hook, render the panel (small diff) |
| `src/context/UserProfileContext.tsx` | Service span around `syncFromFirestore` |
| `src/lib/firestore.ts` | Repository spans on `getAccounts` / `getTransactions` |
| `playwright.config.ts`, `e2e/accounts-observability.spec.ts` | Browser evidence |
| `scripts/diagnostics/export-trace.mjs` | Diagnostic bundle exporter |
| `docs/observability/*` | This plan, README, ADDING-A-TRACEABLE-FLOW, CI proposal |

## 4. Privacy / redaction design

One redactor, used by **every** sink (event emit, endpoint ingest, endpoint response, exporter). Keys redacted case-insensitively and recursively: `authorization, cookie, set-cookie, access-url, accessurl, simplefinaccessurl, apikey, api_key, token, secret, password, connectionstring, accountnumber, cardnumber, routingnumber, ssn, email` and anything ending in `token`/`secret`/`password`/`key`. Value patterns: URLs containing `user:pass@`, `postgres://…`, bearer strings, 12-19 digit runs (masked to `****1234`), SSN shape.

Structural rules: no transaction titles, no merchant names, no descriptions, no raw provider payloads, no full documents. Only counts, aggregates, types, ids, timestamps, durations, statuses. Aggregated dollar amounts appear **only** in the provenance summary (the number already on screen) and are never shipped anywhere outside the local dev process.

## 5. Test strategy

Jest (existing runner) for: traceparent parse/format + continuation + parallel isolation + async preservation; redaction (tokens, cookies, access URLs, connection strings, account numbers, nested); provenance (counts, exclusions, last-sync, non-mutation, no full account numbers); Accounts event emission (name/route/traceId present, no sensitive fields); production lockout of the diagnostics route.

Playwright for the browser half. Authenticated assertions are gated on `PW_TEST_EMAIL`/`PW_TEST_PASSWORD` (never committed); without them the test still asserts middleware correlation, the diagnostics round-trip, console/network capture and secret-absence. Documented as the known blocker.

## 6. CI artifact strategy

No CI system exists, so per the task's instruction not to guess, OBS-001 ships `docs/observability/OBS-001-CI-PROPOSAL.md` with the exact workflow file, job name, artifact name (`observability-accounts-<run-id>`) and contents, rather than inventing a platform.

## 6b. Addendum — verified environment constraints (received mid-implementation)

The full discovery report confirmed constraints that changed two decisions:

| Constraint | Effect on this plan |
|---|---|
| One Firebase project; **production is also the development environment**; `next dev` reads live Firestore; no emulator | The Playwright plan changed from "env-gated real login" to **no login at all**. Isolation moved to the React **context boundary**: `/dev/accounts-fixture` supplies `AuthContext`/`UserProfileContext`/`TransactionContext` from `src/lib/obs/fixtures.ts`, so `UserProfileProvider` never mounts and no Firestore read is reachable. The spec asserts a tripwire on live endpoints. Real-`/accounts` validation is **manual-only**. |
| `users/{uid}/accounts` is canonical; `profile.paymentAccounts` is an in-memory view assembled by `UserProfileContext` | Confirms the layering already instrumented: repository span on `firestore.getAccounts()`, service span on `syncFromFirestore()`. No `/api/accounts` layer was invented. |
| `meta/simplefinSync` may contain an **access URL**; `meta/monarchSync` a session token | Added `src/lib/obs/sync-metadata.ts` — an **allow-list** projection (source, last success, last attempt, status, counters, sanitized error, staleness, plus `withheldFields`). Applied to the `sync_now` result in the Refresh flow. |
| Production browser console logging exposes account payloads, balances and last-four | Replaced on the Accounts path only: `firestore.addAccount`, `firestore.createUserProfile`, `UserProfileContext.addPaymentAccount`. The remaining application-wide logs are reported, not cleaned up. |
| Known ledger defects (card-payment double counting, pending-as-posted, …) belong to FIN-001 | Provenance reports execution **faithfully**, including those behaviours. Nothing was silently corrected. |
| No CI, and OBS-001 must not build one | `OBS-001-CI-PROPOSAL.md` instead of a workflow. No production credentials anywhere. |

## 7. Risks and assumptions

- **`meta/monarchSync.lastSuccess` is not readable by the browser** (top-level collection, no rule grants access). Last-sync is therefore derived from the newest `updatedAt` on account documents (written by the sync re-anchor) and the newest synced transaction date, with the limitation stated in the provenance payload itself.
- The five Accounts totals **do not filter on `isActive`** — `getAccounts()` already queries `isActive == true`, so inactive accounts are excluded at the repository, not the calculation. Provenance reports this truthfully rather than pretending the calculation excludes them.
- `localStorage` is read before Firestore, so the first paint is frequently a cache hit with a later server refill. Provenance reports `cacheStatus` per load.
- Middleware runs on Firebase App Hosting SSR; the change only adds response headers, so a failure mode is "header missing", never a broken page.
- Observability is **off by default in production**: emit is a no-op unless `NEXT_PUBLIC_OBS_LEVEL` is set, and the diagnostics route 404s.
