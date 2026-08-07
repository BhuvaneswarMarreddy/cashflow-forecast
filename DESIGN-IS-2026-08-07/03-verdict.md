# Verdict — REDESIGN

Total 10/30 with zeros on thoroughness (#8) and less-but-better (#10): the app's numbers engine deserves a UI rebuilt from information architecture down, not a restyle — which is exactly the sweep the owner already approved in issue #27; this audit turns taste into evidence.

## Highest-leverage moves

1. **#10 — Collapse 13 routes to 7.** Merge analytics→history ("Activity"), cashflow→forecast tab (decided), calendar→month drill-down, onboarding's manual account setup→/accounts. Evidence: per-screen mergeOrKill verdicts, wf_a3964a1c journal.
2. **#8 — States pass everywhere.** Loading/error/empty/focus/Escape on every screen; fix unclamped dates. Evidence: dashboard missingStates list.
3. **#2/#5 — One number per screen; evict duplicates.** Dashboard keeps runway + safe-to-spend + recent; charts/income-sources leave; navbar stops restating; FAB becomes one action. Evidence: duplicatedInfo lists (7 affordances → /accounts).
4. **#4/#6 — Copy pass + the four accuracy bugs** (Cancel-deletes, two Math.abs sign strips, mislabeled navigation). Filed as defects independent of the redesign.
5. **#9 — Weight diet:** route-level code splitting, contexts off the auth pages, dev routes out of prod bundles.
