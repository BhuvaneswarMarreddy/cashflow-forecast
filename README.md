# 💰 CashFlow Forecast

**A forward-looking personal finance app that traces every dollar.**

> *"If I spend money today, what will happen to me in the next 30–90 days?"*

CashFlow Forecast imports your bank/card CSVs, classifies and pairs transfers, reconciles
to what you actually hold, and shows where every dollar came from and went — as a live
money-flow diagram. Built for people who want clarity and control without connecting a
bank.

**🌐 Live:** https://marreddy-cashflow.web.app

---

## What it does

- **🔀 Money-flow trace** — every dollar from income → between accounts → out, as a Sankey
  you can click through, plus a treemap and a waterfall that proves it all adds up.
  → **[FLOW_ENGINE.md](FLOW_ENGINE.md)**
- **🔮 Forward forecast** — projected balance for the next 30/90/180/365 days; know your
  lowest point *before* it happens.
- **📊 Smart classification** — auto-detects transfers and card payments so they never
  count as income or spending.
- **🤖 AI insights** — ask "why is next month tight?", get trend analysis and a
  can-I-afford-this check. → **[AI.md](AI.md)**
- **📥 Native CSV import** — re-upload your full export monthly; deterministic ids mean it
  overwrites instead of duplicating.
- **💳 Accounts, budgets, goals, debt planner, recurring detection, Excel export.**

### Foundational ideas

| Concept | Why it matters |
|---|---|
| **Money has time** | $100 today ≠ $100 next month. Every transaction lives on a date. |
| **Trust the balance, not the flow** | User-entered balances are truth; CSVs are authoritative for *flows* only (exports drop rows). |
| **Certainty > precision** | A good estimate beats exact math on incomplete data. |

---

## Quick start

```bash
npm install
cp .env.example .env.local     # add OPENAI_API_KEY (see CONTRIBUTING.md)
npm run dev                    # http://localhost:3000
```

Build, test, and deploy:

```bash
npm test          # full jest suite (incl. the CSV audit replay)
npm run build     # production build
npm run deploy    # gated deploy: tsc + tests + hooks-check, then firebase deploy
```

Full setup, environment variables, testing, admin scripts, and the contribution workflow
are in **[CONTRIBUTING.md](CONTRIBUTING.md)**.

---

## 📚 Documentation

| Doc | What's inside |
|---|---|
| **[FLOW_ENGINE.md](FLOW_ENGINE.md)** | The money-trace pipeline end-to-end: import → classify → pair → reconcile → visualize, plus the verification guarantees. |
| **[ARCHITECTURE.md](ARCHITECTURE.md)** | Firestore data model, contexts, page-by-page guide, components, project structure, and the Ink & Gold brand system. |
| **[AI.md](AI.md)** | The AI features (decision check, Q&A, monthly insights, receipt scanning) and configuration. |
| **[CONTRIBUTING.md](CONTRIBUTING.md)** | Setup, env vars, testing, the deploy gate, admin data ops, and coding conventions. |

---

## Roadmap

**High priority:** push notifications for bills · recurring-transaction templates ·
optional Plaid bank sync (manual-first stays the default).
**Later:** multi-currency · shared accounts · investment tracking · a native mobile app.

---

## Tech

Next.js 16 (App Router) · React 19 · TypeScript · Firebase (Auth + Firestore + Hosting/SSR)
· Recharts · Tailwind · OpenAI. Money math is integer cents throughout.

## License

MIT — use freely for personal and commercial projects.

---

*The goal isn't to track every penny. It's to **know what's coming** and **make confident
decisions**. Build your safety net. See your future. Control your money.*
