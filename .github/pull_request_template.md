## What changed

<!-- One or two sentences. What a reader needs to know before the diff. -->

## Why

<!-- The defect, the measurement, or the decision behind it. If a number was
     wrong, say what it read before and after. -->

## Evidence

- [ ] `npm test` — web suite green
- [ ] `python -m pytest functions-sync -q` — sync suite green
- [ ] `npm run build` — production build clean
- [ ] Verified against real data (say how, and what the numbers were)

## Phone

<!-- One product, two repos. A feature is not done until both halves are live.
     Changed what homeSnapshot returns? The `mobile contract` CI job says whether
     the phone still reads it. -->

- [ ] No phone change needed, or its PR is linked: BhuvaneswarMarreddy/cashflow-mobile#

## Risk

<!-- What could this break, and what would show it. Money paths: state which
     totals move and why that is correct. -->
