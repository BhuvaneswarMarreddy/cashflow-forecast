# 💰 CashFlow Forecast

**A Personal Finance Management System for the Next Generation**

> *"If I spend money today, what will happen to me in the next 30-90 days?"*

CashFlow Forecast is a forward-looking personal finance application designed specifically for **young adults (20-29 years old)** who want to take control of their finances, build financial resilience, and prepare for economic uncertainties like the potential 2026 recession.

**🌐 Live Application:** https://marreddy-cashflow.web.app

---

## 📚 Documentation

This README is the product overview. Deep detail lives in four focused docs:

| Doc | What's inside |
|---|---|
| **[FLOW_ENGINE.md](FLOW_ENGINE.md)** ⭐ | The money-trace pipeline end-to-end: import → classify → pair → reconcile → visualize, plus the verification guarantees. |
| **[ARCHITECTURE.md](ARCHITECTURE.md)** | Page-by-page guide, components, the Firestore data model, contexts, project structure, and the Ink & Gold brand. |
| **[AI.md](AI.md)** | The AI features (decision check, Q&A, monthly insights, receipt scanning) and configuration. |
| **[CONTRIBUTING.md](CONTRIBUTING.md)** | Setup, environment variables, testing, the deploy gate, admin data ops, and coding conventions. |

### Quick start

```bash
npm install
cp .env.example .env.local     # add OPENAI_API_KEY (see CONTRIBUTING.md)
npm run dev                    # http://localhost:3000
npm test                       # full suite, incl. the CSV audit replay
npm run deploy                 # gated deploy (tsc + tests + hooks-check → firebase)
```

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
| **Trust the balance, not the flow** | User-entered balances are truth; CSV exports drop rows, so they're authoritative for *flows* only (see [FLOW_ENGINE.md](FLOW_ENGINE.md)). |

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
| "Where did every dollar go?" | **Flow page** traces income → accounts → out (see FLOW_ENGINE.md) |
| "Can I afford to buy this?" | Decision Check Panel simulates spending impact |
| "When will I run out of money?" | Runway Calculator shows days/months of expenses covered |
| "I don't know where my money goes" | History page shows spending by category & merchant |
| "I have too many subscriptions" | Recurring-payment detector on the Flow page |
| "I'm scared about the recession" | Emergency Fund Panel helps you build 3-6 months buffer |
| "I get paid Friday, can I survive till then?" | Forecast Timeline shows daily balance projections |

---

## ✨ Key Features Overview

### 🔀 Money-Flow Trace ⭐
- Every dollar from income → between accounts → out, as a clickable Sankey
- Treemap and waterfall views; the waterfall lands on exactly $0 (proof it all adds up)
- Reconciles to your real net worth to the cent; missing export rows shown as ⚠ nodes
- → **[FLOW_ENGINE.md](FLOW_ENGINE.md)**

### 🔮 Forward-Looking Forecast
- See your projected balance for the next 30, 90, 180, or 365 days
- Know your lowest balance point BEFORE it happens
- Get warnings before you hit unsafe territory

### 🤖 AI-Powered Insights
- Ask questions: "Why is next month tight?"
- Get trend analysis: "Your spending increased 15%"
- Receive actionable suggestions without judgment
- → **[AI.md](AI.md)**

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
| **Reduce unnecessary subscriptions** | Recurring-payment detector on the Flow page |
| **Track all spending** | Import CSV from all bank accounts |
| **Know your monthly expenses** | Analytics page shows average spending |
| **Simulate job loss** | Runway Calculator "what-if" scenarios |
| **Pay down high-interest debt** | Track balances & APRs; Debt Payoff Planner |

### Emergency Fund Goals

| Safety Level | Months of Expenses | Who Needs This |
|--------------|-------------------|----------------|
| Minimum | 1 month | Stable job, dual income |
| Standard | 3 months | Most people |
| Comfortable | 6 months | Single income, gig workers |
| Recession-Ready | 12 months | High-risk job, preparing for downturn |

---

## ✅ Recently Added

| Feature | Description | Location |
|---------|-------------|----------|
| **Money-Flow Trace (NEW!)** | Full dollar-tracing pipeline + Flow page — Sankey / treemap / waterfall, reconciliation to net worth, recurring detection, 12-month projection | `/flow` — see FLOW_ENGINE.md |
| **Ink & Gold rebrand** | Gold-coin logo (animated gleam) on graphite surfaces, gold accent, CVD-validated chart palette. Replaces the earlier deep-blue theme | App-wide |
| **Native Monarch CSV import** | Deterministic ids make monthly re-uploads overwrite instead of duplicate; auto-creates accounts | History → Import CSV |
| **Transfer detection & pairing** | Internal moves matched leg-to-leg and excluded from income/spending — the feature Monarch lacks | Flow + History |
| **Planned Payments** | Financial todo list — estimated monthly payments, status tracking, mark-complete to create a transaction | Forecast page |
| **Category Budgets** | Monthly spending limits per category with real-time tracking and projections | Accounts → Category Budgets |
| **Bill Reminders** | Auto-generated from card due dates, loans, and recurring transactions (next 14 days) | Forecast page |
| **Savings Goals** | Track goals with targets, dates, priority, quick-add amounts | Forecast + Accounts |
| **Debt Payoff Planner** | Snowball & Avalanche calculator: payoff timeline, interest saved, debt-free date | Accounts → Debt Planner |
| **Excel Export** | Download all data as a multi-sheet .xlsx | Settings → Export Data |

## 🚧 What's Still Missing

### High Priority (Should Add)

| Feature | Description | Why Important |
|---------|-------------|---------------|
| **Push Notifications** | Browser/mobile push for bill reminders | Never miss a payment |
| **Recurring Transaction Templates** | Quick-add common transactions | Faster data entry |
| **Bank Connection (Plaid)** | Auto-import transactions | Less manual work (optional — manual-first by design) |

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

## 📜 License

MIT License — Use freely for personal and commercial projects.

## 🙏 Acknowledgments

Built with **Next.js 16**, **React 19**, **Firebase**, **OpenAI GPT-4o-mini**,
**Recharts**, **Tailwind CSS**, and **Lucide Icons**.

---

**Remember:** The goal is not to track every penny. The goal is to **know what's coming**
and **make confident decisions**.

*Build your safety net. See your future. Control your money.*
