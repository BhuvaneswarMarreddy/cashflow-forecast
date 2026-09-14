# cashflow-forecast

Web app + Cloud Functions for one owner's money. `cashflow-mobile` is the other
half of the same product. How work moves: [CONTRIBUTING-PROCESS.md](CONTRIBUTING-PROCESS.md).

## Shipping

- **A push to `main` deploys** `functions:api` + hosting (`.github/workflows/deploy.yml`),
  then smoke-tests the live pages and every callable. Never run `npm run deploy` after a merge.
- `firestore.rules` and `functions-sync/` are **never** deployed by CI, on purpose. When a
  push changes them, the deploy opens a "Hand deploy needed" issue. Deploy from a fresh
  `git checkout main && git pull --ff-only`, because `firebase deploy` ships the local tree.
- There is one Firebase project, and it is production. Tests use fixtures, mocks and the
  emulator only. Screens are exercised through `/dev/*-fixture` routes.

## Checks (all run in `validate.yml` on every PR)

```
npx tsc --noEmit
npx jest                          # web
npm test --prefix functions       # Cloud Functions
python -m pytest functions-sync -q
npm run test:rules                # Firestore rules on the emulator
npm run test:e2e                  # Playwright: observability + every fixture screen
```

`e2e/screens.spec.ts` marks known screen defects with `test.fail`. When you fix one,
delete its line in `KNOWN`.

## The phone contract

`contracts/homeSnapshot.json` is recorded by
`functions/src/__tests__/contract-homeSnapshot.test.ts`. If that test fails, you changed
what the phone receives: re-record with `UPDATE_CONTRACTS=1 npm test --prefix functions -- contract`.
The `mobile contract` CI job then runs cashflow-mobile's checks against it. If that job
fails, ship the mobile change first, or keep the old field.

## Money rules

- **Nothing auto-applies.** Only the owner's confirmation moves a number. Read
  `src/__tests__/counterparty-settlement.test.ts` before touching classification.
- **A value that cannot be backed is `null`, never `0`.** The UI says what is missing.
- **Pass the income policy** (`IncomeContext`) to `interpretTransaction` and friends.
  Omitting it silently creates a different income rule.
- **Figures are computed here, once.** The phone renders the server's integer cents and never re-derives them.
- Before believing a screen-level money bug, probe the engine: call `src/lib` directly in a throwaway test.

## CSS gotchas

- Tailwind v4 owns `--radius-*` and `--container-*`: declare them in `@theme`, not `:root`.
- Component classes go in `@layer components`. Unlayered CSS beats every utility.
- Touch targets use `.tap-target`, never padding.
- Turbopack serves stale CSS across restarts: `rm -rf .next` before judging a style.
