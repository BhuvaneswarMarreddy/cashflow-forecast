# Handoff

The redesign is already in motion as issue #27 (owner-approved pitch: Midnight/Paper
theme pair, runway hero, 4-color system, coin identity). This audit's role was to
ground #27's task slicing in evidence. The handoff therefore feeds #27 directly
rather than opening a new plan:

```
/make-plan Redesign the CashFlow UI surface. Current design failed a Rams audit at 10/30
(zeros on #8 thorough and #10 as-little-design-as-possible).

Verdict: "Total 10/30 with zeros on thoroughness and less-but-better: the app's numbers
engine deserves a UI rebuilt from information architecture down, not a restyle."

Why redesign, not refine: total far below 20; duplicated affordances dominate every
screen; states are systematically missing.

Preserve: Ink & Gold brand (Midnight dark + Paper light pair per issue #27), the coin
logo, the Timeline|Bills tab pattern, the money-trace Sankey concept (innovative, 2/3),
the entire data/analysis engine (out of scope by owner decree).

Discard: 13-route IA (→ ~6 screens: Home, Forecast[Timeline|Bills|Cashflow],
Activity[History+Analytics], Flow[+/flow/review sub-route], Accounts[8 tabs→4],
Settings-as-sheet; calendar→month drill-down; onboarding→2 steps). Per-account rainbow
and 10-color chart palette (→ validated 4-color system). The 6-item mixed FAB
(→ single Add action). Stacked-panel screens (→ one number per screen + tabs).

Top moves: (1) IA collapse 13→6; (2) states pass everywhere incl. Escape/focus;
(3) evict duplicate numbers — one computation, one display; (4) copy pass killing
jargon (legs/cadence/reconcile/Composed) + the #28-#30 defect fixes; (5) weight diet:
contexts off auth routes, dev routes out of prod, route-level splitting.

Deliverables: per-screen issues under #27, each ending with fixture screenshots,
resumable via "start on the UI tasks".
```
