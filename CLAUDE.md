# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A **Claude Code plugin marketplace**, not an application. Nothing runs as a
service; everything under `plugins/` executes inside *someone else's* Claude Code
session. A hook that throws kills their turn; a hook that prints needlessly costs
them context on every prompt. Everything outside `plugins/` is repo machinery and
never ships.

## Commands

```bash
npm run gate                 # THE GATE: ten steps chained with &&. Run this.
npm run gate:fast            # the cheap steps only, in seconds. NOT the gate; see below.
npm test                     # every tooling/test-*.js suite, then validate. Step 1 of 10.
node tooling/bump.js 8.9.0   # the ONLY correct way to change the version
node tooling/test-pre-tool-filter.js   # a single suite; there is no name filter
node tooling/generate-agents-md.js --write   # after editing any rule-*/SKILL.md; step 7 fails on drift
node tooling/check-claude-md.js        # step 8: does THIS FILE still describe the tree?
npm run check:coverage       # step 9: the suite again under coverage; red only ABOVE the measured floor
```

**`npm test` is ONE TENTH of the gate, and every step it skips fails silently.**
`[measured 2026-08-30]` a session ran nine green `npm test` runs and never
executed `check:suites`, so a newly added suite was reported green while
`check-suites-can-fail.js` had it counted as NOT verified. The suite in question
was the one gating pushes.

Nothing about the first command hints at the rest, which is why `npm run gate`
now exists: it chains all ten.

`[measured 2026-09-07]` **THE CHAIN IS `&&`, so a red first step means the other
nine NEVER RAN.** The gate is

```
npm test && npm run check:suites && npm run check:probe-shapes
  && npm run check:population && npm run check:entrypoints
  && npm run check:skill-tools && npm run check:skill-plugin-root
  && npm run check:agents-md
  && npm run check:claude-md && npm run check:coverage
```

Steps eight and nine are the cheap ones, and they sit where they do for the reason `&&`
makes unavoidable: a cheap step that goes red early hides every expensive step
behind it, so nothing that matters is skipped when one of these is the one that
fails. `check:agents-md` regenerates `AGENTS.md` from the `rule-*` skills to a
temp path and diffs it, takes milliseconds, and its only failure is a stale
document. `check:claude-md` grades the mechanically checkable claims in THIS
FILE against the tree — the gate chain above, the `passes` table, the population
counts, the branch-protection claim. **It is also the reason the numbers in this
section can be trusted now.** Every one of them used to be a sentence that went
stale in silence, and three did inside 48 hours; this very sentence pair is what
the ninth step reads. The tenth, `check:coverage`, is the expensive one and the
last: it runs every suite a second time under `NODE_V8_COVERAGE` and fails only
when the count of plugin functions no suite enters rises above the floor dated
in its source (`tooling/find-untested-functions.js`), so it sits behind the two
cheap steps because a stale sentence in this file must not cost a second suite
run to discover, and nothing sits behind it. It is a floor against regression,
not a claim of quality; see "Four coverage questions" below.

A session landing a rescued commit read the resulting exit 1 as "the gate is
red", and was one step from describing the commit as gated when `check:suites` —
the step that catches exactly the unverifiable-new-suite case above — had not
executed at all. Its change ADDED a suite, so that was the one step it could not
afford to skip. When the first step fails, run the remaining nine yourself; the
chain's exit status is a verdict on one step, not on ten.

**And `npm run gate` is NOT "what CI runs"**, in both directions. CI adds a
`node --check` parse loop over every `plugins/*/hooks/*.js` that the gate has no
equivalent for, and the gate runs `check:probe-shapes`, which CI does not. Seven
of CI's steps are `if: matrix.os == 'ubuntu-latest'`, so a green local gate on
macOS and a green CI run are not claims about the same set of checks.

**Run it on a CLEAN tree, after committing and before pushing.** `check:suites`
grades HEAD, in a private worktree under tmpdir, so it refuses a dirty tree and
exits 2: run it dirty and every verdict is about committed code while the output
names files you are still editing. Iterate with `npm test`, then commit, then
`npm run gate`, then push. A commit you intend to describe as gated needs that
second command to have run against it.

⚠️ **This paragraph said "rewrites sources in place" until 2026-09-05, and it
had been false since 7d70fab on 2026-08-31**, when the sweep stopped touching
the shared tree. The refusal was right the whole time and its stated reason was
not, which is the harder kind of stale claim: a sentence that is still USEFUL
goes uncorrected because the advice it gives works. It survived here, in the
file every session reads, and in the script's own refusal message, where it told
people to stash to protect work that was never at risk.

Worth generalising, because this file is full of the same shape. An INVARIANT
cannot rot: "a 42703 means the column is missing" is a property of the world. An
IMPLEMENTATION DESCRIPTION rots the instant someone refactors, and both read as
mechanism. The discriminator is whether the sentence names something a refactor
can change: a tool, a file, a data structure, a code path. When it does, it is a
dated claim whether or not it carries a date.

⚠️ **"An exit 2 here is load; re-run it on a quiet machine" was wrong, and it
was the advice in this file and in the project memory until 2026-09-10.** The
measurement is in `docs/evidence-check-suites-budget-2026-09-10.md`; three runs
over five hours, and the quietest was five times the slowest with five times the
conflicts. Load is not the mechanism in either direction, and the refutation needs
no theory — it is arithmetic over this repo's own constants. A suite that blows the
child budget costs seconds through the sweep's exact invocation, so a timeout
demands a blowup far beyond the largest slowdown `spawn-budget.js` will even admit
(`CONTENTION_MAX`). Compare the two yourself rather than trusting this sentence:
time the suite, then read the clamp.

⚠️ **That holds per SUITE and fails at ONE call site, so read the conflict line
before applying it.** `[measured 2026-09-11]` `test-all.js (runner canary run)
did not run (ETIMEDOUT)` is the exception, and for it the paragraph above gives
backwards advice. The arithmetic there assumes the child is one suite costing
seconds; this child is `test-all.js`, which does **not** fail fast — it exits only
after every suite has run (`tooling/test-all.js`, its final `process.exit`) — so
the runner canary must fit the ENTIRE suite population inside the one child
budget. 129 suites that day, against 900 s: ~1.3x is enough, not 45x. The control
is what makes this stand rather than a second theory: the same commit, zero code
change, exit 2 at 15-min load 28.8 with three peer sweeps live, then exit 0 in
16m17s at load 15.7 with `0 NOT verified`. **So for THAT line, re-running quiet is
the fix; for a seconds-long suite it still is not.** Rule your own change out
first by timing the suite you touched — the change measured here added 0.7 s of
the 900. Receipt:
`~/claude-memory/evidence-2026-09-11-dispatch-readiness-class-split/`.

And note which kind of sentence each of these is, by this file's own test two
paragraphs up: the refutation above is arithmetic over a constant, and this
qualifier names a CODE PATH — `test-all.js` not failing fast. Make that suite
stop on first failure and this paragraph is stale the same day, with nothing to
announce it.

What was actually wrong is a shape worth recognising anywhere: **two timeout
regimes, nested, with no relationship to each other, and the inner ceiling the
larger one.** The sweep gave each suite a fixed budget while several suites could
self-grant more than that through `runBudgeted` — one of them passing a
`maxTimeout` equal to the whole outer budget, so a single widened retry could eat
it alone. (`node tooling/check-suites-can-fail.js` and `tooling/spawn-budget.js`
hold the live numbers; the doc above holds the ones measured that day.) Neither system
could then report: the outer kill landed mid-retry, so the suite never printed the
INDETERMINATE line it had computed, and the sweep, holding only `ETIMEDOUT`,
recorded a conflict with no cause. The fix was not a bigger number — the budget is
unchanged — it is that the parent now PUBLISHES its deadline and the inner policy
clamps to it. **When a budget is enforced by a process other than the one spending
it, the two have to know about each other, or the only reliable outcome is that
nobody gets to say what happened.**

Two corollaries that keep costing sessions. `os.loadavg()` is not a usable
contention signal on this box — it read 12.37 at idle and 12.37 under 28 busy
workers in the same ramp — so a load figure beside a timing proves nothing about
whether the machine was contended. And a contention probe built from
single-threaded work reads **1.00 until runnable threads exceed the core count**,
so on 14 cores every load this gate actually runs at measures as idle.

**And a child killed on timeout still carries everything it printed.** `spawnSync`
returns its `stdout` and `stderr` populated, and the suites here print their
assertions as they go, so the last lines name what was in flight. Nine timeouts
across those three runs were reported as the bare string `ETIMEDOUT` with that
evidence in hand and discarded, which is why five hours produced no diagnosis.
Whatever you are writing that reports a result with no exit code: the budget is
spent either way, so spend it on evidence.

**And do not touch the tree WHILE it runs.** Clean at the start is not enough:
`test-all.js` snapshots `git status` before the suites and compares after, so a
file edited mid-run fails `tree-inert` with "THE TEST RUN MODIFIED THE WORKING
TREE. A suite rewrote what it grades." `[measured 2026-09-02]` that fired on a
run where no suite had done anything: two tracked files were edited 13 s and 42 s
into it, established by mtime rather than by reflog adjacency. Every other suite
exited 0, which is the point of the check and also why the red is easy to
misread as being about the diff.

Gate runs take tens of minutes here, so the temptation to keep editing is real.
Draft in the scratchpad instead and apply once the run ends. Ignored paths are
invisible to `tree-inert`, so a report under `.claude/reports/` can be written
mid-run. Check before relying on that: `.gitignore` lists individual `.claude/`
paths rather than the directory, so `git check-ignore -v <path>` is the answer
and "it is under `.claude/`" is not.

One trap while checking any of this: `$?` after a pipe is the PIPE's status.
`npm run check:suites | tail -3` reports 0 while the script exits 2. That cost
two wrong readings in the session that wrote this paragraph.

`test-all.js` discovers suites by pattern (`/^test-.*\.js$/`) — a new
`tooling/test-*.js` needs no registration.

### The fast tier: `npm run gate:fast`

`[measured 2026-09-08, this machine, load 4.2 rising to 12.5]` the seven steps
timed INDEPENDENTLY on a clean tree, each exit code captured to a FILE because
`$?` after a pipe is the pipe's:

| step | seconds | share |
|---|---|---|
| `npm test` | 323.7 | 20.00% |
| `check:suites` | 1286.2 | 79.46% |
| `check:probe-shapes` | 0.1 | 0.01% |
| `check:population` | 0.4 | 0.02% |
| `check:entrypoints` | 7.8 | 0.48% |
| `check:skill-tools` | 0.3 | 0.02% |
| `check:agents-md` | 0.2 | 0.01% |
| **total** | **1618.7 (27.0 min)** | |

**Two steps are 99.46% of it. The other five are 8.8 SECONDS TOGETHER.** So
`gate:fast` runs the cheap ones, and `npm run gate` still runs everything. The
bar wants a re-run after every rebase and `docs/decisions.md` is newest-first, so
roughly half the open queue rebases on every merge to main — that product, not
any single step, is the fleet's dominant cost.

That 8.8 s is the SUM OF STEP TIMES, not what a re-run costs: `gate:fast` spawns
each step through `npm run`, which adds ~0.3 s apiece. `[measured 2026-09-08,
load 5.9, 14 cores]` end to end the tier is 11.1 s (n=3) against 27 minutes —
`check:entrypoints` alone was 9.47 s as two direct `node` calls and 9.75 s
through `npm run`, n=3 interleaved. Both figures move with the load; the ratio
does not.

`check:entrypoints` was the one worth measuring rather than assuming: it probes
~118 scripts with `--help` under a 10 s budget each, so its worst case is
minutes, and a cost model that guessed would have put it in the wrong tier.
Measured, it was 7.8 s at load 4.2 and 9.5 s at load 5.9 — nearly the whole of
this tier either way, and the only step in it whose cost tracks the load.

**`gate:fast` IS NOT THE GATE, and it says so on every run — including a clean
one.** It prints what it ran, what it DEFERRED, and a summary line counting the
steps that ran against the steps in `scripts.gate`, then the number deferred. A
partial run that renders like a complete one is precisely the false green this
file exists to prevent, so silence is not available to it; the other steps
already print their population on a clean run for the same reason. **Nothing was
dropped and no existing name changed meaning** — a session running
`npm run gate` from memory still gets every step.

It is a script and not a second `&&` chain, for three reasons the chain itself
demonstrates. `&&` short-circuits, so a red step hides every step behind it.
Exit 2 is INDETERMINATE here, and a chain folds that refusal into a verdict.
And a partial run has to be able to LOOK partial. Every step runs on its own and
the three states stay three.

**The step list is DERIVED from `scripts.gate`, never copied.** `gate-fast.js`
splits that chain on `&&` — the same authority `check-claude-md.js` grades this
file's counts against — and anything it does not recognise is DEFERRED, so a step
added to the chain lands in the slow tier by default rather than being assumed
cheap. A hand-maintained copy would rot the first time someone added a step,
silently, exactly as the `passes` table came to list four states while five
existed. The safe default is for the fast tier to claim LESS than it covers.

### Four coverage questions, none substituting for another

```bash
node plugins/autodev-core/scripts/find-orphan-checks.js .   # scripts nobody runs
npm run check:hooks       # wired hooks no suite drives (hard gate in validate)
npm run check:functions   # functions never entered (a full suite run under coverage; --gate is step 9)
npm run check:vacuity <subject.js> <suite.js>   # code no assertion depends on
```

**Coverage measures execution; mutation measures verification.** A function can be
entered every run while nothing asserts anything about it.

`check:vacuity` **rewrites its subject with mutants**. It refuses a dirty subject,
and `validate` fails while a `*.vacuity-backup` exists. After killing a run,
confirm no survivor is left — one rewrites the file underneath you. Kill it the
way the next paragraph says, by pid; this line used to read "`pkill -9` then
`pgrep` to confirm" and was still saying it after the paragraph below was added
to forbid exactly that. Two sentences, each plausible alone, contradicting each
other four lines apart.

**Kill by pid, never by pattern.** Every session runs these suites from its own
worktree with the same command line, so `pkill -f test-all.js` is a fleet-wide
action: it matches every peer's run exactly as well as it matches yours.
`[measured 2026-09-08]` this clone had 34 worktrees registered, one of them a
live `check:suites` sweep, and all of them would have matched; a session that
ran that pattern kill the same day reported ending a peer's `check:suites` and
another session's `test-hook-execution-evidence`. The cost is worse than the
interruption, because a killed run writes no exit file and an ABSENT verdict is
indistinguishable from a failing one — the peer inherits a red they did not
cause and cannot explain. `pgrep -f <pattern>` is the right way to LIST
candidates and the wrong way to choose among them: confirm a pid's cwd is yours,
then `kill -9 <pid>`.

## Architecture

`autodev-core` (the workflow, its skills, agents and hooks, the sprint system) ·
`autodev-memory` (sqlite memory, its own hooks) · `autodev-stack` (vendor
skills). `${CLAUDE_PLUGIN_ROOT}` resolves **per plugin**, so cross-plugin paths
cannot work — if core needs a file, core ships it.

**That sentence carried four counts until 2026-09-08, and three of them were
wrong.** It was written on 2026-08-17 as "43 skills, 4 agents, 7 hook events"
for core and "4 hook events" for memory, and all four were exact that day.
`[measured 2026-09-08]` core has **59 skills, 5 agents and 10 hook events**;
memory's 4 is still right, and it is right because nobody has added a memory
hook, not because anything checks.

The drift is not carelessness, it is the shape of the sentence. Of the 526
commits since it was written, 18 added a skill to core and 14 touched core's
`hooks.json` — and 9 edited this file, none of them noticing. A count is the
purest IMPLEMENTATION DESCRIPTION in the sense used above: it is falsified by
the ordinary act of doing the work here, and falsifying it emits nothing. The
shipped manifests already know this — `marketplace.json` and every `plugin.json`
name what a plugin *does* ("brainstorm, auto, iterate, audit, review, ship, plus
the prd.json sprint system") and count nothing.

**So do not put the numbers back.** `ls plugins/autodev-core/skills | wc -l` is
correct every day; a number in prose is correct only on the day it is typed. And
no gate would have caught this one. `check:population` is the plausible
candidate and is not it: it asks whether a script reporting an absence says what
it scanned, it never reads a document, and it is advisory by design because it
has demonstrated false positives. Nothing in the gate grades prose against the
tree — which is the reason the prose must not make claims the tree can falsify.

### Skills are the unit of behaviour

`plugins/<plugin>/skills/<name>/SKILL.md`, frontmatter-driven. User-invocable ones
take their command name from the directory. **A `rule-*` skill is auto-loaded only
if its own frontmatter says so** — `user-invocable: false` *and* a `paths:` glob
matching a file the session actually reads. The prefix guarantees neither: some
`rule-*` skills are ordinary invocable skills, and some carry globs that nothing in
this repo matches. Both are silently ABSENT rather than always-on, and an absent rule
looks exactly like a rule nobody needed — the lesson `rule-gate-integrity` draws
about vetoes, turned on the rule library itself. So **load `rule-diagnosis`,
`rule-ab-testing` and `rule-gate-integrity` explicitly** before proposing a cause, a
detector or a gate; `[measured 2026-09-08]` only the last of the three auto-loads
here. `head -12 plugins/autodev-core/skills/rule-*/SKILL.md` answers which is which,
and it is correct every day — a count in this file would not be. Long
reference material goes in `references/` beside the skill so it loads on demand.

### The prd.json sprint system

`prd.json` at a user's project root is the shared state between `auto`, `status`,
the Stop hook and the drift audit. Stories live in a `stories` object keyed by id;
the load-bearing field is **`passes`**:

| value | remaining work? | an agent can act on it? |
|---|---|---|
| `null` | yes — pending | yes |
| `true` | no — done | — |
| `false` | yes — failed | yes, retry |
| `"deferred"` | **no** — a decision not to do it | no |
| `"needs-setup"` | **yes** — blocked on a human | **no** |

`deferred` exists because counting it as pending (`passes !== true`) made `auto`
block forever on work nobody intended to do. **`needs-setup` repeated that
incident from the other side** and is the state most readers get wrong: it is
work that still counts as remaining, but that no agent can advance, because it
waits on something only a person can supply — an API key, a dashboard toggle, an
account. Retrying it burns a turn every run; counting it as done hides a blocked
story forever. The two questions are independent, which is why the table has two
columns: *is this still remaining work* and *can an agent move it* are different
questions, and four of the five values answer them differently.

Anything reading this file must distinguish **all five** states, not treat
`passes` as a boolean and not stop at four. Use `summarise()` from
`plugins/autodev-core/scripts/prd-states.js` rather than hand-rolling a filter —
it keeps the five apart and carries an `unrecognised` bucket so a sixth value
surfaces instead of being folded into a neighbour. Every hand-rolled filter in
this repo's history has been wrong, always by collapsing a state into the one
next to it: `needs-setup` was missing from `archive-prd`'s keep-list, and
`false` was folded into "pending" by `session-start.js` so the word *failed*
appeared nowhere.

`[measured 2026-08-29]` this table said **four** states for as long as
`needs-setup` had existed, and briefs written from it propagated the omission to
other sessions. A schema documented in prose drifts from the schema in code
silently; when you add a state, this table and `prd-states.js` change in the
same commit.

`stop-auto-check.js` blocks the end of a turn while pending stories remain, so a
wrong answer there hangs the session rather than erroring. Its escape hatches, in
order: an explicit auto-exit signal, a stale flag (>2h), an unparseable
`prd.json`, a missing one, and an idle one-shot tracked by a marker file. It also
skips stories the nightly drift audit measured as long-untouched — a stale backlog
otherwise blocks `auto` indefinitely.

### Hooks run on every turn

Registered in `plugins/<plugin>/hooks/hooks.json`. Resolve paths only through
`${CLAUDE_PLUGIN_ROOT}` — validate rejects `~/.claude` and relative paths. Wrap
the body in try/catch and `process.exit(0)` unless blocking *is* the purpose:
`pre-tool-filter.js` fails **closed**, but its private-name block deliberately
fails **open**, because it ships installed and a defect there persists until the
user reinstalls.

**A hook with nothing to say must emit zero bytes** — assert zero stdout *and*
stderr, not merely "no context". Mutants have survived because a test checked one
stream. Every wired hook needs a suite (`check:hooks` is a hard gate); drive it as
a subprocess, following `tooling/test-pre-tool-filter.js`.

### Version is six files and one writer

`VERSION` is the source of truth; `bump.js` propagates it to `package.json`,
`.claude-plugin/marketplace.json` and every
`plugins/*/.claude-plugin/plugin.json`, enumerating plugins from disk. Hand-editing
is how a release got tagged on a commit that failed validate.

**A version number is a plugin-cache key, so two trees must never share one.**
2026-08-21: two sessions released 8.98.0 from this clone within minutes, with
different trees. The cache is keyed on the number, so `claude plugin update`
reported *"already at the latest version"* and installed a build missing one
session's change entirely — a green message describing a number rather than the
code behind it. It took a throwaway 8.97.0 earlier the same day to move the key
for the same reason. **Re-read `VERSION` immediately before `bump.js`**, not when
you started work; in a shared clone it moves under you.

## Conventions that have actually cost something

- **macOS `realpathSync`**: `/var/folders` and `/private/var/folders` are the same
  directory. Resolve any path compared against a child's `process.cwd()`.
- **`git commit -F <file>`, never `-m`** — the shell eats backticks as command
  substitution. ⚠️ **The second half of this line said "and force-push is blocked
  so the message cannot be amended" until 2026-09-08, and it was false.**
  `[measured 2026-09-08]` **force-push is not blocked**: `main` carries no branch
  protection (the API answers 404 *Branch not protected*), the repo has zero
  rulesets, `tooling/githooks/` holds only `commit-msg` and a `pre-push` that
  runs `validate.js` and says nothing about force, and `pre-tool-filter.js`
  records blocking `--force-with-lease` as a PAST mistake it will not repeat.
  Two sessions took worse paths on that sentence's authority in one morning —
  one kept an unwanted merge commit and carried an eleven-file diff into review,
  another merged where a rebase was correct. The real reason not to amend is two
  bullets down and has nothing to do with force: several sessions commit to this
  clone at once. `check:claude-md` now grades this line against the API in BOTH
  directions, so enabling protection tomorrow makes it stale the other way round
  and says so.
- **`;` is not `&&`**, and never pipe a validation run into `head`/`tail` inside a
  chain: the pipeline's exit status is the last command's, so red reads as green.
- **This repo is PUBLIC.** `check-no-private-names.js` gates the tree and
  `tooling/githooks/commit-msg` gates messages. Enable both per clone:
  `git config core.hooksPath tooling/githooks`.
  When a rule keeps failing that gate, stop redacting and split it. `rule-local-first`
  needed three redactions in one evening before the real problem showed: one document
  was trying to be two. **The test is "would this sentence still be true and useful on
  a machine that is not this one?"** Yes → it ships here. No — it names a repo, a port,
  a task, a backup target, or counts this operator's projects — → `~/.claude/rules/`,
  which is on the backup allowlist and so survives a reinstall anyway. Generalising
  usually strengthens the guidance: the portable form warns a reader about THEIR repos,
  where the specific form only reports on someone else's.
  **The denylist is stored as digests, not names** — a plaintext denylist in a public
  repo discloses precisely what it protects, which is what this one did until
  2026-08-22. Add a name without ever committing it:
  `node tooling/check-no-private-names.js --digest <name>` prints one hex line; append
  it to `DIGESTS` and re-sort. It reads stdin when given no argument, if you want the
  name out of shell history too. Do not "restore" the plaintext for readability.
- **Never `git commit --amend` here.** Several sessions commit to this clone at
  once and HEAD moves in seconds, so an amend can land on a commit that stopped
  being yours. 2026-08-21 one did: it rewrote another session's release message
  and absorbed their version bump. Recoverable (safety branch, `--mixed` reset to
  `origin/main`, re-commit) but it left a stray `wip:` message permanently in
  shared history. Commit small and forward; never rewrite.
- **Stage explicit paths, never `git add -A`** — the same concurrency sweeps
  another session's in-flight work into your commit.
- **`process.exit()` can truncate pending output.** This is not macOS-only.
  [Node's process I/O contract](https://nodejs.org/api/process.html#a-note-on-process-io)
  makes stdout/stderr pipes asynchronous on POSIX, including Linux and macOS,
  and synchronous on Windows. File output is synchronous on both; terminal
  output is asynchronous on Windows and synchronous on POSIX. Passing Linux CI
  does not establish that a pipe write was synchronous or completely drained.
  The 2026-09-07 incident reported 65,536 of 84,752 bytes from
  `rendered-layout-gate.js --json`, with exit 0. That observed byte boundary is
  not a portable buffer-size guarantee.
  `[measured 2026-09-09]` Node 24.19.0 on macOS, three variants each writing
  1,048,576 bytes to a pipe and a file: immediate exit delivered 65,536 pipe
  bytes; setting `process.exitCode` and waiting for the write callback each
  delivered all 1,048,576. All six runs exited 0, and all three file redirects
  were complete. Linux and Windows were not executed in this control.
  Set `process.exitCode` and let the event loop drain. A callback for one write
  is sufficient only if no other pending work needs to finish. Test the actual
  subject through a pipe with output large enough to exercise backpressure,
  compare exact content against an independently known payload, and use a file
  redirect as a separate control. Exit 0 or a complete redirected file alone
  does not prove that piped output survived.
- Avoid nested quoting in `node -e`; write a scratch file.

## Product repos

**Commit and push autodev freely; ask before touching a product repo.** They
deploy to production and often run several concurrent sessions — use
`git worktree add`, never `git checkout` in a live main tree, and re-run *their*
gate **after** a rebase, not before: a change green on its own can go red on a new
base without being touched.
