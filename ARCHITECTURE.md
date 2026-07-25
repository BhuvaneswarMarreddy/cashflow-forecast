# 🏛️ Architecture

How the app is structured: pages, components, the data model, state, project layout, and
the brand system. For the money-trace pipeline see **[FLOW_ENGINE.md](FLOW_ENGINE.md)**;
for AI see **[AI.md](AI.md)**.

← Back to [README](README.md)

## Contents
1. [Tech stack](#tech-stack)
2. [Page-by-Page Guide](#-page-by-page-guide)
3. [Components Deep Dive](#-components-deep-dive)
4. [Data Architecture](#️-data-architecture)
5. [Project Structure](#-project-structure)
6. [Brand & Theming](#-brand--theming--ink--gold)

---

## Tech stack

Next.js 16 (App Router) · React 19 · TypeScript · Firebase (Auth + Firestore + Hosting with
web-frameworks SSR on Cloud Functions gen2) · Recharts · date-fns · xlsx · Tailwind ·
OpenAI. **Money math is integer cents throughout**; dollars exist only at the render layer.

---

## 📱 Page-by-Page Guide

### 1. 🏠 Landing Page (`/`)
**Purpose:** Marketing/welcome page for new visitors.
- App introduction, feature highlights, Login/Signup buttons.
- Redirects to `/forecast` after login.

### 2. 🔐 Login Page (`/login`)
**Purpose:** Authenticate existing users.
- Email + Password login, Google Sign-In, link to signup, forgot-password link.
- After login: redirects to `/forecast` (or `/onboarding` if new).

### 3. 📝 Signup Page (`/signup`)
**Purpose:** Create new account (full name, email, password). After signup: `/onboarding`.

### 4. 🚀 Onboarding Page (`/onboarding`)
**Purpose:** Initial setup wizard. Data saved to the Firestore `users/{userId}` document.
Can be skipped, but the forecast will be limited.

1. **Bank Accounts** — name, type (Checking/Savings), current balance, last 4 (optional)
2. **Credit Cards** — name, provider (AMEX, Chase…), current balance owed, credit limit,
   APR, due date, link to the payment account (which checking pays this card)
3. **Loans** — name, balance owed, APR, monthly payment, due date, payment account
4. **Income Sources** — name, amount, frequency (Weekly/Biweekly/Monthly/Yearly), pay
   date, end date (optional, for contract work)

### 5. 📈 Forecast Page (`/forecast`) — **MAIN PAGE**
**Purpose:** The heart of the app — see your financial future.

- **A. Account Selector** — forecast for all accounts combined, an individual checking, or
  an individual card; shows linked card payments for a checking account.
- **B. Key Numbers (4 cards)** — Total Cash · Runway (Days) · Runway (Months) · Status
  ("All Clear" or "X days until low").
- **C. Time Period Selector** — 1M / 3M / 6M / 1Y horizon.
- **D. Forecast Chart** — balance over time, projected area, lowest point (red dot),
  safety-threshold line.
- **E. Forecast Timeline** — day-by-day or month-by-month, collapsible; 💵 income (green),
  📅 bills (amber), 💳 card payments (red), ⚠️ critical points.
- **F. AI Insights Panel** — monthly trend, spend vs last month, savings rate, top
  categories/merchants.
- **G. Decision Check Panel** — enter an amount → "Can I Afford This?" → Safe / Caution /
  Unsafe with an AI explanation.
- **H. Emergency Fund Panel** — runway in days/months, progress to a 3–6 month goal, daily
  burn rate.
- **I. AI Question Panel** — ask any financial question, answered from your data.
- **J. Planned Payments Panel** — a financial todo list of estimated payments: month-by-
  month navigation, priorities (🔴/🟡/🟢), status (Pending → Completed/Skipped), recurring
  support, notes. Actions: ✓ Complete (creates the real transaction), ✗ Skip, ✏️ Edit,
  🗑️ Delete. Summary shows pending and completed totals/counts.

### 6. 📜 History Page (`/history`)
**Purpose:** View, add, and analyze all transactions.

- **A. Compact Filter Bar** — Search (title/merchant/category) · Account (All / specific /
  Unlinked) · Time Period (All / This Month / Last Month / 3–6 Months) · Type
  (All/Income/Expenses) · Group By (Month/Year) · Sort (Newest/Oldest/Highest/Lowest).
- **B. Stats Summary** — Total Income, Total Expenses, Net.
- **C. Action Buttons** — Add Transaction · Scan Receipt · Import CSV.
- **D. Transaction List** — grouped by month/year, collapsible; each row shows merchant
  badge, title/date, category icon, account badge, signed amount, edit/delete.
- **E. Smart Classification** — transfers shown correctly (TO/FROM), card payments as
  positive (debt down), transfers excluded from income/expense totals.
- **F. Runway Calculator Tab** — current runway, what-if scenarios, 12-month projection.

### 7. 💳 Accounts Page (`/accounts`)
**Purpose:** Manage all financial accounts.
- **A. Payment Accounts** — banks, cards, loans; each shows balance, credit limit/APR, due
  date, payment link; add/edit/delete.
- **B. Income Sources** — name, amount, frequency, next pay date, end date; add/edit/delete.
- **C. Account Spending** — pick an account, see its transactions grouped by month with a
  monthly total.
- Also hosts **Category Budgets** and the **Debt Payoff Planner** tabs.

### 8. 📊 Analytics Page (`/analytics`)
**Purpose:** Visual spending analysis.
- Time navigation (prev/next, weekly/monthly) · daily-spending area chart with projection
  and budget line · 12-week/12-month period comparison (spending vs income vs budget) ·
  category breakdown (pie + bar) · merchant breakdown (top merchants) · projection alerts.

### 9. 📅 Calendar Page (`/calendar`)
**Purpose:** Calendar view — monthly grid colored by spending level; click a day for its
transactions; income green, expenses red, today highlighted.

### 10. 🎛️ Dashboard Page (`/dashboard`)
**Purpose:** Overview — quick stats, recent transactions, upcoming bills, link to Forecast.

### 11. ⚙️ Settings Page (`/settings`)
**Purpose:** Configuration — monthly budget, safety threshold, emergency-fund goal,
timezone, Excel export, profile management, logout.

### 12. 💳 Payment Methods Page (`/payment-methods`)
Legacy payment-methods management (now folded into Accounts).

### 13. 🔀 Flow Page (`/flow`)
**Purpose:** The money-flow trace. Full detail in **[FLOW_ENGINE.md](FLOW_ENGINE.md)**.

---

## 🧩 Components Deep Dive

### Core
| Component | File | Purpose |
|-----------|------|---------|
| `Navbar` | `Navbar.tsx` | Top nav with links, the coin `LogoMark`, and net balance |
| `LogoMark` | `LogoMark.tsx` | The animated gold-coin brand mark |
| `QuickAddFAB` | `QuickAddFAB.tsx` | Floating action button for mobile quick-add |
| `ClientLayout` | `ClientLayout.tsx` | Wraps pages with navbar and FAB |

### Transactions
| Component | File | Purpose |
|-----------|------|---------|
| `AddTransactionModal` | `AddTransactionModal.tsx` | Add/edit a transaction |
| `CSVImportModal` | `CSVImportModal.tsx` | Import transactions from CSV (see FLOW_ENGINE.md) |
| `ReceiptScannerModal` | `ReceiptScannerModal.tsx` | AI-powered receipt scanning |
| `AccountTransactions` | `AccountTransactions.tsx` | Transactions for a specific account |

### Forecast
| Component | File | Purpose |
|-----------|------|---------|
| `ForecastChart` | `ForecastChart.tsx` | Balance-over-time line chart |
| `ForecastTimeline` | `ForecastTimeline.tsx` | Day-by-day event list |
| `DecisionCheckPanel` | `DecisionCheckPanel.tsx` | "Can I afford this?" simulator |
| `EmergencyFundPanel` | `EmergencyFundPanel.tsx` | Emergency-fund progress |
| `RunwayCalculator` | `RunwayCalculator.tsx` | What-if scenarios and projections |
| `PlannedPaymentsPanel` | `PlannedPaymentsPanel.tsx` | Financial todo list |
| `UpcomingBillsPanel` / `SavingsGoalsPanel` / `DebtPlannerPanel` / `BudgetSettingsPanel` / `BudgetStatusPanel` | — | Bills, goals, debt payoff, budgets |

### AI
| Component | File | Purpose |
|-----------|------|---------|
| `AIQuestionPanel` | `AIQuestionPanel.tsx` | Ask questions about your finances |
| `AIInsightsPanel` | `AIInsightsPanel.tsx` | Monthly trends and AI analysis |

---

## 🗄️ Data Architecture

### Firebase Firestore structure

```
users/
  {userId}/
    - uid: string
    - email: string
    - displayName: string
    - settings: { currency, monthlyBudget, safetyThreshold,
                  emergencyFundGoal, categoryBudgets, notificationPreferences }
    - metadata: { isOnboarded, lastLoginAt }

    accounts/            (subcollection)
      {accountId}/       name, type: 'bank_account'|'credit_card'|'personal_loan',
                         balance, creditLimit?, apr?, dueDate?, paymentFromAccountId?

    income/              (subcollection)
      {incomeId}/        name, amount, frequency, payDate, endDate?, remainingPayments?

    transactions/        (subcollection)
      {transactionId}/   title, amount, type: 'income'|'expense'|'transfer',
                         category, sourceCategory?, paymentMethod, accountId?, merchant?,
                         description?, date, transferDirection?, isRecurring?,
                         recurringFrequency?, recurringEndDate?

    plannedTransactions/ (subcollection)
      {plannedId}/       title, amount, type, category, accountId?, dueDate, notes?,
                         status: 'pending'|'completed'|'skipped', priority,
                         isRecurring?, recurringFrequency?, completedDate?, linkedTransactionId?

    goals/               (subcollection)
      {goalId}/          name, targetAmount, currentAmount, targetDate?, priority(1-5), isActive
```

> **Balances stay user-entered** and are the source of truth — no transaction-derived
> balance can match reality when the source export is incomplete (see FLOW_ENGINE.md).

### Context providers
| Context | File | Purpose |
|---------|------|---------|
| `AuthContext` | `AuthContext.tsx` | User authentication state |
| `UserProfileContext` | `UserProfileContext.tsx` | Profile, accounts, income sources |
| `TransactionContext` | `TransactionContext.tsx` | All transactions |

### Data flow

```
User Action → Context Method → Firestore Service → Firebase → Context State → UI Update
     ↓                                                              ↑
  Component ←────────────────────────────────────────────────────────┘
```

localStorage is a fast cache; a successful Firestore read reconciles it. Both contexts
guard against an empty/failed read wiping the local mirror.

### Gotchas baked into the code
- Imported doc ids contain `%2F`/`%7C`; URL-path DELETE/PATCH re-decode them, so admin
  writes use the Firestore `:commit` batch API (`scripts/fsadmin.py`).
- `getAccounts` filters `where('isActive','==',true)` — a closed account disappears unless
  kept active.
- Account/profile writes must always attempt the server write (never gate on a cached
  online flag), or edits silently update only local state and vanish on reload.

---

## 📁 Project Structure

```
src/
├── app/                   # Next.js pages (App Router)
│   ├── forecast/          # Main page
│   ├── flow/              # Money-flow trace (FLOW_ENGINE.md)
│   ├── cashflow/          # Monthly cashflow
│   ├── history/           # Transactions + Runway tab
│   ├── accounts/          # Accounts, income, budgets, debt planner
│   ├── analytics/         # Spending analytics
│   ├── api/               # API routes (AI, receipt parsing)
│   ├── icon.svg / favicon.ico   # App icons (the coin mark)
│   ├── globals.css        # Theme tokens (Ink & Gold)
│   └── login, signup, onboarding, settings, calendar, dashboard, payment-methods …
├── components/            # React components
├── context/               # React Context providers
├── lib/
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

## 🎨 Brand & Theming — "Ink & Gold"

- **Mark:** a gold coin with an embossed C and a slow gleam sweep —
  `src/components/LogoMark.tsx` (animated, motion-reduce safe). Static source in
  `src/app/icon.svg` and `public/logos/logo-mark.svg`; all favicons/app-icons are rendered
  from it.
- **Theme:** single dark theme. Graphite surfaces, gold accent, dark text on gold CTAs.
  Tokens live in **`src/app/globals.css`** — `--background`, surfaces, `--accent-primary`
  (gold), `--foreground`, borders; success/danger/warning stay semantic.
- **Charts:** the categorical palette in **`src/lib/palette.ts`** (`CAT_COLORS`,
  `FLOW_COLORS`) is gold-anchored and **CVD-validated** (colorblind-safe) with the dataviz
  validator in both light and dark. Card-brand hues (Amex/Chase/Visa/Discover) keep their
  real brand colors.
