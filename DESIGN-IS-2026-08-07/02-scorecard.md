# Scorecard — Rams ten, scored from subagent evidence (01: workflow wf_a3964a1c-4c0)

1. **Innovative — 2/3.** The money-trace Sankey with gap reconciliation (flow/page.tsx) genuinely advances the category; everything else imitates standard finance-app patterns. Refresh with clear improvement → 2.
2. **Useful — 1/3.** The primary task ("am I OK, what's safe to spend") requires scrolling 10 stacked dashboard sections or 17 forecast panels; the answer exists but behind detours. Unnecessary detours → 1.
3. **Aesthetic — 1/3.** 27 color tokens + 6 payment-brand colors + per-account rainbow; Title Case vs sentence case inconsistent app-wide; glass/glow orphan styles. >5 inconsistencies → 1.
4. **Understandable — 1/3.** Jargon throughout: "legs", "cadence", "reconcile", "gross", "Composed" (a Recharts internal as a button label); label lies ("Import from History" only navigates; "View All Transactions" goes to Calendar). 2–3+ controls unclear + jargon → 1.
5. **Unobtrusive — 1/3.** Welcome header consumes the first viewport with zero data; navbar restates dashboard numbers; infinite pulse-glow; rainbow competes with content → 1.
6. **Honest — 1/3.** history/page.tsx:301 confirm says "Cancel = delete only this one" but Cancel still deletes (defect, filed as P0); "≈" on an exactly-computed number (cashflow:256); Math.abs strips minus signs (Navbar:120, dashboard:523). Multiple label↔behavior mismatches → 1 (not 0: defects, not designed manipulation).
7. **Long-lasting — 2/3.** Glassmorphism + glow gradients are early-2020s markers; the rest is neutral. 1 dated marker family → 2.
8. **Thorough — 0/3.** Dashboard: no loading state (txnLoading unused), no error state anywhere, wrong empty-state copy under filters, inconsistent chart empties, no Escape/focus handling on menus, unclamped due dates. 4+ states missing → 0.
9. **Environmentally friendly — 1/3.** 1.4–1.9 MB raw JS per authed route (440–570 KB gz); Firebase+contexts shipped to /login; /dev fixture routes in the prod build; infinite idle animation. 500KB–2MB band → 1.
10. **As little design as possible — 0/3.** 7 tap targets to /accounts on one screen; a 6-item FAB duplicating the nav; 3 dashboard charts duplicating /analytics and /cashflow; Runway shown twice as two tiles; two AddTransactionModal instances mounted. Dominated by duplicated affordances → 0.

**Total: 10/30.**
