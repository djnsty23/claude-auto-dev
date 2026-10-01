---
name: unslop
description: Sweep a product's routes at phone and desktop widths for layout slop (mismatched control rows, glued controls, double borders, short stripes, missing gutters, small tap targets, truncated text, broken rhythm, overflow), turn what is measured into fix stories by component, hand them to auto, and prove each fix with a before/after scorecard.
when_to_use: "Invoked when the user says \"unslop\", \"sweep the UI\", \"is it sloppy\", \"clean up the UI\", \"visual sweep\", before ship on any UI change, or when the Brain dispatches a scheduled per-product sweep."
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, Agent, Task
model: opus
user-invocable: true
argument-hint: "[product dir, or nothing for this repo] [--base http://localhost:PORT]"
---

# Unslop

One word, a whole operation: **sweep, rank, story, fix, re-sweep, compare.** It
is a sibling of `heal`. `heal` sweeps for what an attacker can reach; this sweeps
for what a customer can see.

**Why a skill of its own and not a mode of `design` or `audit`.** `design` makes
one surface and checks that surface. `audit` reads code. This one drives every
route of a running product at three widths, measures the rendered page, and
proves a fix moved the numbers. A mode hidden inside another skill would not
fire on "unslop", and the before/after proof is its own procedure.

## The two kinds of finding, kept apart

| | Mechanical | Vision |
|---|---|---|
| What | A measured rule with a threshold, in `layout-checks.js` | A review agent's judgement against a fixed rubric |
| Can fail a gate | Yes (`--strict`) | **Never.** Advisory only |
| Carries | the measured values and the threshold | a confidence 0..1 |
| Becomes a story | Yes | Only when the user or the Brain promotes it |

Vision findings the rules already measured are dropped as duplicates, so the
advisory list holds only what a rule cannot see: hierarchy, copy, empty and
error states, things that read as unfinished.

## The rules and their thresholds

Each threshold is a knob in `DEFAULTS` of `layout-checks.js`, echoed beside every
finding, and overridable on `rendered-layout-gate.js` as `--<name> <n>`.

| Rule | Fires when | Threshold |
|---|---|---|
| `ROW-HEIGHT` | controls in one flex or grid row differ in height | spread > `rowHeightTolPx` 2 |
| `ROW-CENTER` | their vertical centres differ | spread > `rowCenterTolPx` 2 |
| `ROW-BORDER` | framed controls in the row use different border or ring weights | spread > `rowBorderTolPx` 0.5 |
| `ROW-RADIUS` | non-pill controls use different corner radii | spread > `rowRadiusTolPx` 2 |
| `ROW-PADDING` | text controls inset their labels differently | spread > `rowPaddingTolPx` 4 |
| `GLUED-CONTROLS` | two controls touch and differ in height, frame or fill | gap < `gluedGapPx` 2 |
| `DOUBLE-BORDER` | a frame sits inside another frame on all four sides, or one element has a border and an outer ring | every gap <= `doubleBorderPx` 2 |
| `SHORT-BAR` | a thin painted stripe on a container's top or bottom edge covers most of it but not all | height <= 8, covers >= 50%, misses an edge by > 2 |
| `NO-GUTTER` | text or a control sits too close to the screen edge | < `gutterMinPx` 12, widths <= 767 |
| `TAP-TARGET` | an interactive element (with any positioned pseudo-element) is small | < `tapMinPx` 44 either axis, widths <= 767 |
| `TRUNCATED-TEXT` | an ellipsis, a line clamp or a nowrap clip is hiding content | content exceeds its box by > 1 |
| `RHYTHM` | 3+ repeated sibling blocks are spaced unevenly | spread > `rhythmTolPx` 8 |
| `DOC-SCROLL`, `OVERFLOW-CULPRIT`, `CLIPPED-TEXT`, `TEXT-OCCLUDED` | the existing overflow and occlusion checks | see `rendered-layout-gate.js --how` |

Correct shapes that look like defects are exempt and **counted**: a segmented
button group (consistent, or with one selected segment joined by square corners), a pill or avatar (radius), a centred accent
(narrow), a progress fill (track), a horizontal rail, a full-bleed band, a link
inside a sentence, a small control wrapped by a 44px label or parent. The only
way to exempt a real element is `data-unslop-ok="CODE ..."` in the product's
source, reviewed like code and counted as `markedOk`.

## Run it

Use the product's own worktree, never its live main tree.

1. **Serve it locally.** `git worktree add .claude/worktrees/unslop-<date> -b chore/unslop-<date> origin/main`,
   copy `.env.local` in, install, start the dev server (or a prod build) on a free port.
   **The sweep refuses any base that is not localhost, 127.0.0.1, [::1], *.localhost or *.test**,
   because it may sign in with a test login.
2. **See what it will sweep**, and which test-login variable names exist:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/unslop-sweep.js" routes --root . --sitemap auto --base http://localhost:PORT
   ```
   It reads the Next app router (route groups, locale segments, dynamic routes sampled
   from the sitemap), a sitemap, or `--routes-file`. Dynamic patterns with no sample are
   printed as **unsampled**: say so in the report, never imply they were swept.
3. **Sweep**, signed out, and signed in when a test login exists:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/unslop-sweep.js" sweep --root . --base http://localhost:PORT \
     --sitemap auto --out .claude/reports/unslop/<date>-before --sha "$(git rev-parse --short HEAD)"
   ```
   For the signed-in leg, add `--email-env QA_X_EMAIL --password-env QA_X_PASSWORD` and run it
   under `doppler run --` so the values reach the env and never argv. Use only the product's
   own test accounts, and only on localhost. A product whose sign-in goes to a hosted identity
   provider needs the operator to run this leg: give them the exact command. Values are never
   printed; the report says only whether each name was present.
   Add `--init-storage <json>` (local storage) or `--cookies name=value` to pre-set a stored consent choice, so a banner does not cover
   every screenshot.
4. **Vision pass (advisory).** `unslop-sweep.js vision-pack <out> --max 12`, then spawn one
   `Agent` (opus) with `vision-pack.json` and
   `${CLAUDE_PLUGIN_ROOT}/skills/unslop/references/vision-rubric.md`. It returns findings in the
   rubric's JSON shape. `unslop-sweep.js vision-merge <out> --vision <its json>` drops what the
   rules already measured and keeps the rest as ADVISORY.
5. **Stories.** `unslop-sweep.js stories <out> --prd prd.json` (dry run), then `--write`.
   Findings group by component: anything inside a header, nav or footer landmark is one story
   however many routes show it. Open stories are not added twice.
6. **Fix.** Hand the stories to `auto`. Fix the component, not the page.
7. **Re-sweep against the baseline**, with the same flags plus `--baseline <before out>` so each
   screenshot gets a pixel-diff percentage, then:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/unslop-sweep.js" compare <before out> <after out> [--codes GLUED-CONTROLS] [--routes /app]
   ```
   **A fix counts only when its target count dropped AND no other count rose anywhere**: no
   other rule, no axe violation, on no other route. Verdicts: `COUNTS`, `NO-DROP`,
   `REGRESSED-ELSEWHERE`. Exit 1 unless it counts.
8. **Blind judge.** `unslop-sweep.js pairs <before> <after> --pairs <dir>` writes shuffled pairs
   and keeps the key apart. Spawn an `Agent` with only `pairs.json` and the images, then
   `unslop-sweep.js pair-score <dir> --verdicts <json>` reports the after side's win rate.

## The scorecard

Every capture writes a row to `scorecard.json`: rule hits by rule id, the axe violation count
(when the product has `axe-core` installed; otherwise n/a), the overflow, occlusion and
clipping count, and the pixel-diff percentage against the baseline. An unmeasured value is
null and prints n/a, never 0.

## Report

Routes swept of planned, unsampled patterns, widths, signed-in status, findings by rule
**with the number of captures each rule judged**, the top 10 ranked findings with their
measured values and thresholds, stories added, the compare table and verdict, the blind-judge
win rate, and the advisory vision list kept apart.

## Where it is wired

- `ship` Step 1d runs it on any change that touches UI, before deploy. Mechanical findings are
  done-bar item 3 evidence; unmet ones become stories.
- The Brain dispatches it per product on a schedule: `unslop-sweep.js brief --repo <dir> --base <local url> --return <address>`
  writes the brief, and `unattended-worker.js enqueue` queues it.
