# 💰 CashFlow Forecast

**A Personal Finance Management System for the Next Generation**

> *"If I spend money today, what will happen to me in the next 30-90 days?"*

CashFlow Forecast is a forward-looking personal finance application designed specifically for **young adults (20-29 years old)** who want to take control of their finances, build financial resilience, and prepare for economic uncertainties like the potential 2026 recession.

**🌐 Live Application:** https://cashflow-forecast-prod.web.app

---

## 📋 Table of Contents

1. [Purpose & Philosophy](#-purpose--philosophy)
2. [Who This Is For](#-who-this-is-for)
3. [Key Features Overview](#-key-features-overview)
4. [Page-by-Page Guide](#-page-by-page-guide)
5. [Components Deep Dive](#-components-deep-dive)
6. [Data Architecture](#-data-architecture)
7. [AI Features](#-ai-features)
8. [Recession Preparation Guide](#-recession-preparation-guide)
9. [What's Currently Missing](#-whats-currently-missing)
10. [Technical Setup](#-technical-setup)
11. [Testing](#-testing)

---

## 🎯 Purpose & Philosophy

### Core Question
This app exists to answer **ONE question at any moment**:
> "If I spend money today, what will happen to me in the next 30-90 days?"

### Foundational Concepts

| Concept | Explanation |
|---------|-------------|
| **Money has TIME** | $100 today ≠ $100 on Feb 5. Every transaction lives on a date. |
| **Fixed vs Flexible** | Bills ≠ food ≠ Amazon ≠ fun. They must never mix. |
| **Certainty > Precision** | Estimates are okay. Forecasts beat exact math. Manual override > bank sync. |

### Design Philosophy
- **Non-judgmental**: Never shames you for spending
- **Forward-looking**: Shows what's COMING, not just what happened
- **Decision-focused**: Helps you make choices BEFORE spending
- **Calm & Clear**: No anxiety-inducing charts or red warnings everywhere

---

## 👤 Who This Is For

### Target Audience: Young Adults (20-29)

This app is designed for someone who:
- Is just starting to manage their own finances
- Has income (salary, freelance, gig work)
- Has recurring bills (rent, subscriptions, loans)
- Wants to see where their money goes
- Needs to prepare for economic uncertainty
- Doesn't want a complicated banking app

### Common Scenarios This Solves

| Scenario | How This App Helps |
|----------|-------------------|
| "Can I afford to buy this?" | Decision Check Panel simulates spending impact |
| "When will I run out of money?" | Runway Calculator shows days/months of expenses covered |
| "I don't know where my money goes" | History page shows spending by category & merchant |
| "I have too many subscriptions" | Account view shows all recurring charges |
| "I'm scared about the recession" | Emergency Fund Panel helps you build 3-6 months buffer |
| "I get paid Friday, can I survive till then?" | Forecast Timeline shows daily balance projections |

---

## ✨ Key Features Overview

### 🔮 Forward-Looking Forecast
- See your projected balance for the next 30, 90, 180, or 365 days
- Know your lowest balance point BEFORE it happens
- Get warnings before you hit unsafe territory

### 🤖 AI-Powered Insights
- Ask questions: "Why is next month tight?"
- Get trend analysis: "Your spending increased 15%"
- Receive actionable suggestions without judgment

### 📊 Smart Transaction Classification
- Automatically detects transfers (not income/expense)
- Recognizes credit card payments (reduces debt, not income)
- Identifies merchants and categories automatically

### 📱 Multi-Platform
- Full desktop experience
- Mobile-responsive design
- Quick-add floating button on mobile
- Receipt scanner with camera support

### 🔐 Secure & Private
- Firebase Authentication
- Data stored in Firestore (your data, your account)
- No bank connections required
- Manual control over all data

---

## 📱 Page-by-Page Guide

### 1. 🏠 Landing Page (`/`)
**Purpose:** Marketing/welcome page for new visitors

**What you see:**
- App introduction
- Feature highlights
- Login/Signup buttons

**Path:** Redirects to `/forecast` after login

---

### 2. 🔐 Login Page (`/login`)
**Purpose:** Authenticate existing users

**Options:**
- Email + Password login
- Google Sign-In
- Link to signup
- Forgot password link

**After login:** Redirects to `/forecast` (or `/onboarding` if new user)

---

### 3. 📝 Signup Page (`/signup`)
**Purpose:** Create new account

**Required info:**
- Full name
- Email address
- Password

**After signup:** Redirects to `/onboarding`

---

### 4. 🚀 Onboarding Page (`/onboarding`)
**Purpose:** Initial setup wizard for new users

**Steps:**
1. **Add Bank Accounts**
   - Account name
   - Account type (Checking, Savings)
   - Current balance
   - Last 4 digits (optional)

2. **Add Credit Cards**
   - Card name
   - Provider (AMEX, Chase, etc.)
   - Current balance (what you owe)
   - Credit limit
   - APR
   - Due date
   - Link to payment account (which checking pays this card)

3. **Add Loans**
   - Loan name
   - Balance owed
   - APR
   - Monthly payment
   - Due date
   - Payment account

4. **Add Income Sources**
   - Source name (Salary, Freelance, etc.)
   - Amount
   - Frequency (Weekly, Biweekly, Monthly, Yearly)
   - Pay date
   - End date (optional - for contract work)

**Data saved to:** Firestore `users/{userId}` document

**Can be skipped:** Yes, but forecast will be limited

---

### 5. 📈 Forecast Page (`/forecast`) - **MAIN PAGE**
**Purpose:** The heart of the app - see your financial future

**Sections:**

#### A. Account Selector (Top)
- Dropdown to view forecast for:
  - All accounts combined
  - Individual checking accounts
  - Individual credit cards
- Shows linked credit card payments for checking accounts

#### B. Key Numbers (4 cards)
| Card | What It Shows |
|------|---------------|
| Total Cash | Sum of all checking/savings accounts |
| Runway (Days) | How many days your cash will last |
| Runway (Months) | How many months of expenses covered |
| Status | "All Clear" or "X days until low" |

#### C. Time Period Selector
- 1 Month / 3 Months / 6 Months / 1 Year buttons
- Changes the forecast horizon

#### D. Forecast Chart
- Visual line chart of your balance over time
- Shows projected balance (green area)
- Highlights lowest point (red dot)
- Shows safety threshold line

#### E. Forecast Timeline
- Day-by-day or month-by-month view
- Collapsible groups
- Shows each event:
  - 💵 Income (green)
  - 📅 Bills (amber)
  - 💳 Credit card payments (red)
  - ⚠️ Critical points (red highlight)

#### F. AI Insights Panel
- Monthly trend analysis
- Spending vs last month
- Savings rate calculation
- Top categories and merchants
- "Get Insights" button for AI analysis

#### G. Decision Check Panel
- Enter an amount
- Click "Can I Afford This?"
- See risk level: Safe / Caution / Unsafe
- AI explains the impact

#### H. Emergency Fund Panel
- Current runway in days/months
- Progress toward 3-6 month goal
- Daily burn rate
- AI insight about your safety net

#### I. AI Question Panel
- Ask any financial question
- AI responds based on your data
- Examples:
  - "Why is my balance low next week?"
  - "What bills are coming up?"
  - "Should I wait to buy this?"

#### J. Planned Payments Panel (NEW!)
- **Financial Todo List** for estimated payments
- Add planned expenses/income for each month
- Features:
  - Month-by-month navigation
  - Priority levels (🔴 High, 🟡 Medium, 🟢 Low)
  - Status tracking (Pending → Completed/Skipped)
  - Recurring payments support
  - Notes field
- Actions:
  - ✓ **Complete**: Mark as done and create actual transaction
  - ✗ **Skip**: Skip this month (can restore later)
  - ✏️ **Edit**: Modify details
  - 🗑️ **Delete**: Remove permanently
- Summary shows:
  - Pending total and count
  - Completed total and count

---

### 6. 📜 History Page (`/history`)
**Purpose:** View, add, and analyze all transactions

**Features:**

#### A. Compact Filter Bar
| Filter | Options |
|--------|---------|
| Search | By title, merchant, category |
| Account | All / Specific account / Unlinked |
| Time Period | All Time / This Month / Last Month / 3-6 Months |
| Type | All / Income / Expenses |
| Group By | Month / Year |
| Sort | Newest / Oldest / Highest / Lowest |

#### B. Stats Summary
- Total Income (green)
- Total Expenses (red)
- Net (income - expenses)

#### C. Action Buttons
- **Add Transaction**: Manual entry
- **Scan Receipt**: AI-powered receipt scanner
- **Import CSV**: Bulk import from bank statements

#### D. Transaction List
- Grouped by month/year
- Collapsible sections
- Each transaction shows:
  - Merchant badge (colored)
  - Title and date
  - Category icon
  - Account badge (if linked)
  - Amount (+/- with color)
  - Edit and Delete buttons

#### E. Smart Classification
- Transfers (TO/FROM) shown correctly
- Credit card payments shown as positive (reduces debt)
- Transfers excluded from income/expense totals

#### F. Runway Calculator Tab
- Switch between History and Runway views
- Shows current runway
- "What-if" scenarios
- 12-month projection chart

---

### 7. 💳 Accounts Page (`/accounts`)
**Purpose:** Manage all financial accounts

**Tabs:**

#### A. Payment Accounts Tab
- List of all accounts:
  - Bank accounts
  - Credit cards
  - Loans
- Each card shows:
  - Balance
  - Credit limit / APR (for credit cards)
  - Due date
  - Payment account link
- Edit and Delete buttons
- Add new account button

#### B. Income Sources Tab
- List of all income:
  - Name and amount
  - Frequency
  - Next pay date
  - End date (if set)
- Edit and Delete buttons
- Add new income button

#### C. Account Spending Tab
- Select an account
- View all transactions linked to that account
- Grouped by month
- Total spent per month

---

### 8. 📊 Analytics Page (`/analytics`)
**Purpose:** Visual spending analysis (like stock charts)

**Features:**

#### A. Time Navigation
- Previous/Next period buttons
- Weekly or Monthly view toggle

#### B. Daily Spending Chart
- Area chart showing spending per day
- Projected spending for future days
- Budget line for comparison

#### C. Period Comparison
- 12-week or 12-month chart
- Compare spending vs income vs budget

#### D. Category Breakdown
- Pie chart of spending by category
- Bar chart showing each category amount
- Color-coded by category

#### E. Merchant Breakdown
- Top merchants you spend with
- Pie chart visualization
- Click to filter transactions

#### F. Projection Alerts
- Warnings if projected spending exceeds budget
- Weekly/Monthly projections

---

### 9. 📅 Calendar Page (`/calendar`)
**Purpose:** Calendar view of transactions and events

**Features:**
- Monthly calendar grid
- Days colored by spending level
- Click a day to see transactions
- Income shown in green
- Expenses shown in red
- Today highlighted

---

### 10. 🎛️ Dashboard Page (`/dashboard`)
**Purpose:** Overview dashboard (legacy, redirects to Forecast)

**Shows:**
- Quick stats
- Recent transactions
- Upcoming bills
- Link to Forecast

---

### 11. ⚙️ Settings Page (`/settings`)
**Purpose:** App configuration

**Options:**
- Monthly budget
- Safety threshold
- Emergency fund goal
- Timezone
- Notifications (future)
- Profile management
- Logout

---

### 12. 💳 Payment Methods Page (`/payment-methods`)
**Purpose:** Legacy payment methods management (now in Accounts)

---

## 🧩 Components Deep Dive

### Core Components

| Component | File | Purpose |
|-----------|------|---------|
| `Navbar` | `Navbar.tsx` | Top navigation bar with links and user profile |
| `QuickAddFAB` | `QuickAddFAB.tsx` | Floating action button for mobile quick-add |
| `ClientLayout` | `ClientLayout.tsx` | Wraps pages with navbar and FAB |

### Transaction Components

| Component | File | Purpose |
|-----------|------|---------|
| `AddTransactionModal` | `AddTransactionModal.tsx` | Form to add/edit transactions |
| `CSVImportModal` | `CSVImportModal.tsx` | Import transactions from CSV files |
| `ReceiptScannerModal` | `ReceiptScannerModal.tsx` | AI-powered receipt scanning |
| `AccountTransactions` | `AccountTransactions.tsx` | Show transactions for a specific account |

### Forecast Components

| Component | File | Purpose |
|-----------|------|---------|
| `ForecastChart` | `ForecastChart.tsx` | Line chart showing balance over time |
| `ForecastTimeline` | `ForecastTimeline.tsx` | Day-by-day event list |
| `DecisionCheckPanel` | `DecisionCheckPanel.tsx` | "Can I afford this?" simulator |
| `EmergencyFundPanel` | `EmergencyFundPanel.tsx` | Emergency fund progress tracker |
| `RunwayCalculator` | `RunwayCalculator.tsx` | What-if scenarios and projections |
| `PlannedPaymentsPanel` | `PlannedPaymentsPanel.tsx` | Financial todo list for planned payments |

### AI Components

| Component | File | Purpose |
|-----------|------|---------|
| `AIQuestionPanel` | `AIQuestionPanel.tsx` | Ask questions about your finances |
| `AIInsightsPanel` | `AIInsightsPanel.tsx` | Monthly trends and AI analysis |

---

## 🗄️ Data Architecture

### Firebase Firestore Structure

```
users/
  {userId}/
    - uid: string
    - email: string
    - displayName: string
    - settings: {
        currency: string
        monthlyBudget: number
        safetyThreshold: number
        emergencyFundGoal: number
        categoryBudgets: array
      }
    - metadata: {
        isOnboarded: boolean
        lastLoginAt: timestamp
      }
    
    accounts/           (subcollection)
      {accountId}/
        - name: string
        - type: 'bank_account' | 'credit_card' | 'personal_loan'
        - balance: number
        - creditLimit?: number
        - apr?: number
        - dueDate?: number
        - paymentFromAccountId?: string
        
    income/             (subcollection)
      {incomeId}/
        - name: string
        - amount: number
        - frequency: string
        - payDate: number
        - endDate?: string
        - remainingPayments?: number
        
    transactions/       (subcollection)
      {transactionId}/
        - title: string
        - amount: number
        - type: 'income' | 'expense'
        - category: string
        - paymentMethod: string
        - accountId?: string
        - merchant?: string
        - date: timestamp
        - isRecurring?: boolean
        - recurringFrequency?: string
        - recurringEndDate?: string
        
    plannedTransactions/ (subcollection) - NEW!
      {plannedId}/
        - title: string
        - amount: number
        - type: 'income' | 'expense'
        - category: string
        - accountId?: string
        - dueDate: timestamp
        - notes?: string
        - status: 'pending' | 'completed' | 'skipped'
        - priority: 'high' | 'medium' | 'low'
        - isRecurring?: boolean
        - recurringFrequency?: string
        - completedDate?: timestamp
        - linkedTransactionId?: string
        
    goals/              (subcollection)
      {goalId}/
        - name: string
        - targetAmount: number
        - currentAmount: number
        - targetDate?: string
        - priority: 1-5
        - isActive: boolean
```

### Context Providers

| Context | File | Purpose |
|---------|------|---------|
| `AuthContext` | `AuthContext.tsx` | User authentication state |
| `UserProfileContext` | `UserProfileContext.tsx` | Profile, accounts, income sources |
| `TransactionContext` | `TransactionContext.tsx` | All transactions |

### Data Flow

```
User Action → Context Method → Firestore Service → Firebase → Context State → UI Update
     ↓                                                              ↑
  Component ←────────────────────────────────────────────────────────┘
```

---

## 🤖 AI Features

### 1. Decision Check (`/api/ai/decision`)
**Input:** Spending amount + forecast data
**Output:** Risk level + explanation

```
"You want to spend $500. After this, your lowest balance will be 
$1,200 on March 15th. This is above your safety threshold of $500, 
so this purchase is safe."
```

### 2. Question Answering
**Input:** Any question + forecast data
**Output:** Contextual answer

```
User: "Why is next week tight?"
AI: "Your balance drops to $800 on March 10th because your rent 
($1,500) and car payment ($350) are both due that week. Consider 
waiting until after your paycheck on March 15th."
```

### 3. Monthly Insights
**Input:** 3-6 months of transaction history
**Output:** Trend analysis + suggestions

```
"Your spending increased 12% compared to last month, primarily in 
the Shopping category ($450 → $580). Your savings rate is currently 
15%. Consider setting a weekly budget for discretionary spending."
```

### 4. Receipt Scanning (`/api/parse-receipt`)
**Input:** Photo/screenshot of receipt
**Output:** Extracted transaction data

```json
{
  "merchant": "Target",
  "amount": 47.82,
  "date": "2025-12-28",
  "category": "shopping",
  "items": ["Groceries", "Household"]
}
```

### AI Configuration
- **Model:** GPT-4o-mini
- **Temperature:** 0.3 (factual, consistent)
- **Max Tokens:** 200-400
- **Tone:** Calm, non-judgmental, helpful

---

## 🛡️ Recession Preparation Guide

### Why This Matters (2026 Preparation)

Economic downturns are cyclical. The app helps you:
1. **Know Your Runway** - How many months can you survive without income?
2. **Build Emergency Fund** - Goal: 3-6 months of expenses
3. **Track Spending** - Know where to cut if needed
4. **See the Future** - Don't get surprised by bills

### Recommended Actions

| Action | How to Use the App |
|--------|-------------------|
| **Build 3-6 month emergency fund** | Use Emergency Fund Panel to track progress |
| **Reduce unnecessary subscriptions** | View recurring transactions in History |
| **Track all spending** | Import CSV from all bank accounts |
| **Know your monthly expenses** | Analytics page shows average spending |
| **Simulate job loss** | Runway Calculator "what-if" scenarios |
| **Pay down high-interest debt** | Track credit card balances and APRs |

### Emergency Fund Goals

| Safety Level | Months of Expenses | Who Needs This |
|--------------|-------------------|----------------|
| Minimum | 1 month | Stable job, dual income |
| Standard | 3 months | Most people |
| Comfortable | 6 months | Single income, gig workers |
| Recession-Ready | 12 months | High-risk job, preparing for downturn |

---

## ✅ Recently Added Features (February 2026)

| Feature | Description | Location |
|---------|-------------|----------|
| **Planned Payments (NEW!)** | Financial todo list - add estimated monthly payments, track status (pending/completed/skipped), mark complete to create transactions. Navigate by month, set priorities (high/medium/low), support for recurring items | Forecast page (right sidebar) |
| **Custom Logo & Branding** | New professional logo with chart arrow, dollar ($) and rupee (₹) symbols in gold on deep blue theme. Symbolizes earning in USD → saving/investing in INR | App-wide |
| **Deep Blue Theme** | Updated UI theme with deep blue gradients replacing purple, focusing on values without distraction | App-wide |
| **Category Budgets** | Set monthly spending limits per category (food, shopping, etc.) with real-time tracking, projections, and visual progress bars | Accounts → Category Budgets tab |
| **Bill Reminders** | Automatic reminder generation from credit card due dates, loan payments, and recurring transactions. Shows upcoming bills for next 14 days | Forecast page (right sidebar) |
| **Savings Goals** | Create and track savings goals with target amounts, dates, and priority. Quick-add amounts and visual progress | Forecast page (right sidebar) + full view in Accounts |
| **Debt Payoff Planner** | Snowball and Avalanche strategy calculator. Shows payoff timeline, interest saved, and debt-free date | Accounts → Debt Planner tab |
| **Excel Export** | Download all data as .xlsx file with multiple sheets (Summary, Accounts, Transactions, Budgets, Goals, Debt Plan) | Settings → Export Data |

## 🚧 What's Still Missing

### High Priority (Should Add)

| Feature | Description | Why Important |
|---------|-------------|---------------|
| **Push Notifications** | Browser/mobile push for bill reminders | Never miss a payment |
| **Recurring Transaction Templates** | Quick-add common transactions | Faster data entry |
| **Bank Connection (Plaid)** | Auto-import transactions | Less manual work (optional - manual-first design)

### Medium Priority (Nice to Have)

| Feature | Description |
|---------|-------------|
| **Multi-Currency Support** | For international users |
| **Shared Accounts** | Joint finance tracking with partner |
| **Investment Tracking** | Portfolio value and returns |
| **Tax Category Tagging** | Mark deductible expenses |
| **Custom Reports** | Generate spending reports PDF |
| **Dark/Light Theme Toggle** | User preference |

### Low Priority (Future)

| Feature | Description |
|---------|-------------|
| **Mobile App (React Native)** | Native iOS/Android app |
| **Apple/Google Wallet Integration** | Auto-capture transactions |
| **Receipt OCR Improvements** | Better extraction accuracy |
| **Financial Education** | Tips and tutorials |
| **Community Insights** | Anonymous spending comparisons |

### For Young Adults Specifically

| Feature | Why They Need It |
|---------|------------------|
| **Student Loan Tracker** | Track federal/private loan payments |
| **Rent Split Calculator** | For roommates |
| **Side Hustle Income Tracker** | Multiple income streams |
| **"Latte Factor" Calculator** | Show impact of daily small purchases |
| **First Apartment Checklist** | Budget for moving out |
| **Credit Score Education** | How spending affects credit |

---

## 🛠️ Technical Setup

### Prerequisites
- Node.js 18+
- npm or yarn
- Firebase account
- OpenAI API key

### Installation

```bash
# Clone repository
git clone <repository-url>
cd cashflow-forecast

# Install dependencies
npm install

# Create environment file
cp .env.example .env.local

# Add your keys to .env.local
OPENAI_API_KEY=your-openai-key
```

### Environment Variables

```env
# Required
OPENAI_API_KEY=sk-...

# Firebase (auto-configured)
NEXT_PUBLIC_FIREBASE_API_KEY=...
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=...
NEXT_PUBLIC_FIREBASE_PROJECT_ID=...
```

### Development

```bash
# Start dev server
npm run dev

# Build for production
npm run build

# Run tests
npm test

# Deploy to Firebase
firebase deploy
```

### Project Structure

```
src/
├── app/                    # Next.js pages
│   ├── forecast/          # Main forecast page
│   ├── history/           # Transaction history
│   ├── accounts/          # Account management
│   ├── analytics/         # Spending analytics
│   ├── api/               # API routes (AI)
│   └── ...
├── components/            # React components
├── context/               # React Context providers
├── lib/                   # Utilities
│   ├── firebase.ts        # Firebase config
│   ├── firestore.ts       # Database operations
│   ├── forecast.ts        # Forecast calculations
│   └── ai-config.ts       # AI prompts
└── types/                 # TypeScript types
```

---

## 🧪 Testing

### Run Tests

```bash
# Run all tests
npm test

# Watch mode
npm run test:watch

# Coverage report
npm run test:coverage
```

### Test Coverage

| Test Suite | Tests | Coverage |
|------------|-------|----------|
| Forecast Engine | 14 | Core calculations |
| Transaction Classification | 18 | Income/expense/transfer logic |
| CSV Import | 21 | Parsing various bank formats |
| Type System | 14 | Data validation |
| User Flows | 49 | Integration scenarios |

### Test Files

```
src/__tests__/
├── forecast.test.ts              # Forecast calculations
├── transaction-classification.test.ts  # Smart classification
├── csv-import.test.ts            # CSV parsing
├── types.test.ts                 # Type validation
└── user-flows.test.ts            # User scenarios
```

---

## 📞 Support & Contributing

### Report Issues
File bugs at: [GitHub Issues]

### Feature Requests
Submit ideas at: [GitHub Discussions]

### Contributing
1. Fork the repository
2. Create feature branch
3. Write tests
4. Submit pull request

---

## 📜 License

MIT License - Use freely for personal and commercial projects.

---

## 🙏 Acknowledgments

Built with:
- **Next.js 16** - React framework
- **Firebase** - Authentication & database
- **OpenAI GPT-4o-mini** - AI insights
- **Recharts** - Data visualization
- **Tailwind CSS** - Styling
- **Lucide Icons** - UI icons

---

**Remember:** The goal is not to track every penny. The goal is to **know what's coming** and **make confident decisions**. 

*Build your safety net. See your future. Control your money.*

---

*Last updated: February 2026*
