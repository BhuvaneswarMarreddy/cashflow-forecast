# 🤖 AI Features

CashFlow uses OpenAI to answer questions about *your* data, judge spending decisions,
summarize trends, and read receipts. Every prompt is grounded in your forecast/transaction
data — the AI never invents numbers.

← Back to [README](README.md)

---

## 1. Decision Check — `aiDecision` callable
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

## 4. Receipt Scanning — `parseReceipt` callable
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

## How AI is called

All AI runs in **authenticated Firebase callables** (`functions/`, codebase `api`) —
`aiDecision`, `aiChat`, `parseReceipt` — reached from the client only through
`src/lib/callables.ts`. Each callable rejects unauthenticated requests
(`HttpsError('unauthenticated')`) and applies a per-uid daily rate limit
(see `LIMITS` in `functions/src/rate-limit.ts`).

There are **no AI routes under `src/app/api/`**, and none should be added. The old
unauthenticated proxies `/api/ai/decision` and `/api/parse-receipt` were removed
(SEC-001): they exposed a server-side provider key to anyone on the internet.
`src/__tests__/no-public-ai-routes.test.ts` fails if either comes back.

Prompts live in `functions/src/ai-config.ts` and `functions/src/prompts.ts`. Provider
keys are Firebase **Secrets Manager** secrets bound per-function (`OPENAI_API_KEY`,
`AZURE_OPENAI_*`), never bundled into the Next.js app.
