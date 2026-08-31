# RESUME

Written from state READ at generation time, never from a recollection. Every
number came from a command; anything a command could not answer says so rather
than rendering as empty.

| field | value |
|---|---|
| directory | `~/Downloads/code/autodev` |
| branch | `test/brain-panels-vacuity-gaps` |
| upstream | `origin/test/brain-panels-vacuity-gaps` |
| HEAD committed | 2026-08-27T23:47:38+03:00 |
| generated | 2026-09-01T00:30+03:00 |

**Re-read before acting on any of this.** A resume file is a snapshot, and the
two facts most likely to have moved are the two below: someone may have pushed,
and someone may have merged.

## This branch has nothing outstanding

`git log --oneline origin/main..HEAD` returns **0**, and
`git diff --stat origin/main...HEAD` is empty. The branch's work is already on
main. It is a checkout to work from, not a change waiting to land.

## Unpushed commits

None on this branch. A real zero: the command ran and returned nothing.

**Elsewhere:** `docs/recovery-stitching` in the `stitch` worktree holds
`5d0b73c`, committed and unpushed.

## Uncommitted changes here, and why two of them must NOT be committed

- `?? AGENTS.md` — **do not commit.** This is a stale find-replace copy of
  `CLAUDE.md` with "Claude" swapped for "Codex", which inverted repo facts: it
  calls this a Codex plugin marketplace and says validate rejects `~/.Codex`, a
  string `grep -rn` finds zero times in `tooling/` against ten for the real one.
  Main already carries a corrected `AGENTS.md` that is a pointer to `CLAUDE.md`.
  Committing this local copy re-introduces the defect PR #110 removed. Delete it.
- `?? .claude/` — ephemeral tooling state. `rules/file-organization.md` says it
  stays out of git.
- ` M RESUME.md` — this file.

## Open PRs

- [#111](https://github.com/djnsty23/claude-auto-dev/pull/111) `codex/framework-radar` - feat(radar): add continuous framework research

Recently merged: [#110](https://github.com/djnsty23/claude-auto-dev/pull/110),
squashed to main as `556850f`.

## Worktrees

Another session may hold one of these. Run `git status` in a tree before
touching it: a dirty tree you did not dirty means someone is in there.

```
~/claude-auto-dev                                          f64ed40 [main]
~/claude-auto-dev/.claude/worktrees/code-changelog-d72bca  0222e8e (detached HEAD)
~/claude-auto-dev/.claude/worktrees/incremental-write      556850f (detached HEAD)
~/claude-auto-dev/.claude/worktrees/sad-kirch-355c74       2d3808b (detached HEAD)
~/claude-auto-dev/.claude/worktrees/stitch                 5d0b73c [docs/recovery-stitching]
~/Downloads/code/autodev                                   8475443 [test/brain-panels-vacuity-gaps]
~/Downloads/code/autodev/.claude/worktrees/framework-radar b7e0449 [codex/framework-radar]
```

The `main` clone reads `f64ed40` above while `origin/main` is at `556850f`; the
clone is simply behind, not diverged. A file has as many current values as there
are checkouts, so read a tracked file from the ref
(`git cat-file -p origin/main:<path>`) when one authoritative answer is wanted.

## What a reader should do first

1. `git fetch`, then re-check the sections above. They decay fastest.
2. Run `npm test` before believing anything is green. That name was read from
   `package.json` here, not assumed. The full chain is `npm run gate`
   (`npm test && npm run check:suites`); `npm run gate:release` adds
   `check:runtime`.
3. Read `CHANGELOG.md` and `README.md` — present in this directory, checked
   rather than assumed.
4. Read recent commit bodies. This repo puts the reasoning there rather than in
   a separate design note.

_These steps were derived from what is actually in `~/Downloads/code/autodev`._
