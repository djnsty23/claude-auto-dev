# RESUME

Written by `session-exit.js` from state READ at generation time, never from
a recollection. Every number came from a command; anything a command could
not answer says so rather than rendering as empty.

| field | value |
|---|---|
| directory | `~/claude-auto-dev/.claude/worktrees/vigorous-maxwell-7ac5dc` |
| branch | `claude/intelligent-brattain-6a09ad` |
| upstream | _none tracked_ |
| HEAD committed | 2026-09-02T12:26:46+03:00 |

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
~/claude-auto-dev                                                      6e331ec [main]
~/AppData/Local/Temp/check-suites-wt-54308-5tB9Nn                      6e331ec (detached HEAD)
~/claude-auto-dev/.claude/worktrees/autodev-core-brain-81ae78          6a31e23 (detached HEAD)
~/claude-auto-dev/.claude/worktrees/code-changelog-d72bca              0222e8e (detached HEAD)
~/claude-auto-dev/.claude/worktrees/codex-usage-guide-9a3bb2           187ce9c [claude/agents-md-channel-pointer]
~/claude-auto-dev/.claude/worktrees/incremental-write                  556850f (detached HEAD)
~/claude-auto-dev/.claude/worktrees/sad-kirch-355c74                   2d3808b (detached HEAD)
~/claude-auto-dev/.claude/worktrees/survey-trunk-cache                 70fbfce [fix/survey-trunk-cache]
~/claude-auto-dev/.claude/worktrees/vigorous-maxwell-7ac5dc            c0891f1 [claude/intelligent-brattain-6a09ad]
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
git rev-list --count origin/main..HEAD   ->  10
git status -sb                           ->  ## claude/intelligent-brattain-6a09ad   (no upstream)
```

Ten local commits, none pushed. A push needs the operator's word in the turn.

## What landed this session

| lane | result | commits |
|---|---|---|
| L4 bootstrap | one round, VERDICT: CLEAN, 1 defect found in the adversary's own test | earlier |
| Fly.io removal | workflow disabled, dead token deleted, two docs updated | mirror repo |
| L5 | check:entrypoints wired; 5 scripts stopped doing work on --help; provenance stays advisory | 565f6d1, 2a1a1fc |
| L7 | bare-word dispatch form added; check:skill-tools wired | 016637b, c0891f1 |

Gate green on a clean tree after every code change: 92/92 suites, 91 verified
able to fail, 0 NOT verified, tree restored clean, exit 0.

## Next lane: L6, then L2, L3, L1

L1 is the integration lane and runs last. Two rails L6 should pick up, both
found while executing other lanes rather than by planning:

1. **The gate cannot run inside one tool call.** It exceeds a 10-minute budget,
   and the process SURVIVES the killed call, so anything automating it must
   background and poll rather than wait. A caller that re-runs on timeout puts
   two mutation sweeps on one job.
2. **C9's stop line cannot be read off `quota-tripwire.js --status`.** That
   figure is account-wide across every live session, not this audit's spend. The
   audit's attributable cost is the GPT column of `usage-both.js` plus this
   session's own transcript.

## Two findings that belong to the PLAN, not the code

L5 and L7 each ended by finding their own acceptance test wrong, the same way:
naming a probe by the question they want answered rather than by what the probe
reports. L5 wanted a gate keyed on exit codes, which cannot detect an ignored
flag. L7 wanted a heuristic prose-grader to gate, which its own header declines
to do. Two of two executed lanes, so treat it as a property of the plan and
re-read the remaining lanes' acceptance tests against what their probes print
before starting them.

## Open, needing the operator

- `SUPABASE_WINDROSE_PASSWORD` was rendered into this session's transcript by a
  `doppler secrets delete` that prints the whole store. Confined to the local
  transcript, 0 files elsewhere; the operator read the blast radius and said it
  is fine. No rotation performed.
- A dead `FLY_API_TOKEN` repo secret remains in the analytics repo.
- Q5 stays open: no headless supervisor was built or run.

## L6, partially delivered 2026-09-02

| rail | verdict |
|---|---|
| C9 tripwire | **PASS**, two-sided, ceiling the only variable |
| S5 coordinator-write ban | **ABSENT**; no PreToolUse hook matches Bash |
| S12 archive setting at boot | **FAILS**; `isArchived` used as a filter only |
| C5, C7, mirror race | deferred by the plan's own week-1 scope |

**Next session starts here, smallest first.**

1. **S12, one line in `brain-brief.js`.** It already fetches session rows and
   uses `isArchived` three times as a filter. Print the SETTING: any row with
   `isArchived: true` beside `prState: MERGED` means merging a PR can end the
   merging session. Measured ON today, so a Brain that merges can archive itself
   with no warning at boot.
2. **S5, the coordinator-write hook. Do this in a FRESH session.** It is a
   PreToolUse hook on `Bash`, shipping in this marketplace into other people's
   sessions, where a throw kills their turn and a defect survives until
   reinstall. Fail OPEN, follow `pre-tool-filter.js`'s private-name block, and
   mutation-test by removing the role file. It was deliberately not attempted at
   412k context.
3. Then L2, L3, and L1 last as the integration lane.

**C9 carries a standing limit, unchanged:** its reading is account-wide, moving
$55 to $974 during one session, so it scores "is the account near its wall" and
cannot score "has the audit spent 8% of its window". Use the `usage-both.js` GPT
column plus this session's transcript for the latter.

**Probe note for whoever tests the tripwire next:** use `--fixture-cost`,
`--fixture-window` and `--fixture-now` with a scratch `--state`. Hand-seeding
samples does not work, because a `windowStart` mismatch clears the sample array
(line 264), and both arms of the experiment then return identical output.

## L2 surveyed, not built, 2026-09-02

`STANDING-ORDERS.md` does not exist. The three queue scripts do. And L2's
acceptance names `check-push-authorisation.js` as the gate that must refuse an
order with no verbatim operator words, which it cannot do: it reads only
`plugins/*/skills/*/SKILL.md`. C4 needs a NEW validator over the holder file,
checking the four parts Q2 specified (verbatim words, date, condition, holding
session).

**Start L2 in a fresh session.** It is a new file plus a new gate plus a suite,
and this session reached 457,833 tokens.

**Before starting any remaining lane, re-read its acceptance test against what
its probe actually prints.** Three of three executed lanes found their own
acceptance wrong in the same way, so treat it as the default rather than the
exception.

**Bonus finding, with its population:** 38 npm aliases are defined and **21 are
invoked from nowhere**, measured across package.json, every workflow and 164
scripts. Not 21 defects: some are deliberately manual (`bump`, `radar`,
`usage:both`), two are advisory by design. But `find-orphan-checks.js` calls
every one of them reachable, because a package.json mention counts as a
reference, so this class can grow forever without the detector noticing.
