# Evidence — collected 2026-08-07 by workflow wf_a3964a1c-4c0

Ten subagents, 822k tokens read, 126 tool calls; raw structured returns in the
workflow journal (`subagents/workflows/wf_a3964a1c-4c0/journal.jsonl`). Six
per-screen scrutineers (dashboard, accounts+settings, flow,
forecast+cashflow+calendar, history+analytics, auth+onboarding) + four
specialists (visual system, copy, weight/friction, a11y). All findings carry
file:line citations; subagents were forbidden from scoring.

Headline counts: /forecast renders 17 stacked blocks; /accounts has 8 tab chips;
first-load JS 1.4–1.9 MB raw per authed route; 27 color tokens + 10-color chart
palette + unbounded per-merchant hues; 25 sub-44px buttons; 17 icon-only buttons
without accessible names; 7 same-destination affordances to /accounts on the
dashboard; FAB = 6-item mixed menu (2 actions + 4 nav duplicates).

Defects found incidentally, filed immediately: #28 (Cancel still deletes),
#29 (Math.abs strips minus signs — Navbar + Budget Remaining), #30 (mislabeled
navigation, unclamped due dates, paused-income disagreement).

Accuracy drift catalog (numbers disagreeing with numbers): forecast Runway uses
the selected account's expenses against all-cash (forecast/page.tsx); per-account
forecasts ignore assumption overrides; Runway changes with the 1M/1Y display
range; /calendar posted-only totals vs /cashflow engine totals; History engine
totals vs Analytics raw-sum totals; weekly budget = monthly/4 (~8% overstated);
daily budget line = monthly/30 for every month; blank asterisked balances save
as $0.00; credit utilization ignores cards without limits; silent save failures
in onboarding and flow-review.
