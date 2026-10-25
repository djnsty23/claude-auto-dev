# The new-app chain

A new app, site or tool runs as one pipeline. It is never improvised. Each step reads the previous step's
artifact from disk and writes its own, so no step depends on a conversation that has since been
compacted. Artifacts live in the new repo under `docs/new-app/`, numbered by step. Step 1 runs `git init` and
commits the ledger, so every later artifact can name the commit it read. `setup-project` treats a
destination holding only chain artifacts as Create mode (its Mode Detection says which files).

The chain exists because of a measured failure. An interview settled 34 decisions and then built the app
by hand in the same session. It ran with no spec, no backlog, no setup stories and no review. The session
compacted four times. Two account blockers surfaced mid-build, and a recorded decision was reversed with
no trace.

## Contents

- The steps
- Step 1: the interview and the decision card
- Step 2: spec, plus the module map
- Steps 3 to 5: scaffold, modules, provision
- Step 6: auto
- Step 7: two independent reviews
- Steps 8 and 9
- Phase 2: the works
- A dry walk

## The steps

| # | Step | Reads | Writes |
|---|---|---|---|
| 1 | Interview (a grilling skill if installed, else spec step 1) | the idea, the world | `01-grill.md`, the decision ledger |
| 2 | `spec` | `01-grill.md` | `SPEC.md`, the initial schema, `prd.json`, `02-modules.md` |
| 3 | `setup-project` (create mode) | `SPEC.md` stack and services | scaffold, `CLAUDE.md`, `.env.example`, gate scripts, `03-setup.md` |
| 4 | Module scaffolder, when the operator has a module registry | `02-modules.md` | installed modules, its lock file, `04-modules.md` |
| 5 | Provisioning, the operator's script or the setup stories by hand | `SPEC.md` External services | env names in the secret store, setup stories flipped, `05-provision.md` |
| 6 | `auto`, in a fresh worker | `SPEC.md`, `prd.json`, `01-grill.md` | commits, story passes |
| 7 | `review` plus an independent second reviewer | the diff since the scaffold | `07-review.md` |
| 8 | `design-review` plus `unslop` | the running app | review file, scorecard, `08-design.md` |
| 9 | `ship` | gates, target | deploy ledger, live check, `09-ship.md` |

Rules that hold across all nine:

- **One decision ledger.** `01-grill.md` is the only code space for decisions about this app. A decision
  made at any later step appends the next code there. A reversal marks the old row `superseded by DYn`.
  The `SPEC.md` Assumptions cite ledger codes rather than restating them.
- **Every artifact names what it consumed** (file and commit) in its first line, so a stale input is visible.
  A skipped step still writes its file, with the reason it was skipped.
- **The build never runs in the interview session.** Step 6 starts a fresh worker with the three files it
  needs. The interview transcript is not one of them.
- **Stop at money, credentials, DNS and production data.** These are human steps. They become setup stories
  born `needs-setup` (spec step 4), and the chain builds everything that does not depend on them.
- **A design question is an options artifact.** Brand, palette, type, layout and copy variants go in one
  artifact with 2-3 variants on real content and a recommendation. Attended, the operator picks. Unattended,
  the run takes the recommended variant and logs it as a `DYn` row with the artifact link. A design pick
  never blocks an unattended run.

## Step 1: the interview and the decision card

When a grilling skill is installed, it runs first and writes the ledger. Its columns are code, answer, by,
lock step and status. **By** is honest: `you` (the operator's own words), `accepted` (a recommendation they
said yes to) or `Claude` (decided under the operator's decision policy).

**The decision card is the operator's control point.** It is one message, not a blocking question. It lists
every `accepted` and `Claude` item, one line each, grouped by **lock step**: the earliest step whose Reads
column depends on it, not the step that executes it. The interviewer's lock step is provisional, and `spec`
resets it from the table above. The operator overturns a line by code ("DY3 no, X"). Before the lock step
that is free. After it, the change becomes a rework story with its cost stated.

**One wait, at spec.** Spec-locked rows (scope, schema, who the users are) are the costliest to reverse and
`spec` runs next, so step 2 starts on the operator's go: their reply in an attended run, or the explicit
start a new app needs anyway in an unattended one. That go confirms the whole card. Rows locking at setup
or later never wait, and silence approves them. The human steps above wait too, and they are never on the card.

**Where the card goes.** The step's exit report carries its new rows to whoever briefed the step: the
briefing session by message, or the progress view's "Decided for you" block. A card sent into a worker's own
session, which nobody reads, has not been sent.

**Ledger shape, checked by every step.** Codes are unique. **By** is one of the three values. Lock step is
one of spec, setup, modules, provision, build, ship. Status is `open`, `locked at <step>` once that step's
artifact is written, or `superseded by DYn`. A row that narrows an earlier row supersedes it.

With no grilling skill installed, spec step 1 is the interview. Write its answers and assumptions to
`01-grill.md` in the same shape, so later steps read one format.

## Step 2: spec, plus the module map

Run this skill as written, with three additions:

1. **Read the ledger instead of asking.** A question the ledger answers is not asked again. A gap the
   ledger left open gets a `DYn` row or, for an ASK item, one question.
2. **Map capabilities to modules.** When the operator keeps a registry of reusable modules, write
   `02-modules.md`: one row per capability in the core loop, naming either a registry module and version,
   or `build` with the story id. A capability two projects already built by hand is a promotion candidate.
   Name it there and do not build it a third time.
3. **Write phase 2 now, as sprint 2.** See below. Sprint 1 is the fast, fully working prototype: the core
   loop end to end on real data, signed in, deployed.

## Steps 3 to 5: scaffold, modules, provision

- `setup-project` pins the stack to the versions the operator's other live apps run, read from their
  manifests. Stack drift between sibling apps is how a shared module stops fitting. With no sibling app, it
  uses its version defaults and says so in `03-setup.md`.
- The module scaffolder, when present, installs every `02-modules.md` module before `auto` starts. A
  module that cannot install, for example because it needs SMTP the free tier lacks, becomes a story and
  a ledger row.
- Provisioning runs from the External services list. A provisioning script's exit code is the verdict:
  done, waiting on a person, or failed. Waiting on a person is not failure. The setup stories it could
  not finish stay `needs-setup` with the script's guided step as their `blockedReason`. `05-provision.md`
  lists services and variable names only, never values.
- **Setup stories pass at step 5, not after a deploy.** Their acceptance is what provisioning can check: a
  variable name present, a REST probe answering. Provisioning flips them to `true`. Only the story that needs
  a deployed app (sign-in on a preview, for example) carries the setup story in `blockedBy`. Sign-in and the
  core loop build against a local Supabase or a stub, so `auto` always has actionable stories.

## Step 6: auto

`auto` works `prd.json` in a fresh worker. Brief it with the three files, the gate command from
`03-setup.md`, and the done bar from `SPEC.md`. The ledger travels with it, so a decision made mid-build
lands in the same code space.

## Step 7: two independent reviews

Run `review`, and in parallel a second reviewer from a different model family when one is installed (for
example a Codex plugin), with the identical prompt and no shared findings (review's "review twice"
rule). Merge, de-duplicate and check each surviving finding against the code. `07-review.md` records which
reviewers ran, what each checked clean, and the fixes as stories.

## Steps 8 and 9

`design-review` judges every route with real content and every state, and `unslop` measures layout slop at
phone and desktop widths. Both feed fix stories back to `auto`. `ship` runs its own gates and live check.
`09-ship.md` holds the served URL, the commit, and the live check result.

When a human step still blocks sign-in, step 8 reviews the states it can reach and lists the ones it could not
in `08-design.md`. Those states are reviewed again after the step lands.

## Phase 2: the works

Spec writes these as sprint 2 on day one, so the scope is visible from the start. After the first ship,
step 8 puts the brand kit and design kit to the operator as one options artifact (the design-question rule
above). Then step 9's exit re-enters step 6 with sprint 2, and steps 7 to 9 run again on it:

| Story group | Done means |
|---|---|
| Brand kit | Name, logo, palette and type applied through tokens, never literal colours in components |
| Design kit | Token scale, component variants and motion rules documented in `docs/` and used by every route |
| Every route, every state | A route inventory in `SPEC.md`. Each route has a story whose acceptance covers empty, loading, error, success, signed out and forbidden |
| Admin menus and controls | One admin entry per installed module and data table: list, search, create, edit, a confirmed delete, each behind the role check on the server |

A plan that needs deep judgement (a data model with money or multi-tenant access, a migration path, a
module boundary) gets one pass from the `plan-reviewer` agent before sprint 1 starts. Do not use that
model elsewhere in the chain.

## A dry walk

To check the chain without spending anything, run it on a throwaway idea in a scratch directory with every
external step in its dry-run mode. Confirm that each of the nine artifacts exists, names its input and agrees
with the ledger.
