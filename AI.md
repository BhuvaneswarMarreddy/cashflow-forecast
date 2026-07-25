# 🤖 AI Features

CashFlow uses OpenAI to answer questions about *your* data, judge spending decisions,
summarize trends, and read receipts. Every prompt is grounded in your forecast/transaction
data — the AI never invents numbers.

← Back to [README](README.md)

---

## 1. Decision Check — `/api/ai/decision`
**In:** a spending amount + your forecast. **Out:** a risk level + a plain explanation.

> "You want to spend $500. After this, your lowest balance will be $1,200 on March 15th —
> above your $500 safety threshold, so this purchase is safe."

Surfaced in the **Decision Check Panel** on the Forecast page.

## 2. Question Answering
**In:** any question + your forecast. **Out:** a contextual answer.

> **You:** "Why is next week tight?"
> **AI:** "Your balance drops to $800 on March 10th because rent ($1,500) and your car
> payment ($350) are both due that week. Consider waiting until your paycheck on the 15th."

Surfaced in the **AI Question Panel**.

## 3. Monthly Insights
**In:** 3–6 months of history. **Out:** trend analysis + suggestions.

> "Your spending increased 12% vs last month, mostly in Shopping ($450 → $580). Your
> savings rate is 15%. Consider a weekly budget for discretionary spending."

Surfaced in the **AI Insights Panel**.

## 4. Receipt Scanning — `/api/parse-receipt`
**In:** a photo/screenshot of a receipt. **Out:** structured transaction data.

```json
{
  "merchant": "Target",
  "amount": 47.82,
  "date": "2025-12-28",
  "category": "shopping",
  "items": ["Groceries", "Household"]
}
```

Surfaced in the **Receipt Scanner Modal** (camera supported on mobile).

---

## Configuration

| Setting | Value |
|---|---|
| Model | GPT-4o-mini |
| Temperature | 0.3 (factual, consistent) |
| Max tokens | 200–400 |
| Tone | Calm, non-judgmental, helpful |

Prompts live in `src/lib/ai-config.ts`. The API key is read from `OPENAI_API_KEY` — for
Firebase App Hosting / SSR it must be in the **root `.env`** the frameworks adapter reads
(not only `.env.local`). See [CONTRIBUTING.md](CONTRIBUTING.md#environment-variables).
