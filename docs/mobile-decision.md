# Capacitor or Flutter?

Decision input, 2026-08-07. Measured from this repo, not estimated.

## The question

Native mobile app for long-term personal use: wrap the existing web app with
Capacitor, or start again in Flutter?

## What a Flutter rewrite would actually cost

| | Lines | Fate under Flutter |
|---|---|---|
| `src/lib/**` — money logic | **15,014** | rewrite in Dart |
| ├─ `forecast.ts` | 1,170 | rewrite |
| ├─ `classify.ts` | 642 | rewrite |
| ├─ `bills.ts` | 259 | rewrite |
| ├─ `home.ts` · `money.ts` · `accounts.ts` | 159 | rewrite |
| `src/components` + `src/app` — UI | 20,853 | rewritten either way |
| Tests | **1,190 across 79 suites** | do not port |

Only **2 of the lib files import React**, and both are observability hooks —
not money logic. The engine is already clean, portable TypeScript. That is an
argument for how *well factored* it is, not for how cheap it is to translate.

The 1,190 tests are the real asset. They encode months of accuracy work that was
painful to get right and is dangerous to get wrong: the four-role transfer
typing, the classifier, matcher semantics, the runway honesty rules, Monarch
import, the CSV audit replay that reconciles to −$3,641.38. A Dart rewrite
starts that at zero. For an app whose owner's stated first fundamental is
"numbers accurate", that is the whole ballgame.

## What Capacitor costs

A probe ran the static export in a scratch copy. **It builds today** — 17
routes, ~6 MB, every route static — and boots offline with zero external
requests, verified with all off-device hosts blocked.

Nothing in production needs a server: no `'use server'`, no `next/headers`, no
dynamic segments, no `next/image`. Every backend call already goes through
origin-independent Firebase callables. Fonts are self-hosted. Firestore
persistence is already on.

Blockers are small and named: one dev-only API route, a `force-dynamic` line in
six fixture pages, three redirect pages that need to redirect client-side, and
`trailingSlash: true`.

## Recommendation: Capacitor

Not because Flutter is worse — because the thing worth keeping here is the
engine and its tests, and Capacitor keeps them while Flutter discards them.
Roughly 6–8 days versus months, on an app with one user who wants it to last.

### The honest case for Flutter

Two things would genuinely be better, and neither is hypothetical:

- **Plaid Link cannot run in a WebView.** Under Capacitor the workaround is to
  link banks on the web and let the native app consume the synced data. Flutter
  would use Plaid's native SDK properly.
- **Google sign-in uses a popup**, which a WebView has no opener for. Under
  Capacitor v1 the answer is email/password on native.

Both are survivable for personal use. If either becomes a daily irritation, the
right response is a Capacitor plugin, not a rewrite.

### What would change this decision

Flutter becomes correct if the app stops being personal — if it needs per-user
Plaid tokens, a Plaid plan upgrade, and public App Store distribution. That is a
multi-week backend rewrite regardless of the client, and at that point the
client choice is worth reopening. It is not the situation today.

## Do these before packaging, not after

Both found during the same investigation, both live on the web app now:

- **#71** — anything created offline is never written to Firestore. `local_` ids
  are minted and every write path skips them; there is no flush path. Silent
  data loss. Packaging is what makes people *rely* on offline, so this must land
  first.
- **#72** — "delete my account" leaves the Plaid Item and access token alive.
  Also blocks any future public listing under Apple 5.1.1(v).

Full investigation, including the store-submission checklist and the sequenced
build plan, is in the workflow output referenced from the project memory.
