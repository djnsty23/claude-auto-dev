# RESUME

Written by `session-exit.js` from state READ at generation time, never from
a recollection. Every number came from a command; anything a command could
not answer says so rather than rendering as empty.

| field | value |
|---|---|
| directory | `~/claude-auto-dev/.claude/worktrees/vigorous-maxwell-7ac5dc` |
| branch | `claude/intelligent-brattain-6a09ad` |
| upstream | _none tracked_ |
| HEAD committed | 2026-09-02T02:33:11+03:00 |

**Re-read before acting on any of this.** A resume file is a snapshot, and
the two facts most likely to have moved are the two below: someone may have
pushed, and someone may have merged.

## Unpushed commits

**COULD NOT READ.** No upstream is tracked for this branch, or git could not be reached, so "ahead of origin" has no answer here.

This is not "none". Nothing was measured, so treat it as unknown.

## Uncommitted changes

None. A real zero: the command ran and returned nothing.

## Open PRs

- [#125](https://github.com/djnsty23/claude-auto-dev/pull/125) `claude/agents-md-channel-pointer` - docs(agents): two channel facts a delegate can act on, and a pointer for the rest

## Worktrees

Another session may hold one of these. Run `git status` in a tree before
touching it: a dirty tree you did not dirty means someone is in there.

```
~/claude-auto-dev                                                      f44f321 [main]
~/claude-auto-dev/.claude/worktrees/autodev-core-brain-81ae78          6a31e23 (detached HEAD)
~/claude-auto-dev/.claude/worktrees/code-changelog-d72bca              0222e8e (detached HEAD)
~/claude-auto-dev/.claude/worktrees/codex-usage-guide-9a3bb2           187ce9c [claude/agents-md-channel-pointer]
~/claude-auto-dev/.claude/worktrees/incremental-write                  556850f (detached HEAD)
~/claude-auto-dev/.claude/worktrees/sad-kirch-355c74                   2d3808b (detached HEAD)
~/claude-auto-dev/.claude/worktrees/survey-trunk-cache                 70fbfce [fix/survey-trunk-cache]
~/claude-auto-dev/.claude/worktrees/vigorous-maxwell-7ac5dc            2be34ef [claude/intelligent-brattain-6a09ad]
~/Downloads/code/autodev                                               3f8101f [test/brain-panels-vacuity-gaps]
~/Downloads/code/autodev/.claude/worktrees/framework-radar             a398c93 [codex/framework-radar]
~/Downloads/code/autodev/.claude/worktrees/framework-radar-experiments 4ba28eb [codex/framework-radar-experiments]
~/Downloads/code/autodev/.claude/worktrees/marketing-radar             1d39981 [codex/marketing-radar]
~/Downloads/code/autodev/.claude/worktrees/radar-2026-09-01-first-live f40ee1a [codex/radar-2026-09-01-first-live]
~/Downloads/code/autodev/.claude/worktrees/radar-learning-layer        a63e08d [codex/radar-learning-layer]
```

## What a reader should do first

1. `git fetch`, then re-check the sections above. They decay fastest.
2. Run `npm run gate` before believing anything is green. That name was read from `package.json` here, not assumed.
3. Read `CHANGELOG.md`, `README.md` - present in this directory, checked rather than assumed.
4. Read recent commit bodies. Many projects put the reasoning there rather than in a separate design note.

_These steps were derived from what is actually in `~/claude-auto-dev/.claude/worktrees/vigorous-maxwell-7ac5dc`._

## Unpushed commits, measured by hand after the script said COULD NOT READ

The script is right and its blank is honest: this branch tracks no upstream, so
`ahead of origin` genuinely has no answer. Measured against the trunk instead:

```
git rev-list --count origin/main..HEAD   ->  5
git status -sb                           ->  ## claude/intelligent-brattain-6a09ad   (no upstream)
```

Five local commits, none pushed, and a push needs the operator's word in the
turn. In order: the kill-test seed, the evidence tree, the fix, the merge of
origin/main, and the untracking of the raw adversary output.

## Where the round's artifacts are

- Round log: `.claude/reports/harness-audit-rounds.md` in this worktree, ~400
  lines, gitignored by design and durable by being appended.
- Raw adversary findings: `.claude/reports/l4-bootstrap-findings.md`, same
  directory. Carries absolute home paths, which is why it is not tracked.
- Summary that survives this session: `DECISIONS-2026-09-02.md` in the config
  mirror, committed there locally.
- The adversary's plan review moved out of the archived planning worktree into
  the mirror's `reports/` directory; the path in the original brief is dead.

## Next lane, L5 remainder, in order

1. Wire `check:entrypoints` into `gate` and into CI. It is defined on main and
   nothing runs it; control grep for `check:population` finds it wired in both.
2. The `--help` sweep over the whole script population, printing the population
   and the non-returners.
3. Claim-provenance precision on the last 100 commit bodies; promote to blocking
   only under 5% false positives on that sample.

Stopping here rather than starting L5: last-turn context measured 328,686
tokens, over the ~300k threshold at which a lane hands off to a fresh session.
