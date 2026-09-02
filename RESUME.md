# RESUME

Written by `session-exit.js` from state READ at generation time, never from
a recollection. Every number came from a command; anything a command could
not answer says so rather than rendering as empty.

| field | value |
|---|---|
| directory | `~/claude-auto-dev/.claude/worktrees/vigorous-maxwell-7ac5dc` |
| branch | _not a git repo_ |
| upstream | _none tracked_ |
| HEAD committed | 2026-09-02T15:45:05+03:00 |

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
~/claude-auto-dev                                                      27f1c69 [main]
~/claude-auto-dev/.claude/worktrees/autodev-core-brain-81ae78          e4942c1 [claude/stoic-mayer-faab1d]
~/claude-auto-dev/.claude/worktrees/code-changelog-d72bca              0222e8e (detached HEAD)
~/claude-auto-dev/.claude/worktrees/codex-usage-guide-9a3bb2           187ce9c [claude/agents-md-channel-pointer]
~/claude-auto-dev/.claude/worktrees/incremental-write                  556850f (detached HEAD)
~/claude-auto-dev/.claude/worktrees/sad-kirch-355c74                   2d3808b (detached HEAD)
~/claude-auto-dev/.claude/worktrees/survey-trunk-cache                 70fbfce [fix/survey-trunk-cache]
~/claude-auto-dev/.claude/worktrees/vigorous-maxwell-7ac5dc            302b147 (detached HEAD)
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

## Unpushed commits, measured by hand where the script cannot answer

The script reports COULD NOT READ, correctly: this branch tracks no upstream, so
"ahead of origin" has no answer. Measured against the trunk instead:

```
git rev-list --count origin/main..HEAD   ->  17
```

Seventeen local commits, none pushed. A push needs the operator's word in the
turn, or a recorded standing order in the Q2 form. `~/claude-memory/STANDING-ORDERS.md`
holds **zero** orders, so nothing currently authorises one.

## L2 delivered, 2026-09-02

| artefact | state |
|---|---|
| `~/claude-memory/STANDING-ORDERS.md` | the holder. Zero orders, which is correct |
| `tooling/check-standing-orders.js` | validator, 19 selftest checks |
| `tooling/test-standing-orders.js` | 17 passed |
| `tooling/standing-order-wake.js` | the wake, and C4's once-only transition |
| `tooling/test-standing-order-wake.js` | 25 passed, three wakes over one flip |
| `check:standing-orders` | npm alias. Not in the gate chain: `npm test` runs the suite |

Commits `0232835`, `ffffe6e`, `302b147`. Mirror `9982315`.

    npm run gate  ->  94/94 suites, 93 verified able to fail, 0 NOT verified,
                      tree restored clean, GATE_EXIT=0

C4 measured: wake 1 does not fire, wake 2 fires once and writes
`executed <ts>`, wake 3 does not re-fire with the condition still true.

**The acceptance test was wrong a fourth time, in the same way.** L2's
acceptance named `check-push-authorisation.js` as the gate that must refuse an
order with no verbatim words. Run it and it prints
`63 shipped SKILL.md scanned` - a different question over a different corpus.
Keep running each lane's probe before starting the lane.

## Two things the next session should not rediscover

1. **A backgrounded `npm run gate` reports its exit as 0 regardless**, if the
   command ends with anything after `;`. Run one here was RED and the task
   notification said exit code 0. Capture `GATE_EXIT=$?` and read that.
2. **`.claude/reports/` was deleted from this worktree during a gate run**,
   cause unknown and not asserted. The round log survived only because the
   mirror had copied it three minutes earlier. It is gitignored, so `git status`
   showed nothing. The plan calls the log "durable by appending"; that is false,
   and the durability actually came from `~/claude-memory/reports/`.

## Next lane: S5, then L3, then L1

**S5, the coordinator-write hook.** A PreToolUse hook refusing `git commit` and
`git push` when the session holds the Brain role file and cwd is outside the
harness repo. Absence re-confirmed here with a control:

```
git ls-tree -r --name-only HEAD | grep hooks.json                  ->  2 tracked
git grep -c "AskUserQuestion" HEAD -- plugins/*/hooks/hooks.json   ->  1  (control)
git grep -c "Bash"            HEAD -- plugins/*/hooks/hooks.json   ->  0
```

PreToolUse carries `Read|Write|Edit` and `AskUserQuestion` only, so the ban has
no mechanism at all. Build it in a FRESH session: it ships in this marketplace
and runs in other people's sessions, where a throw kills their turn and a defect
survives until reinstall. Fail OPEN, follow the private-name block in
`pre-tool-filter.js`, and mutation-test by removing the role file.

Then L3, then L1 as the integration lane.
