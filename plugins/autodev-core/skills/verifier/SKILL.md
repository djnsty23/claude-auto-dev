---
name: verifier
description: "Build a project-local verify skill and driver script that starts the app, drives its real controls through its main user flows and reports pass or fail with evidence. Use when a product repo has no scripted way to exercise the app the way a user does."
when_to_use: "Invoked when the user says \"verifier\", \"make a verifier\", \"how do we verify this app\" or \"drive the app\", when a session is about to verify a change by improvising clicks or curls because the repo has no driver, and when a project verify skill no longer matches the app's flows."
allowed-tools: Bash, Read, Write, Edit, Grep, Glob
model: opus
user-invocable: true
argument-hint: "[product repo path] [--flows name,name]"
---

# Verifier

Every session that verifies a change by hand invents its own probe. The probes
differ, nobody can tell which ones can fail, and the next session starts again.
This skill writes the probe once, inside the product repo, as a skill plus a
driver script. Later sessions run that driver instead of improvising.

The output lives in the product repo, not in this plugin:

```
<repo>/.claude/skills/<app>-verify/SKILL.md     how to run it, its flows, how to update it
<repo>/.claude/skills/<app>-verify/driver.mjs   starts the app, drives the flows, exits 0, 1 or 2
```

`<app>` is the package or directory name in kebab case.

## Step 0: look for one first

```bash
ls .claude/skills/*-verify/SKILL.md 2>/dev/null
ls playwright.config.* cypress.config.* 2>/dev/null
grep -nE '"(e2e|verify|smoke)[^"]*":' package.json
```

An existing verify skill that still runs is updated, never duplicated. An
existing e2e suite is a driver already: wrap it in the project skill and add
only the missing pieces (phone widths, console capture, the red proof).

Check that the output path will survive a commit:

```bash
git check-ignore -v .claude/skills/x/SKILL.md
```

If `.claude/` is ignored, the skill is invisible to every later clone. Stop and
report it with the one-line `.gitignore` negation you propose. Editing the
ignore file is the user's call.

**Done when** you know whether you are creating, updating or wrapping.

## Step 1: discover how the app runs

Read the repo. A start command from memory or from a similar project is a guess.

| Source | What it gives |
|---|---|
| `package.json` `scripts`, `bin`, `main` | dev and start commands, CLI entry point |
| `.claude/launch.json` | the command, args and port sessions already use |
| `next.config.*`, `vite.config.*`, `astro.config.*`, `nuxt.config.*` | framework, default port, base path |
| `pyproject.toml`, `Cargo.toml`, `go.mod`, `Makefile`, `Procfile`, `Dockerfile` | non-Node start and build commands |
| `.env.example`, `.env.sample` | the variable NAMES the app needs |
| `README` | last, and only to confirm what the files above say |

Classify each surface the app exposes: **web UI**, **HTTP API**, **CLI**. A
repo with two surfaces gets one driver section per surface, in one script.

Run the start command once by hand and record four facts: the exact command,
the port or entry path, the readiness signal (a URL returning 200, a log line,
a process exit), and the environment it needed. A required variable with no
example value is a blocker. Record it as needs-setup and name it.

**Done when** the app started from the recorded command on this machine and you
saw the readiness signal.

## Step 2: choose the flows

Pick the three to five flows a real user cannot do without. Find them in the
routes or pages directory, the navigation component, the API router, the CLI's
command table and the existing tests. Name each flow with a short verb phrase:
`sign-up`, `create-invoice`, `export-csv`.

Each flow ends on an **observable assertion**. Something a broken app would
show differently:

| Surface | Assert on | Never on |
|---|---|---|
| Web UI | visible text after the action, the URL it lands on, a saved value read back after reload | "page loaded", a screenshot alone, no console error alone |
| HTTP API | status AND named fields of the response body, then a read-back of what a write stored | a 200 on `/` |
| CLI | exit code AND stdout content AND any file it should write | the process starting |

Write the flow list before any driver code: name, steps, assertion. This is the
success criterion the driver encodes.

**Done when** each flow has an assertion that would read differently if that
flow broke.

## Step 3: write the driver

Start from the skeletons in [references/drivers.md](references/drivers.md). The
contract every driver keeps:

- **One command.** `node .claude/skills/<app>-verify/driver.mjs [--flow name] [--base URL]`.
- **Exit codes.** 0 every flow passed. 1 at least one flow failed. 2 could not
  run: the app did not start, a dependency or setup item is missing. Exit 2 is
  never a pass.
- **It owns the app's lifecycle.** It starts the recorded command on a free
  port, waits for the readiness signal with a timeout, and kills the whole
  process tree on exit, including on failure. `--base` reuses a server that is
  already running instead.
- **One line per flow.** `PASS sign-up` or `FAIL sign-up: expected "Welcome", saw "Error"`,
  then the evidence directory path, then the population: flows run, screenshots
  written, console errors, failed requests.
- **Evidence in an ignored directory.** Write to `.claude/reports/verify/<timestamp>/`
  or another path `git check-ignore` confirms is ignored, so a run never dirties the tree.

Web UI drivers add:

- **Headless only.** Launch the browser with `headless: true`. No headed mode,
  no slow-motion option, no window on the user's screen.
- **Three widths.** Screenshot each flow's final state at 390 and 414 wide
  (phone) and 1280 wide (desktop). Assert `innerWidth` in the same step that
  captures, so a wrong viewport cannot pass silently.
- **Console and network.** Collect console errors, uncaught page errors, failed
  requests and responses with status 400 or above, per flow. Any of them fails
  the flow. A known, accepted error goes in an allowlist in the driver with a
  one-line reason beside it.
- **Selectors a user would see.** Find controls by role and accessible name or
  by visible text. CSS classes and test ids survive changes a user would notice,
  so they hide exactly the breaks this driver exists to catch.

Use the repo's installed Playwright if it has one. Otherwise add it as a dev
dependency in the same change and say so in the report.

### Credentials

Flows behind sign-in use test values only, read from the project's own seed,
fixture or example-config files, or created by the driver against a local
database. Never a real account. Pass the values through environment variables,
never on the command line, and never print them, masked or not. A flow that
needs credentials the repo does not provide reports needs-setup and exits 2.
It does not skip silently.

**Done when** the driver runs end to end and prints one line per flow.

## Step 4: prove it can go red

A verifier never seen to fail is not known to work. Load `rule-gate-integrity`
before this step. Three runs, all recorded:

1. **Green on the current app.** Every flow passes. If one fails, decide
   whether the app or the driver is wrong before going on. A failing flow on a
   working app means the assertion is wrong.
2. **Red on a planted break.** Derive the break from this app, in a file one
   flow depends on:
   - Web UI: rename the accessible name of a button a flow clicks, or change a
     route path the flow visits.
   - HTTP API: make a handler the flow calls return 500, or drop a field the
     flow asserts on.
   - CLI: change a string the flow reads from stdout, or the exit code.

   Apply it in a scratch copy (`git worktree add` into a scratch directory, or
   `git archive HEAD` extracted there) or edit in place and undo with the exact
   inverse edit. Never undo with `git checkout` or `git restore`, which also
   discards unrelated work in the file. The driver must exit 1, and the FAIL
   line must name the flow that touches the break. Other flows passing is the
   specificity check.
3. **Green again** after the undo, with `git diff --stat` showing no leftover
   change from the plant.

If the plant leaves the driver green, the assertion is not looking at what
broke. Fix the assertion and repeat step 2. Plant at least one break per
surface. One per flow is better and cheap.

**Done when** all three runs exist with their exit codes: 0, then 1 naming the
right flow, then 0.

## Step 5: write the project skill

Use the template at the end of [references/drivers.md](references/drivers.md).
It must name:

- the start command and readiness signal from Step 1,
- every flow with its steps, assertion and the source file that owns it,
- the run command and what each exit code means,
- how to update it: when a flow changes, edit that flow, run green, then
  re-plant a break for that flow and see it go red,
- the date and the plant used for the last red proof.

Its `description` names the moment it applies: after any change to the app's
source, and before claiming a change works.

## Step 6: report

Files created or changed (`git status --short`), the three runs from Step 4
with exit codes and FAIL lines, the population of the green run, and every
needs-setup item with what unblocks it. Leave the commit to the user unless the
current mandate already includes committing.

## Boundaries

- No visible browser window at any point, including while debugging.
- No real accounts, no production URLs, no secret values in output or files.
- The driver verifies user flows. It does not replace the repo's unit tests,
  typecheck or build. Run those through the repo's own gate.
