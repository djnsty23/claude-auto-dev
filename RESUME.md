# Resume here — coordinator session, night of 2026-09-02/03

`[measured 2026-09-03 03:20]` Every line below was re-read at that time. Where a
number appears, the command that produced it is named, because this file went
stale three times in one night and each staleness was invisible from inside it.

Product repos are lettered. This repo is public; naming them fails its own test —
would this sentence still be true and useful on a machine that is not this one?
The mapping and the per-repo detail live in the memory mirror, which is on the
backup allowlist.

## The one thing to read first

**Nothing is broken and nothing is waiting on me.** Six PRs sit open across four
repos, every one of them deliberately, and the reasons differ.

## This branch

`claude/autodev-core-brain-7cb881`, pushed, **PR #130 (draft)**.

    git rev-list --left-right --count origin/main...HEAD   ->   0  8

Eight commits: tree-inert watching HEAD, the coordinator report hook and its
suite, this repo's CI branch filter, both draft-skip corrections, a motion-layer
addition to the design-system rule, the harness-audit idle-work section, and a
windowsHide fix.

`npm run gate`: 132 suites, 2301 PASS, **one failing suite** — `test-away-state`,
**pre-existing on the trunk and not from this branch**. `npm run validate`:
19 PASS, 0 FAIL.

## Open PRs, and why each is open

| PR | state | why it is not merged |
|---|---|---|
| this repo **#131** | green, ready | The trunk fix, and it now blocks #132 as well as three others. Its session was offered a straight-to-main merge on a panel and the operator chose the PR round-trip instead, with the tradeoff named: no review surface on a fix to a test that had just proved it could lie about being green. A later broad merge grant does not reverse a specific choice about this change. **His.** |
| this repo **#130** | draft | Mine. No hurry. |
| this repo **#132** | draft, PR run RED | The rendered-layout gate. Its single failure is `test-away-state`, the trunk bug **#131** fixes, not its own work: third sighting tonight. Its push run is green only because the branch is 34 behind and carries 92 of the trunk's 96 suites, so it never ran the failing file. **Do not rebase it before #131 merges** - that would import the bug and turn the green run red too. Its session measured this itself and is holding it deliberately. |
| Project A **#654** | gate SUCCESS, CLEAN | Wires an offer engine that was advertised and never applied. Careful work: resolved server-side rather than from the request body, and explicitly fail-safe. **Live payment path** — deploys on merge. |
| Project B **#33** | gate SUCCESS | During a payment-provider secret roll only the first signature was tried, so the webhook returned 400 to every legitimate event, with a rejection byte-identical to a forged one. Its existing test PINNED the defect. **Live payment path** — deploys on merge. Ready to land in seconds. |
| Project C ×7 | mixed | One real gate FAILURE, one check still running, one CONFLICTING, four drafts. None ready. |

**The two payment-path PRs are held on one reasoning, stated so the standard is
visible rather than implied:** the merge grant covers deciding whether work is
USEFUL, and both are. It does not cover deploying money code at 03:00 when the
operator's own condition was "we'll have to check on live after deploy and really
test everything out" — a condition unmeetable for hours.

## Merged tonight

- **Project B #32.** Nine buyer-facing surfaces still advertised the old free-tier
  rate after it changed; one localised page promised "no limit on how many you
  keep" directly under a hard cap. Measured in a browser, ships a shape test.
- **Project D #4**, after the operator overrode a hold with "no users, can't break
  anything".

## Rescued work, and where it is NOT

**No count here, for the same reason the gate step count was deleted.** I wrote
"16" while the true figure was 15, by counting FILES in `~/claude-memory/rescue/`
when one of them is a `.md`. Count them when you need the number, with the filter
that makes it the right question:

    ls -1 ~/claude-memory/rescue/*.bundle | wc -l

Every bundle is `bundle verify` okay, each verified from the repo it came from,
because verifying from the wrong one produces both false reds and a false green.

**A bundle goes stale the moment its session commits again**, which happened
within the hour: the ab-artifact-check tip moved from `4dba7168` to `1dd003db`
after I bundled it, so the rescue covered one of two commits. Re-bundled. Any
sweep that bundles and walks away is protecting a tip that no longer exists.

Two were added after the earlier sweep:

- `autodev-main-0fbe6dd-20260903.bundle` (19,329 B) - six commits on the shared
  clone's local `main`, now including a REVERT of the duplicate trunk fix, so
  that session compared against #131 and backed its own out. Committing to
  `main` in a shared clone still violates this repo's own CLAUDE.md.
- `autodev-draftskip-c83bcf3-20260903.bundle` (18,077 B) - three commits on
  `fix/draft-skip-precondition`, a branch that exists on no remote and has no PR.

**`rescue/` is gitignored** (`.gitignore:9`), so new bundles never reach the
remote. That matters because two of the sixteen hold CLIENT work, which the
backup protocol forbids from reaching personal GitHub, and the ignore rule is
what enforces it. Nobody should "fix" that rule without reading the directory.

**But the rule is not retroactive, and I nearly reported the opposite.** Two
bundles predate it, are tracked, and ARE on GitHub:

    git ls-files rescue      ->  2, not 0
    analytics-client-ip-73f0544.bundle
    vigorous-maxwell-7ac5dc-c885ddd.bundle

Both are from repos the operator owns, so neither is a client leak, and I
checked that rather than assuming it. The near-miss is the reusable part: I
printed the count with the words "0 is correct" beside it, and the command
returned 2. A label asserting the expected answer sits next to the real one and
reads as agreement. Never write the expected value into the same line as the
measurement.

So these are insurance against a deleted worktree, not against a dead disk.

## The Stop hook is verified LIVE, not just by its suite

`[measured 2026-09-03]` The 16-case suite drives fixtures. This drove the shipped
`stop-brain-report.js` as a subprocess against two real worktrees, using the env
overrides so nothing in `~/.claude` was touched and the write guard stayed disarmed:

| behaviour | result |
|---|---|
| role file ABSENT (the ship-safe default) | silent, 0 bytes stdout AND stderr |
| role file present, first sighting | silent, baseline sha recorded |
| HEAD moved since last look | FIRES, correct branch and sha in the notice |
| immediately again, inside the window | silent, throttled |
| the coordinator being told to report to itself | silent |

Every path exit 0. So the mechanism works and the only thing standing between it
and doing its job is the role file the operator has not created.

One number in the notice needs reading carefully, and it is right rather than
wrong. It says "4 ahead of upstream" where a sweep for genuinely unpublished work
says 3. Both are correct: `@{upstream}..HEAD` counts against ONE ref, and the
sweep counts against every origin ref. The extra commit is published on another
branch. The notice names its reference, which is what keeps it honest.

## The away-state fix has no rival, checked rather than assumed

`[measured 2026-09-03]` Worry retired. Exactly one origin branch carries a change
to `tooling/test-away-state.js` that is not on main, and it is **#131's own
branch**. There is no competing PR. The session I flagged for a possible duplicate
had in fact MERGED #131's branch into its work, which is the correct move and the
opposite of duplicating it. So the morning decision is one merge, not a choice
between two.

## The debt that is easiest to forget

**`~/.claude/brain-role.json` does not exist**, so `stop-brain-report.js` — added
this session to fix the coordination failure that defined it — has never fired and
cannot. Arming it also arms `coordinator-write-guard`'s four-verb block, so it is
the operator's call. Its `home_repos` MUST include the memory mirror or the backup
obligation silently breaks. Full shape in the decisions log.

## Where the durable output went

Not in this repo, deliberately:

- `DECISIONS-2026-09-03.md` in the mirror — every reversible call with reasoning
- `FINDINGS-claude-code-docs-2026-09-03.md` — what nine pasted docs pages were
  worth here, measured
- `RESUME-fleet-2026-09-03.md` — per-repo fleet state and the letter mapping
- `~/.claude/rules/verification-traps.md` — two new sections; its own checker
  reports 28 sections, 28 indexed, 0 gaps
- `~/.claude/rules/local-first.md` — a gate step count DELETED after being wrong a
  fourth time, executing that paragraph's own standing instruction

## Standing, until told otherwise

- **Check peers every turn while autobrain is on, interruptions included.**
  Operator, 2026-09-03.
- **Idle work is harness self-evaluation** — five questions, all counts rather
  than readings. First round complete; findings in the decisions log.
- Panels denied fleet-wide until **05:26:23Z**. `brain-panels.js --on` restores;
  `--expire` clears it if it is past that and still set.
