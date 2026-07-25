# 🏛️ Architecture

How the app is structured: the data model, state, pages, components, and the brand system.
For the money-trace pipeline see **[FLOW_ENGINE.md](FLOW_ENGINE.md)**; for AI see
**[AI.md](AI.md)**.

← Back to [README](README.md)

---

## Tech stack

Next.js 16 (App Router) · React 19 · TypeScript · Firebase (Auth + Firestore + Hosting with
web-frameworks SSR on Cloud Functions gen2) · Recharts · date-fns · xlsx · Tailwind ·
OpenAI. **Money math is integer cents throughout**; dollars exist only at the render layer.

## Project structure

```
src/
├── app/                   # Next.js pages (App Router)
│   ├── forecast/          # Main page — the financial future
│   ├── flow/              # Money-flow trace (see FLOW_ENGINE.md)
│   ├── cashflow/          # Monthly cashflow view
│   ├── history/           # Transactions + Runway tab
│   ├── accounts/          # Accounts, income, budgets, debt planner
│   ├── analytics/         # Spending analytics
│   ├── api/               # API routes (AI, receipt parsing)
│   ├── icon.svg / favicon.ico   # App icons (the coin mark)
│   ├── globals.css        # Theme tokens (Ink & Gold)
│   └── login, signup, onboarding, settings, calendar, dashboard …
├── components/            # React components
├── context/               # React Context providers
├── lib/                   # Pure logic
│   ├── classify.ts        # The one transaction classifier
│   ├── transfers.ts       # Transfer-leg pairing
│   ├── flows.ts           # Flow graph + reconciliation + recurring + projection
│   ├── forecast.ts        # Forecast calculations & derived balances
│   ├── firestore.ts       # Database operations
│   ├── firebase.ts        # Firebase config
│   ├── palette.ts         # CVD-validated chart palette
│   └── ai-config.ts       # AI prompts
├── __tests__/             # Jest tests (unit + CSV audit replay)
└── types/                 # TypeScript types
```

---

## Data model (Firestore)

```
users/{userId}
  ├─ uid, email, displayName
  ├─ settings: { currency, monthlyBudget, safetyThreshold,
  │              emergencyFundGoal, categoryBudgets, notificationPreferences }
  ├─ metadata: { isOnboarded, lastLoginAt }
  │
  ├─ accounts/{accountId}         name, type: bank_account|credit_card|personal_loan,
  │                               balance, creditLimit?, apr?, dueDate?, paymentFromAccountId?
  ├─ income/{incomeId}            name, amount, frequency, payDate, endDate?
  ├─ transactions/{txId}          title, amount, type: income|expense|transfer,
  │                               category, sourceCategory?, paymentMethod, accountId?,
  │                               merchant?, description?, date, transferDirection?, isRecurring?
  ├─ plannedTransactions/{id}     title, amount, type, category, dueDate,
  │                               status: pending|completed|skipped, priority, isRecurring?
  └─ goals/{goalId}               name, targetAmount, currentAmount, targetDate?, priority, isActive
```

**Balances are the source of truth** and stay user-entered — no transaction-derived balance
can match reality when the source export is incomplete (see FLOW_ENGINE.md).

### Gotchas baked into the code
- Doc ids for imported rows contain `%2F`/`%7C`; URL-path DELETE/PATCH re-decode them, so
  all admin writes use the Firestore `:commit` batch API (`scripts/fsadmin.py`).
- `getAccounts` filters `where('isActive','==',true)` — a closed account disappears unless
  kept active.
- Account/profile writes must always attempt the server write (never gate on a cached
  online flag), or edits silently update only local state and vanish on reload.

---

## State (Context providers)

| Context | File | Responsibility |
|---|---|---|
| `AuthContext` | `context/AuthContext.tsx` | User authentication state |
| `UserProfileContext` | `context/UserProfileContext.tsx` | Profile, accounts, income sources |
| `TransactionContext` | `context/TransactionContext.tsx` | All transactions |

**Data flow:** `User action → Context method → Firestore service → Firebase → Context
state → UI`. localStorage is a fast cache; a successful Firestore read reconciles it. Both
contexts guard against an empty/failed read wiping the local mirror.

---

## Page-by-page guide

| Page | Path | Purpose |
|---|---|---|
| **Forecast** ⭐ | `/forecast` | The main page. Account selector, key numbers (cash, runway, status), horizon selector, forecast chart + day-by-day timeline, and the AI / decision / emergency-fund / planned-payments panels. |
| **Flow** | `/flow` | Money-flow trace — Sankey / treemap / waterfall, reconciliation, recurring, projection. See FLOW_ENGINE.md. |
| **Cashflow** | `/cashflow` | Where income goes month by month; category breakdown; rewards. |
| **History** | `/history` | All transactions with filter/search/group/sort, stats summary, add / scan-receipt / import-CSV, and a Runway Calculator tab. |
| **Accounts** | `/accounts` | Payment accounts, income sources, per-account spending, category budgets, and the debt payoff planner. |
| **Analytics** | `/analytics` | Daily-spending area chart, period comparison, category & merchant breakdowns, projection alerts. |
| **Calendar** | `/calendar` | Monthly grid colored by spending; click a day for its transactions. |
| **Settings** | `/settings` | Budget, safety threshold, emergency-fund goal, timezone, Excel export, profile/logout. |
| **Landing / Login / Signup / Onboarding** | `/`, `/login`, `/signup`, `/onboarding` | Marketing, auth, and the initial setup wizard (accounts → cards → loans → income). |

---

## Components

**Core:** `Navbar` (top nav + the coin `LogoMark` + net balance), `QuickAddFAB` (mobile
quick-add), `ClientLayout` (wraps pages).

**Transactions:** `AddTransactionModal`, `CSVImportModal`, `ReceiptScannerModal`,
`AccountTransactions`.

**Forecast:** `ForecastChart`, `ForecastTimeline`, `DecisionCheckPanel`,
`EmergencyFundPanel`, `RunwayCalculator`, `PlannedPaymentsPanel`, `UpcomingBillsPanel`,
`SavingsGoalsPanel`, `DebtPlannerPanel`, `BudgetSettingsPanel` / `BudgetStatusPanel`.

**AI:** `AIQuestionPanel`, `AIInsightsPanel`, `DecisionCheckPanel`.

---

## Brand & theming — "Ink & Gold"

- **Mark:** a gold coin with an embossed C and a slow gleam sweep —
  `src/components/LogoMark.tsx` (animated, motion-reduce safe). Static source in
  `src/app/icon.svg` and `public/logos/logo-mark.svg`; all favicons/app-icons are rendered
  from it.
- **Theme:** single dark theme. Graphite surfaces, gold accent, dark text on gold CTAs (so
  they stay crisp). Tokens live in **`src/app/globals.css`** — `--background`, surfaces,
  `--accent-primary` (gold), `--foreground`, borders; success/danger/warning stay
  semantic.
- **Charts:** the categorical palette in **`src/lib/palette.ts`** (`CAT_COLORS`,
  `FLOW_COLORS`) is gold-anchored and **CVD-validated** (colorblind-safe) with the dataviz
  validator in both light and dark. Card-brand hues (Amex/Chase/Visa/Discover) are left as
  their real brand colors.
