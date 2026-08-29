# RESUME

Written by `session-exit.js` from state READ at generation time, never from
a recollection. Every number came from a command; anything a command could
not answer says so rather than rendering as empty.

| field | value |
|---|---|
| directory | `~/Code/autodev` |
| branch | `main` |
| upstream | `origin/main` |
| HEAD committed | 2026-08-29T08:02:54+03:00 |

**Re-read before acting on any of this.** A resume file is a snapshot, and
the two facts most likely to have moved are the two below: someone may have
pushed, and someone may have merged.

## Unpushed commits

None. A real zero: the command ran and returned nothing.

## Uncommitted changes

None. A real zero: the command ran and returned nothing.

## Open PRs

None. A real zero: the command ran and returned nothing.

## Worktrees

Another session may hold one of these. Run `git status` in a tree before
touching it: a dirty tree you did not dirty means someone is in there.

```
~/Code/autodev                                                1500983 [main]
~/Code/autodev/.claude/worktrees/autodev-update-3b29cd        7be5d55 (detached HEAD)
~/Code/autodev/.claude/worktrees/brain-tree-inert             5646d5d [release/8.140.0]
~/Code/autodev/.claude/worktrees/layout-spec-a-design-d06780  9bf2f20 (detached HEAD)
```

## What a reader should do first

1. `git fetch`, then re-check the sections above. They decay fastest.
2. Run `npm run test` before believing anything is green. That name was read from `package.json` here, not assumed.
3. Read `CHANGELOG.md`, `README.md` - present in this directory, checked rather than assumed.
4. Read recent commit bodies. Many projects put the reasoning there rather than in a separate design note.

_These steps were derived from what is actually in `~/Code/autodev`._
