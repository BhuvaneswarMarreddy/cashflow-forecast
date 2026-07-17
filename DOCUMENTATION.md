# CashFlow Forecast - Complete User Documentation

## 📋 Table of Contents
1. [Application Overview](#application-overview)
2. [User Flow Diagrams](#user-flow-diagrams)
3. [Page-by-Page Navigation Guide](#page-by-page-navigation-guide)
4. [Feature Implementation Details](#feature-implementation-details)
5. [Data Flow & Storage](#data-flow--storage)
6. [Visual Checklist](#visual-checklist)

---

## Application Overview

CashFlow Forecast is a personal finance application designed for young professionals (ages 22-29) to manage their finances with a **manual-first** approach (no bank sync). The app focuses on:

- **Cash Flow Forecasting** - See your future balance projections
- **Budget Management** - Set and track category spending limits  
- **Savings Goals** - Track progress toward financial goals
- **Debt Planning** - Strategic debt payoff with snowball/avalanche methods
- **Transaction Tracking** - Manual entry with CSV import and receipt scanning
- **AI-Powered Insights** - Get explanations, not advice

---

## User Flow Diagrams

### 🔄 Main Application Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              AUTHENTICATION                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│   ┌──────────┐    ┌──────────┐    ┌──────────────┐                          │
│   │  Login   │───▶│  Signup  │───▶│  Onboarding  │                          │
│   └──────────┘    └──────────┘    └──────────────┘                          │
│        │                                  │                                   │
│        │    ┌─────────────────────────────┘                                   │
│        │    │                                                                 │
│        ▼    ▼                                                                 │
│   ┌──────────────────────────────────────────────────────────────────────┐   │
│   │                         MAIN NAVIGATION                              │   │
│   │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐                │   │
│   │  │ Forecast │ │ Overview │ │ History  │ │ Accounts │                │   │
│   │  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘                │   │
│   └───────│────────────│────────────│────────────│───────────────────────┘   │
│           │            │            │            │                            │
│           ▼            ▼            ▼            ▼                            │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 📊 Forecast Page Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            FORECAST PAGE                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                    TIME PERIOD SELECTOR                              │   │
│   │              [ 1M ] [ 3M ] [ 6M ] [ 1Y ]                             │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                               │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                    ACCOUNT SELECTOR                                  │   │
│   │   [ All Accounts ] [ Chase Checking ] [ Amex Card ] [ ... ]         │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                               │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                    ESSENTIAL NUMBERS                                 │   │
│   │  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐   │   │
│   │  │ Total Cash  │ │Runway Days  │ │Runway Months│ │   Status    │   │   │
│   │  │  $12,500    │ │    125      │ │    4.2      │ │  All Clear  │   │   │
│   │  └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘   │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                               │
│   ┌───────────────────────────────────┬─────────────────────────────────┐   │
│   │          LEFT COLUMN              │        RIGHT COLUMN             │   │
│   ├───────────────────────────────────┼─────────────────────────────────┤   │
│   │                                   │                                 │   │
│   │  ┌─────────────────────────────┐  │  ┌─────────────────────────┐   │   │
│   │  │     FORECAST CHART          │  │  │   DECISION CHECK        │   │   │
│   │  │   (Line graph showing       │  │  │   "Can I afford $X?"    │   │   │
│   │  │    balance over time)       │  │  │   [Enter Amount]        │   │   │
│   │  │                             │  │  │   [Check] Button        │   │   │
│   │  └─────────────────────────────┘  │  └─────────────────────────┘   │   │
│   │                                   │                                 │   │
│   │  ┌─────────────────────────────┐  │  ┌─────────────────────────┐   │   │
│   │  │    FORECAST TIMELINE        │  │  │   BUDGET STATUS         │   │   │
│   │  │   (List of upcoming events) │  │  │   (Category spending)   │   │   │
│   │  │   • Jan 15 - Rent -$1500    │  │  │   Groceries: 75% used   │   │   │
│   │  │   • Jan 20 - Paycheck +$4k  │  │  │   Entertainment: 45%    │   │   │
│   │  └─────────────────────────────┘  │  └─────────────────────────┘   │   │
│   │                                   │                                 │   │
│   │  ┌─────────────────────────────┐  │  ┌─────────────────────────┐   │   │
│   │  │     AI INSIGHTS             │  │  │   UPCOMING BILLS        │   │   │
│   │  │   (Monthly trends,          │  │  │   (Next 14 days)        │   │   │
│   │  │    spending patterns,       │  │  │   • Feb 5 - Amex $500   │   │   │
│   │  │    savings rate analysis)   │  │  │   • Feb 10 - Insurance  │   │   │
│   │  │   [Get AI Insights] btn     │  │  └─────────────────────────┘   │   │
│   │  └─────────────────────────────┘  │                                 │   │
│   │                                   │  ┌─────────────────────────┐   │   │
│   │                                   │  │   SAVINGS GOALS         │   │   │
│   │                                   │  │   Emergency Fund: 60%   │   │   │
│   │                                   │  │   Vacation: 25%         │   │   │
│   │                                   │  │   [Add Goal] button     │   │   │
│   │                                   │  └─────────────────────────┘   │   │
│   │                                   │                                 │   │
│   │                                   │  ┌─────────────────────────┐   │   │
│   │                                   │  │   EMERGENCY FUND        │   │   │
│   │                                   │  │   3.2 months saved      │   │   │
│   │                                   │  │   Goal: 6 months        │   │   │
│   │                                   │  └─────────────────────────┘   │   │
│   │                                   │                                 │   │
│   │                                   │  ┌─────────────────────────┐   │   │
│   │                                   │  │   AI Q&A PANEL          │   │   │
│   │                                   │  │   "Ask about finances"  │   │   │
│   │                                   │  │   [Send] button         │   │   │
│   │                                   │  └─────────────────────────┘   │   │
│   └───────────────────────────────────┴─────────────────────────────────┘   │
│                                                                               │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 💰 Accounts Page Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            ACCOUNTS PAGE                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                      SUMMARY CARDS                                   │   │
│   │  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐   │   │
│   │  │Bank Balance │ │Credit Used  │ │Monthly Income│ │Monthly Budget│   │   │
│   │  │  $15,000    │ │   $2,500    │ │   $6,500    │ │   $4,000    │   │   │
│   │  └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘   │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                               │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                          TABS                                        │   │
│   │  [Accounts] [Spending] [Income] [Budget] [Categories] [Debt Plan]   │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                               │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                      TAB CONTENT                                     │   │
│   │                                                                       │   │
│   │  ═══════════════════════════════════════════════════════════════    │   │
│   │  ACCOUNTS TAB:                                                       │   │
│   │  ├─ [+ Add Account] button                                          │   │
│   │  ├─ Chase Checking ••1234     $12,000  [Edit] [Delete]             │   │
│   │  ├─ Amex Gold ••5678          -$2,500  [Edit] [Delete]             │   │
│   │  │   └─ Paid from: Chase Checking                                   │   │
│   │  │   └─ APR: 24.99% • Due: 15th                                    │   │
│   │  └─ Car Loan ••9012           -$15,000 [Edit] [Delete]             │   │
│   │                                                                       │   │
│   │  ═══════════════════════════════════════════════════════════════    │   │
│   │  SPENDING TAB:                                                       │   │
│   │  ├─ Transactions grouped by account                                 │   │
│   │  ├─ Shows which transactions are linked to which account            │   │
│   │  └─ "Unlinked Transactions" section at bottom                       │   │
│   │                                                                       │   │
│   │  ═══════════════════════════════════════════════════════════════    │   │
│   │  INCOME TAB:                                                         │   │
│   │  ├─ [+ Add Income] button                                           │   │
│   │  ├─ Salary - Monthly - $5,500 - Pay day: 1st [Edit] [Delete]       │   │
│   │  └─ Freelance - Monthly - $1,000 [Edit] [Delete]                   │   │
│   │                                                                       │   │
│   │  ═══════════════════════════════════════════════════════════════    │   │
│   │  BUDGET TAB:                                                         │   │
│   │  ├─ Target Monthly Spending input                                   │   │
│   │  ├─ [Save Budget] button                                            │   │
│   │  └─ Shows savings potential (Income - Budget)                       │   │
│   │                                                                       │   │
│   │  ═══════════════════════════════════════════════════════════════    │   │
│   │  CATEGORIES TAB (Budgets):                                           │   │
│   │  ├─ Current Month Status (progress bars)                            │   │
│   │  │   ├─ Groceries: $300/$400 (75%)                                 │   │
│   │  │   └─ Entertainment: $150/$200 (75%)                             │   │
│   │  ├─ Set Category Limits                                             │   │
│   │  │   ├─ [+ Add Budget] button                                      │   │
│   │  │   └─ [Suggest Budgets] button (50/30/20 rule)                   │   │
│   │  └─ Edit/Delete existing budgets                                    │   │
│   │                                                                       │   │
│   │  ═══════════════════════════════════════════════════════════════    │   │
│   │  DEBT PLAN TAB:                                                      │   │
│   │  ├─ Strategy selector: [Snowball] [Avalanche]                       │   │
│   │  ├─ Extra Monthly Payment input                                     │   │
│   │  ├─ Debt Summary Table:                                             │   │
│   │  │   ├─ Account | Balance | APR | Min Payment | Payoff Order       │   │
│   │  │   ├─ Amex   | $2,500  | 25% | $75         | 1st                 │   │
│   │  │   └─ Car Loan| $15,000 | 5%  | $400        | 2nd                 │   │
│   │  └─ Shows: Total interest saved, Payoff timeline                    │   │
│   │                                                                       │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                               │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 📜 History Page Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            HISTORY PAGE                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  VIEW TOGGLE:  [History] [Runway]                                    │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                               │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                    STATS & ACTIONS BAR                               │   │
│   │  Income: +$6,500   Expenses: -$4,200   Net: +$2,300                 │   │
│   │                                            [Add] [Scan] [Import]    │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                               │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                      FILTERS ROW                                     │   │
│   │  [🔍 Search...] [Account ▼] [Time ▼] [All|In|Out] [Month|Year] [Sort]│   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                               │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                   TRANSACTION LIST                                   │   │
│   │                                                                       │   │
│   │  ┌─────────────────────────────────────────────────────────────┐    │   │
│   │  │ ▼ January 2026 (45 transactions)     +$6,500  -$4,200      │    │   │
│   │  ├─────────────────────────────────────────────────────────────┤    │   │
│   │  │ 🏠 Rent Payment      Jan 15 • Housing       -$1,500 [✏️][🗑️]│    │   │
│   │  │ 🍕 Grocery Store     Jan 14 • Groceries     -$120   [✏️][🗑️]│    │   │
│   │  │ 💼 Direct Deposit    Jan 1  • Salary        +$5,500 [✏️][🗑️]│    │   │
│   │  └─────────────────────────────────────────────────────────────┘    │   │
│   │                                                                       │   │
│   │  ┌─────────────────────────────────────────────────────────────┐    │   │
│   │  │ ▶ December 2025 (38 transactions)    +$6,200  -$3,800      │    │   │
│   │  └─────────────────────────────────────────────────────────────┘    │   │
│   │                                                                       │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                               │
│   ═══════════════════════════════════════════════════════════════════════   │
│                                                                               │
│   RUNWAY VIEW (when toggled):                                                │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                    RUNWAY CALCULATOR                                 │   │
│   │  Current Cash: $12,500                                               │   │
│   │  Monthly Expenses: $4,200                                            │   │
│   │  Runway: 2.9 months                                                  │   │
│   │                                                                       │   │
│   │  [Chart showing money depletion over time]                          │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                               │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 🏠 Dashboard Page Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            DASHBOARD (Overview)                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │ [!] Complete your setup: Add accounts • Set up income • Set budget  │   │
│   │                                              [Continue Setup →]      │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                               │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │              FORECAST SUMMARY CARD (clickable)                       │   │
│   │  📈 Cash Flow Forecast                                               │   │
│   │  See your financial future for the next 90 days                     │   │
│   │                                                                       │   │
│   │  Lowest Point: $2,500    Safety Status: Safe    [View Forecast →]   │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                               │
│   Welcome back, John!                              [+ Add Transaction]      │
│                                                                               │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                     YOUR ACCOUNTS                [Manage →]          │   │
│   │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐               │   │
│   │  │ Chase    │ │ Amex     │ │ Savings  │ │ Cash     │               │   │
│   │  │ $12,000  │ │ -$2,500  │ │ $8,000   │ │ $500     │               │   │
│   │  │ ████████ │ │ ██░░░░░░ │ │          │ │          │               │   │
│   │  └──────────┘ └──────────┘ └──────────┘ └──────────┘               │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                               │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │                     STATS CARDS                                      │   │
│   │  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐   │   │
│   │  │Cash Available│ │Credit Used  │ │Monthly Income│ │Budget Left  │   │   │
│   │  │  $20,500    │ │   $2,500    │ │   $6,500    │ │   $1,800    │   │   │
│   │  └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘   │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                               │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │ ⚠️ UPCOMING BILLS                                                    │   │
│   │  Amex Gold    Due Feb 5 (5 days)    $500                            │   │
│   │  Insurance    Due Feb 10 (10 days)  $200                            │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                               │
│   ┌────────────────────────────┐  ┌────────────────────────────────────┐   │
│   │    MONTHLY OVERVIEW        │  │    BY PAYMENT METHOD               │   │
│   │    [Line Chart]            │  │    [Pie Chart]                     │   │
│   │    Income vs Expenses      │  │    Chase 60%, Amex 30%, Cash 10%   │   │
│   └────────────────────────────┘  └────────────────────────────────────┘   │
│                                                                               │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │              EXPENSES BY CATEGORY (Bar Chart)                        │   │
│   │  Housing      ████████████████████████  $1,500                       │   │
│   │  Groceries    ██████████                $600                         │   │
│   │  Transport    ████████                  $400                         │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                               │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │              INCOME SOURCES                      [Manage →]          │   │
│   │  💼 Salary    Monthly • Day 1    +$5,500                            │   │
│   │  💻 Freelance Monthly             +$1,000                            │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                               │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │              RECENT TRANSACTIONS                 [All|Past|Future]   │   │
│   │  🏠 Rent Payment       Jan 15, 2026    Chase        -$1,500         │   │
│   │  🍕 Grocery Store      Jan 14, 2026    Amex         -$120           │   │
│   │  💼 Direct Deposit     Jan 1, 2026     --           +$5,500         │   │
│   │                                        [View All Transactions →]     │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                               │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Page-by-Page Navigation Guide

### 1. 🔐 Authentication Flow

| Page | URL | Purpose | Actions |
|------|-----|---------|---------|
| Login | `/login` | User authentication | Email/password login |
| Signup | `/signup` | New user registration | Create account |
| Forgot Password | `/forgot-password` | Password recovery | Reset email |
| Onboarding | `/onboarding` | Initial setup | Add accounts, income, budget |

### 2. 📊 Forecast Page (`/forecast`)

**Primary Purpose:** Answer "Can I afford this?" and see future cash position.

**Key Sections:**
| Section | Location | Purpose |
|---------|----------|---------|
| Time Period Selector | Top header | Switch between 1M/3M/6M/1Y views |
| Account Selector | Below header | View all accounts or single account forecast |
| Essential Numbers | 4-card grid | Current cash, runway days, runway months, status |
| Forecast Chart | Left column | Visual line graph of balance over time |
| Forecast Timeline | Left column | List of upcoming income/expenses |
| AI Insights Panel | Left column | Monthly trends, savings rate, spending analysis |
| Decision Check | Right column | "Can I spend $X?" calculator |
| Budget Status | Right column | Category spending vs limits |
| Upcoming Bills | Right column | Bills due in next 14 days |
| Savings Goals | Right column | Progress toward savings targets |
| Emergency Fund | Right column | Months of runway saved |
| AI Q&A | Right column | Ask questions about finances |

### 3. 🏠 Dashboard Page (`/dashboard`)

**Primary Purpose:** Quick overview of financial health.

**Key Sections:**
| Section | Purpose |
|---------|---------|
| Setup Banner | Prompts to complete onboarding if needed |
| Forecast Summary | Quick view of forecast, links to full forecast |
| Account Cards | Visual cards for each account with balances |
| Stats Cards | Cash available, credit used, income, budget remaining |
| Upcoming Bills Alert | Warning for bills due soon |
| Monthly Overview Chart | Line chart of income vs expenses |
| Payment Method Pie Chart | Spending distribution by payment method |
| Category Bar Chart | Spending by category |
| Income Sources | List of income sources |
| Recent Transactions | Last 8 transactions |

### 4. 📜 History Page (`/history`)

**Primary Purpose:** View, add, import, and manage transactions.

**Key Features:**
| Feature | Description |
|---------|-------------|
| View Toggle | Switch between History and Runway views |
| Add Transaction | Manual entry modal |
| Scan Receipt | AI-powered receipt scanning |
| Import CSV | Bulk import from bank exports |
| Search | Full-text search across transactions |
| Account Filter | Filter by specific payment account |
| Date Filter | All time, this month, last month, 3/6 months |
| Type Filter | All, Income only, Expense only |
| Group By | Month or Year grouping |
| Sort | Newest, oldest, highest, lowest |
| Edit/Delete | Modify or remove transactions |

### 5. 💳 Accounts Page (`/accounts`)

**Primary Purpose:** Manage all financial accounts, income, budgets, and debt.

**Tabs:**
| Tab | Purpose | Key Actions |
|-----|---------|-------------|
| Accounts | Manage payment accounts | Add/edit/delete accounts, link credit cards to checking |
| Spending | View transactions by account | See which transactions are linked where |
| Income | Manage income sources | Add/edit/delete income, set pay dates |
| Budget | Set monthly spending target | Save overall budget, see savings potential |
| Categories | Category-level budgets | Set limits per category, get 50/30/20 suggestions |
| Debt Plan | Strategic debt payoff | Choose snowball/avalanche, set extra payments |

### 6. ⚙️ Settings Page (`/settings`)

**Purpose:** Account management and data export.

**Sections:**
| Section | Options |
|---------|---------|
| Profile | Update display name |
| Financial | Link to Accounts page |
| Data | Export all data to Excel |
| Danger Zone | Sign out |

---

## Feature Implementation Details

### Transaction Management

```
ADD TRANSACTION FLOW:
┌─────────────┐   ┌─────────────┐   ┌─────────────┐
│  + Button   │──▶│   Modal     │──▶│   Saved     │
│  or FAB     │   │   Form      │   │   to DB     │
└─────────────┘   └─────────────┘   └─────────────┘
                        │
                        ▼
              ┌─────────────────┐
              │  Fields:        │
              │  • Title        │
              │  • Amount       │
              │  • Date         │
              │  • Type         │
              │  • Category     │
              │  • Account      │
              │  • Description  │
              │  • Recurring?   │
              │    └─ Frequency │
              │    └─ End Date  │
              │    └─ Count     │
              └─────────────────┘
```

### Recurring Transactions

```
RECURRING LOGIC:
┌──────────────────────────────────────────────────────────────────────┐
│                                                                       │
│   Frequency Options:                                                  │
│   ├─ Weekly     (every 7 days)                                       │
│   ├─ Biweekly   (every 14 days)                                      │
│   ├─ Monthly    (same date each month)                               │
│   └─ Yearly     (same date each year)                                │
│                                                                       │
│   End Conditions (choose one):                                        │
│   ├─ End Date   (stops after specific date)                          │
│   ├─ Count      (stops after N occurrences)                          │
│   └─ Neither    (continues indefinitely)                             │
│                                                                       │
│   Example:                                                            │
│   Car Insurance: $150/month for 6 months                             │
│   Car Lease: $400/month for 39 months                                │
│   Salary: $5,500/month (until end date if job ends)                  │
│                                                                       │
└──────────────────────────────────────────────────────────────────────┘
```

### Budget System

```
BUDGET FLOW:
┌───────────────────┐
│  Monthly Budget   │
│  (Overall target) │
└─────────┬─────────┘
          │
          ▼
┌───────────────────────────────────────────────────────────────────────┐
│                    CATEGORY BUDGETS                                   │
│                                                                       │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐    │
│  │  Groceries  │ │   Housing   │ │Entertainment│ │  Transport  │    │
│  │   $400/mo   │ │  $1,500/mo  │ │   $200/mo   │ │   $300/mo   │    │
│  │  ████░░░░   │ │  ████████   │ │  ██░░░░░░   │ │  ████░░░░   │    │
│  │    75%      │ │    100%     │ │    25%      │ │    60%      │    │
│  └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘    │
│                                                                       │
│  50/30/20 Rule Suggestions:                                          │
│  • Needs (50%): $3,250                                               │
│  • Wants (30%): $1,950                                               │
│  • Savings (20%): $1,300                                             │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
```

### Debt Payoff Strategies

```
DEBT STRATEGIES:
┌──────────────────────────────────────────────────────────────────────┐
│                                                                       │
│  SNOWBALL (Pay smallest balance first)                               │
│  ├─ Motivational wins                                                │
│  ├─ Builds momentum                                                  │
│  └─ May pay more interest overall                                    │
│                                                                       │
│  AVALANCHE (Pay highest APR first)                                   │
│  ├─ Mathematically optimal                                           │
│  ├─ Saves most money on interest                                     │
│  └─ May take longer to see first payoff                             │
│                                                                       │
│  PAYOFF CALCULATION:                                                  │
│  1. Sort debts by strategy (balance or APR)                         │
│  2. Pay minimums on all debts                                        │
│  3. Apply extra payment to #1 priority                               │
│  4. When #1 paid off, roll payment to #2                            │
│  5. Calculate total interest & payoff timeline                       │
│                                                                       │
└──────────────────────────────────────────────────────────────────────┘
```

### AI Integration

```
AI CONTEXT PROVIDED:
┌──────────────────────────────────────────────────────────────────────┐
│                                                                       │
│  FORECAST DATA:                                                       │
│  ├─ Current balance                                                  │
│  ├─ Lowest balance point & date                                      │
│  ├─ Safety threshold                                                 │
│  ├─ Days until unsafe                                                │
│  ├─ Upcoming bills (next 5)                                          │
│  └─ Upcoming income (next 3)                                         │
│                                                                       │
│  BUDGET DATA:                                                         │
│  ├─ Category limits                                                  │
│  ├─ Current spending                                                 │
│  ├─ Percent used                                                     │
│  └─ Over budget categories                                           │
│                                                                       │
│  SAVINGS DATA:                                                        │
│  ├─ Goal names & targets                                             │
│  ├─ Current amounts                                                  │
│  └─ Percent complete                                                 │
│                                                                       │
│  DEBT DATA:                                                           │
│  ├─ Account names                                                    │
│  ├─ Balances & APRs                                                  │
│  └─ Minimum payments                                                 │
│                                                                       │
│  AI RULES:                                                            │
│  • NEVER calculate balances (use provided data)                      │
│  • NEVER give financial advice                                       │
│  • NEVER use judgmental language                                     │
│  • ONLY explain what the numbers show                                │
│                                                                       │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Data Flow & Storage

### Firestore Collections

```
FIRESTORE STRUCTURE:
┌──────────────────────────────────────────────────────────────────────┐
│                                                                       │
│  users/{userId}                                                       │
│  ├─ name                                                             │
│  ├─ email                                                            │
│  ├─ monthlyBudget                                                    │
│  ├─ isOnboarded                                                      │
│  ├─ paymentAccounts[]                                                │
│  │   ├─ id, name, type, provider, balance                           │
│  │   ├─ creditLimit, apr, statementDate, dueDate                    │
│  │   ├─ paymentFromAccountId (links card to checking)               │
│  │   └─ color, lastFourDigits, isActive                             │
│  ├─ incomeSources[]                                                  │
│  │   ├─ id, name, amount, frequency                                 │
│  │   ├─ payDate, endDate                                            │
│  │   └─ isActive                                                     │
│  └─ settings                                                         │
│      ├─ safetyThreshold                                              │
│      ├─ categoryBudgets[]                                            │
│      │   ├─ categoryId, monthlyLimit, isEnabled                     │
│      └─ notificationPreferences                                      │
│          ├─ remindDaysBefore[]                                       │
│          └─ channels[]                                               │
│                                                                       │
│  users/{userId}/transactions                                          │
│  ├─ id, title, amount, date, type                                    │
│  ├─ category, paymentMethod, description                             │
│  ├─ accountId, merchant                                              │
│  └─ isRecurring, recurringFrequency, recurringEndDate, recurringCount│
│                                                                       │
│  users/{userId}/goals                                                 │
│  ├─ id, name, targetAmount, currentAmount                            │
│  ├─ targetDate, priority, linkedAccountId                            │
│  └─ createdAt, updatedAt                                             │
│                                                                       │
│  users/{userId}/reminders                                             │
│  ├─ id, date, title, amount                                          │
│  ├─ relatedAccountId, relatedTransactionTemplateId                   │
│  └─ status (upcoming/dismissed/paid)                                 │
│                                                                       │
└──────────────────────────────────────────────────────────────────────┘
```

### Data Sync Flow

```
DATA SYNC:
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Browser   │────▶│  Firestore  │────▶│   Context   │
│   (User)    │◀────│  (Database) │◀────│   (State)   │
└─────────────┘     └─────────────┘     └─────────────┘
      │                   │                    │
      │                   │                    │
      ▼                   ▼                    ▼
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│ User Action │     │  Real-time  │     │ UI Updates  │
│ (Add, Edit) │     │   Listeners │     │ (Re-render) │
└─────────────┘     └─────────────┘     └─────────────┘
```

---

## Visual Checklist

Use this checklist when testing the application visually:

### Navigation & Layout
- [ ] Navbar displays correctly with all 4 links (Forecast, Overview, History, Accounts)
- [ ] Active nav item is highlighted
- [ ] User dropdown menu works
- [ ] Mobile menu opens/closes correctly
- [ ] Net Balance shows in header

### Forecast Page
- [ ] Time period selector buttons work (1M/3M/6M/1Y)
- [ ] Account selector shows all accounts
- [ ] Essential numbers cards display correctly
- [ ] Forecast chart renders with correct data
- [ ] Timeline shows upcoming events
- [ ] All right-column panels expand/collapse
- [ ] Decision Check calculates correctly
- [ ] AI insights button triggers loading state

### Dashboard
- [ ] Setup banner shows if incomplete
- [ ] Forecast summary card is clickable
- [ ] Account cards show correct balances
- [ ] Stats cards have correct values
- [ ] Charts render (line, pie, bar)
- [ ] Recent transactions list works
- [ ] All "View more" links work

### History Page
- [ ] View toggle (History/Runway) works
- [ ] Add/Scan/Import buttons open modals
- [ ] Search filters transactions
- [ ] Account dropdown filters correctly
- [ ] Date filter works
- [ ] Type filter (All/In/Out) works
- [ ] Month/Year grouping works
- [ ] Sort options work
- [ ] Group expand/collapse works
- [ ] Edit/Delete buttons work
- [ ] Transaction amounts show correct colors (+ green, - normal)
- [ ] Transfers don't count in totals

### Accounts Page
- [ ] Summary cards show correct totals
- [ ] All 6 tabs switch correctly
- [ ] Accounts Tab: Add/Edit/Delete works
- [ ] Accounts Tab: Linked payment account shows
- [ ] Spending Tab: Transactions grouped by account
- [ ] Income Tab: Add/Edit/Delete works
- [ ] Budget Tab: Save budget works
- [ ] Categories Tab: Budget progress bars show
- [ ] Categories Tab: Add budget modal works
- [ ] Debt Plan Tab: Strategy selector works
- [ ] Debt Plan Tab: Calculations display correctly

### Modals & Forms
- [ ] Add Transaction Modal opens/closes
- [ ] All form fields work
- [ ] Recurring options show/hide correctly
- [ ] CSV Import parses file correctly
- [ ] Receipt Scanner opens camera/upload
- [ ] Delete confirmations work
- [ ] Account Modal shows all fields for type

### Responsive Design
- [ ] Works on mobile (< 640px)
- [ ] Works on tablet (640-1024px)
- [ ] Works on desktop (> 1024px)
- [ ] Charts resize correctly
- [ ] Tables scroll horizontally on mobile

---

## Summary

CashFlow Forecast provides a comprehensive, manual-first approach to personal finance management with:

1. **Core Features**
   - Cash flow forecasting with account-level detail
   - Budget management at overall and category levels
   - Transaction tracking with CSV import and receipt scanning
   - Savings goals with progress tracking
   - Debt payoff planning with snowball/avalanche strategies

2. **AI Integration**
   - Decision explanations (not advice)
   - Spending pattern analysis
   - Monthly trend insights

3. **Data Management**
   - Real-time sync with Firestore
   - Excel export of all data
   - Offline-capable with localStorage caching

4. **User Experience**
   - Clean, modern UI with dark theme
   - Collapsible panels for information density
   - Mobile-responsive design
   - Quick actions via floating action button

The app is designed for young professionals preparing for financial uncertainty, with emphasis on expense control, transaction awareness, and proactive planning.
