# Deploy pipeline

Push to `main` → it tests, deploys, and checks the live site. No laptop involved.

## Setup — once, two minutes

```bash
npx firebase-tools login:ci
```

Approve in the browser. It prints a token starting `1//`.

Then: **GitHub repo → Settings → Secrets and variables → Actions → New repository secret**

| Name | Value |
|---|---|
| `FIREBASE_TOKEN` | the token it printed |

Also check **Settings → Actions → General** that workflows are allowed to run.

That is the whole setup. There is no service account to create and no roles to assign.

## What happens on a push to `main`

1. `validate.yml` runs in full — tsc, 998 Jest tests, 26 functions tests, 62 Python
   tests, the functions commonjs build, the Next production build, the react-hooks
   crash scan, the Playwright observability spec, and the 180 Firestore rules tests
   against the emulator.
2. Only if all of that is green: `firebase deploy --only functions:api,hosting`.
3. The live site is hit on five routes and must return 200, and the three deleted AI
   proxy routes must still return 404. Otherwise the run goes red.

About **9 minutes**. Nothing to watch — GitHub emails you if it fails.

Docs-only pushes (`**/*.md`, `docs/**`) skip the whole thing.

## What it does NOT deploy, and why

**`firestore.rules`.** A bad ruleset locks you out of your own financial data, and the
fix is a Firebase console visit, not a `git revert`. The 180-test emulator suite runs
on every push so *drift is caught* — that is the bug that actually happened, where the
live rules turned out to be an older revision missing six collections the app writes.
Publishing stays deliberate:

```bash
npx firebase-tools deploy --only firestore:rules
```

To automate it anyway, add `,firestore:rules` to the `--only` list in `deploy.yml`.

**`functions:sync`.** The Python codebase holding your SimpleFIN and Monarch
credentials. It has never been deployed from CI and that should be its own change.

## Deploying without pushing

**Actions → deploy → Run workflow.** Same gate, same steps.

> `workflow_dispatch` only appears in the UI once this file is on the default branch.
> Until the first push lands, deploy locally with `npm run deploy`.

## When it breaks

**Validation failed** — read the failing step; nothing was deployed. The site is untouched.

**Deploy failed** — Firebase deploys hosting and functions separately, so you may be
half-shipped. Check the live site, then either re-run the workflow or:

```bash
npx firebase-tools hosting:rollback
```

**Smoke test failed** — the deploy succeeded but the site does not serve. Roll hosting
back with the command above, then look at the run log for which route broke.

**`FIREBASE_TOKEN` stopped working** — tokens are revoked by a Google password change or
by `firebase logout --token`. Re-run `login:ci` and update the secret.

## The local path still works

```bash
npm run deploy          # scripts/predeploy.sh + firebase deploy
```

`predeploy.sh` boots the app against the **real** Firebase backend as its last gate,
which is why CI does not just shell into it. Keep it for when you want to watch a
deploy happen.

## Cost

Private repos get 2,000 free Actions minutes a month. At ~9 minutes a run that is
roughly **200 deploys**, and docs-only pushes cost nothing. The rules emulator adds
about 30 seconds per run; it earns that back the first time it catches a rules change
that would have denied a collection.
