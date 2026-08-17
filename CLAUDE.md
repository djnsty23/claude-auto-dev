# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A **Claude Code plugin marketplace**, not an application. Nothing here runs as a
service; everything ships to users' machines and is executed by *their* Claude
Code. Three plugins are published from `plugins/`, catalogued in
`.claude-plugin/marketplace.json`.

The consequence that matters: **you are editing code that runs inside someone
else's session.** A hook that throws kills their turn; a hook that prints
needlessly costs them context on every prompt.

Everything outside `plugins/` — `tooling/`, `docs/` — is repo machinery and is
never shipped.

## Commands

```bash
npm test                 # every tooling/test-*.js suite, then validate. The gate.
node tooling/validate.js # manifests, version sync, frontmatter, hook wiring
node tooling/bump.js 8.9.0   # the ONLY correct way to change the version
```

Run a single suite directly — there is no test-name filter:

```bash
node tooling/test-pre-tool-filter.js
```

`tooling/test-all.js` discovers suites by pattern (`/^test-.*\.js$/`), so a new
`tooling/test-*.js` file is picked up with no registration step.

### The four coverage questions

Each answers something the others cannot; none substitutes for another.

```bash
node plugins/autodev-core/scripts/find-orphan-checks.js .   # scripts nobody runs
npm run check:hooks      # wired hooks no suite drives   (hard gate in validate)
npm run check:functions  # functions never entered       (~20s, runs the suite under coverage)
npm run check:vacuity <subject.js> <suite.js>             # code no assertion depends on
```

**Coverage measures execution; mutation measures verification.** A function can
be entered on every run while nothing asserts anything about it.

`check:vacuity` **rewrites its subject file** with mutants. It refuses to start
unless the subject is committed, and `validate` fails while a `*.vacuity-backup`
exists. Do not run it on a dirty tree, and `pkill -9` then `pgrep` to confirm any
kill — a surviving run rewrites the file underneath you.

## Architecture

### Three plugins, no cross-plugin imports

| plugin | contains |
|---|---|
| `autodev-core` | the workflow, 43 skills, 4 agents, 7 hook events, the `prd.json` sprint system |
| `autodev-memory` | cross-session memory: sqlite DB, semantic search, 4 hook events |
| `autodev-stack` | vendor integrations (skills only) |

`${CLAUDE_PLUGIN_ROOT}` resolves **per plugin**, so a cross-plugin path cannot
work. If core needs a file, core ships it. `autodev-core` must stand alone.

### Skills are the unit of behaviour

`plugins/<plugin>/skills/<name>/SKILL.md`, frontmatter-driven. Two kinds:

- **user-invocable** — `audit`, `ship`, `brainstorm`; the directory name is the command
- **`rule-*`** — always-on, `user-invocable: false`, auto-loaded via a `paths:`
  glob. These encode conventions derived from real failures. Read
  `rule-ab-testing`, `rule-diagnosis` and `rule-gate-integrity` before proposing
  a detector, a gate, or a cause — they exist because those proposals were
  repeatedly wrong, and they carry the worked examples.

Long reference material goes in `references/` beside the skill so it loads only
when needed (`skills/browser/` is the pattern).

### Hooks run on every turn

Registered in `plugins/<plugin>/hooks/hooks.json`, implemented alongside. Core
wires SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, PreCompact,
PostCompact.

- Resolve paths only through `${CLAUDE_PLUGIN_ROOT}`; validate rejects `~/.claude`
  and relative paths.
- Wrap the body in try/catch and `process.exit(0)` unless blocking *is* the
  purpose. `pre-tool-filter.js` fails **closed** deliberately; its private-name
  block fails **open**, because it ships installed and a defect there would
  persist until the user reinstalls.
- **A hook with nothing to say must emit zero bytes.** Asserting "no context" is
  not enough — assert zero stdout, and stderr too. Several mutants survived
  precisely because a test checked one stream.
- Every wired hook needs a suite (`check:hooks` is a hard gate). Drive it as a
  subprocess; follow `tooling/test-pre-tool-filter.js`.

### Version is six files and one writer

`VERSION` is the source of truth; `bump.js` propagates it to `package.json`,
`marketplace.json` and every `plugins/*/plugin.json`, enumerating plugins from
disk. Hand-editing is how a release got tagged on a commit that failed validate.

## Conventions that will bite you

- **macOS `realpathSync`**: `/var/folders` and `/private/var/folders` are the same
  directory. Any path compared against a child's `process.cwd()` must be resolved
  first, or the comparison silently fails.
- **Write commit messages to a file and `git commit -F`.** With `-m` the shell
  eats backticks as command substitution; messages have lost words that way and
  cannot be amended, because force-push is blocked.
- **Never pipe a validation run into `head`/`tail` inside an `&&` chain**, and
  `;` is not `&&` — the pipeline's exit status is the last command's, so a red
  suite reads as green. Redirect to a file and check `$?`.
- **This repo is PUBLIC.** `check-no-private-names.js` denylists the private
  codebases discussed in its docs, and `tooling/githooks/commit-msg` blocks them
  in messages too. Enable both hooks per clone: `git config core.hooksPath tooling/githooks`.
- Avoid nested quoting in `node -e`; write a scratch file instead.

## Working on the product repos this tooling targets

Standing rule: **commit and push autodev freely; ask before touching a product
repo.** They deploy to production and often have several concurrent sessions —
use `git worktree add`, never `git checkout` in a live main tree, and re-run
*their* gate **after** any rebase, not before. A change that is green alone can
go red on a new base without being touched.
