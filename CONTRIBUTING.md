# 🛠️ Contributing & Operations

Setup, testing, the deploy gate, admin data ops, and coding conventions. For how the app
is structured see **[ARCHITECTURE.md](ARCHITECTURE.md)**.

← Back to [README](README.md)

---

## Prerequisites
- Node.js 18+ (Firebase Functions run on Node 24)
- npm
- A Firebase project (Auth + Firestore + Hosting)
- An OpenAI API key

## Installation

```bash
git clone <repository-url>
cd cashflow-forecast
npm install
cp .env.example .env.local
```

## Environment variables

```env
# Required
OPENAI_API_KEY=sk-...

# Firebase (public client config)
NEXT_PUBLIC_FIREBASE_API_KEY=...
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=...
NEXT_PUBLIC_FIREBASE_PROJECT_ID=...
```

> **SSR gotcha:** the Firebase web-frameworks adapter reads the **root `.env`** (not
> `.env.local`) at deploy time. AI keys the server function needs must live in the root
> `.env`, which the deploy depends on and which is gitignored.

## Development

```bash
npm run dev      # dev server at http://localhost:3000
npm run build    # production build
npm run lint     # eslint
```

---

## Testing

```bash
npm test              # run all suites
npm run test:watch    # watch mode
npm run test:coverage # coverage report
```

Suites in `src/__tests__/` cover the forecast engine, transaction classification, CSV
import, the type system, user-flow integration, transfers, and the flow engine —
**including `flows.integration.test.ts`, which replays the real CSVs through the engine on
every run** and asserts the reconciliation to the cent (see
[FLOW_ENGINE.md](FLOW_ENGINE.md#verification--the-run-it-in-loops-guarantee)).

The standalone audit loop `scripts/verify_flow_groundtruth.py` re-derives the frozen
ground-truth numbers directly from the CSVs.

---

## Deploying

**Always deploy via the gate** — it blocks broken builds from reaching production:

```bash
npm run deploy
```

This runs, in order: **tsc → the full jest suite → a React-hooks crash-rule scan** (added
after a conditional-hook bug once shipped a white screen), and only then
`firebase deploy --only hosting`. The gate script is `scripts/predeploy.sh`. Never
hand-run `firebase deploy` to bypass a failing gate.

Browsers cache aggressively — after a UI/theme change, hard-refresh (Cmd/Ctrl+Shift+R) or
use a private window; favicon changes ship with a `?v=` cache-buster in
`src/app/layout.tsx`.

---

## Admin data operations — `scripts/fsadmin.py`

Server-side data tooling. **Every mutating command is a dry-run until you pass `--apply`,
and destructive steps back up first** to `scripts/backups/`.

```bash
python3 scripts/fsadmin.py summary  --email you@example.com          # counts + breakdown
python3 scripts/fsadmin.py backup   --email you@example.com          # snapshot transactions
python3 scripts/fsadmin.py purge    --email you@example.com          # DRY RUN
python3 scripts/fsadmin.py purge    --email you@example.com --apply  # deletes all subcollections, backs up first
```

Notes:
- Resolves the uid via Firebase **Auth**, not the users collection (a profile doc may be
  missing while subcollections exist).
- All writes use the Firestore `:commit` batch API — imported doc ids contain `%2F`/`%7C`,
  and a URL-path DELETE/PATCH re-decodes them into a silent no-op.
- If a call 401s, refresh the CLI token: `firebase projects:list --non-interactive`.

---

## Coding conventions

- **Integer cents everywhere** in money logic (`toCents`); format to dollars only at
  render.
- **Dates compare as `yyyy-MM-dd` strings** (`day(iso)`), never Date instants — the app
  serves an IST user and UTC-midnight math has dropped rows before.
- **One classifier.** All income/expense/transfer decisions go through
  `src/lib/classify.ts`; don't re-derive inline.
- **Server writes always attempt** — never gate a Firestore mutation on a cached
  online flag; the try/catch handles true offline.
- **Non-trivial logic ships a test.** Frozen audit targets are frozen: when a check fails,
  fix the code or your understanding, not the target.
- Charts: keep the categorical palette **CVD-validated** (run the dataviz validator); don't
  hand-pick chart colors.

## Pull requests

1. Branch off the current feature branch.
2. Add/adjust tests; `npm test` and `npm run build` must be green.
3. Keep the diff focused; follow the conventions above.
4. Open a PR describing the change and how you verified it.

## License

MIT.
