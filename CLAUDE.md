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
npm test                     # every tooling/test-*.js suite, then validate. The gate.
node tooling/bump.js 8.9.0   # the ONLY correct way to change the version
node tooling/test-pre-tool-filter.js   # a single suite; there is no name filter
```

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
`pkill -9` then `pgrep` to confirm — a survivor rewrites the file underneath you.

## Architecture

`autodev-core` (the workflow, 43 skills, 4 agents, 7 hook events, the sprint
system) · `autodev-memory` (sqlite memory, 4 hook events) · `autodev-stack`
(vendor skills). `${CLAUDE_PLUGIN_ROOT}` resolves **per plugin**, so cross-plugin
paths cannot work — if core needs a file, core ships it.

### Skills are the unit of behaviour

`plugins/<plugin>/skills/<name>/SKILL.md`, frontmatter-driven. User-invocable ones
take their command name from the directory. **`rule-*` skills are always-on**
(`user-invocable: false`, auto-loaded by a `paths:` glob) and encode conventions
derived from real failures — read `rule-diagnosis`, `rule-ab-testing` and
`rule-gate-integrity` before proposing a cause, a detector or a gate. Long
reference material goes in `references/` beside the skill so it loads on demand.

### The prd.json sprint system

`prd.json` at a user's project root is the shared state between `auto`, `status`,
the Stop hook and the drift audit. Stories live in a `stories` object keyed by id;
the load-bearing field is **`passes`**:

| value | meaning |
|---|---|
| `null` | pending — counts as remaining work |
| `true` | done |
| `false` | failed |
| `"deferred"` | a decision **not** to do it — explicitly NOT remaining work |

`deferred` exists because counting it as pending (`passes !== true`) made `auto`
block forever on work nobody intended to do. Anything reading this file must
distinguish the four states, not treat `passes` as a boolean.

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
`marketplace.json` and every `plugins/*/plugin.json`, enumerating plugins from
disk. Hand-editing is how a release got tagged on a commit that failed validate.

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
  substitution, and force-push is blocked so the message cannot be amended.
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
- **Never `git commit --amend` here.** Several sessions commit to this clone at
  once and HEAD moves in seconds, so an amend can land on a commit that stopped
  being yours. 2026-08-21 one did: it rewrote another session's release message
  and absorbed their version bump. Recoverable (safety branch, `--mixed` reset to
  `origin/main`, re-commit) but it left a stray `wip:` message permanently in
  shared history. Commit small and forward; never rewrite.
- **Stage explicit paths, never `git add -A`** — the same concurrency sweeps
  another session's in-flight work into your commit.
- Avoid nested quoting in `node -e`; write a scratch file.

## Product repos

**Commit and push autodev freely; ask before touching a product repo.** They
deploy to production and often run several concurrent sessions — use
`git worktree add`, never `git checkout` in a live main tree, and re-run *their*
gate **after** a rebase, not before: a change green on its own can go red on a new
base without being touched.
