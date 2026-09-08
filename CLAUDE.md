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
npm run gate                 # THE GATE: eight steps chained with &&. Run this.
npm test                     # every tooling/test-*.js suite, then validate. Step 1 of 8.
node tooling/bump.js 8.9.0   # the ONLY correct way to change the version
node tooling/test-pre-tool-filter.js   # a single suite; there is no name filter
node tooling/generate-agents-md.js --write   # after editing any rule-*/SKILL.md; step 7 fails on drift
node tooling/check-claude-md.js        # step 8: does THIS FILE still describe the tree?
```

**`npm test` is ONE EIGHTH of the gate, and every step it skips fails silently.**
`[measured 2026-08-30]` a session ran nine green `npm test` runs and never
executed `check:suites`, so a newly added suite was reported green while
`check-suites-can-fail.js` had it counted as NOT verified. The suite in question
was the one gating pushes.

Nothing about the first command hints at the rest, which is why `npm run gate`
now exists: it chains all eight.

`[measured 2026-09-07]` **THE CHAIN IS `&&`, so a red first step means the other
seven NEVER RAN.** The gate is

```
npm test && npm run check:suites && npm run check:probe-shapes
  && npm run check:population && npm run check:entrypoints
  && npm run check:skill-tools && npm run check:agents-md
  && npm run check:claude-md
```

The last two steps are the cheap ones, and they are last for the reason `&&`
makes unavoidable: a cheap step that goes red early hides every expensive step
behind it, so nothing that matters is skipped when one of these is the one that
fails. `check:agents-md` regenerates `AGENTS.md` from the `rule-*` skills to a
temp path and diffs it, takes milliseconds, and its only failure is a stale
document. `check:claude-md` grades the mechanically checkable claims in THIS
FILE against the tree — the gate chain above, the `passes` table, the population
counts, the branch-protection claim. **It is also the reason the numbers in this
section can be trusted now.** Every one of them used to be a sentence that went
stale in silence, and three did inside 48 hours; this very sentence pair is what
the eighth step reads.

A session landing a rescued commit read the resulting exit 1 as "the gate is
red", and was one step from describing the commit as gated when `check:suites` —
the step that catches exactly the unverifiable-new-suite case above — had not
executed at all. Its change ADDED a suite, so that was the one step it could not
afford to skip. When the first step fails, run the remaining seven yourself; the
chain's exit status is a verdict on one step, not on eight.

**And `npm run gate` is NOT "what CI runs"**, in both directions. CI adds a
`node --check` parse loop over every `plugins/*/hooks/*.js` that the gate has no
equivalent for, and the gate runs `check:probe-shapes`, which CI does not. Six
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

### Four coverage questions, none substituting for another

```bash
node plugins/autodev-core/scripts/find-orphan-checks.js .   # scripts nobody runs
npm run check:hooks       # wired hooks no suite drives (hard gate in validate)
npm run check:functions   # functions never entered (~20s, suite under coverage)
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
`[measured 2026-09-08]` core has **58 skills, 5 agents and 10 hook events**;
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
- **`process.exit()` after printing TRUNCATES, on macOS only.** node's
  `process.stdout` is asynchronous when it is a PIPE on darwin, and synchronous
  when it is a pipe on linux and win32; it is synchronous for a FILE and a TTY
  everywhere. `process.exit()` does not drain a pending async write, so a script
  that prints more than the 64KiB OS pipe buffer and then exits delivers exactly
  65536 bytes — and exits 0, because the write never failed. 2026-09-07:
  `rendered-layout-gate.js --json` did this with 84752 bytes of output, and its
  suite had failed 2 of 282 on every mac in the project since the day it was
  written while CI stayed green on `[ubuntu, windows]`.
  Set `process.exitCode` and let the event loop drain; do not call
  `process.exit()` on a path that has written to stdout.
  **Three things hide it, and it used all three**: redirect to a file and the
  write is synchronous so the output looks whole; run it on Linux CI and the
  write is synchronous so CI is green; check the exit status and it is 0. Any
  assertion here has to drive the subject through a PIPE and compare byte counts
  against a FILE redirect — and assert the output EXCEEDS one buffer first, or
  the comparison passes by construction on small fixtures.
- Avoid nested quoting in `node -e`; write a scratch file.

## Product repos

**Commit and push autodev freely; ask before touching a product repo.** They
deploy to production and often run several concurrent sessions — use
`git worktree add`, never `git checkout` in a live main tree, and re-run *their*
gate **after** a rebase, not before: a change green on its own can go red on a new
base without being touched.
