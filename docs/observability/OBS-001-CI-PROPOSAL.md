# OBS-001 — CI proposal

**No CI system exists in this repository.** There is no `.github/`, no GitLab/Azure/
Jenkins/Circle configuration. The only gate is `scripts/predeploy.sh`, run manually by
`npm run deploy`.

OBS-001 therefore does **not** create a pipeline. Inventing a CI platform — and one
holding Firebase credentials — is a larger decision than an observability task should
make on the owner's behalf. This document is the exact proposal to implement when the
owner chooses to.

---

## 1. What exists today

| Candidate | Status |
|---|---|
| `.github/workflows/` | absent |
| GitLab / Azure / Jenkins / CircleCI | absent |
| `scripts/predeploy.sh` | the de-facto gate: `tsc` → `jest` → react-hooks crash rules → build + local boot smoke |
| `npm run deploy` | `predeploy.sh` then `firebase deploy --only hosting`. Manual, local, and it talks to the **production** project |

### The coverage gap the gate leaves

`predeploy.sh` runs the **web** Jest suite only. Two suites never run before a deploy:

- `functions/` — Node/TypeScript Cloud Functions (`functions/package.json` → `jest`)
- `functions-sync/` — Python sync (`test_simplefin.py`, `test_sync.py`)

Closing that gap is OPS-001's remit; the job below runs all three so the proposal does
not bake the gap in.

## 2. Recommended job

One **non-deployment** validation workflow. GitHub Actions is assumed only because the
repo has a GitHub remote; the steps translate directly to any runner.

Proposed file: `.github/workflows/observability.yml`
Job name: `observability-accounts`
Trigger: `pull_request` + `workflow_dispatch`. **Never** on tag or release.

```yaml
name: observability
on:
  pull_request:
  workflow_dispatch:

jobs:
  observability-accounts:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    env:
      NEXT_PUBLIC_OBS_ENV: development   # enables the diagnostics endpoint + fixture route
      NEXT_PUBLIC_OBS_LEVEL: debug
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm' }
      - uses: actions/setup-python@v5
        with: { python-version: '3.12' }

      # 1. dependencies
      - run: npm ci
      - run: npm ci --prefix functions
      - run: pip install -r functions-sync/requirements.txt

      # 2. typecheck + build
      - run: npx tsc --noEmit
      - run: npm run build

      # 3. tests — all three suites, not just the web one
      - run: npm test -- --ci
      - run: npm test --prefix functions
      - run: python -m pytest functions-sync -q

      # 4. browser observability validation (fixture-backed, no live data)
      - run: npx playwright install --with-deps chromium
      - run: npm run test:e2e

      # 5. diagnostic manifest for the trace the E2E run produced
      - name: Export diagnostic bundle
        if: always()
        run: |
          TRACE=$(ls test-results/observability 2>/dev/null | head -1)
          if [ -n "$TRACE" ]; then
            echo "Primary Trace ID: $TRACE"
            echo "Diagnostic Artifact: observability-accounts-${{ github.run_id }}"
            npm run diag:export -- "$TRACE" || true
          else
            echo "no trace evidence produced"
          fi

      - name: Upload sanitized diagnostics
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: observability-accounts-${{ github.run_id }}
          retention-days: 7
          if-no-files-found: warn
          path: |
            diagnostic-bundles/
            playwright-report/
            test-results/observability/
```

### Commands, explicitly

| Purpose | Command |
|---|---|
| Build | `npm run build` |
| Typecheck | `npx tsc --noEmit` |
| Web tests | `npm test -- --ci` |
| Node Functions tests | `npm test --prefix functions` |
| Python sync tests | `python -m pytest functions-sync -q` |
| Playwright (safe, mocked) | `npm run test:e2e` |
| Diagnostic bundle | `npm run diag:export -- <traceId>` |

`npm run test:e2e` is safe in CI **because** it drives `/dev/accounts-fixture`, which
supplies the React contexts from `src/lib/obs/fixtures.ts` and has no code path to
Firebase. The spec asserts a tripwire: zero requests to `firestore.googleapis.com`,
`identitytoolkit.googleapis.com`, `cloudfunctions.net` or `bridge.simplefin.org`.

### On failure

The job prints, before the artifact upload:

```
Primary Trace ID: <trace-id>
Diagnostic Artifact: observability-accounts-<run-id>
```

## 3. Artifact structure

```
observability-accounts-<run-id>/
  diagnostic-bundles/<traceId>/
    manifest.json            app, env, git commit/branch, run name, timestamp,
                             trace ids, artifact paths, redaction status,
                             known missing evidence
    trace-summary.json
    frontend-events.jsonl
    backend-events.jsonl
    provenance.json
    network-summary.json
    console-summary.txt
    screenshots/             fixture data only
    playwright-trace/        retained on failure/retry
  playwright-report/         HTML report
  test-results/observability/<traceId>/
```

Every file passes through the exporter's redactor, and the exporter **exits non-zero if
the finished bundle still matches a secret pattern** — so a leak fails the job rather
than being published.

## 4. Required test environment

**No secrets. No Firebase credentials. No service account. No `.env`.**

The job needs only Node 20, Python 3.12 and Chromium. `NEXT_PUBLIC_OBS_ENV=development`
enables the fixture route and the diagnostics endpoint; both 404 in production.

### If real-data browser coverage is ever wanted (a separate task)

That needs the isolation this project does not have yet:

1. `firebase init emulators` → Auth + Firestore, ports pinned in `firebase.json`.
2. A `NEXT_PUBLIC_USE_EMULATOR` branch in `src/lib/firebase.ts` calling
   `connectAuthEmulator` / `connectFirestoreEmulator`, gated to non-production.
3. A seed script writing `src/lib/obs/fixtures.ts` into the emulator.
4. A test user created **in the emulator**, credentials generated per run.
5. Playwright signing in against the emulator only.

Until then, real-`/accounts` validation stays **manual**. Do not add production Firebase
credentials to CI to shortcut this.

## 5. Security restrictions

- Do not add repository secrets to this workflow. It needs none.
- Do not run it on `push` to `main`, on tags, or on release.
- Do not add a deploy step. `firebase deploy` stays manual and local.
- Do not upload `.env*`, `.firebase/`, or anything from a real-data run.
- Keep retention short (7 days) — diagnostics are for the investigation, not an archive.

## 6. Files that would need to change

| File | Change |
|---|---|
| `.github/workflows/observability.yml` | new — the job above |
| `scripts/predeploy.sh` | optional (OPS-001): add the Functions + Python suites to close the gate gap |
| `.gitignore` | already updated by OBS-001 for `test-results/`, `playwright-report/`, `diagnostic-bundles/` |

## 7. Deployment is untouched

OBS-001 modified no deployment path: `npm run deploy`, `scripts/predeploy.sh`,
`firebase.json`, `firestore.rules` and every hosting/functions setting are unchanged.
The proposed workflow adds no deploy stage, no environment, no approval and no secret.
