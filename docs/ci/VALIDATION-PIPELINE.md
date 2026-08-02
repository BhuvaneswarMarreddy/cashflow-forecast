# OPS-CI-001 — Non-deploying validation pipeline

Implements `docs/observability/OBS-001-CI-PROPOSAL.md`, corrected against reality. Every
command below was run locally in a clean worktree before it was committed; the
corrections to the draft are listed in § Corrections.

| | |
|---|---|
| Workflow | `.github/workflows/validate.yml` |
| Workflow name | `validate` |
| Job id / name | `validate` |
| Triggers | `pull_request`, `workflow_dispatch` — nothing else |
| Secrets used | **none** (no `secrets` context is referenced anywhere in the file) |
| Deploy steps | **none** |
| Permissions | `contents: read` |
| Timeout | 25 minutes |

## What runs

| # | Step | Command | Locally observed |
|---|---|---|---|
| 1 | Web deps | `npm ci` | ok |
| 1 | Functions deps | `npm ci --prefix functions` | ok |
| 1 | Python test dep | `python -m pip install pytest` | ok |
| 2 | Type check | `npx tsc --noEmit` | clean, exit 0 |
| 3 | Web tests | `npm run test:ci` | **444 passed, 31 suites** |
| 3 | Functions tests | `npm test --prefix functions` | **26 passed, 3 suites** |
| 3 | Python tests | `python -m pytest functions-sync -q` | **62 passed** |
| 4 | Build | `npm run build` | exit 0, no `.env` needed |
| 5 | react-hooks crash scan | inline eslint JSON scan | **0 violations**, 120 files |
| 6 | Browser observability | `npm run test:e2e` | **2 passed** |
| 7 | Diagnostic bundle | `npm run diag:export -- <trace>` | exit 0, redaction `clean` |

`npm run test:ci` is `jest --ci` with an explicit ignore list (see § Exclusions). It is a
new script; `npm test` is unchanged so the local deploy gate keeps its full coverage.

## Why Playwright is safe here

`npm run test:e2e` drives `/dev/accounts-fixture`, which supplies the React contexts
from `src/lib/obs/fixtures.ts` and therefore has **no code path to Firebase**.
`e2e/accounts-observability.spec.ts` asserts a live-data tripwire — the run fails if any
request reaches `firestore.googleapis.com`, `identitytoolkit.googleapis.com`,
`securetoken.googleapis.com`, `cloudfunctions.net` or `bridge.simplefin.org`. The spec
never signs in, never writes and never refreshes SimpleFIN.

`NEXT_PUBLIC_OBS_ENV=development` is required, and is supplied by
`playwright.config.ts → webServer.env`. It is deliberately **not** set at job level: that
would leak into `npm run build` and stop the pipeline from validating the real
production artifact.

## Exclusions, and the requirements they create

### `src/__tests__/flows.integration.test.ts` — excluded from CI

The CSV audit replay reads `transactionsbyaccount/`, a gitignored export of **real
personal financial data**. It must never be present on a CI runner, so those 7 tests
cannot run there. This is the 451 → 444 difference: the integration checkout has the
CSV folder, a fresh checkout does not.

It is excluded by path rather than left to its own guard because **the guard does not
work**. The file uses `const maybe = fs.existsSync(DIR) ? describe : describe.skip`, but
Jest still evaluates a `describe.skip` callback body — and the body calls `load()`, which
calls `fs.readdirSync(DIR)` and throws `ENOENT`. Without the exclusion the suite
*crashes* on any machine lacking the data rather than skipping:

```
Test Suites: 1 failed, 31 passed, 32 total
Tests:       444 passed, 444 total
```

**Future requirement:** move `load()` inside a `beforeAll`, or make `maybe` short-circuit
the body, so the suite skips cleanly with no data. That file belongs to the financial
domain (`src/lib/flows.ts` and its tests) and was not touched by OPS-CI-001. Once fixed,
drop the last pattern from `test:ci` and CI regains the guard for free.

`npm run deploy` still runs this suite in full — `scripts/predeploy.sh` gate 2 calls
plain `npm test` on the owner's machine, where the CSVs exist.

### `functions-sync/main.py` — no test coverage in CI

`main.py` imports `firebase_admin`, `firebase_functions` and the Firestore client. It
cannot be exercised without production Firebase. The tested modules (`sync_core.py`,
`simplefin.py`) are stdlib-only and fully covered.

**Future requirement:** the Firestore/Auth emulator setup described in
`OBS-001-CI-PROPOSAL.md § 4` is the prerequisite for testing `main.py` and for any
real-data browser coverage.

### `scripts/predeploy.sh` gate 6 — never runs in CI

Gate 6 builds and boots the app against the **real Firebase backend** (production is
also the development project) and curls `/`, `/login`, `/accounts`, `/flow`, `/forecast`,
`/history`, `/cashflow`. That is production connectivity, so CI must not run
`predeploy.sh`. The workflow reproduces gates 1–5 with its own build step and its own
copy of the react-hooks scan instead.

**Future requirement:** same emulator work. Until then the boot smoke stays a local,
manual, pre-deploy step.

### `functions-sync/requirements.txt` — deliberately not installed

It pins the Cloud Function *runtime* dependencies (`firebase-admin`,
`firebase-functions`, `monarchmoney`), which only `main.py` imports — and `main.py` is
excluded above. It also does **not** contain `pytest`, so the draft's
`pip install -r functions-sync/requirements.txt` would not have made the test command
runnable. `pytest` is installed directly instead.

## Deploy gate changes

`scripts/predeploy.sh` went from 4 gates to 6. Nothing was removed, reordered or
loosened:

| Gate | Before | After |
|---|---|---|
| tsc | 1/4 | 1/6 — unchanged |
| web jest (incl. CSV audit replay) | 2/4 | 2/6 — unchanged |
| **functions jest** | *(not gated)* | **3/6 — new** |
| **python sync tests** | *(not gated)* | **4/6 — new** |
| react-hooks crash rules (JSON scan) | 3/4 | 5/6 — unchanged |
| build + local boot smoke (real backend) | 4/4 | 6/6 — unchanged |

`set -e` is retained. The Python gate prefers `pytest` when it is importable and falls
back to `python3 -m unittest discover -s functions-sync` otherwise, so the gate never
demands a `pip install` on the owner's machine; both runners execute the same 62 tests
and both exit non-zero on failure.

## Artifacts

Name: `observability-accounts-<run-id>` · retention: **7 days** · `if-no-files-found: warn`

```
diagnostic-bundles/<traceId>/
  manifest.json           app, env, git commit/branch, run name, timestamp, trace ids,
                          artifact list, redaction status, known missing evidence
  trace-summary.json
  frontend-events.jsonl
  backend-events.jsonl
  provenance.json
  network-summary.json
  console-summary.txt
  screenshots/accounts.png    fixture data only
  playwright-trace/           populated on failure/retry only
playwright-report/            Playwright HTML report
test-results/observability/<traceId>/
```

Everything passes through the exporter's redactor, and the exporter **exits 2 if the
finished bundle still matches a secret pattern**. The workflow does not swallow that
exit code, so a leak fails the job instead of being published.

On both success and failure the job prints, before the upload:

```
Primary Trace ID: <trace-id>
Diagnostic Artifact: observability-accounts-<run-id>
```

### Known artifact limitation

`npm run diag:export` also queries the development diagnostics endpoint, but Playwright
has already torn down its `webServer` by the time the export step runs, so the endpoint
is unreachable and `manifest.knownMissingEvidence` will say so. The bundle is still
complete: the exporter copies the same evidence from
`test-results/observability/<traceId>/`, which the spec wrote during the run. Verified
locally — 7 artifacts, redaction `clean`, exit 0.

## Corrections made to the draft proposal

1. `pip install -r functions-sync/requirements.txt` → `pip install pytest`. The
   requirements file does not contain pytest, and nothing under test imports what it
   does pin.
2. `npm test -- --ci` → `npm run test:ci`. Plain `jest --ci` fails in a clean checkout
   (see § Exclusions).
3. `npm run build` no longer inherits `NEXT_PUBLIC_OBS_ENV=development`; job-level env
   was removed so the build validates the production artifact.
4. `npm run diag:export ... || true` → no `|| true`, so the exporter's secret-scan
   failure actually fails the job as § 3 of the proposal promised.
5. Added the react-hooks crash scan, which the draft omitted entirely.
6. Added `permissions: contents: read` and `cache-dependency-path` for both lockfiles.
7. Workflow renamed `observability.yml` → `validate.yml`; it is the whole validation
   gate now, not just the observability slice.

## Not verifiable until this runs on a real runner

- The workflow has **never executed in GitHub Actions**. Only its YAML was validated
  locally (parsed with a YAML parser) plus every command it invokes.
- Local verification ran on **Node 26 / npm 11 / macOS**. The workflow pins **Node 20**
  (matching `functions/package.json` engines) on **ubuntu-latest**.
- Local Python is **3.9.6**; the workflow pins **3.12**.
- `npx playwright install --with-deps chromium` needs `sudo` apt access on the runner;
  only `npx playwright install chromium` was run locally.
- `actions/checkout@v4` produces a shallow clone — `git rev-parse HEAD` in the exporter
  manifest works, but `git rev-parse --abbrev-ref HEAD` may report a detached ref on
  `pull_request`.
- Cold-cache install and build timings against the 25-minute timeout.
