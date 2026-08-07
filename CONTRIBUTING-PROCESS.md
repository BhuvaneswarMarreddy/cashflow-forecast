# How work moves through this repo

One person builds this today. The process below is written as if twenty were, because
the cost of an unclear tracker is the same either way: two people touching the same
file, a decision nobody can find, a fix nobody knows shipped.

---

## 1. Every change starts as an issue

No work begins without one. The issue is where the *why* lives; the PR only shows the
*what*.

Each issue carries four labels, and they are not decoration — they are how you decide
what to pick up next:

| Label group | Values | Answers |
|---|---|---|
| **Priority** | `P0` `P1` `P2` `P3` | How much does waiting cost? |
| **Type** | `type:feature` `type:defect` `type:infra` `type:design` | What kind of work is it? |
| **Area** | `area:ingest` `area:engine` `area:ai` `area:ui` `area:ops` | Which part of the system does it touch? |
| **Status** | `status:ready` `status:blocked` `status:designing` `status:on-hold` | Can someone start it *right now*? |

- **P0** — drop everything: data loss, or the app is silently wrong.
- **P1** — blocks the roadmap or hurts accuracy.
- **P2** — scheduled and valuable, not urgent.
- **P3** — do it when it becomes cheap.

**Area is the collision map.** Two people can safely work in parallel when their
issues carry different areas. Same area means read each other's branch first.

---

## 2. Every issue states its dependencies

A comment on each issue says three things, in plain words:

- **Blocked by** — which issues must land first, and *why* (never just a number)
- **Blocks** — what is waiting on this
- **Parallel-safe** — whether someone else can work at the same time, and which files
  are the collision risk

An issue that is blocked carries `status:blocked` and does not get picked up, even if
it looks tempting. The single ordering picture lives in the **roadmap issue**, which
also records what is deliberately paused and by whose decision.

---

## 3. Design before code, when the decision is hard

Anything labelled `type:design` gets a written decision *before* implementation:
alternatives, the one chosen, and why. It lands in `docs/ideas/` and is linked from
the issue.

This is not ceremony. On the instructions layer, that pass found three blockers in
code we already had — the confirmation card would have read "matches 0 transactions"
for exactly the new kind of rule, and the save path would have silently dropped the
new fields. Building the "obvious" version first would have shipped all three.

---

## 4. One branch, one issue

```
feat/<short-name>     a new capability
fix/<short-name>      something wrong today
chore/<short-name>    tooling, deps, process
docs/<short-name>     documentation
```

`main` is never committed to directly.

---

## 5. The PR links the issue, and closes it on merge

The PR body uses a closing keyword, so merging the PR closes the issue automatically —
no manual bookkeeping, and no issue left open for work that shipped:

```
Closes #10
```

Use `Closes` when the PR completes the issue, and `Refs #10` when it is only a step
along the way. A partial PR must never say `Closes`.

The template asks for four things, and each exists for a reason:

- **What changed** — so a reviewer knows before reading the diff
- **Why** — the defect, the measurement, or the decision
- **Evidence** — the suites and build actually run, with numbers. If a figure was
  wrong, say what it read before and after
- **Risk** — what could break and what would show it. For money paths: which totals
  move, and why that is correct

---

## 6. Merge only on green, and squash

CI runs the full gate: type-check, lint, four test suites (web, Firestore rules,
Python sync, Functions), a production build, and a deploy-resolvability check.

Squash-merge, delete the branch. One issue becomes one commit on `main`, so the
history reads as a list of decisions rather than a stream of keystrokes.

**Deliberately not automated:** Firestore rules are published by hand. A bad ruleset
locks the owner out of their own financial data, and the rollback is a console visit
under stress, not a `git revert`.

---

## 7. After merge

- The issue closes itself via the keyword.
- If the change altered any money figure, run `npm run audit` and paste the result
  into the issue before it closes.
- If it changed a decision, update `docs/DECISIONS.md`.

---

## The short version

```
issue  →  (design doc, if the decision is hard)  →  branch  →  PR "Closes #N"
       →  green CI  →  squash-merge  →  issue closes itself
```

Nothing is in flight without an issue. Nothing merges without evidence. Nothing that
shipped stays open.
