# CLAUDE.md

Keep this file within 8,192 bytes, enforced by `check:claude-md`. Incidents and moved text are in
[docs/claude-md-long-form.md](docs/claude-md-long-form.md).

## What this repo is

A **Claude Code plugin marketplace**. `plugins/` ships into other people's sessions. Hook errors kill turns and needless output costs context. Everything else is unshipped repo machinery.

## Commands

```bash
npm run gate                 # THE GATE: thirteen steps chained with &&. Run this.
npm run gate:fast            # cheap steps: the merge bar, not the release bar.
npm test                     # every tooling/test-*.js suite, then validate. Step 1 of 13.
                             # It publishes the coverage receipt that check:coverage grades.
node tooling/bump.js 8.9.0   # the ONLY correct way to change the version
node tooling/generate-agents-md.js --write   # after editing any rule-*/SKILL.md
node tooling/check-claude-md.js              # does THIS FILE still describe the tree?
```

**`npm test` is ONE THIRTEENTH of the gate**, and `npm run gate` exists because it chains all thirteen.

**THE CHAIN IS `&&`, so a red first step means the other twelve NEVER RAN.** The gate is

```
npm test && npm run check:suites && npm run check:probe-shapes
  && npm run check:population && npm run check:entrypoints
  && npm run check:skill-tools && npm run check:skill-plugin-root
  && npm run check:agents-md && npm run check:decisions
  && npm run check:claude-md && npm run check:hook-parse
  && npm run check:conflict-markers && npm run check:coverage
```

When the first step fails, run the remaining twelve yourself.
The chain's exit status is a verdict on one step, not on thirteen.

- **`npm run gate` waits its turn** via `tooling/gate-lock.js` in the machine-wide `full-gate-queue.js`, behind product gates, then runs `scripts["gate:chain"]`. Remove a stopped waiter with `full-gate-queue.js leave --pid <pid>`.
- **Exit 2 is INDETERMINATE**, never pass or fail. Read the conflict or `tooling/gate-recovery.js` machine evidence (unfinished chain, ENOSPC below the disk floor, occupied port, crash with event 2004). In `npm test`, evidence belongs in each failed suite's own log.
- **`[stated 2026-10-17]` A PR merges on `gate:fast`, a release on the full gate.** Rebase onto `origin/main`, commit, then `{ git rev-parse HEAD; npm run gate:fast; echo "gate-receipt: exit $?"; } > r.log 2>&1` is the merge receipt. `publish-release.js` takes only a full `npm run gate` receipt of the release candidate. `check:suites` grades HEAD in a private worktree and refuses dirt. `plugins/autodev-core/scripts/merge-lock.js` does the per-repo lock, base check and merged-tree readback.
- **Product fast lanes require operator policy.** `plugins/autodev-core/scripts/fast-lane.js run` classifies size and sensitive paths, runs lint/typecheck/test/build, and records a receipt. `merge-lock.js --fast-lane-receipt` reclassifies GitHub's diff.
- **Do not touch the tree during a gate.** `test-all.js` fails `tree-inert` for changed `git status` under stable HEAD. Moved HEAD exits 2, or 1 if a suite also fails. Draft in a scratchpad. `check:coverage` refuses missing/stale/partial/red receipts with exit 2. `find-untested-functions.js --fresh` measures anew.
- **The gate differs from CI.** `check:hook-parse` runs CI's `node --check` on `plugins/*/hooks/*.js`. Seven of CI's steps are `if: matrix.os == 'ubuntu-latest'`.
- **Conflict markers in strings parse.** `check:conflict-markers` scans all tracked files. Doc examples need closed fences.

- **Kill by pid, never by pattern**: every worktree runs the same command lines. Confirm the pid's cwd.
- A child killed on timeout still carries its stdout. Report what it printed, not a bare `ETIMEDOUT`.
- `$?` after a pipe is the pipe's status: `npm run check:suites | tail -3` reads 0 on an exit 2.

`test-all.js` finds `tooling/test-*.js` by pattern: a new suite needs no registration.

## Architecture

`autodev-core` ships workflow, skills, agents, hooks and sprints. `autodev-memory` ships sqlite memory and hooks. `autodev-stack` ships vendor skills. `${CLAUDE_PLUGIN_ROOT}` resolves per plugin. If core needs a file, core must ship it.

State no skill, agent or hook-event counts here: they go stale silently. Count on disk.

### Skills are the unit of behaviour

`plugins/<plugin>/skills/<name>/SKILL.md` is frontmatter-driven. Invocable names come from directories. **No `rule-*` skill is auto-loaded, and a `paths:` glob loads nothing.** Explicitly load `rule-diagnosis`, `rule-ab-testing` and `rule-gate-integrity` before proposing a cause, detector or gate. Put long references in the skill's `references/`.

### The prd.json sprint system

`prd.json` shares state between `auto`, its progress view, Stop and drift audit. Its `stories` object is keyed by id. **`passes`** means:

| value | remaining work? | an agent can act on it? |
|---|---|---|
| `null` | yes, pending | yes |
| `true` | no, done | n/a |
| `false` | yes, failed | yes, retry |
| `"deferred"` | **no**, a decision not to do it | no |
| `"needs-setup"` | **yes**, blocked on a human | **no** |

Readers must distinguish **all five** states, not boolean truthiness and not stop at four. Use `summarise()` in `plugins/autodev-core/scripts/prd-states.js`, including its `unrecognised` bucket. Change this table and the parser together for new states.

`stop-auto-check.js` blocks turn end while work is pending. Escapes: explicit auto-exit, flag older than 2h, missing/unparseable PRD, idle one-shot marker, or drift-audited long-untouched stories.

### Hooks run on every turn

Register hooks in `plugins/<plugin>/hooks/hooks.json` using only `${CLAUDE_PLUGIN_ROOT}` paths. Validate rejects `~/.claude` and relative paths. Wrap bodies in try/catch, set `process.exitCode` and drain output. Only intentional blockers fail. `pre-tool-filter.js` fails closed except its private-name block, which fails open.

**Nothing to say means zero stdout and stderr.** Every wired hook needs a subprocess suite (`check:hooks` is a hard gate). Follow `tooling/test-pre-tool-filter.js`.

### Version is six files and one writer

`VERSION` is authoritative. Only `bump.js` writes versions to `package.json`, `.claude-plugin/marketplace.json` and every `plugins/*/.claude-plugin/plugin.json`. Versions are cache keys, so never reuse one for two trees. Re-read `VERSION` and origin branches immediately before bumping.

## Conventions that have cost something

- **`git commit -F <file>`, never `-m`**: the shell eats backticks.
  `[measured 2026-10-15]` **force-push is blocked** on main, stable and `v*` tags by rulesets and
  the pre-push hook ([docs/release-rulesets](docs/release-rulesets/README.md)). `check:claude-md` grades both ways.
- **Never `git commit --amend` or `git add -A`.** Stage explicit paths. Concurrent sessions move HEAD and leave unrelated work.
- **This repo is PUBLIC.** Enable tree/message privacy gates with `git config core.hooksPath tooling/githooks`. Machine-specific rules belong in `~/.claude/rules/`. Keep denylisted names as digests, generated by `node tooling/check-no-private-names.js --digest <name>`, never plaintext.
- **`process.exit()` can truncate output.** POSIX pipes are asynchronous. Set `process.exitCode`, drain the event loop, and test a write large enough for backpressure.

- A scripted rewrite of `process.exit(X)` must count parens, then grep for survivors.
- **`;` is not `&&`**, and a validation run piped into `head` or `tail` inside a chain reads red as green.
- macOS `realpathSync`: `/var/folders` and `/private/var/folders` are one directory. Resolve any path
  compared against a child's `process.cwd()`.
- Avoid nested quoting in `node -e`. Write a scratch file.

## Product repos

**Commit and push autodev branches freely.** main moves only by PR through merge-lock. Product merges/deploys follow `~/.claude/rules/decision-policy.md`, otherwise ask. Use `git worktree add`, never checkout in a live main tree. Re-run the product gate after rebasing. `plugins/autodev-core/scripts/shared-install.js link <worktree>` hardlinks main's node_modules. Unshare before installs ([details](docs/shared-install.md)).
