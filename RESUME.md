# RESUME

Written by `session-exit.js` from state READ at generation time, never from
a recollection. Every number came from a command; anything a command could
not answer says so rather than rendering as empty.

| field | value |
|---|---|
| directory | `~/claude-auto-dev/.claude/worktrees/codex-usage-guide-9a3bb2` |
| branch | `claude/intelligent-brattain-6a09ad` |
| upstream | `origin/claude/intelligent-brattain-6a09ad` |
| HEAD committed | 2026-09-02T22:01:15+03:00 |

**Re-read before acting on any of this.** A resume file is a snapshot, and
the two facts most likely to have moved are the two below: someone may have
pushed, and someone may have merged.

## Unpushed commits

- `8b79aa2 fix(session-exit): --help wrote RESUME.md, and the usage named flags that do not exist`
- `0d0d6cb fix(selftests): derive three population counts, one of which was already wrong`

## Uncommitted changes

- `M RESUME.md`

## Open PRs

- [#127](https://github.com/djnsty23/claude-auto-dev/pull/127) `fix/test-validate-orphan-fixture` - fix(suites): two baselines that failed for reasons outside themselves, and v8.155.0

## Worktrees

Another session may hold one of these. Run `git status` in a tree before
touching it: a dirty tree you did not dirty means someone is in there.

```
~/claude-auto-dev                                               e1a53d6 [main]
~/claude-auto-dev/.claude/worktrees/autodev-core-brain-81ae78   e4942c1 (detached HEAD)
~/claude-auto-dev/.claude/worktrees/codex-radar-20260902-184238 e1a53d6 [codex/radar-20260902-184238]
~/claude-auto-dev/.claude/worktrees/codex-usage-guide-9a3bb2    8b79aa2 [claude/intelligent-brattain-6a09ad]
~/claude-auto-dev/.claude/worktrees/vigorous-maxwell-7ac5dc     b6f25ad [fix/test-validate-orphan-fixture]
~/Downloads/code/autodev                                        3f8101f [test/brain-panels-vacuity-gaps]
```

## What a reader should do first

1. `git fetch`, then re-check the sections above. They decay fastest.
2. Run `npm run gate` before believing anything is green. That name was read from `package.json` here, not assumed.
3. Read `CHANGELOG.md`, `README.md` - present in this directory, checked rather than assumed.
4. Read recent commit bodies. Many projects put the reasoning there rather than in a separate design note.

_These steps were derived from what is actually in `~/claude-auto-dev/.claude/worktrees/codex-usage-guide-9a3bb2`._
