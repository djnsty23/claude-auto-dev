# CLAUDE.md

The rules for this repository. The incidents behind them are in
[docs/claude-md-long-form.md](docs/claude-md-long-form.md).

## What this repo is

A **Claude Code plugin marketplace**, not an application. Everything under `plugins/` runs inside
someone else's session: a hook that throws kills their turn, and one that prints needlessly costs
them context on every prompt. Everything outside `plugins/` is repo machinery and never ships.

## Commands

```bash
npm run gate                 # THE GATE: twelve steps chained with &&. Run this.
npm run gate:fast            # the cheap steps only, in seconds. NOT the gate.
npm test                     # every tooling/test-*.js suite, then validate. Step 1 of 12.
node tooling/bump.js 8.9.0   # the ONLY correct way to change the version
node tooling/generate-agents-md.js --write   # after editing any rule-*/SKILL.md
node tooling/check-claude-md.js              # does THIS FILE still describe the tree?
```

**`npm test` is ONE TWELFTH of the gate**, and nothing about it hints at the rest, which is why
`npm run gate` exists: it chains all twelve.

**THE CHAIN IS `&&`, so a red first step means the other eleven NEVER RAN.** The gate is

```
npm test && npm run check:suites && npm run check:probe-shapes
  && npm run check:population && npm run check:entrypoints
  && npm run check:skill-tools && npm run check:skill-plugin-root
  && npm run check:agents-md && npm run check:decisions
  && npm run check:claude-md && npm run check:hook-parse
  && npm run check:coverage
```

When the first step fails, run the remaining eleven yourself.
The chain's exit status is a verdict on one step, not on twelve.

- **`npm run gate` takes the machine-wide full-gate lock** (`tooling/gate-lock.js`), and the chain
  above is `scripts["gate:chain"]`. It waits for a live holder and prints who it is behind, moves a
  dead holder's lock aside to `.stale-HHMM`, and releases to `.released-HHMM` on any outcome. The
  chain's exit code passes through. A chain it did not see finish exits 2. `AUTODEV_GATE_LOCK=0`
  skips the lock.
- **Exit 2 is INDETERMINATE**, never a pass or a fail. Read the conflict line before re-running.
- **Run it on a clean tree, after committing and before pushing.** `check:suites` grades HEAD in a
  private worktree and refuses a dirty tree. Iterate with `npm test`, then commit, gate and push.
- **Do not touch the tree while it runs.** `test-all.js` compares `git status` before and after and
  fails `tree-inert` on any change. Draft in a scratchpad. `git check-ignore -v <path>` says whether a
  path under `.claude/` is ignored.
- **`gate:fast` does not satisfy the merge bar.** It runs the cheap steps it derives from
  `scripts["gate:chain"]`, takes no lock, and names what it deferred. The bar is the full gate
  after any rebase.
- **The gate is not what CI runs.** `check:hook-parse` is CI's `node --check` loop over
  `plugins/*/hooks/*.js`, but seven of CI's steps are `if: matrix.os == 'ubuntu-latest'`.
- **Kill by pid, never by pattern.** Every worktree runs the same command lines, so `pkill -f`
  reaches peers. Confirm a pid's cwd, then kill that pid.
- A child killed on timeout still carries its stdout. Report what it printed, not a bare `ETIMEDOUT`.
- `$?` after a pipe is the pipe's status: `npm run check:suites | tail -3` reads 0 on an exit 2.

`test-all.js` finds `tooling/test-*.js` by pattern: a new suite needs no registration. Coverage
asks four questions: `find-orphan-checks.js` (scripts nobody runs), `check:hooks` (hooks no suite
drives), `check:functions` (functions never entered), `check:vacuity` (code no assertion depends
on, and it rewrites its subject).

## Architecture

`autodev-core` (the workflow, its skills, agents and hooks, the sprint system) · `autodev-memory`
(sqlite memory, its own hooks) · `autodev-stack` (vendor skills). `${CLAUDE_PLUGIN_ROOT}` resolves
per plugin, so cross-plugin paths cannot work: if core needs a file, core ships it.

State no skill, agent or hook-event counts here: they go stale silently. Count on disk.

### Skills are the unit of behaviour

`plugins/<plugin>/skills/<name>/SKILL.md`, frontmatter-driven. User-invocable skills take their
command name from the directory. **No `rule-*` skill is auto-loaded, and a `paths:` glob loads
nothing**: over 30 days every load of a rule skill was a Skill call the model chose. Load
`rule-diagnosis`, `rule-ab-testing` and `rule-gate-integrity` explicitly before proposing a cause, a
detector or a gate. Long reference material goes in `references/` beside the skill.

### The prd.json sprint system

`prd.json` at a user's project root is shared state between `auto`, `status`, the Stop hook and the
drift audit. Stories live in a `stories` object keyed by id. The field that matters is **`passes`**:

| value | remaining work? | an agent can act on it? |
|---|---|---|
| `null` | yes, pending | yes |
| `true` | no, done | n/a |
| `false` | yes, failed | yes, retry |
| `"deferred"` | **no**, a decision not to do it | no |
| `"needs-setup"` | **yes**, blocked on a human | **no** |

Anything reading this file must distinguish **all five** states, not treat `passes` as a boolean and
not stop at four. Use `summarise()` from `plugins/autodev-core/scripts/prd-states.js`: it keeps the
five apart and has an `unrecognised` bucket. A new state changes this table and `prd-states.js` in
one commit.

`stop-auto-check.js` blocks the end of a turn while pending stories remain, so a wrong answer hangs
the session. Its escape hatches: an explicit auto-exit signal, a flag older than 2h, an unparseable or
missing `prd.json`, an idle one-shot marker, and stories the drift audit measured as long-untouched.

### Hooks run on every turn

Registered in `plugins/<plugin>/hooks/hooks.json`, with paths only through `${CLAUDE_PLUGIN_ROOT}`
(validate rejects `~/.claude` and relative paths). Wrap the body in try/catch and `process.exit(0)`
unless blocking is the purpose. `pre-tool-filter.js` fails closed, but its private-name block fails
open, because it ships installed and a defect there lasts until the user reinstalls.

**A hook with nothing to say emits zero bytes**: assert zero stdout and zero stderr. Every wired hook
needs a suite (`check:hooks` is a hard gate), driven as a subprocess like
`tooling/test-pre-tool-filter.js`.

### Version is six files and one writer

`VERSION` is the source of truth. `bump.js` propagates it to `package.json`,
`.claude-plugin/marketplace.json` and every `plugins/*/.claude-plugin/plugin.json`. A version number
is a plugin-cache key, so two trees must never share one: re-read `VERSION` and the origin branches
immediately before `bump.js`.

## Conventions that have cost something

- **`git commit -F <file>`, never `-m`**: the shell eats backticks.
  `[measured 2026-09-08]` **force-push is not blocked**: `main` has no branch protection and no
  rulesets, and `check:claude-md` grades this sentence against the API in both directions.
- **Never `git commit --amend`, and stage explicit paths, never `git add -A`.** Several sessions
  commit to this clone at once, so HEAD moves in seconds and `-A` sweeps up their work.
- **This repo is PUBLIC.** `check-no-private-names.js` gates the tree and
  `tooling/githooks/commit-msg` gates messages: enable both per clone with
  `git config core.hooksPath tooling/githooks`. A sentence that would not be true on another machine
  belongs in `~/.claude/rules/`, not here. The denylist is stored as digests. Add a name with
  `node tooling/check-no-private-names.js --digest <name>`, never in plaintext.
- **`process.exit()` can truncate pending output.** Pipes are asynchronous on POSIX. Set
  `process.exitCode` and let the event loop drain. Test it with one write big enough to hit
  backpressure.
- A scripted rewrite of `process.exit(X)` must count parens, then grep for survivors.
- **`;` is not `&&`**, and a validation run piped into `head` or `tail` inside a chain reads red as green.
- macOS `realpathSync`: `/var/folders` and `/private/var/folders` are one directory. Resolve any path
  compared against a child's `process.cwd()`.
- Avoid nested quoting in `node -e`. Write a scratch file.

## Product repos

**Commit and push autodev freely.** A product repo deploys to production and often has several
sessions at once. Who merges and who deploys there is the operator's decision policy
(`~/.claude/rules/decision-policy.md` when it exists), not this file. Without one, ask first. Use
`git worktree add`, never `git checkout` in a live main tree, and re-run the product's own gate after
a rebase, not before.
