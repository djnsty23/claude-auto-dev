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

Resolve the actual loaded `autodev-core` directory into `autodev_core_root`
before running the shell examples. Use the loaded skill's location; do not
guess from the target project's working directory or assume another host set
`CLAUDE_PLUGIN_ROOT`. Verify the named script exists under that resolved root.

Git history supplies candidates for understanding rework. A nearby `fix` and
`feat` touching the same file establish temporal overlap, not causation or proof
that either version reached production. Verify the diff, intended behavior and
release history before describing a fix as a shipped first-pass failure.

This turns that history into a ranked list of what to gate.

## 1. Measure

```bash
node "${autodev_core_root}/scripts/mine-fixes.js" .
```

Add `--json` for machine-readable output, `--since=60.days` (any `git log
--since` date) to read only recent history, `--window-days=7` for slower-moving
repos. It is read-only and never writes to the repo.

If it reports no conventional `fix:` commits, record that this classifier has
no applicable population. Do not invent a ranking. Continue other already
authorized audit/build work using available evidence; an empty mining result
does not mean the project has no defects.

## 2. Read the top classes against the real commits

The tool ranks by subject-line keywords, which is a proxy — and **measured
against a read of the commit bodies, a weak one.** On three production repos the
two passes disagreed on magnitude by roughly 8x (ordering/async: 41% / 32% / 40%
by reading, 5% / 6% / 3% by regex) and on *which class ranked first*. A body
saying "the phone home raced boot and lost" ships under the subject
`fix(now): first-paint`; the regex only ever sees the subject.

Quote the fix:feature ratio, overlap window and hot-file list with their actual
populations and definitions. **The keyword ranking is a hypothesis, not a floor
or verified share:** false positives can overcount a class as well as terse
subjects undercounting it. Read the actual commits behind the top two or three
classes, including negative controls, before drawing conclusions:

```bash
git log --format='%h %s%n%b' --grep='^fix' -30 -- <hot file from the report>
```

You are looking for a **stated cause to verify against the diff**, not a label: "because …", "was never
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

## 4. Propose or implement within the current mandate

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

Use `preflight` for a demonstrated missing check, preserving its gate-integrity
requirements. A request for analysis ends with measured proposals; an existing
mandate to improve the harness authorizes implementing the justified winner
without another planning-only handback. Do not add checks merely to fill the
table. Test each proposed assertion against the real defect and a valid control;
the table describes examples, not universally correct predicates.

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

Verify that the project actually loads this file and preserves it durably.
Writing guidance does not prove it reaches every future change; distinguish a
recorded lesson, a loaded rule, an executed check and a verified outcome.

## Running it on a schedule

The loop above only closes when someone remembers to ask. A nightly or weekly
routine can run the **measurement half** unattended and propose the rest:

```bash
node "${autodev_core_root}/scripts/mine-fixes.js" <repo> --json
```

Report-only rules for the unattended run:

- Quote the tool's counts with their populations and proxy definitions. The
  keyword ranking may contain false positives; verify representative diffs
  before claiming a failure class, whether or not a human is present.
- A report-only scheduled mandate ends with evidence-backed proposals. If the
  existing automation also authorizes scoped improvements, use an isolated
  owned worktree and complete the same diagnosis, comparison and verification
  required interactively. Being unattended changes supervision, not authority.
- Record the scheduler's actual attempt, outcome and unresolved work separately.
  A fresh timestamp must not make a failed analysis look successful. Resolve the
  actual host's scheduler state/schema rather than inventing a `.last-run` file.

### The other half: what went wrong IN the session

`mine-fixes` reads git, so it can only see failures that survived long enough to
be committed and then fixed. The failures that cost the most time never get
there — an Edit refused because the file was never read, a browser call made
before its precondition existed, a query naming a column that does not exist.
They are paid for in retries inside a session and leave no trace in history.

```bash
node "${autodev_core_root}/scripts/analyze-session-patterns.js" --days 7 --json
```

Two differences from `mine-fixes` that change how it is run and read:

- **It is machine-wide, not per-repo.** It reads the transcript tree, so run it
  ONCE per routine rather than once per repo — looping it over repos reports the
  same fleet numbers N times and makes a single stuck session look systemic.
- **Rank by `sessions`, not `count`.** A class hitting twenty sessions once each
  is a fleet problem worth a rule; one hitting a single session forty times is
  that session having a bad day, and the output flags the second case as
  concentration so it cannot be misread as the first.

Report-only, with the same rules as above, plus two specific to this tool:

- **Quote the population, never a bare percentage.** The output leads with files
  scanned, lines skipped as outside the window, tool results and the error rate
  for a reason: this tool has already produced two confidently wrong readings —
  a denominator that counted only error-bearing lines (so "783 of 783 failed"),
  and a window that filtered by file mtime while counting events months older.
  A share with no denominator beside it is how both survived review.
- **Check `--by-day` before proposing anything.** A class that is already falling
  needs no new rule; something has fixed it. The Bash denylist removal shows the
  shape to look for — 40, 34, 2, 1 across four days while the daily error total
  held, so the fall was the change and not a quiet weekend. Propose work for
  classes that are flat or rising, and say which day the series starts.

A class that persists despite a written fix warrants diagnosis. Verify whether
the rule is loaded, understood, applicable and executed, and whether the proxy
classification is correct. A gate or hook is one possible remedy, not a cause
or solution established by a flat count alone.
