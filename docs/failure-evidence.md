# What actually goes wrong on the first pass

Measured 2026-08-16 across three production repos built with this framework.
Every rule in `rule-ramifications` traces to a number here.

## Method

A `fix` commit that touches a file a `feat` or `refactor` commit changed in the
previous three days is not maintenance — it is the feature having shipped
broken. Commit subjects and bodies were then clustered by stated root cause.

App-data commits (habit check-offs, meal logs) were excluded from fitmito;
they are not engineering work.

Reproduce with `node tooling/mine-fixes.js <repo>`, or `/learn-from-fixes`
inside a project.

## Headline

| Repo | Engineering commits | fix : feat+refactor | Fixes per feature |
|---|---|---|---|
| fitmito | 5,154 | 799 : 853 | **0.94** |
| ecommercebenchmark | 2,174 | 830 : 486 | **1.71** |
| spotivibly | 3,001 | 1,299 : 651 | **2.00** |

**93% of fitmito's fixes land within 24 hours on a file a feature had just
touched** (56–58% within 3 days for the other two). This is not accumulated
debt. It is the first pass being wrong and being corrected immediately.

## Failure classes, by share of that repo's fix commits

| Class | fitmito | spotivibly | ecommercebenchmark |
|---|---|---|---|
| Ordering / async race | **41%** | **32%** | **40%** |
| Unhandled state in a flow | 20% | 9% | 19% |
| Cache/key scoping | 12% | 7% | 16% |
| Duplicated derivation | 10% | 4% | 11% |
| Units, references, formats | 10% | 5% | 11% |
| Lifecycle not cleaned up | 8% | 7% | 6% |
| Cross-surface consistency | 8% | 3% | 6% |
| Config / env targeting | 3% | 3% | 8% |

Classes overlap — one fix can belong to several.

By *theme* rather than root cause, the rework in brand-new feature code ranks:
incomplete flow / dead path (112 in fitmito), copy/content (75), UI layout (52),
state/sync (37). Runtime crashes are only 20. **The problem is not that the code
crashes. It is that it runs, and is wrong.**

## Why the existing gates miss all of this

> "this is invisible in a diff and cannot be caught by testing the component
> alone — the bug lives in WHO owns the mount"

Typecheck, build, and a clean console detect the 20 crashes. They cannot detect
a handler nested where it never runs, four surfaces disagreeing about one
number, a cache key missing the account dimension, or a locale still holding a
translation of the previous sentence.

## Representative commits

**Duplicated derivation**
`fix(fuel): single-source day fuel totals so Fuel/Plate/Label/Glance never disagree`

**Cache/key scoping — a real data leak**
`fix(auth-cache): payload cache key must include the account — a warm lambda served one admin's prefs to another`

**Reachability**
`[action-reach] action "x" is checked ONLY at brace-depth 3, never at the dispatch depth of 1 — it is nested inside another handler, so the outer action check is false for every one of its requests and it can NEVER run.`

**Units and references**
`fix: protein % showed 200%+ on The Label (EU 50g ref vs 180g target)`

**Lifecycle**
`fix(replica): one render loop, ever — stacked rAF loops multiplied the spin`

**Copy drift, and why a filler tool does not fix it**
`because i18n-fill only fills MISSING keys` — an in-place English edit leaves
every locale holding a translation of the old sentence, with nothing failing.

**Config targeting**
`fix(usage): producthealth read the WRONG Supabase project`

## Two findings about gates themselves

**1. More prose rules did not help.** spotivibly and ecommercebenchmark carry
526- and 593-line `CLAUDE.md` files and have the *worst* fix-per-feature ratios
(2.00 and 1.71). fitmito's is 55 lines, at 0.94. Rules that are read but not
enforced do not change the outcome.

**2. A gate nobody runs is not a gate.** fitmito's own preflight file records it:

> "THE OTHER 60 GATES, which nothing ran. … A sweep found five red, two of which
> had been failing since 2026-07-22 … The only thing in the repo that objected
> was a harness nobody ran, and it objected for eight days."

The same defect existed in this framework: `tooling/test-all.js` passed a
malformed argument list, so every suite launched a bare `node` with no script
and reported PASS. CI was green on an empty test run for an entire release.

fitmito's answer is the one to copy: gates run automatically, track known-red
against open story ids, **and fail when a known-red gate starts passing** — a
stale excuse is how a real failure gets waved through.

## What this changed in the framework

- `rule-ramifications` — the eight classes as a pre- and post-implementation
  checklist, auto-loaded.
- `/learn-from-fixes` + `tooling/mine-fixes.js` — any project can rank its own
  classes from its own history instead of inheriting this list.
- `rule-verification` — now defers to the eight classes rather than treating a
  clean typecheck as sufficient.
