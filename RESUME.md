# RESUME

Written by `session-exit.js` from state READ at generation time, never from
a recollection. Every number came from a command; anything a command could
not answer says so rather than rendering as empty.

| field | value |
|---|---|
| directory | `~/claude-auto-dev/.claude/worktrees/autodev-core-brain-81ae78` |
| branch | `claude/autodev-core-brain-7cb881` |
| upstream | _none tracked_ |
| HEAD committed | 2026-09-03T02:03:33+03:00 |

**Re-read before acting on any of this.** A resume file is a snapshot, and
the two facts most likely to have moved are the two below: someone may have
pushed, and someone may have merged.

## Unpushed commits

**COULD NOT READ.** No upstream is tracked for this branch, or git could not be reached, so "ahead of origin" has no answer here.

This is not "none". Nothing was measured, so treat it as unknown.

## Uncommitted changes

None. A real zero: the command ran and returned nothing.

## Open PRs

None. A real zero: the command ran and returned nothing.

## Worktrees

Another session may hold one of these. Run `git status` in a tree before
touching it: a dirty tree you did not dirty means someone is in there.

```
~/claude-auto-dev                                               0d8302c [main]
~/AppData/Local/Temp/check-suites-wt-41904-xUVmFf               ab00a35 (detached HEAD)
~/claude-auto-dev/.claude/worktrees/autodev-core-brain-81ae78   71462ea [claude/autodev-core-brain-7cb881]
~/claude-auto-dev/.claude/worktrees/codex-radar-20260902-184238 e1a53d6 [codex/radar-20260902-184238]
~/claude-auto-dev/.claude/worktrees/codex-usage-guide-9a3bb2    ab00a35 [fix/away-state-time-bomb]
~/claude-auto-dev/.claude/worktrees/vigorous-maxwell-7ac5dc     0285b8f [claude/affectionate-kalam-8a7ed8]
~/Downloads/code/autodev                                        3f8101f [test/brain-panels-vacuity-gaps]
```

## What a reader should do first

1. `git fetch`, then re-check the sections above. They decay fastest.
2. Run `npm run gate` before believing anything is green. That name was read from `package.json` here, not assumed.
3. Read `CHANGELOG.md`, `README.md` - present in this directory, checked rather than assumed.
4. Read recent commit bodies. Many projects put the reasoning there rather than in a separate design note.

_These steps were derived from what is actually in `~/claude-auto-dev/.claude/worktrees/autodev-core-brain-81ae78`._

## Measured by hand, because session-exit could not (2026-09-03 02:07)

It reported `unpushed UNKNOWN`, correctly: this branch has NO UPSTREAM
(`claude/autodev-core-brain-7cb881`), so there is nothing for it to diff against.
That is a COULD-NOT-READ, not a zero. The real answer, against `origin/main`:

    git rev-list --left-right --count origin/main...HEAD   ->   0  5

**FIVE COMMITS, UNPUSHED, ALL GATED CLEAN:**

    71462ea  feat(hooks): tell the coordinator when work has landed
    7f54c04  docs(design-system): Magic UI is the motion layer
    4ad27bd  fix(gate): tree-inert watches HEAD, CI branch filter
    f33042d  docs(brain): draft-skip precondition, corrected
    02b70d1  docs(brain): draft-skip precondition, first version

`npm run gate` on these: 132 suites, 2301 PASS, **exactly one failing suite** and
it is not mine — `test-away-state`, a pre-existing time bomb on the trunk
(`tooling/test-away-state.js:58` hardcodes `until: 2026-09-02T22:00:00Z` as "the
FUTURE"; it expired at 22:00Z). The S5 session holds the fix as `ab00a35` on
`fix/away-state-time-bomb`, has the operator's panel authorisation to push on
green, and had not pushed as of 02:07.

**So the sequence is: their fix lands on main, I rebase, push these five.**
Nothing here is blocked on anything I can do alone.

## Fleet, as of 02:07

- Open PRs: fatboyslim 6, qr 1, spotivibly 1, afk-farm 1, claude-auto-dev 0.
- Panels DENIED across 30 locations until **05:26:23Z (08:26 local)**. Restore
  with `brain-panels.js --on`, or `--expire` if it is past that and still set.
- 83 stranded commits bundled to `~/claude-memory/rescue/` (fatboyslim 5,
  growceanu 48 + 28 subset, Shopify 2 in `Downloads/code/_rescue`, client work
  deliberately not in the mirror). growceanu's branch reached origin separately.
- Standing instruction from the operator, 2026-09-03: **check on peers every turn
  while autobrain is on, even when interrupted.**

## Only the operator can do these

1. **afk-farm PR #4** — that repo's brief says the owner merges, never a session.
2. **`subagentPromptCacheTtl`** — unset, so subagents get 5 minutes while gates
   run 20 to 40. Billing-adjacent, so left alone.
3. **`betsetgo` branch `chore/ci-branch-filter`** — an empty pointer at
   origin/master from a change that proved unnecessary. `git branch -D` is
   blocked by a hook, correctly.

## Read this before re-deriving anything

`~/claude-memory/FINDINGS-claude-code-docs-2026-09-03.md` (commit `a07e9c7`) has
everything nine pasted docs pages were worth to this setup, measured. The two
that pay: a 3,998-line always-on instruction load against a 200-line target, and
66 skill descriptions costing ~2,397 tokens on every request with none hidden.

`~/claude-memory/DECISIONS-2026-09-03.md` has every reversible call made
overnight, with its reasoning, for auditing or reversing.
