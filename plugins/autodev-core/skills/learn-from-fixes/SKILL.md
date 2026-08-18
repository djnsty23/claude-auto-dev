---
name: learn-from-fixes
description: Rank the failure classes this project actually ships by mining its own fix commits, then propose executable gates for the top ones. Use when the same kind of bug keeps reaching manual QA.
when_to_use: "Invoked when the user says \"learn from fixes\", \"what do we keep getting wrong\", \"why does QA keep finding things\", \"analyze our bugs\", or after a release where manual QA found more than it should have."
allowed-tools: Bash, Read, Write, Edit, Grep, Glob
model: opus
user-invocable: true
argument-hint: "[repo path]"
---

# Learn From Fixes

A project's git history is a labelled dataset of what its first pass gets wrong.
A `fix` commit landing on a file a `feat` commit touched days earlier is not
maintenance — it is the feature having shipped broken, with the diagnosis written
in the commit message.

This turns that history into a ranked list of what to gate.

## 1. Measure

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mine-fixes.js" .
```

Add `--json` for machine-readable output, `--window-days=7` for slower-moving
repos. It is read-only and never writes to the repo.

If it reports no conventional `fix:` commits, say so and stop — the analysis
needs conventional subjects, and inventing a ranking without them would be
exactly the unverified guess this skill exists to prevent.

## 2. Read the top classes against the real commits

The tool ranks by subject-line keywords, which is a proxy — and **measured
against a read of the commit bodies, a weak one.** On three production repos the
two passes disagreed on magnitude by roughly 8x (ordering/async: 41% / 32% / 40%
by reading, 5% / 6% / 3% by regex) and on *which class ranked first*. A body
saying "the phone home raced boot and lost" ships under the subject
`fix(now): first-paint`; the regex only ever sees the subject.

So: the fix:feature ratio, the rework window and the hot-file list are counts and
can be quoted. **The class ranking is a starting point, and its number is a
floor, not a share.** Before drawing conclusions, read the actual commits behind
the top two or three classes:

```bash
git log --format='%h %s%n%b' --grep='^fix' -30 -- <hot file from the report>
```

You are looking for the **stated cause**, not the label: "because …", "was never
…", "only fired when …", "in two places". That sentence is what a gate has to
catch.

## 3. Report

For each of the top classes, give:

- **How often**, with the count and the share of fixes.
- **A representative commit**, quoted.
- **Why existing gates missed it** — typecheck, build, console, tests. If they
  could have caught it, the finding is that they were not run, which is a
  different and more fixable problem.
- **What would catch it next time**, concretely.

Rank by frequency × how expensive each instance was to find. A class that only
manual QA can catch outranks a more frequent one that a typecheck catches.

## 4. Propose gates, do not write them yet

For the top two or three classes, propose an **executable** check — something
that runs in preflight or CI and fails the build:

| Class | Shape of the gate |
|---|---|
| Reachability / dead path | Parse the dispatch site; assert every handler is registered at the depth that actually runs |
| Duplicated derivation | Grep for the same computation in more than one module; assert one exported source |
| Cache / key scoping | Assert every cache key includes the account/tenant dimension |
| Cross-surface consistency | Assert the surfaces that show one value all import the same function |
| Copy / i18n drift | Hash the English string per key; fail when English changed and a locale's hash did not |
| Lifecycle | Assert every `addEventListener` / `setInterval` / `requestAnimationFrame` has a matching teardown in the same file |

Then hand the chosen ones to `/preflight add <class>`, which owns the gate file and the four laws that keep it honest. Show the user the list and let them choose. Do not generate six gates nobody
asked for — an unwanted gate gets disabled, and a disabled gate teaches the team
that gates are noise.

## 5. Two rules about gates themselves, both learned the hard way

**A gate nobody runs is not a gate.** Wire every gate into one command that runs
automatically. In a repo audited for this, sixty harness scripts existed and
nothing ran them; two had been failing for eight days and the only thing that
objected was a script nobody executed.

**A gate that can go stale must fail when it does.** Keep known failures in an
explicit list keyed to open work items, and **fail the build when a known-red
gate starts passing** — otherwise a stale excuse is how a real failure gets
waved through.

Verify any gate you do write by reintroducing the original defect and confirming
the gate goes red. A gate never seen to fail is not known to work.

## 6. Write it down

Append the confirmed classes to `.claude/project-rules.md` under a
`## What this project keeps getting wrong` heading, each with its count and date.
`/autodev-init` owns that file; this skill adds a section to it rather than
creating a competing one.

That file is what `review` and `audit` read, so a class recorded there is
checked on every future change — which is the entire point of the exercise.

## Running it on a schedule

The loop above only closes when someone remembers to ask. A nightly or weekly
routine can run the **measurement half** unattended and propose the rest:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mine-fixes.js" <repo> --json
```

Report-only rules for the unattended run:

- Quote the tool's counts (fix:feature ratio, rework window, hot files) as
  counts. **The class ranking is a floor, not a share** — the calibration in
  step 2 applies doubly when no human is reading the commit bodies.
- When a repo's numbers look worth a human's time, log a *proposal* to run
  `/learn-from-fixes` there. Never write gates or edit `project-rules.md`
  unattended — an unwanted gate teaches the team that gates are noise, and an
  unreviewed rule is a guess wearing a rule's clothes.
- End the run by touching the scheduled task's `.last-run` heartbeat, clean or
  not, so `drift-audit` can tell a quiet week from a dead schedule.
