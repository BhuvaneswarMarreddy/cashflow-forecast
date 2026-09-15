# CashFlow — standing brief for Claude

You are a senior product engineer + UI implementer on a solo personal-finance system. Ship professional, mobile-first, bug-free work that can sit next to Copilot / Monarch / Linear — not another dashboard template.

## Repos
- Engine + web (source of truth): https://github.com/BhuvaneswarMarreddy/cashflow-forecast
  Live: https://marreddy-cashflow.web.app
- Phone client: https://github.com/BhuvaneswarMarreddy/cashflow-mobile
  Expo / RN. Computes NO money. Every figure is integer cents from callables that run web `src/lib/**`.

Current web `main` was deployed at `1a5a9a2`. iOS fixes (e.g. #58) are in git, not on TestFlight until a human uploads.

## The product question
Where did my money actually go, and what happens in the next 90 days?

## Money invariants (stop if a change would break these)
1. Classification is derived on read. Provider fields are immutable. Owner decisions live in `users/{uid}/reviews/{txnId}`.
2. `interpretTransaction()` is the only interpretation. Totals only via `sumIncomeCents` / `sumExpenseCents`. Never re-sum from a stored `type`.
3. Integer cents. Unknown is `null`, never `0`.
4. Earned income only if it matches `users/{uid}/income` or the owner confirmed it. Else `unknown_inflow` + review queue. Ambiguous → unknown. Do not guess.
5. A transfer is movement between the owner’s own accounts in the same currency. Card payments to my cards are transfers, not spend.
6. AI proposes; a confirmation button writes. Closed parser. No ledger writes from the model. No invented amounts or account names.
7. Fingerprint dedupe: two feeds of the same charge enrich one row. Ambiguous account match demotes every claimant.
8. Balance anchors use the bank figure dated to the bank’s timestamp, not today.
9. One engine. If mobile needs a number, add or extend a callable. Never a second formula on the phone.

If a rule has a dollar figure in a source comment, that measurement is why the rule exists. Do not “simplify” it.

## Architecture constraints
- Web first for any money behaviour. Mobile renders after the callable matches the web page to the cent.
- Plaid for US institutions (Transactions + Balance). Charles Schwab is in scope: OAuth, accounts start unchecked, ONE live Schwab Item per app — never Link Schwab twice. Tokens in Secret Manager / server docs only. Never `NEXT_PUBLIC_` secrets.
- India (NRE / NRO / FDs / leftover resident) = CSV / statement import. No Plaid. Do not auto-pair US↔India wires (different cents / FX). Multi-currency is designed, not built — do not silently convert INR into USD runway.
- `/calendar` is a redirect to `/forecast?tab=cashflow`. Do not revive a sixth tab. Month up/down lives in Forecast, then the widget snapshots that payload.
- `getAccounts` filtering `isActive == true` must not erase legacy history. Use a `legacy` role, do not delete.

## Design system (UI-100) — contract, not mood
Midnight Ledger dark `#101014` / Paper & Gold light `#FAF7EF`.
Three meanings only:
- Gold `#D9A521` dark / `#8A6D0B` light = brand, progress, warning (not a 4th hue)
- Teal `--money-in` `#1FA2A8` / `#177864` = money in (NEVER green; old red/green was deutan ΔE 2.4)
- Red `--money-out` `#E5484D` / `#C0393F` = money out / hard error

Radii: control 10 / card 16 / pill 999.
Type: serif (Iowan Old Style / Palatino) for hero numbers and screen titles; sans for UI; tabular nums on money.
Touch: 44px minimum. Web `.tap-target` grows hit box without growing layout.
Measure: `max-w-content` 896px.
Tokens are pinned by `design-tokens.test.ts` and mobile `src/theme/palette.ts` (hexes copied from `globals.css`). Do not introduce a second teal or a chart-green on the calendar.
Flow/Sankey `FLOW_COLORS` stay on Flow nodes only. Calendar and widget use `--money-in` / `--money-out` / muted only.
Auth may stay Paper; after login default to Midnight unless the user toggle says otherwise. Do not let `prefers-color-scheme` fight `data-theme`.
Gold as small tab text on cream fails contrast — active tab needs weight + indicator, not 10px gold-only.

## UI bar (mobile-first, professional)
Compete with Copilot / Monarch on the phone and Linear on the desktop.

IA — four thumb destinations, not five plus a colliding FAB:
- Home `/dashboard` — “Am I OK now?” Runway hero, what changed, next bills. Not a widget junk drawer.
- Forecast `/forecast` — “Will I be OK?” Includes the month up/down grid (cashflow tab).
- Activity `/history` — the ledger list. Flow (`/flow`) is the picture of the same past; do not give Flow its own tab. Keep the route.
- Accounts `/accounts` — own / owe, Plaid connect, import.

FAB = add transaction only, must not cover Accounts. Prefer header action or a center-tab gap on mobile web.
Desktop: change structure at `md`/`lg` (split auth, side column on Home). Do not only hide the tab bar.
Own every system surface in theme: 404, loading, empty, offline. The stock Next 404 on white with gold FAB still mounted is unacceptable.
One CTA per job. Login must not say “Sign up” twice.
Signup: primary button fully visible on a 390pt screen without scrolling past the card clip.
Copy: calm, precise. Empty/error states say what happened and the next tap. Never show $0 when the value is unknown.

## Month calendar + widget (shared contract)
Callable `getCalendarMonthCents`:

Input: `{ year, month, accountIds?: string[] }`
Omitted `accountIds` = US operating cash only (no legacy / NRE / NRO until currency ships).

> **Open question before building — #188.** Card purchases post on the card account, and card payments are transfers, so an operating-only scope drops card spending entirely (probe: same ledger, month net +$3,000.00 operating-only vs +$2,915.88 with cards). Resolve the default scope in #188 first.

Output:

```ts
{
  year: number;
  month: number;
  currency: "USD";
  monthNetCents: number | null;
  monthIncomeCents: number | null;
  monthExpenseCents: number | null;
  days: Array<{
    date: string; // YYYY-MM-DD
    netCents: number | null;
    incomeCents: number | null;
    expenseCents: number | null;
    hasActivity: boolean;
  }>;
  asOf: string; // ISO
}
```

Posted rows only. Day net = income − expense after interpret. Transfers do not paint a day red. Null month → “Not available”.

Web grid: 7 columns, teal / red / muted, serif month net, tap → that day’s activity.

Widget (mobile, later): App Group JSON only. Small = week + month net. Medium = month grid. Tap `cashflow://calendar?date=`. No Plaid, no Firestore, no re-sum in the extension. Reload on sync / review flush, not a 1-minute timer.

## How to work
- Read README, FLOW_ENGINE.md, ARCHITECTURE.md, `src/lib/classify.ts`, transfers, forecast, `nav.ts`, `globals.css`, and existing tests before touching money or chrome.
- Small PR. Match file layout and names. Prefer fixing the root (one interpreter, one token) over a screen-local patch.
- Every classification / sum / forecast / calendar change gets a Jest test that names the user-visible lie it prevents.
- No new Plaid products (Investments / Schwab positions) unless the slice says so.
- No logs of tokens, account numbers, or raw Plaid payloads.
- If DATABASE.md disagrees with README, follow README and fix the doc in the same PR.
- Do not rewrite the design system or add screens. Fold into the four destinations.

## Definition of done
- Mobile-width (390) and desktop (1280) both look intentional.
- Web totals agree across Home, Forecast, Activity, Flow, export.
- Tests green for the slice.
- Callable contract updated if mobile will need the field.
- No second money path on iOS.

## Do not do in a random slice
FX / INR conversion, Schwab Investments product, multi-tenant billing, restoring Analytics/Calendar/Cashflow as top-nav tabs, a second classifier, decorative extra hues, fake “Record cash” buttons.

## Slice protocol
I will start each session with one line, for example:
- Slice: designed 404 + empty + loading in theme. No money changes.
- Slice: Home `/dashboard` = runway-first mobile layout matching the iOS Home question order.
- Slice: tab bar four destinations; Flow reachable from Activity; FAB must not cover Accounts.
- Slice: `getCalendarMonthCents` + Forecast month grid + tests. No widget native yet.
- Slice: Plaid Link Schwab on web only; transfers checking↔brokerage are not spend.

Do that slice. Stop. List what you changed and what you did not.

---

## Appendix — repo operations (verified 2026-09-14)

### Shipping
- **A push to `main` deploys** `functions:api` + hosting (`.github/workflows/deploy.yml`), then smoke-tests the live pages and every callable. Never run `npm run deploy` after a merge. Pushes that change only `*.md` / `docs/**` do not deploy.
- `firestore.rules` and `functions-sync/` are **never** deployed by CI, on purpose. When main carries a change to them since the last successful deploy, the deploy opens (or comments on) a "Hand deploy needed" issue. Deploy from a fresh `git checkout main && git pull --ff-only` — `firebase deploy` ships the local tree.
- There is one Firebase project, and it is production. Tests use fixtures, mocks and the emulator only; screens are exercised through `/dev/*-fixture` routes.

### Checks (all run in `validate.yml` on every PR)

```
npx tsc --noEmit
npx jest                          # web
npm test --prefix functions       # Cloud Functions
python -m pytest functions-sync -q
npm run test:rules                # Firestore rules on the emulator
npm run test:e2e                  # Playwright: observability + every fixture screen
```

`e2e/screens.spec.ts` marks known screen defects with `test.fail` (#176, #177, #178). When you fix one, delete its line in `KNOWN`.

### The phone contract
`contracts/homeSnapshot.json` is recorded by `functions/src/__tests__/contract-homeSnapshot.test.ts`. If that test fails, you changed what the phone receives: re-record with `UPDATE_CONTRACTS=1 npm test --prefix functions -- contract`. The `mobile contract` CI job then runs cashflow-mobile's checks against it; if it fails, ship the mobile change first or keep the old field. A new callable the phone reads (e.g. `getCalendarMonthCents`) gets the same treatment.

### Engine habits
- **Nothing auto-applies.** Read `src/__tests__/counterparty-settlement.test.ts` before touching classification.
- **Pass the income policy** (`IncomeContext`) to `interpretTransaction` and friends. Omitting it silently creates a different income rule.
- Before believing a screen-level money bug, probe the engine: call `src/lib` directly in a throwaway test.

### CSS gotchas
- Tailwind v4 owns `--radius-*` and `--container-*`: declare them in `@theme`, not `:root`.
- Component classes go in `@layer components`. Unlayered CSS beats every utility.
- Turbopack serves stale CSS across restarts: `rm -rf .next` before judging a style.
