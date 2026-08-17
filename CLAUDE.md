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
- Avoid nested quoting in `node -e`; write a scratch file.

## Product repos

**Commit and push autodev freely; ask before touching a product repo.** They
deploy to production and often run several concurrent sessions — use
`git worktree add`, never `git checkout` in a live main tree, and re-run *their*
gate **after** a rebase, not before: a change green on its own can go red on a new
base without being touched.
