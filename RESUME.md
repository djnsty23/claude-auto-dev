# RESUME

Written by `session-exit.js` from state READ at generation time, never from
a recollection. Every number came from a command; anything a command could
not answer says so rather than rendering as empty.

| field | value |
|---|---|
| directory | `C:\Users\nstyp\Downloads\code\autodev` |
| branch | `release/8.107.0` |
| upstream | `origin/release/8.107.0` |
| HEAD committed | 2026-08-25T00:14:37+03:00 |

**Re-read before acting on any of this.** A resume file is a snapshot, and
the two facts most likely to have moved are the two below: someone may have
pushed, and someone may have merged.

## Unpushed commits

- `4b4605c fix(watch-panels): it reported a broken fleet-status ONCE, then went silent`

## Uncommitted changes

- `?? --`
- `?? .claude/`
- `?? plugins/autodev-core/scripts/session-exit.js`

## Open PRs

None. A real zero: the command ran and returned nothing.

## Worktrees

Another session may hold one of these. Run `git status` in a tree before
touching it: a dirty tree you did not dirty means someone is in there.

```
C:/Users/nstyp/claude-auto-dev                                 86bbe22 [main]
C:/Users/nstyp/claude-auto-dev/.claude/worktrees/fix-injection 106467f [fix/shell-injection-in-shipped-scripts]
C:/Users/nstyp/Downloads/code/autodev                          4b4605c [release/8.107.0]
```

## What a reader should do first

1. `git fetch`, then re-check the two sections above. They decay fastest.
2. Run the gate before believing anything is green. Check `package.json` for
   its name at the commit you are on rather than assuming one.
3. Read `CHANGELOG.md` and recent commit bodies: this project puts the
   reasoning in the commit, not in a separate design note.
