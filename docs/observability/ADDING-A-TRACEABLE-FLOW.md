# Adding a traceable flow

Repeatable checklist for extending OBS-001's foundation to another page (Forecast, Cash
Flow, Transactions, Subscriptions, Budgets, Debt Planner, Sync).

Instrument **boundaries, not methods**. One user operation = one trace.

```
UI activity → API trace → service span → repository/provider span
           → provenance → Playwright validation → CI artifact
```

---

## 1. UI activity

Write `src/lib/obs/use<Page>Observability.ts`, modelled on
[useAccountsObservability.ts](../../src/lib/obs/useAccountsObservability.ts).

- [ ] Continue the document's trace: `startTrace(documentTraceparent())`. Do not mint a
      fresh id when the server already supplied one.
- [ ] Emit `<Page>.PageViewed` and `<Page>.LoadStarted` on mount, once — not per render.
- [ ] Emit `<Page>.LoadCompleted` (with `recordCount`, `dataSource`, `lastSyncAt`) or
      `<Page>.LoadFailed` (with a sanitized `errorType`), exactly once, when data settles.
- [ ] Add `track*` callbacks for the *meaningful* clicks only. If you are tempted to log
      a scroll, a hover or a keystroke: don't.
- [ ] Publish `window.__OBS__ = { traceId, provenance, events, flush }` for Playwright.
- [ ] Call the hook **above every early return** — a hook after a conditional return is
      React error #310.

Then call the hook from the page and render `<PageDiagnostics>` (copy
[AccountsDiagnostics.tsx](../../src/components/AccountsDiagnostics.tsx)); it must return
`null` when `isEnabled()` is false.

## 2. API trace

Nothing to do for a Firestore-backed page — `src/middleware.ts` already continues or
mints the trace for every request and returns `X-Trace-Id`.

If your flow adds a real HTTP endpoint or a Firebase callable:

- [ ] Read `traceparent` from the request; use `continueOrStart()`, never `getTrace()`
      (server module state is shared across concurrent requests).
- [ ] Attach `span.header()` to outbound calls you control.
- [ ] Return `x-trace-id` on the response.
- [ ] Firebase SDK calls cannot carry the header — record them as client spans and say
      so in the limitations, as the Accounts flow does.

## 3. Service span

In the context/service that orchestrates the load:

```ts
const span = startSpan('<Service>.<Operation>', {
  service: '<ContextName>', operation: '<BusinessOperation>', dataSource: 'Firestore',
});
try   { …; span.end({ recordCount: rows.length }); }
catch (err) { span.end({ status: 'error', error: err }); }
finally { span.end(); }   // idempotent; guarantees no span is left open
```

## 4. Repository / provider span

In `src/lib/firestore.ts` (or the provider client):

- [ ] Wrap the read with a span carrying `repository`, `dataSource`, and — in
      `metadata` — the collection path and filter **shape**, never values.
- [ ] Record `recordCount` and `snapshot.metadata.fromCache`.
- [ ] Never log documents, rows, SQL with parameters, or a raw provider response.
- [ ] If you find PII console logging on the path you are touching, replace it with a
      span. Do not start an unrelated repo-wide cleanup.

## 5. Provenance

Add a `<page>SummaryProvenance()` next to
[provenance.ts](../../src/lib/obs/provenance.ts).

- [ ] Re-apply the page's **own** filters and reducers. Import the real calculation;
      never re-implement it "more correctly".
- [ ] For each displayed metric report: value, calculation name + version, `asOf`,
      `lastSourceSync`, included/excluded counts, exclusion reasons, pending-data
      treatment, data source, cache status, staleness, trace id.
- [ ] Account identifiers: internal id and a masked label (`****1234`) only.
- [ ] Anything the app cannot currently explain goes in `limitations` — in words. A
      known ledger defect must be described, never silently smoothed over.
- [ ] Bump `calculationVersion` when the underlying calculation changes.

## 6. Redaction

- [ ] New sensitive key? Add it to `SECRET_KEYS` / `MASK_KEYS` in
      [redact.ts](../../src/lib/obs/redact.ts) — **not** to a local filter.
- [ ] New operational document with credentials? Write an allow-list projection like
      [sync-metadata.ts](../../src/lib/obs/sync-metadata.ts). Allow-list, never deny-list.
- [ ] Add a test proving the secret cannot survive serialization.

## 7. Tests (Jest)

- [ ] Correlation: no inbound context → one created; valid inbound → continued;
      parallel operations stay distinct; async work keeps the trace.
- [ ] Activity: page-view and load-completed/failed emitted, each with event name,
      route and trace id, and no sensitive values.
- [ ] Provenance: counts correct for a sanitized fixture; last-sync present when
      available; **the financial result is unchanged**; no full account numbers.
- [ ] Redaction: tokens, cookies, access URLs, connection strings, account numbers,
      nested fields.
- [ ] Environment: the diagnostics surface 404s and `emit()` is silent in production
      (use `@jest-environment node` for route handlers).

## 8. Playwright validation

- [ ] Add a fixture route under `src/app/dev/` supplying the page's contexts from
      sanitized fixtures. **Never** sign in and never read live Firestore — production
      is also the development environment.
- [ ] Extend [accounts-observability.spec.ts](../../e2e/accounts-observability.spec.ts)
      or add a sibling spec: assert `X-Trace-Id`, the rendered trace id, UI↔backend
      correlation on one id, provenance shape, no secret in captured artifacts, and the
      live-endpoint tripwire.
- [ ] Write evidence to `test-results/observability/<traceId>/` so the exporter finds it.
- [ ] Print `Primary Trace ID:` and `Diagnostic Artifact:`.
- [ ] Do not click anything destructive, and never trigger a live provider sync.

## 9. CI artifact

- [ ] Follow [OBS-001-CI-PROPOSAL.md](OBS-001-CI-PROPOSAL.md): the job name, the
      `observability-<page>-<run-id>` artifact, and the sanitized contents.
- [ ] Never touch a deployment job, a release approval, or a secret.

---

## Definition of done

A developer with only a trace id can answer: what page and action started it, which
operations ran and in what order, which data source answered, how many records
contributed, when the source last synced, which calculation produced the number, what
the browser showed, and whether anything errored — **without** any credential, full
account number or raw provider payload appearing anywhere in the evidence.
