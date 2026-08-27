# RESUME

Written by `session-exit.js` from state READ at generation time, never from
a recollection. Every number came from a command; anything a command could
not answer says so rather than rendering as empty.

| field | value |
|---|---|
| directory | `~/Downloads/code/autodev` |
| branch | `test/brain-panels-vacuity-gaps` |
| upstream | `origin/test/brain-panels-vacuity-gaps` |
| HEAD committed | 2026-08-27T22:14:01+03:00 |

**Re-read before acting on any of this.** A resume file is a snapshot, and
the two facts most likely to have moved are the two below: someone may have
pushed, and someone may have merged.

## Unpushed commits

None. A real zero: the command ran and returned nothing.

## Uncommitted changes

- `M .gitignore`
- ` M RESUME.md`
- `?? .claude/`

## Open PRs

None. A real zero: the command ran and returned nothing.

## Worktrees

Another session may hold one of these. Run `git status` in a tree before
touching it: a dirty tree you did not dirty means someone is in there.

```
~/claude-auto-dev                                 86bbe22 [main]
~/claude-auto-dev/.claude/worktrees/fix-injection 106467f [fix/shell-injection-in-shipped-scripts]
~/claude-auto-dev/.claude/worktrees/rec-quality   cde1997 [rescue/recommendation-quality]
~/claude-auto-dev/.claude/worktrees/rel-8123      377366b [release/8.123.0]
~/claude-auto-dev/.claude/worktrees/rel-8125      ac691b4 (detached HEAD)
~/claude-auto-dev/.claude/worktrees/sec-rebase    7d5517c [fix/shipped-script-injection-rebased]
~/Downloads/code/autodev                          5555d34 [test/brain-panels-vacuity-gaps]
```

## What a reader should do first

1. `git fetch`, then re-check the sections above. They decay fastest.
2. Run `npm run test` before believing anything is green. That name was read from `package.json` here, not assumed.
3. Read `CHANGELOG.md`, `README.md` - present in this directory, checked rather than assumed.
4. Read recent commit bodies. Many projects put the reasoning there rather than in a separate design note.

_These steps were derived from what is actually in `~/Downloads/code/autodev`._
