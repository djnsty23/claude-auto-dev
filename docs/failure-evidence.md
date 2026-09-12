# What actually goes wrong on the first pass

Measured 2026-08-16 across three production repos built with this framework.
Every rule in `rule-ramifications` traces to a number here.

> **The repos are anonymised; the numbers are not.** They are private codebases,
> and a per-repo defect rate is that team's to publish or not. It is not this
> tool's to advertise. They are labelled Project A, Project B and Project C, with
> no further description.
>
> Run `/learn-from-fixes` in your own repo to get this table for your code. That
> is the point of the document — not these three.

## Method

A `fix` commit that touches a file a `feat` or `refactor` commit changed in the
previous three days is not maintenance — it is the feature having shipped
broken. Commit subjects and bodies were then clustered by stated root cause.

Commits that record app data rather than change code were excluded from
Project A; they are not engineering work.

### Two passes, and they do not agree

**Corrected 2026-08-16.** This section previously said *"Reproduce with
`node tooling/mine-fixes.js <repo>`"*, directly under the class-share table. It
does not reproduce, and the gap is not small.

| Ordering / async race | Project A | Project C | Project B |
|---|---|---|---|
| Read pass (subjects **and bodies**, clustered by stated root cause) | 41% | 32% | 40% |
| `mine-fixes.js` (regex over **subjects only**) | 5% | 6% | 3% |

They disagree on the **top class**, not just the magnitude: the read pass ranks
ordering first for Project A, the tool ranks unhandled-state first.

Both are doing something real. A commit body names a race between two startup
steps; its subject names only the symptom. The regex sees the subject. So
treat them as different instruments:

- **Mechanical and trustworthy** — the fix:feature ratio, the 3-day rework
  window, and the hot-file list. These are counts over `git log`, and the tool
  and the read pass agree exactly.
- **A hint that needs reading** — the class ranking. `mine-fixes.js` gives you
  somewhere to start; the number under it is a floor, not a share. **Read the
  commits before you act on a ranking**, which is the same rule this framework
  applies to every other detector it ships.

The percentages below are from the read pass. They are the honest ones, and they
are also the ones you cannot get for free.

## Headline

| Repo | Engineering commits | fix : feat+refactor | Fixes per feature |
|---|---|---|---|
| Project A | 5,154 | 799 : 853 | **0.94** |
| Project B | 2,174 | 830 : 486 | **1.71** |
| Project C | 3,001 | 1,299 : 651 | **2.00** |

**93% of Project A's fixes land within 24 hours on a file a feature had just
touched** (56–58% within 3 days for the other two). This is not accumulated
debt. It is the first pass being wrong and being corrected immediately.

## Failure classes, by share of that repo's fix commits

| Class | Project A | Project C | Project B |
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
incomplete flow / dead path (112 in Project A), copy/content (75), UI layout (52),
state/sync (37). Runtime crashes are only 20. **The problem is not that the code
crashes. It is that it runs, and is wrong.**

## Why the existing gates miss all of this

> "this is invisible in a diff and cannot be caught by testing the component
> alone — the bug lives in WHO owns the mount"

Typecheck, build, and a clean console detect the 20 crashes. They cannot detect
a handler nested where it never runs, four surfaces disagreeing about one
number, a cache key missing the account dimension, or a locale still holding a
translation of the previous sentence.

## Representative fixes

The commit subjects are withheld because they name private product features.
What each class looked like:

**Duplicated derivation**: several surfaces each computed the same daily total,
and they disagreed.

**Cache/key scoping**: a cache key did not include the account.

**Reachability**: a handler nested inside another handler, so its check was
false for every request and it could never run.

**Units and references**: a percentage computed against the wrong reference
value, so it showed over 200%.

**Lifecycle**: a second render loop started without the first being stopped.

**Copy drift, and why a filler tool does not fix it**: the locale filler only
fills missing keys, so an in-place English edit leaves every locale holding a
translation of the old sentence, with nothing failing.

**Config targeting**: a usage report read the wrong database project.

## Two findings about gates themselves

**1. More prose rules did not help.** Project C and Project B carry
526- and 593-line `CLAUDE.md` files and have the *worst* fix-per-feature ratios
(2.00 and 1.71). Project A's is 55 lines, at 0.94. Rules that are read but not
enforced do not change the outcome.

**2. A gate nobody runs is not a gate.** Project A's own preflight file records
that most of its gates were run by nothing, that a sweep found several of them
red, two failing for weeks, and that the only objection came from a harness
nobody ran.

The same defect existed in this framework: `tooling/test-all.js` passed a
malformed argument list, so every suite launched a bare `node` with no script
and reported PASS. CI was green on an empty test run for an entire release.

Project A's answer is the one to copy: gates run automatically, track known-red
against open story ids, **and fail when a known-red gate starts passing** — a
stale excuse is how a real failure gets waved through.

## What this changed in the framework

- `rule-ramifications` — the eight classes as a pre- and post-implementation
  checklist, auto-loaded.
- `/learn-from-fixes` + `tooling/mine-fixes.js` — any project can rank its own
  classes from its own history instead of inheriting this list.
- `rule-verification` — now defers to the eight classes rather than treating a
  clean typecheck as sufficient.
