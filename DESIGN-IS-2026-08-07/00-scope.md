# Audit scope — 2026-08-07

**Audited:** the entire user-facing surface of CashFlow Forecast at main @ b924ede —
13 routes (dashboard, accounts, analytics, calendar, cashflow, flow, forecast+bills,
history, settings, login, signup, forgot-password, onboarding) plus Navbar, BottomNav,
QuickAddFAB.

**Primary user:** the owner — non-technical, checks on a phone, often at night;
motivated by seeing progress toward zero debt and a funded reserve.

**Primary task:** answer "am I okay and what's safe to spend?" in one glance;
maintain the bills register; trace where money went when a number looks wrong.

**Constraints:** Ink & Gold brand (Midnight dark + Paper light pair, locked
2026-08-07); Next.js + Firebase; both themes; engine/analysis untouched; the two
fundamentals — numbers accurate, UI simple — outrank all other considerations.

**Trigger:** owner's request for a tech-reviewer-grade scrutiny of every screen
("this should have been a dropdown… I'm okay to lose any of the screens") before
approving the redesign pitch (issue #27).

**Method:** design-is (Rams ten principles); evidence via 10 parallel subagents
(6 per-screen structural scrutineers + visual system, copy, weight/friction, a11y);
scoring by orchestrator only.
