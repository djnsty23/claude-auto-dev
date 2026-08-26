# Changelog

## [8.124.0] - 2026-08-26

### Fixed: a heal fix-agent isolated the wrong repo

`isolation: 'worktree'` builds the worktree from the **session's** repo, never
from the repo named in the agent's prompt. Every heal fix agent is pointed at a
different repo via `repo.path`, so the flag isolated the wrong tree and the agent
then edited the target's main clone, which is exactly where other live sessions
keep uncommitted work.

The crashing case was already known: on a session whose cwd is not a git repo,
every fix agent dies with *"Cannot create agent worktree: not in a git
repository"* after the find and verify stages have been paid for, which is how
the first real run lost its whole fix stage on 2026-08-22. The silent case is
worse and was not documented: when the session's cwd *is* a git repo, nothing
errors and the writes land in somebody else's tree.

The fix agent now creates its own worktree inside `repo.path` and reports the
resulting `pwd` and branch as the first line of its gate report. Its prompt also
tells it to branch from the current HEAD unless it has checked the default branch
carries the code, since a repo whose work lives on a long-running feature branch
will not have those files on its default branch at all.

`heal/SKILL.md` had prescribed this remedy from the day the trap was found. The
script did not carry it for four days, because **no suite read that file**. The
2026-08-26 external sweep worked around it by hand in all four of its fix agents.

### Added: `tooling/test-workflow-isolation.js`

Fails any workflow that points an agent at a caller-supplied `repo.path` while
asking for `isolation: 'worktree'`. Written as a rule about the pattern rather
than an allowlist of filenames, so the next such workflow is covered on the day
it lands rather than the day it misfires.

It prints its population (`N workflow scripts · N agent calls · N foreign-target
· N isolation uses · N offending`) and **exits non-zero when that population is
empty**, because a gate with nothing to scan reports PASS and is indistinguishable
from a healthy tree. Mutation-tested by restoring the real flag: 5/7, failing both
the general and the specific assertion, then reverted.

### Fixed: the completion line no longer hardcodes a repo count

`${clean.length}/3` under-reported on any sweep that was not three repos.

## [8.123.0] - 2026-08-26

### Added: the panel recommendation rule becomes a gate

`rules/options-protocol.md` has required every question block to mark one option
`(Recommended)` for as long as it has existed. Measured over 242 transcripts and
1,732 questions, 205 carry no mark at all, running at 12% across the last seven
days and firing again the morning of the measurement. The rule being written
down was not the missing piece.

`panel-recommendation.js` is a PreToolUse hook on `AskUserQuestion` that exits 2
when a multi-option question marks nothing. Exit 2 rather than an advisory,
because that stderr is the only channel reaching the model in time to fix the
panel in flight; an advisory ships the wrong panel and corrects the next one,
which is what the rule already did. A hit costs one retry before the user sees
anything.

Validated against real panels rather than fixtures alone: 963 compliant panels
from the transcripts, 0 blocked; 200 unmarked panels, 200 blocked; 0 crashes. A
gate whose false-positive rate is unmeasured gets muted the first time it is
wrong about something that matters.

It fails open on every internal error, because it ships installed and a defect
would eat panels in someone else's session until they reinstall. A missing
recommendation is a style breach; a swallowed panel is a broken turn.
`AUTODEV_PANEL_CHECK=off` disables it, since the convention belongs to this
marketplace rather than to everyone who installs it.

### Fixed: the recommendation detector only looked at one of two spellings

`check-recommendation-quality.js` anchored its pattern to the end of the option
LABEL. 24 panels put `(Recommended)` at the front of option #1's description
instead, which is the most literal reading of "mark option #1, with the reason
in its first clause", and every one was scored as a rules breach. The count
falls from 229 to 205 and those 24 join the judged pool.

Both spellings now count, each anchored. An unanchored pattern would score a
description DISCUSSING the convention as a mark, and this repo produces panels
about panels.

The measurement was real and answered a narrower question than the one being
asked: not "is there a recommendation" but "is there one where I looked".

### Added: measurement behind the rule

`check-recommendation-quality.js` reports honoured, rejected and swept, printing
the population it scanned so a zero cannot be mistaken for a probe that found
nothing. It also established that a PAUSE recommendation is rejected 43 times in
100 against 9 for everything else.

### Added: an advisory for a shell exit code that is the answer

A counting `grep` returning no match exits 1, so a chain reports failure for a
successful measurement and the red badge stops the reader before the output that
answered the question.

### Changed: the advisory cap sits at seven, deliberately

`agent-schema-violation` is the candidate for removal at 0.02 min/hit, but the
wall-clock probe prices a failure at tool_use to tool_result, while that class's
real cost is a workflow run dying at the retry cap after the work is finished.
Removing it on that number would trust a measurement about the wrong layer.

### Fixed: the names gate was clean and blind to home paths

Two spellings of the same detector, and a security gate reporting clean while
unable to see one of them.

### Added: observe which rules actually load

A dead rule and a loaded one are indistinguishable from the outside.

## [8.122.0] - 2026-08-25

### Fixed: a timing budget that produced false reds under load, after two wrong fixes

`test-image-scan-hook` asserts the hook's own work stays under 150 ms. It failed
during a full `test-all` at samples 286/475/437 against a 202 ms budget while
passing standalone, and the hook was healthy the whole time.

The existing design was already careful: it measured Node startup as a baseline,
budgeted +150 ms on top, and took min-of-3 on both sides specifically to survive
a spike. It still failed, because ALL THREE samples were slow, so taking the
minimum could not help.

**Two fixes were attempted and both disproved by running them.** Recorded in the
file, because each looked correct and reading why is cheaper than repeating them.

1. **Min of the per-pair differences.** Biased low: the minimum lands on
   whichever pair had the slowest baseline. Produced -182.8 ms from a 60 ms hook
   against a 243 ms bare node, and an assertion that goes hundreds of
   milliseconds negative sails through the regression it exists to catch.
2. **Interleaved floor-to-floor, min(total) minus min(bare).** Still flaked, at
   188.6 ms from floors of 234 total against 46 bare, on an unmutated hook.
   Alternating samples land on opposite phases when load oscillates faster than
   the sampling.

The root problem is that no wall-clock comparison across separate process spawns
is reliable on a loaded machine. More samples raise the cost without removing the
failure.

**So it now refuses to judge when the machine is too noisy, and says so.**
Detected from the baseline's own spread, which needs no knowledge of the hook: a
bare-node max/min above 2.5x prints NOT MEASURED for that case. A false red is
worse than a false green here, because it looks like diligence, so it gets acted
on, and the action is a change to working code.

**Skipping every case is not a pass.** If no case was measurable the check had no
subject, so it fails rather than reporting green, which stops absent coverage
reading as coverage.

### Verified

Two consecutive full `npm test` runs: **48/48, exit 0**, with the noise gate
skipping 2 cases in one run and 4 in the other under real parallel load. That is
the condition the old assertion failed on.

Mutation tested both ways. A 400 ms delay injected into the hook fails the budget
at 404.4 ms in the first clean window it gets. Forcing every case unmeasurable
fails on "0 of 7 timed" rather than passing silently.

Measured incidentally: the hook's actual own work is **2.5 to 8.3 ms**, not the
234 ms the old assertion implied. It was reporting machine load.

## [8.121.0] - 2026-08-25

### Investigated: why 41 of 45 skills never fire, and why both obvious fixes are wrong

`[measured 2026-08-25]` Across 565 transcripts. Two intuitive remedies were
attempted and both were stopped by evidence, so the write-up exists to keep them
from being re-attempted on the same reasoning.

**Established.** The skill listing is recorded in transcripts, and descriptions
are selectively dropped from it. Proof is one listing showing bare names beside a
single described skill. Survival is a stable per-skill property, from 98% for
`rule-diagnosis` down to 1.7% for `a11y`, and it predicts MODEL invocation
specifically: the only skill the model chose was the one at 98%, and everything at
6% or below got zero.

**Invocation does not buy survival**, which rules out the obvious confound.
`brain` fired 17 times at 12% survival and `audit` 11 times at 2.4%. Causation
runs description to model-reach, not the reverse.

**The mechanism is opaque from outside.** Eliminated by test: invocation count
(inverted), frontmatter shape (identical field sets), recency (11 skills modified
the same day do not survive), description length (the longest does not survive,
the second longest does), the memory database (one row, written that morning from
a command's stdout), and repo-file contamination (`a11y` appears in more repo
files and still scores 9 against 506).

**Cutting the dead skills is circular.** The criterion yields 28 candidates
including `auto` at 518 lines, plus `commit`, `preflight`, `ship`, `test` and
`brainstorm`, which are the primary command vocabulary. A description is dropped,
so the model cannot choose the skill, so it never fires, so it looks dead, so it
gets cut. Every step follows and the conclusion is inverted.

**Trimming descriptions is a guess.** It would follow if survival were driven by
total budget. Nothing supports that and length points the other way. Editing 51
files to influence an unidentified mechanism is prescribing a fix for an
unverified cause.

**What works is already in use.** User-typed invocation needs no description at
all: `audit` at 2.4% survival with 11 invocations, every one typed. So the
leverage is fewer names worth remembering rather than more skills or shorter
descriptions. Which is also why `phase` cannot rescue itself, having entered a
listing that already drops 47 of 51.

Written up in `skills/phase/references/why-skills-do-not-fire.md`, with the
single-variable test that would settle the mechanism if anyone wants to run it.

### Verified

`npm test`: 48/48 suites, exit 0.

Noted while gating, not fixed: `test-image-scan-hook` carries a wall-clock budget
assertion (202ms) that fails under machine load inside the parallel runner. It
measured 286ms during a busy moment and passes alone. A timing budget inside a
parallel test runner is a latent flake, and it is unrelated to this change.

## [8.120.0] - 2026-08-25

### Decided: `audit` stays an SOP-in-a-skill, and the reason is measured

The question was whether to rewrite `audit` as a Workflow script. It has the
clearest DAG of any skill here, and the case looked strong: the size gate is
prose so nothing enforces the agent count, there is no verifier node, and
per-dimension output is free-form so aggregation is the model re-reading prose.

The outcome data says no. Graded on results rather than on how tidy the mechanism
looks, across two mature product repos and **288 audit-generated stories**:

| | audit-generated | hand-generated |
|---|---|---|
| Project A | 123 stories, 110 done (89%), 11 failed, 0 deferred | 41 stories, 40 done |
| Project B | 165 stories, 151 done (92%), 2 deferred (1.2%) | 48 stories, 9 deferred (18.8%) |

`deferred` means somebody looked at the story and decided not to do it, so it is
the closest proxy available for a finding not worth having. Audit findings are
deferred **15x less often** than hand-written work. A missing verifier node
should surface as noise people decline to act on, and it does not.

So the port is not worth building. Rewriting a mechanism with an 89-92%
completion rate, to fix defects the data does not show, optimises something that
is not broken.

Written up in `skills/audit/references/why-this-stays-a-skill.md`, including the
two limits of the `deferred` proxy, three specific falsifiable conditions that
would justify revisiting, and the generalisable half: code-as-graph earns its
place where the EDGES must be enforced, and an SOP is adequate where a person
reads the output and would notice a missing step.

One thing deliberately NOT claimed: that the size gate is ignored in practice.
The obvious probe counts string mentions in a transcript rather than tool calls,
so a session that merely READ the skill file scores as though it had launched
agents. That needs the structured records, not a grep.

## [8.119.0] - 2026-08-25

### Corrected: v8.117.0 shipped a skill-invocation number that read one channel of two

`[measured 2026-08-25]` The `phase` skill and the 8.117.0 notes both said that
across 555 transcripts in seven days, exactly ONE of this plugin's invocable
skills had ever been invoked.

That is true of the Skill-tool channel and false as a statement about usage. A
person typing `/autodev-core:brain` is not recorded in the `"skill"` field at
all. It lands in a `<command-name>` block, and the naive grep never looked there.

The control that caught it: `autodev-core:brain` appears **2,138 times** in the
raw transcripts and **zero times** in the field the claim was counted from. It
was invoked 17 times in the window. `audit` 11 times. `auto-brain` 3.

Corrected figure, both channels, 558 transcripts and 744 MB:

| | reached |
|---|---|
| by the MODEL choosing (Skill tool) | **1** of 45 (`rule-diagnosis`, once) |
| by a PERSON typing a slash command | **3** of 45 (`brain`, `audit`, `auto-brain`) |
| by neither | **41** of 45 |

The split is the finding, not the total. A handful of skills are reachable by
hand and the model-initiated channel is effectively dead, and those are different
problems needing different fixes. A merged count cannot tell you which you have,
which is why the report now prints them separately and always will.

### Added: analyze-skill-invocations, so this is tracked rather than re-derived

`npm run check:skills` for the selftest; run it directly for the real number. It
reads both channels, separates auto-loaded `rule-*` hits from chosen ones, prints
the population it scanned, and refuses to report a zero TOTAL as a finding: a
zero exits **2** (PROBE BROKEN, the field name probably changed) rather than
**1** (a real reachability finding). Those two look identical in output and are
opposite in meaning.

Mutation tested against the historical bug itself. Dropping the command channel
kills five assertions including "a skill reached ONLY by slash command is counted
as fired". Counting `rule-*` auto-loads as chosen kills its own assertion.
Reporting a zero total as a finding kills the PROBE BROKEN pair.

### Changed: workflow-liveness now covers loops and tasks, not only Actions

A loop can live in three places and 8.118.0 could only see one of them.

- `--repo owner/name` GitHub Actions workflows carrying a cron, as before
- `--log label=path=minutes` anything whose file mtime advances when it runs.
  The portable one, and the only kind that can see a loop living nowhere an API
  does. It reads MTIME rather than parsing timestamps out of the file, because a
  log written by `cmd` carries a locale-formatted date and a parser that failed
  on an unfamiliar one would report NEVER RAN for a healthy job.
- `--task name=minutes` a Windows scheduled task, judged on ATTENDANCE ONLY.
  `[measured]` a task whose script exits 1 still reports `LastTaskResult=0`,
  because `wscript.exe` returns its own status rather than the child's. A monitor
  keyed on that field would show a permanently green job that reports a finding
  every day, so this reads `LastRunTime` and nothing else.

New verdict **MISSING**, and it is fatal. A subject that is named and absent is a
misconfiguration, and the premise of this whole tool is that a thing which
silently is not there looks identical to a thing that is fine. UNKNOWN stays
non-fatal on purpose: it means the subject exists and only its cadence could not
be read, and making that red would leave the check permanently red for any
monthly cron. A permanently red gate gets muted.

Also fixed: PowerShell's error text printed above the report and buried the
verdict, and a diagnostic dumped an entire command line onto the row it belonged
to.

### Verified

`npm test`: **48/48 suites, exit 0**, before and after the bump.

Both new suites are hermetic, driving their scripts as subprocesses against
fixture trees rather than this machine's real state. Live run of the extended
liveness check: 23 subjects across 3 repos, 2 logs and 3 tasks, with the log and
task readings of the same two jobs agreeing exactly at 11m and 94m from
independent sources.

## [8.118.0] - 2026-08-25

### Added: workflow-liveness, because a job that never runs emits nothing

`[measured 2026-08-25]` Every scheduled workflow across three repos stopped on
2026-08-21 and nothing said so for four days. A production error monitor on a
15-minute cron ran zero times out of roughly 380 expected.

The reason nobody noticed is structural rather than careless. `gh run list`
returns runs that HAPPENED. A job that is never scheduled produces no row at
all, so the repo reads as quiet, and quiet is indistinguishable from healthy.

That inverts the usual intuition about noisy failures. The failing runs were the
harmless ones, because a failure still creates a row a person can see. The
damaging failure emitted nothing anywhere. So the question this asks is not "are
runs failing" but "when did this workflow last run, against how often it claims
to run", which is a different query, and nothing was asking it.

Four choices in the implementation, each one a rule already learned here:

- An unreadable cron reports UNKNOWN and never healthy. Letting an unanticipated
  state fall through to fine is how `startup_failure` hid an outage across three
  merges. The summary line counts unjudgeable rows separately and says in as
  many words that they are not passing rows.
- NO RUNS AT ALL is its own verdict. "Never ran" and "ran and is current" are
  opposite facts that would otherwise both produce an empty overdue list.
- Every run prints the population it scanned, so a clean report is
  distinguishable from a probe that found nothing.
- A missing `gh` is COULD NOT CHECK with a non-zero exit, never a pass.

First live run found 5 overdue or never-run across 3 repos and 18 workflows,
with zero false positives. Both suspicious rows were triaged rather than tuned
away: `browser-gates` really does carry a weekly cron 80 lines below its push
trigger, and `Edge Mutation Sweep` really has no runs, confirmed against a
known-positive control on a workflow that does.

### Verified

`npm test`: 47/47 suites, exit 0, before and after the bump. The new suite is
hermetic, driving the script as a subprocess through `--selftest`, the usage
path, and an emptied PATH so `gh` cannot resolve. It is mutation tested: making
an unreadable cron guess 1440 instead of returning null kills the assertion
written for that, and making a missing `gh` print a reassuring line kills the
one written for that.

## [8.117.0] - 2026-08-25

### Added: a phase entry point, and the gate that caught it lying

`phase` is a one-word entry point. Say `spec`, `design`, `build`, `verify`,
`ship` or `audit` and it returns the two or three sentences that change the work
in that phase, plus the skills that already exist for it. It exists because
reaching for a skill requires remembering it exists, and the measurement says
nobody does.

**Its own premise was re-measured before it landed rather than taken on trust.**
Over 555 transcripts in seven days, 15 distinct skills were invoked and exactly
one belonged to this plugin: `rule-diagnosis`, once. The other 36 user-invocable
skills fired zero times. What sessions did reach for was `artifact-design`, 34
times, and the knowledge bases. The draft claimed 40 invocable with 38 at zero,
which was the right shape and the wrong numbers, and a wrong number in a shipped
public skill is the thing to fix before landing rather than after.

**The draft also listed four skills that do not exist**: `fix`, `pr-review`,
`deploy` and `clean`. A skill whose entire subject is that an unreachable skill
is indistinguishable from an absent one, shipping four pointers to nothing. That
is the failure it was written to describe, arriving inside it.

### Added: checkSkillCrossReferences, because nothing here could see that

`validate.js` had no check that could catch it. `checkSkillFrontmatter`
validates a skill against itself, and `checkScriptReferences` resolves
plugin-relative FILE paths only. Neither reads one skill's claim about another.

The new gate reads lines beginning `Existing:` plus their wrapped continuation,
because a line-oriented probe cannot see a list that spans lines, and resolves
every backticked name against the skills on disk. Scope is deliberately narrow,
so it prints the population it scanned (33 names across 1 file) and reports NOT
CHECKED rather than PASS when no file uses the convention. A gate with no
subject that says PASS turns absent coverage into reported coverage.

Mutation tested rather than trusted: reintroducing `fix` produces a FAIL naming
the file and the name, an invented name does the same, and the clean tree passes.

### Changed: brain-brief orders the repo set by recency, and can retire a repo

The repo set now sorts most recently worked on first, by the newest commit on
any ref, printing that age beside each name. Newest commit rather than branch
tip because work in flight usually sits on a side branch, and rather than last
fetch time because that measures the survey instead of the work. A repo whose
date cannot be read sorts LAST, never first: an unreadable date is not a fresh
one, and the top of that list is what a panel offers first.

Config gains a `retired` array. A retired repo is excluded from every section
and NAMED under RETIRED rather than dropped, so a later reader can tell a
decision from a config someone edited by accident. Retired paths resolve to
their repo root before exclusion, so the exclusion still holds for a repo
reached through a worktree or a session cwd.

`shortAge` stopped leaking floats into its minutes branch, which was rendering
`22.254466664791106m`.

### Changed: the brain boot's first question is multi-select and recency-ordered

Projects are not mutually exclusive, so a single-select over them manufactures a
backlog out of a choice that did not need making. And ordering by leverage
instead of recency is the overseer's opinion smuggled into the sort, which is
the coordination half of the role that two independent peer evaluations valued
at zero. The order now comes from the survey rather than from a judgement.

The boot never offers a retired repo.

### Verified

`npm test`: 46/46 suites, exit 0. `validate`: 19 PASS, 0 FAIL. The brain-brief
suite gained five assertions and one negative; breaking the retired exclusion
kills two of them, and breaking the RETIRED print block kills a third, which is
one assertion per behaviour rather than one covering both.

## [8.116.0] - 2026-08-25

### Fixed — most of this plugin's rules could reach nobody, and the gate for it could not fire

Nine skills sat in the unreachable shape: `user-invocable: false` with no
`paths:` glob. No user can type them, and no file read loads them. Among the
nine were `rule-verification`, `rule-gate-integrity` and `rule-diagnosis` — the
three skills that exist to describe this exact failure.

**The documented delivery never existed.** `docs/rules.md` and an earlier
changelog entry both assert these auto-load via globs. Searching the history for
the string finds **no commit that ever added one**. The contract was written
down and never wired, which is worse than a broken mechanism, because nothing
looks wrong.

**The gate was vacuous.** `validate.js` required `user-invocable:false` **and**
`disable-model-invocation:true`. That second field appears **zero times**
anywhere in `plugins/`, so the conjunction could never be satisfied and the check
had never fired once — while reading as coverage of precisely the defect it could
not see. Second instance of that shape here.

Repaired to fail on `user-invocable:false` with no glob, and **mutation-tested
rather than trusted**: control exit 0, glob stripped from one skill exit 1 naming
that file, restored exit 0. The previous version passed all three.

Seven skills got globs chosen for where the work happens. Two did not, and that
is a finding rather than an omission: `rule-diagnosis` and `rule-options-protocol`
govern speech acts — stating a cause, ending a turn — which read no file. A glob
for them would be a lie that passes the gate. They are `user-invocable: true`.

**Model-invocation is not a fallback.** The skill listing is capped near 1% of
the context window and drops descriptions least-invoked-first. Measured by direct
probe of a live agent's own context: **all ~56 core skills arrive as bare names
with no description**. A trigger that depends on text the harness has already
discarded is not a trigger.

### Removed — six skills that deferred to a harness built-in

`fix`, `pr-review`, `monitoring`, `deploy`, `env-vars`, `clean`. Each one's own
body handed off to a built-in that already exists and already fires, or to a
sibling that supersedes it. All six had zero references in the tree and zero
invocations across 75 measured transcripts.

Deliberately a falsification test rather than the full plan: if freeing six
entries does not bring descriptions back, the pressure is dominated by
account-level plugins outside this repo and further cutting here is aimed at the
wrong tree. The fourteen proposed merges are **not** done, on purpose.

### Added — `rule-report-shell`

The house shell for any HTML report an agent publishes, auto-loading on
`**/*.html` so a session picks it up when it is about to write one. Ships a
working template rather than prose describing one.

Four findings are baked in, each measured on a rendered page. Scrollbars do not
inherit a page theme, so a dark page gets the OS light scrollbar — a white rail
down a near-black code well; no repo checked had any scrollbar styling at all.
The published `0fr` → `1fr` grid disclosure **cannot work** inside a column-flex
card: `overflow:hidden` is what the collapse needs and it zeroes the child's
automatic minimum, so the expand resolves to 0px, while `overflow:visible` fixes
the expand at 500.422px and leaves the collapse stuck open. One direction or the
other, never both. The shell uses `max-height` read from `scrollHeight` at click
time. Rhythm is a ratio — space between sections is 3× the space within them.

### Fixed — `heal-sweep.workflow.js` pinned no model on any agent

All three `agent()` calls inherited the session model, so a session on a
premium-priced model ran the whole sweep at roughly 5× intended cost, silently.
Inheritance is invisible in the script **and** in the result: nothing in a
workflow's output records which model ran it, so the error is undetectable after
the fact.

`rule-agent-concurrency` also gained the measured cost of a fan-out: 280 agents
returned 3.5M characters — about 880k tokens — into main threads, median 12,933
and 60% over 10k. Agents that wrote a file and returned a path averaged 5,217
against 13,389 for those that did not. Serial refine chains duplicate where
parallel ones do not (mean similarity 0.072 against 0.008), and agent loss is the
quota wall rather than width.

**Known incomplete:** that skill's `**/*.workflow.js` glob matches zero files in
five consumer repos measured and one here, so it fires only inside this repo and
never where agents are actually spawned. The shape of the defect is closed; the
defect is not. Cross-references are the real fix, tracked in `docs/sweep/`.

## [8.115.0] - 2026-08-25

### Added — `brain-panels`, and the boot now self-heals it

A managed session that stops on a panel blocks until a human looks, and
overnight nobody does. Asking it not to panel is a convention; `brain-panels.js`
is the enforcement. `--off` denies `AskUserQuestion` in the managed repos, `--on`
restores from a marker recording the prior state verbatim.

**Per-project, never machine-wide.** A user-level deny would strip the
coordinator's own panels, and the panel is how the coordinator reaches the user —
turning it off silences the one channel that carries a decision. The
coordinator's repo is excluded by name.

**Restorable by any session, not only the one that set it.** `[measured
2026-08-25]` two sessions died the same night without a clean exit, one
mid-queue. A revert that depends on a clean exit is a revert that does not
happen.

**Deliberately no SessionEnd hook.** That hook fires for every session, so a
MANAGED session ending would revert the block meant to constrain it. `/brain`
checks for a stale marker at boot instead, which is the correct place: a marker
found there means a previous session set it and never restored.

### Changed — the boot asks which PROJECT before which sessions

`[stated 2026-08-25]`. Project is the upstream question; sessions follow from it,
and asking "which sessions should start" while the project is unsettled asks
about the wrong layer. Options must be grounded in something the survey printed
— a list of repo names is not a panel; a list of repos with the fact that makes
each one urgent is.

### Changed — start the session in the autodev clone root

The Brain's own output is autodev commits: 24 in one session across nine
releases. A directory higher, `session-exit.js` reports COULD NOT READ for every
section and each fix needs a `cd` first. The tradeoff is stated in the skill
rather than left implicit: being inside autodev biases attention toward tooling.

## [8.114.0] - 2026-08-25

### Fixed — a generator wrote a home path into a PUBLIC repo

`session-exit.js`, shipped the same day, put an absolute home directory into a
committed `RESUME.md` — twice in the header table and again inside an embedded
`git worktree list`. It was the **only** personal path in 246 tracked files and
it survived the entire suite.

Nothing was looking. `check-no-private-names` protects project NAMES and stores
them as digests, which is right for names and blind to paths by construction: a
home directory is neither a project name nor a secret.

The generator now renders `~/Downloads/code/thing`. Redacted rather than
omitted — a reader still needs to know WHICH directory a snapshot describes;
they do not need to know whose.

### Added — `check-no-home-paths`, and its first run was 0% precision

Matches the SHAPE rather than a username, so it fires for any user on any
machine including a CI runner. Wired into `validate` as a hard gate.

**Its first run reported 24 hits and every one was a placeholder** —
`/Users/...`, `C:/Users/x`, `/Users/CHANGEME`, `C:\\Users\\RUNNER`,
`/home/my-project`. Zero true positives. Documentation about home paths has to
be able to show one, and a rule-windows skill that cannot print the shape cannot
teach the rule it exists for.

So it carries a placeholder exception list, with the reasoning in the source,
because an exception list is usually the wrong answer. What it could hide is a
real person named `x` or `runneradmin`; what it prevents is a 0%-precision check
being silenced within a day, which is the failure that actually loses a leak. A
short real username still fires — `abc` is not on the list.

Verified both directions: clean across 236 tracked files, and a planted
lookalike under a realistic username is caught. The selftest pins four shapes it must catch and
three near-misses it must not, because a check that flags the word "home" in
prose is one somebody silences.

## [8.113.0] - 2026-08-25

### Fixed — `/auto-brain` told coordinators to read a field that cannot answer

`isRunning` is not a boolean. It has at least four meanings and
`list_sessions` cannot tell them apart: working, wedged, **blocked on a panel**,
and errored out.

`[measured 2026-08-25]` A dead-man's check built on `list_sessions` reported a
panel-blocked session as dead across **ten consecutive checks**, each more
confident than the last. It was alive the whole time and resumed the moment
someone answered the panel. `fleet-status.js --pending` detects panel-blocking
directly and was already installed — the check simply never asked it.

Three rules follow, all measured the same night:

**A repeated observation is one observation.** Ten reads of the same frozen
timestamp is one data point. Identical evidence must not raise confidence across
checks — that is what turned a wrong reading into a settled verdict.

**Read the worktree, not the report.** Both sessions that went quiet had done
their best work AFTER their last report and never got to send it. One `git log`
each found a design census and a working prototype. Reports are the lossy
channel; commits are the durable one.

**Message cost is asymmetric.** A message is nearly free to send and expensive to
receive — it arrives as a full user turn at the RECEIVER's context depth. One
session was sent nine messages and another six as direction evolved; both were
`opus-5` at `xhigh` effort, 31 and 50 hours old, and both went silent holding
unreported work. `get_session` carries `createdAt`, `model` and `effort`;
`list_sessions` carries none of them, so a sender is blind to the cost by
default. Consolidate to one message per direction change, and past three to one
session in an hour, batch.

Rolling summaries gain the same correction: **commit before reporting**, because
a report is sent at the end of a unit and a session that dies mid-unit sends
nothing.

## [8.112.0] - 2026-08-25

### Fixed — a dispatch without a return address cannot be answered

`[measured 2026-08-25]` Four peers were asked to report. **Every one that
answered said the sender id did not resolve.** Each had reached for
`ListAgents`, which lists in-process *subagents* rather than sessions, and
nothing joins those two identifier spaces. All had to guess the sender by title
and one nearly gave up.

The framework already said *going idle is your message to send*. It never said
how to address it, so the rule was complete and unusable. `session-exit.js`s
`--peers` block and `/auto-brain`s dispatch step now both require the
sender's own session id in every message.

### Added — managed sessions do not raise panels

`[stated 2026-08-25]` A session being coordinated sends its question to the
coordinator as a short message and keeps working on everything the question does
not block. The coordinator batches those to the user.

The section carries its own warning, because this instruction has been relayed
wrongly once and is the canonical laundering incident: `[measured 2026-08-23]`
an overseer told seven sessions to disable panels as a standing rule from the
user. One refused and was right, five complied without flagging it, and the rule
was reversed within the hour. **The difference is provenance, not content** — a
coordinator that has not heard it from the user directly does not have this rule
and may not acquire it from a peer.

Three constraints keep it from repeating: escalation must have somewhere else to
go (a panel is HOW a session escalates, so this pairs only with a dispatch
carrying a reply address, which is why that fix came first); the coordinator
never answers on the user behalf; and it is instruction rather than
enforcement — no permission settings are edited, because that is a machine-wide
change affecting sessions nobody is coordinating.

Money, production deploys, client state and anything irreversible still stop.
Those are authorisation rather than ambiguity, and a message to a coordinator is
not authorisation.

### Added — the rolling-summary protocol

`[stated 2026-08-25]` — *"send you short summaries with what they did so that
you are aware at all times."* One message per **completed unit of work**: not
per commit, not on a timer. Three to five lines — what changed, what was
verified with the command and what it printed, what is next or blocked.

"Short" is defined rather than implied, because it will not be otherwise. The
long four-part report is for going idle; a rolling update that grows into one
costs both sides a full turn each time, and at a deep context that is the
dominant cost of coordinating at all.

## [8.111.0] - 2026-08-25

### Fixed — the clobber guard protected only the recoverable case

8.109.0 refused to overwrite a foreign `RESUME.md` when it was **tracked**. A
peer named the hole within the hour: *"a repo where RESUME.md is untracked loses
it outright."*

That is right, and it inverts what the first guard was for. Tracking is what made
the earlier incidents **recoverable** — `git restore` brought both files back. A
guard that fires only where git would have saved you anyway is protecting the
case that needed it least, while the unrecoverable case walks through.

Now keyed on **size as well as tracking**, still with authorship first: a foreign
file at or above 20 KB and more than 4x what is about to be written is refused
whether or not git knows about it. `[measured 2026-08-25]` the third incident
destroyed a **458 KB / 6,132-line** hand-maintained cold-start document, named in
its own `CLAUDE.md` as the entry point, against a 5 KB snapshot. Two orders of
magnitude is a hard stop, not a warning.

Three sessions hit this in one evening. Two were bitten and recovered; the third
read the source before running it and reported the hazard instead. All three
independently made the same point: **the default output path is the danger, not
the write.** `RESUME.md` is precisely the filename a project most often already
owns and hand-wrote, and the same holds for `NOTES.md`, `TODO.md`, `CHANGELOG.md`.

Worth recording alongside it, because it is why the failure was silent: the
script printed `wrote RESUME.md (5207 bytes)`, which **reads as success**. A
session that ran it and then committed would have buried a 6,114-line deletion
inside an unrelated commit with nothing to trace it back to.

### Changed — the fleet survey says what it cannot see

`[measured 2026-08-25]` A session whose cwd is a repo the survey lists does all
of its work in a project **on a different drive**. Briefing it from the survey
described the wrong repo entirely — right facts, wrong subject.

The scan is one directory deep under one root, so a repo absent from it is not a
repo nobody is working in. It now says so at the top, and points at `--root`.
This is the same class as the note already in `/auto-brain` step 2 — cwd is
where a session started, not where its work is — arriving from a second
direction: the join is not the only thing that can be wrong, the **population**
can be too.

## [8.110.0] - 2026-08-25

### Added — `/auto-brain`, for running the fleet across an unattended window

Built rather than improvised, on the instruction *"don't start it blindly, we
need to build a workflow that works."*

The constraint it is designed around: two peer sessions evaluated an overseer
independently and both scored the **coordinating** half at zero. Every wrong
steer was a claim about a session's own tree, branch, queue or intent; every
useful one was a fact about code, git or platform metadata. So this coordinates
by **distributing measured facts and asking**, never by asserting state. A brief
containing a sentence about what a session has done is wrong by construction.

`auto-brain-survey.js` reads every git repo under the code root: branch, trunk,
ahead/behind, dirty count, worktrees, gate script names, open PRs, and the
presence and age of `RESUME.md` / `PUBLISH-QUEUE.md` / `prd.json` / `TASKS.md`.
It prints `COULD NOT CHECK` rather than a zero wherever a probe cannot answer,
because "no open PRs" and "gh cannot answer for a bitbucket remote" are opposite
facts that become the same brief once flattened.

Three flags, each changing how a repo may be worked: a **client remote** (never
push to a personal remote), a **trunk that is not main/master** (one repo here
has a `main` two months behind its real trunk, and comparing against the wrong
one inverts verdicts rather than merely dating them), and a **large
`RESUME.md`** — one is 458KB and hand-written.

The skill requires one approval before dispatch, and carries a correction found
while using it: **cwd is where a session started, not where its work is.** A
session listed under one repo's worktree reported twelve commits in another, so
filing by cwd would have briefed it on the wrong project and left the other —
which had an open mergeable PR — looking ownerless.

Every brief must carry: commits stay local, no push or deploy or production
mutation, run the repo's own named gate, escalate rather than resolve, write
`RESUME.md` at the end, and say plainly if the brief is wrong for that repo.

### Fixed — a `0x01` in a commit subject moved the wrong class to the top

`mine-fixes` frames records with `--format=%x00%H%x01%ct%x01%s` and destructured
three fields. Git preserves a literal `0x01` inside a commit subject — measured,
not assumed — so such a subject split into four or more parts, the destructure
kept three, and everything past the embedded byte was discarded.

The record was **not dropped**, which is what made it quiet: it still counted as
a fix and as rework, inflating the totals the ranking is read against, while its
truncated subject matched no class and vanished from the ranking itself.

This script decides which failure class a project builds a gate for, so that is
not cosmetic. Measured: repairing the split moves `cache / key scoping` from 2
to 4, **overtaking** `ordering / async race` at 3. The top class was wrong, and
a team acting on it would have gated the second-most-common failure while the
first went unguarded.

The suite had pinned the misparse deliberately. Those assertions are updated
rather than deleted, the one reading "a subject split by the format separator
LOSES its class evidence" is inverted, and a new one pins the reordering by
**meaning** — the top class must be the one containing that subject, byte-for-
byte — so a regression fails on what matters rather than on a ranking string.

One vacuous assertion found while doing it: the bar-width checks had no trailing
anchor, and a short bar is a prefix of every longer bar, so they passed both
with and without the fix.

## [8.109.0] - 2026-08-25

### Fixed — `session-exit.js` overwrote a hand-written RESUME.md

Shipped in 8.108.0, reported by a peer within the hour, measured rather than
theorised: a bare run replaced a **tracked, hand-written 2,427-line project
handoff** with a 3kB snapshot. Recovered with `git checkout`, nothing survived —
but only because that session noticed.

`RESUME.md` as a project doc is a convention in more than one repo here, and at
least one `CLAUDE.md` points new sessions at it as the first thing to read. So
the collision is likely, not exotic. Eight sessions had been told to run the
script.

**The guard is keyed on AUTHORSHIP, not on tracking**, and that distinction is
the fix rather than a detail. Refusing on "tracked" alone would stop the tool
updating its own committed output, and a tool that cannot run twice is one
nobody runs once. It now refuses only when the target exists, is tracked by git,
and does **not** carry this script's own marker — exit 3, file untouched, with
`--out` and `--force` both named in the refusal. Mutation-tested three ways:
removing the guard fails 4 assertions, keying it on tracking alone fails the
rerun-over-our-own-output assertion, and both directions are pinned.

### Fixed — the closing advice prescribed files it never checked for

Reported by a session working a GTM/analytics engagement with no `package.json`
and no `CHANGELOG.md`: the generated advice told the reader to run a gate and
read a changelog, so a next session "burns its first minutes looking for files
that do not exist".

This script exists to stop unverified things rendering as fact, and its last
section asserted two. The steps are now **derived** from what is present:
the gate script is read out of `package.json` and named, or the file's absence
is stated outright so nobody goes hunting; only docs that exist are listed; and
the section closes by saying the steps were derived from that directory.

`validate` is deliberately last in the gate-name preference. It is often a real
script *and* a subset of the fuller run — here `npm test` runs every suite and
then validate, so naming validate would send a reader to a narrower gate that
still passes.

## [8.108.0] - 2026-08-25

### Added — an exit procedure, because there was none

Turn-level state saves itself (the Stop hook writes a fleet heartbeat) and an
*archived* session gets a stub from `session-sweep --write-resume`. A **live**
session ending had nothing: what was unpushed, what was open, what was decided,
all of it in a transcript nobody reads.

`session-exit.js` writes `RESUME.md` from state it **reads** — branch, unpushed
commits against the tracked upstream, uncommitted files, open PRs, worktrees.
Never from recollection, and that is the point rather than a detail. `[measured
2026-08-24]` a session reported "four unpushed commits" from memory; the
measured answer was one.

**Null is not empty, and that is the whole design.** "No unpushed commits" and
"git was never asked" are opposite facts that flatten to the same blank section,
and the blank is the one a reader trusts. Every section renders three ways:
populated, `None. A real zero: the command ran and returned nothing`, or
`COULD NOT READ` naming why. No upstream tracked, `gh` unauthenticated, and
not-a-git-repo each say so rather than rendering as clean.

**It writes one file: its own.** `--peers` prints the request to send rather
than pretending to write theirs. A session cannot read a peer's working tree,
uncommitted changes or decisions — asserting them is how every wrong steer gets
made — so it asks, and warns against joining peers on id, since pipe names and
session-list ids are separate identifier spaces and one session can look like
two.

26 assertions against throwaway git repos including a bare origin. Mutation:
collapsing null onto the empty branch, the exact edit a careless refactor makes,
fails 3 of 26 and they are the three pinning the distinction.

`/brain`'s "Before you finish" now runs it instead of describing what a handoff
should contain.

### Fixed — `watch-panels` reported a broken fleet-status once, then went silent

`if (consecutiveErrors === 3)` fires exactly once, ever. The intent above it is
right — "only shout once it is persistent" — but a fleet-status broken for hours
announced itself at minute three and then said nothing, so the watcher looked
healthy and quiet while it was scanning nothing. That is the muted-detector
failure the branch exists to prevent, reintroduced by the branch itself. It now
re-announces at 3 then every 30, carrying the count so a repeat is
distinguishable from a fresh failure.

It also carried the **class 28** defect fixed in `fleet-overlap` earlier:
`SCRIPTS` was built from `process.env.USERPROFILE` with no fallback, pointing at
one specific clone. Found by running that class's own detection across the repo
— the step the registry instructs and I had skipped. The sweep validated the
entry's triage too: 16 hits, 14 legitimate home targets, 1 prose false positive,
1 real defect.

### Added — suites for the last six never-loaded scripts

`watch-panels` 53, `fleet-board` 62, `mine-fixes` 45, `telemetry-report` 66,
`claudemd-audit` 48, `steer-log` 85. The `claudemd-audit` one is the notable
one: eight precision rules, each learned from a false positive, each now pinned
by the fixture it exists to suppress *beside* a control in the same repo that
must still fire.

**Coverage: 13 never-loaded plugin files → 3.** `check:functions` also gained a
caveat on that list — V8 writes its dump on normal exit, never on SIGTERM, so a
long-running subject a suite `kill()`s produces no coverage and lands there
despite being exercised. `watch-panels` and `fleet-board` carry 115 assertions
between them and appear in it.

**A defect found and deliberately left alone**, pinned as-is: git preserves a
literal `0x01` in a commit subject, and `mine-fixes` splits on `0x01` into three
fields — such a commit counts as a fix and as rework but reaches no class.
Mutation-proved: repairing it reorders the ranking, which is the wrong-class-on-
top hazard the script exists to avoid.

## [8.107.0] - 2026-08-24

### Fixed — a guard against a commit-push loop that counted the clock

`fleet-publish`'s `meaningful()` is the only thing standing between a timed
`--push` and a commit on every run. It compared the whole record with
`publishedAt` removed — and `oldestBlockedMin` is in that record. That value
ticks up every minute a panel stays open, so **while anything was blocked, every
run committed and pushed** to a real remote.

Measured: two records differing only 199 vs 200 read as "counts changed —
pushed", while a `publishedAt`-only control correctly read as unchanged.

Fixed as an **allowlist** of the fields that constitute state, not by excluding
one more field. The direction is the fix: a denylist fails open, so the next
time-varying field anyone adds silently re-arms the loop against GitHub. An
allowlist fails closed — a new state field is merely late.

The existing suite already asserted that a `publishedAt`-only difference does
not push, and was green throughout. That assertion tested the one field already
excluded. **A test of the case that works says nothing about the case that does
not.**

### Fixed — `fleet-overlap` invoked a different clone's `fleet-status`

`FLEET` was a hardcoded absolute path through `USERPROFILE` to one checkout, for
a file that is a **sibling in the same plugin**. So the installed plugin ran
`~/claude-auto-dev`'s parser rather than the one shipped beside it — a released
version did not run its own code — any clone silently read a different
checkout's parser, and a machine without `USERPROFILE` threw on load.

Second half, and the one that could mislead rather than merely misbehave: a
failed child crashed with a stack trace and printed **nothing on stdout**. A
session reading stdout saw an empty result, which reads as "no overlaps". It now
prints `COULD NOT CHECK`, names the subject and reason, says "This is NOT no
overlapping pairs. Nothing was scanned.", and exits 2.

Two suites went red, and the reason is worth keeping: **both forced their
failure scenarios through the bug.** A test that needs a defect to reach its
unhappy path passes for the wrong reason and blocks the fix. Neither was
weakened — both now copy the subject beside the siblings they control, so no
testability seam was added to `plugins/`.

### Added — `check:drift`, which detects the shape of the 8.106.0 bug

Two functions in one file assigning to the same record, field sets overlapping,
one a strict subset of the other. Validated both directions: against the pre-fix
blob it names the real defect exactly; against the repo it reports 42 files, 193
functions, 0 pairs. Its first run found a false positive
(`Object.assign(defaults(), o)`), fixed by widening the parser rather than by an
exception list — a blanket skip would have blinded it to the only bug it has
ever caught.

Deliberately **not** wired into `validate`: a subset can be intentional, so a
hit is a question, and a question-raiser wired as a hard gate teaches people to
silence it.

### Added — suites for three more never-loaded scripts

`fleet-overlap` (70), `fleet-publish` (128), `quota-tripwire` (178). Coverage
moved from 29 of 42 plugin files executed to 35, and never-loaded from 13 to 7.
The never-called function count rose from 1 to 3 because newly-loaded files
brought their own uncovered functions — previously invisible, now counted.

## [8.106.0] - 2026-08-24

### Fixed — `fleet-status --stalled` could not report a stalled session at all

`scanFleet()` was extracted from `main()` so the board server could call it
in-process. Heartbeats were then added to the **extraction only**. `main()` kept
scanning transcripts and never learned about them, so on the CLI path
`endedCleanly` stayed `undefined` while both stalled branches in `classify()`
test `=== false` and `=== null`. Neither matches `undefined`.

That is not a check that failed. It is a check structurally unable to fire, and
from the outside it is indistinguishable from a healthy fleet — the failure mode
that costs most, because it looks like good news.

The divergence was measured rather than guessed: `scanFleet` set `endedCleanly`
and `stoppedAt`, `main()` set neither, and `main()` set nothing `scanFleet` did
not. A strict subset, which is what silent drift after an extraction looks like.
Both now share one `loadHeartbeats()`, so there is no second copy to diverge.

**Why the suite did not catch it, which is the part worth keeping.** All 121
assertions passed both before and after the fix. Every stalled assertion calls
`classify()` directly with a synthetic object, and the heartbeat fixtures were
only ever reached through the helper that goes via `scanFleet`. **A classifier
test cannot see a feeder that never calls it.** Coverage of a function is not
coverage of its wiring.

The first replacement assertion was itself vacuous — it checked that
`endedCleanly` was *present* in `--json`, and with an empty map the assignment
still yields `null`, so restoring the bug left it green. Mutation caught that,
reading it did not. The surviving assertion checks the **value** against
fixtures whose heartbeats disagree, and restoring the bug now fails exactly 3 of
125 with the diagnostic.

### Added — suites for the three unloaded scripts an overseer session depends on

`check:functions` reported 13 plugin scripts no suite loads. These three were
ranked by what breaking them would cost: `fleet-status.js` is the single
transcript parser under six consumers, `brain-brief.js` opens every overseer
session, and `fleet-notify.js` fires real toasts where broken dedup either mutes
the user or hides a blocked session.

278 assertions, all behavioural, all driven as subprocesses against fixtures in
a temp dir — none reads this machine's live git state, transcripts or session
list, so none can pass for the wrong reason on a quiet day. Mutation-tested on
scratch copies: 7 killed on fleet-status, 10 with zero survivors on
fleet-notify.

Nine scripts remain uncovered and are named rather than quietly dropped:
fleet-publish, fleet-overlap, quota-tripwire, watch-panels, mine-fixes,
claudemd-audit, steer-log, telemetry-report, fleet-board.

## [8.105.0] - 2026-08-24

### Fixed — three instruments claimed a layer they had not measured

One class, found three times in this repo's own tooling. A measurement is real,
its label names a different thing, and the reader acts on the label.

**`brain-brief` called an ancestry count "ONLY HERE".**
`rev-list --not --remotes=origin` answers "does any origin ref hold this SHA".
The output called that "commits ONLY HERE", which reads as "this work exists
nowhere else". `[measured 2026-08-24]` a worktree reported 2518; against the
repo's live trunk, 2378 of its non-merge commits were patch-id identical to
commits already up there from a history rewrite, and ten were genuinely
stranded. The number was correct and 250x the answer being sought. The metric is
unchanged — the comment above it had already rejected switching to a base
branch, and that reasoning still holds. The row now says "unreachable from any
origin ref (CONTENT NOT CHECKED)" and the legend names the discriminating
command, with a warning to resolve `origin/HEAD` rather than assume
`origin/main`: one repo here has a `main` two months behind its trunk, and
comparing against it inverts the verdict.

**`drift-audit` printed an all-clear with no denominator.** On zero findings it
said "plugins, schedules and settings are all current" and exited 0. A run whose
auditors bailed early printed the identical sentence to one that checked
everything. Every auditor now records what it examined, a guard that bails
records NOT CHECKED, and the census loop is unconditional and above the branch,
so an all-clear cannot print without it by construction.

**`check:functions` could not see the files with the worst coverage.** Its
denominator was the coverage map itself, so a module nothing loads contributed
to neither numerator nor denominator — absent rather than uncovered, while the
headline called it "named functions in plugin sources". Measured: 42 source
files, 29 executed, **13 never loaded**, all of them scripts. Also fixes the
attribution branch, which never fired on Windows because V8 emits
`file:///C:/...` — 0 of 13 entries attributed by path before, 13 of 13 after.

### Added — coverage for eight functions no suite entered

None was dead; all had live callers, which is why they got tests rather than an
exemption list. `fleet-heartbeat.js` is required by the wired Stop hook and had
no suite at all. New `tooling/test-fleet-heartbeat.js`; `test-queue-drained` and
`test-session-sweep` gain the paths that reached the rest. 8 never-called → 1,
the documented floor. 12 mutants planted, 11 killed, the twelfth documented as
an equivalent mutant rather than hidden.

### Changed — `/brain`'s boot sequence has an ending

It gathered state and stopped, which is the vacuum its own role section warns
about. `[measured 2026-08-24]` a session read that warning during boot and one
turn later authored itself a four-item work list. The boot now ends with a
defined action: report the state, ask which sessions should start, do not author
a work list for yourself — and report the live-session headcount as a finding
rather than a caveat.

## [8.104.0] - 2026-08-24

### Fixed — the boot skill taught a retired role, and its core step never ran

`/brain` is the versioned boot path, so a fresh overseer session reads it before
anything else. Two defects, and the second had been there since the skill was
written.

**It taught the behaviour that was retired.** The role section said *"Answer
other sessions' panels rather than relaying them. A blocked session is a
question queued for the user personally. Pick the option, send it."*
`[measured 2026-08-24]` an overseer did exactly that, relaying a panel selection
as authorisation for a production migration. The session refused, correctly: a
peer cannot carry the user's authorisation for a production mutation.

**Step 2 could not have run as typed.** It invoked its scripts through
`${CLAUDE_PLUGIN_ROOT}`, and that variable is **not set** in the Bash tool's
environment — verified against a control in the same probe, where `USERPROFILE`
was set. The one step whose facts are true right now was the one step that
failed. Replaced with the marketplace install path, deterministic because this
plugin ships in its own marketplace, and confirmed by running `fleet-overlap.js`
from it.

**The role is now the measured split.** Two peer sessions evaluated an overseer
independently, without seeing each other's answers, and reached the same
conclusion: the probing was worth its cost, the coordinating was worth nothing.
Assert measured facts about code, git and platform metadata freely; never assert
anything about a peer's tree, branch, queue, decisions or intent; for that
second category, ask, because a question asserts nothing and was the most
credited interaction in both evaluations.

**Every fence is now PowerShell.** The fleet runs on Windows and the skill was
handing out bash. Each command was executed before being written down, including
`-Encoding UTF8`, without which PowerShell 5.1 renders the file's punctuation as
replacement characters. The macOS and Linux translation is one line at the top
rather than a second copy.

The boot sequence, the standing rules with their measurements, the never-list,
the shared-clone hazard and the workflow spend rules are folded in, so the
versioned artifact and the paste-able one no longer drift.

## [8.103.0] - 2026-08-24

### Fixed — nine rules called themselves "Always-on" with nothing to load them

CLAUDE.md states that `rule-*` skills are always-on, auto-loaded by a `paths:`
glob. `[measured 2026-08-24]` **12 skills claimed Always-on in `when_to_use`, 3
declared a paths trigger, and 9 declared no trigger of any kind.** All nine are
also `user-invocable: false`, so nothing reaches them except the model electing
to call `Skill` by description. Across 212 transcripts, `rule-*` skills were
explicitly invoked **3 times in total**.

Among the nine: `rule-gate-integrity`, `rule-diagnosis` and `rule-verification`
— the three that describe this exact failure. A mechanism structurally incapable
of firing, wearing a label that reads as coverage.

`when_to_use` on the nine now names the moment to load rather than asserting a
guarantee no mechanism provides. No paths globs were invented to make the claim
true: "the moment you are about to say why something is happening" has no file
glob, and a fake one is worse than an honest description.

`validate` now fails any skill claiming Always-on without a `paths:` trigger.
Its first run reported exactly the nine predicted, which is the point of running
a gate before believing it rather than after.

One distinction worth not collapsing: on the machine this was measured on, the
`@`-imported `~/.claude/rules/*.md` DID load, and four documented traps recurred
anyway. The portable plugin copies mostly never load at all. Loading is
necessary and demonstrably not sufficient.

### Added — SessionStart says when someone else is already in this repo

Sessions cannot see each other, so two agents routinely edit the same lines in
different worktrees and neither learns until a cleanup PR deletes one of them.
One line now reports other worktrees by branch and origin branches not merged
into main.

Local refs only, deliberately: `ls-remote` and `gh` are the authoritative
registries and both are network calls, and this runs on every session start. So
the output says "as of the last fetch" and names the authoritative commands
rather than implying a freshness it does not have.

The negative case is the point. A line that appeared unconditionally would train
every session to skip it, and then it is worse than absent. A solitary clone
gets nothing, and that silence is asserted. Mutation-tested: never-emit turns 5
assertions red, always-emit turns the silence assertion red.

### Fixed — telemetry wrote its report wherever the shell happened to be

The report path was built from `process.cwd()`, which follows the session's
shell. Every directory a session cd'd into was quietly collecting a
`.claude/reports/`.

Found only because one broke the gate: a session cd'd into
`plugins/autodev-core/skills/` to read frontmatter, the next tool call planted a
telemetry file there, and `validate` enumerated it as a skill directory with no
SKILL.md. Nothing else would ever have reported it.

The payload's cwd is the session's own directory and does not follow the shell,
so it is preferred; walking up to the nearest `.git` collapses a deep start onto
one location per repo. The walk is bounded at 40 rungs — a symlink cycle must
not spin a hook that runs on every tool call.

`pluginDirs()` and `skillDirs()` now also skip dot-directories, so a stray one
cannot break the gate again.

Mutation-tested by restoring the original bug: 4 assertions fail, and the 2
fallback assertions correctly survive, because the fix does not change behaviour
when there is no repo above the start directory.

`event.cwd` deliberately still records `process.cwd()`. That answers "where did
this tool call run", a different question from "which project owns this report",
and conflating them would silently change the meaning of 878 existing rows.

### Added — RESUME.md, split so the public half can be public

`check-no-private-names.js` caught the first draft naming two private projects on
four lines. The machine-specific half moved to `~/.claude/memory/`. Refreshed
again once the state it described had moved, because a handoff that reports
superseded state is the failure it exists to prevent.

## [8.102.0] - 2026-08-23

### Fixed — the queue advisory reprinted itself until it stopped being read

[measured 2026-08-23] `check-queue-drained` fired six times in one session with
a byte-identical four-item standing list, because the queue genuinely had not
changed. A detector that reprints itself unchanged is one the reader learns to
skim, which is how a real finding gets missed later — the muted-scanner failure
`rules/security.md` already records, arriving from the other direction.

An unchanged advisory now collapses to one line carrying its repeat count.
The count is the signal: "unchanged (4 item(s), 6 consecutive commits)" says
more than a sixth identical reprint.

What it deliberately does NOT do is detect delivery. Matching prose against
labels is guesswork, and guessing wrong hides live work, so the check still
cannot tell delivered from undelivered and still says so. CARRIED FORWARD is
never demoted — that finding is exact, and demoting it would be hiding.

Fails open by construction: no state file, unreadable state, and every caller
that passes none all get the full report. The worst case is the noise this
exists to reduce, never silence.

Selftest 6 → 12 assertions. The original six passed whether or not the feature
worked at all. Mutation-tested: replacing `if (repeats > 0)` with `if (false)`
turns two of the new assertions red, and reverting restores PASS.

### Fixed — three `.claude` paths named private and client projects in a PUBLIC repo

`check-no-private-names` was failing on the working tree: a generated report
(8 hits, one a CLIENT name), `.claude/RESUME.md` (8), and `.claude/launch.json`
(4). None were tracked and nothing was published, but `.claude/` is only
partially ignored here by design, and several sessions commit to this clone at
once — so each was one `git add -A` from the published tree.

Added individually in the established style rather than reverting to ignoring
`.claude/` wholesale, per d4123dc's own instruction to read what a rule
compensates for before widening it.

### Merged — two clones had diverged after d4123dc

Parallel unpushed lines existed in two clones, neither aware of the other:
the queue and gitignore fixes here, the heal worktree-trap docs and the brain
boot command there. Reconciled before bumping, because a version number is a
plugin-cache key and releasing from either line alone would publish a build
missing the other's work under a number claiming to contain it.
## [8.101.0] - 2026-08-22

### Fixed — a restart made `stalled` fire on sessions that had simply ended

Found by running the post-restart checks rather than by a report, which is the
point of writing them down.

A session killed by a restart has a transcript write postdating its last Stop
hook, so `endedCleanly` is false — and on disk that is indistinguishable from a
turn that hung. Both live `stalled` verdicts were exactly this, both
`isRunning: false`. A restart mass-produces the pattern, so the board would have
gone red across the fleet at the moment noise is least wanted.

`stalled` now requires liveness. `isRunning` is runtime-only, but the desktop
record's `lastActivityAt` ticks while a session is alive. `[measured]` over 490
records with 9 running: **running max 324s, not-running min 865s** — cleanly
separable, so a 600s cut carries ~2x margin either side. The file's own mtime
does NOT separate them (running max 323s against not-running min 103s); it has to
be the field.

The first probe reported a false overlap, because `list_sessions` **excludes the
current session** — so this session counted as not-running while being the
freshest record on disk. Corrected, the gate reproduces `list_sessions` exactly:
9 `likelyRunning` against its 8 reported plus self.

### Fixed — 5 of 13 files in the heartbeat store were not heartbeats

Other sessions here drive the Stop hook with FIXTURE payloads while testing it,
so the store had accumulated `s.json`, `sess.json`, `clean.json`,
`carried.json` and `nope.json`. That inflated the coverage figure the board
reasons about from 8 to 13, and crashed the CLI listing.

`write()` now requires a UUID. That makes any fixture payload harmless rather
than requiring every harness in the repo to know this file exists.

`readAll()` was also picking up the notifier's own dotfiles, and `prune()` would
have **deleted them as stale heartbeats after 7 days** — silently wiping the
notifier's dedup memory, which is what stops it repeating itself.

## [8.100.0] - 2026-08-21

### Released so the runtime can reach the fleet work — a same-version sha drift

No new code of its own. Four commits landed on main after the `chore(release):
8.99.0` commit and were unreachable by every installed session, because the
plugin cache is keyed on the version and the pin named the release commit.

`claude plugin update autodev-core@autodev` reported **"already at the latest
version (8.99.0)"** and changed nothing. It compares version STRINGS, so a
same-version sha bump is invisible to it. Measured by bytes rather than argued:
the cached `fleet-status.js` was 15888 bytes, byte-identical to the pinned sha,
where the newer tree is 17316 — and `install-fleet-notify-task.ps1` plus
`fleet-notify-hidden.vbs` were absent from the cache entirely.

That first file is the scheduled-task installer for the fleet notifier, which is
the fix for the notifier having no host. It had been committed, pushed, and
unreachable.

Riding in this release, all authored by another session on this shared clone:

- `a59bb31` schedule the notifier, and retune classify against real data
- `0081168` wait 15m before notifying, and hide cold rows by default
- `605ff9a` cross-machine status, as counts only
- `596815b` docs: two hazards this clone produced today, both concurrency

### Fixed — two plugin pins that were ten releases stale

`autodev-memory` and `autodev-stack` were pinned at **8.89.0** while their 8.99.0
trees already sat in the cache, so every session since had loaded stale copies of
both. `claude plugin update` moved them correctly — the stale-pin case does work,
it is only the same-version case above that does not.

### Known — `check:runtime` cannot see either failure

It reads the cache DIRECTORY (is the highest version present?) and content
markers, never `installed_plugins.json`. It passed throughout both problems
above. To verify what will actually load, read the pin and byte-compare the
cached file against the sha it names.

## [8.99.0] - 2026-08-21

### Added — `--archive-orphaned`, for the sessions the app can no longer reach

`archive_session` sees about **70 of 482** records, and `limit` does not change
it. The cause turned out to be structural rather than a cap: sessions live under
`<store>/<workspace>/`, the app tracks one workspace, and everything in the
others answers "not found". Measured, the directory predicts reachability
exactly — 5/5 reachable in the live dir, 5/5 unreachable across two orphaned
ones. **Age predicts nothing**: four-day-old records were unreachable while much
older ones were not.

So the weekly task could never clear those rows at all, and they silt up
untouched — 231 of them on this machine.

`--archive-orphaned` marks SAFE records archived by editing the store, for
orphaned workspaces only. Off by default, never implied, and it still touches no
git worktree.

It is safe exactly where it is permitted: the app never loaded those records, so
it holds nothing to overwrite them with. Live-workspace rows are skipped and
still go through `archive_session`. When two workspaces are both recently active
it treats **neither** as orphaned — an unmodelled shape is a reason to touch
nothing, not a reason to guess.

A string replace rather than parse-then-stringify, deliberately: reserializing
rewrites field order and escaping across a file the app owns, which would make
any breakage indistinguishable from the change under test.

The suite gains two rows identical but for their workspace, so "wrote the right
one" cannot be confused with "wrote anything". Measured on the real store: 215
written, **0 parse failures, 0 reverts**, and the app kept listing its own
sessions normally throughout.

## [8.98.0] - 2026-08-21

### Added — the fleet taps you, instead of waiting to be opened

A pending panel is perishable. Three scans minutes apart found 2 blocked, then 0,
then 1, and two panels caught at 19:24 were answered inside fifteen minutes. A
board you have to remember to open misses exactly the window it exists for.

`scripts/fleet-notify.js` fires a Windows toast when a session becomes blocked.
**Once per panel, never once per scan** — the state key is `sessionId + askedAt`,
so re-scanning an open panel is silent, a new panel in the same session notifies
again, and an unblock prunes the state so a later re-block notifies. A notifier
that repeats gets muted, and a muted notifier is worse than none because it also
stops you checking by hand.

That dedup is tested, and the test earned its keep: `pass()` returned early when
nothing was fresh, **before** writing state, so the prune lived only in memory —
a session that unblocked stayed marked seen forever. Ten assertions now cover it,
including that a FAILED notify must not record state or the retry is lost.

`scripts/toast.ps1` uses the WinRT notifier rather than BurntToast, which is not
installed here and would make this fail closed on a fresh machine.

### Changed — fleet-status reads the heartbeat, three-valued

`true` = the Stop hook fired at or after the last write, so the turn finished.
`false` = the transcript grew after the last recorded turn end. `null` = no
heartbeat; say nothing.

**`null` falls back to the timing heuristic rather than to the confident
reading.** Every session is `null` until the hook has run in it, so a
fall-through would have invented "stalled" across the entire fleet on the first
run. All three branches are unit-tested.

### Fixed — planted test data could reach the surface under test

A test wrote a heartbeat for a REAL session id into the live directory, and the
board duly reported that session as stalled off fabricated data. `AUTODEV_FLEET_DIR`
now lets tests write elsewhere.

The contamination was findable because real hook payloads carry Windows
backslashes while the test payloads used forward slashes — worth remembering as a
provenance marker when auditing this directory by hand.

### Added — the `/fleet` skill

Leads with `--pending` rather than the board, because most of the time the answer
is wanted and not a browser. It tells the reader to report the population line: a
bare "nothing is blocked" is indistinguishable from a probe that read nothing.

It also carries the standing instruction not to offer to answer a blocked
session's question — see 8.96.0 for why that cannot work.

## [8.97.0] - 2026-08-21

### Fixed — version-number collision left the previous fix uninstalled

8.96.0 was published twice from two sessions working the same clone. The cache
is keyed by version, so the copy that won held the ephemeral rule but **not**
the merged-hours floor that 8.96.0's own changelog describes — and
`plugin update` reported "already at the latest version (8.96.0)" because the
numbers matched. A fix on main, a stale build installed, and a green update
message saying nothing was wrong.

No code change here beyond the version. It exists so the cache key moves and
the floor actually reaches the runtime.

Worth remembering when several sessions share one clone: a version number is a
cache key, and two different trees must never share one.

## [8.96.0] - 2026-08-21

### Fixed — a PR that merged three minutes ago is finished, but it is not cold

`sessions` treated a settled PR as proof a session was done, and that verdict
bypassed the idle clock entirely. Measured on two real sessions today: every PR
merged, worktree clean and pushed, last activity **three minutes earlier**. Both
qualified as archivable while their author was plainly still working in them.

Being finished with the PRs is not being finished with the session.
`--merged-min-hours` (default **12**) now requires both. Inside the floor the
verdict is ACTIVE and the reason names the hours, so it cannot be mistaken for
an ordinary recency call.

This mattered because the weekly task acts on its own judgement. Without the
floor, its blast radius included work finished an hour before it ran.

## [8.95.0] - 2026-08-21

### Added — one view of every session, and a heartbeat that costs nothing

`check-queue-drained` only ever sees the transcript it was handed, so nothing on
this machine could answer the question you actually have with seventeen sessions
running: which one is waiting on me right now.

`scripts/fleet-status.js` reads every transcript in one pass and reports the
sessions blocked on an unanswered panel. Detection is the exact inverse of the
queue check — that one collects panels which *received* a `tool_result`, this one
collects the `tool_use` whose id never got one. Measured on this machine: 39
transcripts across 78 project dirs, 31 of which raise panels.

Two things learned building it, both encoded rather than written down:

**A pending panel is short-lived.** Two caught at 19:24 were answered inside
fifteen minutes. A board that only refreshes when opened will usually show an
empty fleet and report nothing, which is why the population line prints what was
scanned — a report that prints only a verdict cannot be told apart from one that
found nothing.

**A transcript is not addressable.** The id that `send_message` accepts is
`local_<uuid>`, and it lives in the desktop session store, joined to a transcript
only by that record's `cliSessionId`. Checking that a transcript's internal
`sessionId` matches its own filename looks like a mapping check and is vacuous —
it compares a file to itself. 28 of 39 sessions resolve; the other 11 can be
displayed but never messaged, and the output says so rather than offering a dead
control.

### Added — `scripts/fleet-heartbeat.js`, written from the Stop hook

An mtime says a transcript grew. It cannot say a turn *ended*, and those look
identical from outside. The Stop hook fires exactly when a session stops working
and starts waiting, so that is where the heartbeat is written.

It deliberately does not read the transcript: `check-queue-drained` already reads
that file on every Stop and they run to ~4.7MB, so a second full read inside a
5s-timeout hook is the expensive mistake. Metadata only, write-then-rename so a
reader cannot catch a half-written record, pruned after 7 days.

No model turn is involved anywhere, which is the whole point. A heartbeat that
woke each session to self-report would re-ingest its context — roughly 405k
tokens — to say one line.

Mutation-tested rather than asserted: with `write()` throwing, with the module
unloadable, and with the file deleted outright, the Stop hook still emits
`{"decision":"approve"}` in all three cases. An unfired guard is a claim.

## [8.94.0] - 2026-08-21

### Changed — scheduled sessions age out in days, not weeks

`sessions` held every session to one 14-day clock. But the population is not one
kind of thing: **261 of ~480 records carry a `scheduledTaskId`** — morning
briefings, daily digests, review pulses — and those are disposable by
construction, because the task that made them will make another tomorrow.
Treating them like hand-started work meant the list silted up with yesterday's
digests, which is most of what was there.

Scheduled sessions now age out at `--ephemeral-days` (default **2**);
hand-started work keeps `--stale-days` (default **14**).

Detection is the `scheduledTaskId` field, not a regex over titles. A regex would
miss a renamed task and would catch hand-started work that happens to be called
"daily digest" — the field records who launched the session, which is the
question actually being asked.

Also honours `autoArchiveExempt`, a flag the app already sets. A tool that
invents a second opt-out beside an existing one just creates two places to look.

Paired with a weekly `session-sweep-weekly` scheduled task that archives only
finished SCHEDULED residue on its own judgement, and reports finished
hand-started sessions for a human call rather than acting on them.

## [8.93.0] - 2026-08-21

### Added — `sessions`, which archives finished work without discarding live work

Sessions accumulate. This machine held **302 unarchived** against the ~70 the
app's own list surfaces, going back three months, and roughly three quarters of
them were cron residue — morning briefings and daily digests that regenerate on
their own.

The command classifies them, checks their worktrees, writes resume stubs, and
hands a vetted list to `archive_session`. It archives nothing itself, so a bug
in it cannot delete a worktree.

**The classification was never the hard part.** `archive_session` removes the
session's git worktree, so the real question is which worktrees are disposable,
and three measurements shaped that check:

- **PR state on disk is a snapshot, not current state.** One PR was cached
  `MERGED` in one session and `OPEN` in another on the same day; the forge said
  `MERGED`. States now refresh live, one `gh pr list` per repo rather than one
  per PR. That alone moved five sessions out of the wrong bucket.
- **The recorded branch is not always the checked-out branch.** Two worktrees of
  six sat on a different branch than their record named, so checking the record
  inspected a branch the worktree was not on — which invented blocks, and could
  equally have cleared a branch nobody ever checked. It reads live HEAD now.
- **The default branch is not always `main`.** One repo's real default is a
  long-lived feature branch, with its `main` **7694 commits behind**; a
  hardcoded base would have reported 7694 orphan commits. It asks git, then the
  forge, then fails closed rather than guessing.

**Stashes are deliberately not a blocker**, and that is not an oversight.
`refs/stash` lives in the common git dir, so every worktree of a repo sees the
same list and removing one loses none of it — measured across a main checkout
and two siblings, all reporting the identical four entries. Blocking on it would
strand every worktree in any repo that had ever stashed, and protect nothing.

Unknown states fail closed throughout: an unreadable worktree is unsafe, never
safe. Third-party work is excluded by **git remote** rather than by project
name, which is both the more durable tell and the reason no client identifier
appears in this public repo.

On the first real run against 479 records it cleared 216 and caught two sessions
holding work that existed nowhere else — one with uncommitted files, one with a
local-only commit.

### Added — `check-queue-drained --sweep`, over every transcript

Landed in `5f568bb`, which was on `main` before this release was cut, so it ships
here. It walks a projects root and reports options-protocol items that were
selected and then offered again. Measured on this machine: 78 project dirs, 166
transcripts, 1,780 MB, 844 answered panels.

Two tiers, because they are not the same claim and collapsing them would
manufacture a to-do list out of history:

- **carried forward** — re-offered, so undelivered *at the time*. 49 items. Many
  landed later; this is history, not a backlog.
- **open at session end** — also picked in the *final* panel. 14 items. Tighter,
  and still not proof: an item picked last can be delivered before the session
  ends, and a measured case did exactly that — "Write up the session as a lessons
  entry" appears in this tier and demonstrably shipped.

Both lines label which tier they are, so neither can be read as the other. It
reuses `analyse()`, so the sweep and the post-commit hook cannot disagree about
what counts as a selection. Population is printed before any finding, and the
prefilter's skipped count sits beside the analysed count, so a small number is
distinguishable from a broken walk. A missing root reports NOT RUN.

The suite runs it over a controlled root of exactly three transcripts — one
carrying, one clean, one with no panel — so the asserted counts are exact rather
than "some". 36 assertions.

## [8.92.0] - 2026-08-21

### Changed — the queue report rides on hooks that already spawn

8.91.0 shipped `queue-drained` as its own PostToolUse hook on `Bash`. That was
the wrong shape by `telemetry.js`'s own note, which had already measured the
trade: a dedicated Bash hook costs roughly 6.3 minutes of wall clock a day on
this machine (64 ms a spawn, 5,923 Bash calls measured) to carry something that
fires only on commits. Measured again for this one: **56 ms median on the silent
path**, on every Bash call. The standalone hook is gone.

**Post-commit, in `telemetry.js`.** Both riders — the tool-failure advisory and
the queue report — now collect into ONE stdout write. Two JSON objects on one
stream is not parseable output, so the suite asserts that a call triggering BOTH
still emits exactly one valid object. That assertion first asserts both riders
actually fired, or it would pass vacuously whenever only one did, which is most
of the time.

**At Stop, in `stop-auto-check.js`,** and only the EXACT finding: an item
selected in two separate panels, which is proof it was re-offered. It rides as
`systemMessage` on the decision that hook was already emitting, so it carries no
decision of its own and cannot fight `approve`/`block`. The advisory queue print
stays on the commit path — Stop fires far more often than a commit does, and a
check that speaks every turn is one that gets ignored.

Both additions are separately wrapped. A queue note must never be why a tool call
looks failed, nor why a turn cannot end. Asserted directly: a missing transcript
still approves, and the decision survives untouched in every case.

29 assertions, up from 15. Three injected mutants — gating always false, two
stdout writes, the stop note never set — are each killed by the assertion written
for it, and the 48-assertion `stop-auto-check` suite is unchanged and green.

## [8.91.0] - 2026-08-21

### Added — `queue-drained`, a post-commit report on what was selected and not delivered

An item picked from an options panel is a work order, not a topic. The delivery
contract says report against that list every turn, and nothing enforced it.

Measured on 2026-08-20: `Write up the session as a lessons entry` was selected,
then offered again in two later panels before it was finally done. The slip sat
in the transcript the whole time, and nothing was reading the transcript.

The hook runs after `git commit` and prints two findings of deliberately
different strength:

- **CARRY-FORWARD is exact.** A label selected in two SEPARATE panels was
  re-offered, and an item is only re-offered because it was not delivered. No
  semantics and no judgement — the transcript proves it.
- **QUEUE is advisory.** It prints the most recent panel's picks and says in its
  own output that it cannot tell delivered from undelivered. A check that guessed
  at delivery would be wrong often enough to get muted, and a muted check catches
  nothing.

It never splits the answer string on commas, because labels contain commas
(`Merge #17, then clear #16`); it tests each panel's own labels for containment
instead. Measured across 103 real panels: no label shadows another, so
containment is exact here rather than merely convenient. The selftest plants a
comma inside a label so a comma-splitting mutant dies on it.

Always exits 0 — PostToolUse informs, and a false positive must never come
between a successful commit and the person who made it. An unreadable transcript
reports NOT RUN rather than passing silently.

Gating is on the command text, since the hook matcher only sees the tool name. A
regex matching option tokens alone missed `git -C <path> commit`, the common
shape on this machine, so it skips tokens non-greedily. Twelve command shapes are
asserted, negatives included.

Run it by hand with `npm run check:queue` (selftest), or against a transcript
with `node plugins/autodev-core/scripts/check-queue-drained.js --transcript <path>`.

### Fixed — the CI fixtures in `test-preflight-template` had no trigger

Both fixtures wrote a workflow body of `jobs:` alone. 8.90.0's `workflow-valid`
hard-fails a workflow with no top-level `on:`, so those fixtures stopped being
valid workflows the moment that gate shipped, and the assertion `and it is a
warning, not a failure` began measuring workflow-valid's verdict instead of the
ci-coverage warning it names. The gate is right and the fixture was wrong. Both
fixtures are corrected, not only the one that went red.

## [8.90.0] - 2026-08-20

### Added — `workflow-valid`, a gate on the files that run the gates

A workflow file GitHub REJECTS fails in 0 seconds with zero jobs and no log,
because it is refused before a job is created or its triggers are even
evaluated. Nothing readable tells you it happened.

Measured in one product repo: `ios-simshots.yml` carried two top-level `concurrency:`
blocks for three days — a second added with its cost rationale, the first not
removed — and every push produced a 0s red that also held every open PR at
`mergeStateStatus=UNSTABLE`. That repo has sixty gates and none of them read the
files that run the gates, which is why this ships in the template rather than in
one project. The tell that it had never run: its only trigger is
`workflow_dispatch`, so the push-event runs were GitHub failing to parse it
badly enough that it could not tell whether to run it at all.

The defect also could not have been caught by review. Both diffs were correct
alone — one PR added a concurrency block, and a branch authored before that PR
existed added an identical one. It exists only in the union, which is the exact
shape a gate catches and a reading does not.

A LINE SCAN, NOT A PARSE, and that is load-bearing. YAML parsers accept
duplicate keys and keep the last, so they call a rejected file valid — a
`yaml.safe_load` check printed "YAML OK" on that dead file. Node has no YAML in
its builtins either and this template stays dependency-free. Top-level keys are
the only thing at column 0 in a workflow, since a block scalar must indent past
its key, so the scan is exact for the class it covers. It also catches a missing
`jobs` or trigger, both the same silent rejection. It is not a workflow linter
and should not grow into one.

Ships as a third default beside `syntax` and `gates-ran` because, like them, it
needs to know nothing about the repo — and it sits next to `gates-ran`, which
already reads `.github/workflows` to prove preflight is wired into CI. That gate
asks whether CI references preflight; this one asks whether CI can start at all.

Its summary agrees with its own findings: the first draft printed "no
duplicates" unconditionally, so a run that had just named a duplicate
contradicted itself one line later.

Mutation-tested across all three branches — duplicate key, missing `jobs`,
missing trigger — plus a clean control. Swept 215 workflow files across 42
`.github/workflows` directories before writing it: the only rejects were stale
pre-fix copies of that same file, so this is a rare defect with an expensive
silence rather than a common one.

## [8.89.0] - 2026-08-19

### Added — `--by-cost`, and a cap on the advisory

The miner ranked by frequency and breadth, so a class that fails fast ranked
level with one burning two minutes a hit. On the first real run the two views
disagree exactly as expected: `command-timeout` is the top cost class at 36.5
minutes in 24h with a 130s median, while ranking sixth by breadth. Fourteen
two-minute timeouts is a real cost no frequency ranking would surface.

Timing pairs a `tool_use` timestamp with its result, because the transcript's
only `durationMs` belongs to attachments and is not tool duration. It measures
WALL CLOCK INCLUDING PERMISSION WAITS and the header says so rather than leaving
the reader to assume. The worry that permission prompts would dominate was
unfounded — denials have a 1.0s median, because a denial is fast. Median, not
mean, so one call left pending overnight cannot own the ranking.

The advisory is capped at six rules; a seventh earns its place on cost per hit,
never frequency, and must name which rule it replaces. The weekly review may now
open a PR proposing one rule, and may never merge — report-only has a known
failure mode in this repo, where a correct detection was filed as a warning
nobody read.


## [8.88.0] - 2026-08-19

### Added — show-your-work and writing-for-agents

show-your-work records choices as they are made, the complement to
check:patterns reading failures afterwards. Append-only TSV, one row per
decision, rejections included, since a rejection records a road not taken that
nothing else captures. Not hook-enforced on purpose: a decision log a hook
writes is a transcript with extra steps.

writing-for-agents governs document architecture for documents an AGENT
executes, a different axis from rules/writing-style.md, which governs prose for
people. Its central claim: a pointer's wording, not its target, decides whether
material is ever reached, so a must-have behind a weak pointer is a variance bug.
check:triggers measures exactly that, and now reports about 3,668 tokens of skill
descriptions resident every session.

## [8.87.0] - 2026-08-19

### Added — wizard, grilling, and check:triggers

Adapted from a review of mattpocock/skills (MIT) rather than installed wholesale;
most of that repo duplicates something already here. wizard hands work back when
it is blocked on a human, which is the constructive half of the most expensive
class measured today (a session retried for two hours against an error that asked
for a human decision). grilling attacks a plan's premise before it becomes code —
the gap where review checks the diff against the plan and tests check the code
against the spec, and both pass while the spec answers the wrong question.

check:triggers prices the skill set: 13,886 bytes of description and when_to_use,
about 3,472 tokens, resident every session whether or not a skill loads. A
description is a trigger, not a summary, and 54 of 55 already name a condition.

## [8.86.0] - 2026-08-19

### Added — two more advisory rules, taking real-failure coverage to 23.5%

sql-schema-guess (7 hits in 24h) and agent-schema-violation (6). Replayed against
the real failures of the last day the advisory now speaks on 42 of 179, up from
29. A guessed column fails the whole query, so each guess costs another round
trip to production and the hit rate does not improve — one agent missed seven in
a row where one introspection query answered all seven. A schema violation reads
as the agent misbehaving and is usually the contract being wrong.

## [8.85.0] - 2026-08-19

### Added — the failure advisory covers four classes, and now the browser too

Replayed against the real failures of the last 24 hours, it speaks on 29 of 175
(16.6%): tmp-path-split 16, shell-quoting 9, browser-blocked-on-user 2,
browser-self-destroyed-eval 2. A rule set that never fires on real data is a
hypothesis, so it was checked against the data rather than reasoned about.

The browser rules live in the hook because there is no browser skill left to put
them in — it was removed in 8.79.0 and its guidance is now spread across five
unrelated skills. The hook fires at the one moment a checklist would be read.

"Multiple Chrome browsers are connected" is the most expensive class measured:
it reads like a transient connection problem and is a question waiting for a
person. One session spent two hours retrying against it.

## [8.84.0] - 2026-08-19

### Added — the Windows /tmp split gets named when it bites

13 distinct sessions hit it in 24h, one each, and it is already documented in an
always-loaded rules file. That is the finding: a rule in context for every
session that still does not prevent the failure will not be fixed by more prose.
It survives because the error text misdirects — Git Bash resolves /tmp inside
its own root while Node reads it as C:	mp, so the message is "Cannot find
module '/tmp/ai.json'", which reads as "the file was not created" and sends you
to debug the writer.

Not its own hook, by measurement: one Node spawn costs 64ms here and Bash is 70%
of tool calls (5,923/day), so a dedicated PostToolUse hook would spend ~6.3
minutes of wall clock a day to prevent a class costing about five. It is a pure
function called from the hook that already spawns, and it speaks only on a
failed Bash call carrying the signature — about 0.15% of calls.

### Changed — the shell catch-all was about half fiction

`shell-nonzero-exit` led every report with 28 sessions and 47 hits behind the
advice "check whether the exit code IS the answer". Measured across 100 shell
exits in 24h, it split three ways: `command-not-found` (126/127, never "the
answer"), `shell-exit-may-be-the-answer` (exit 1 or 2 with output and no error
marker — grep exits 1 on no-match, and an && chain turns that answer into a
failed command), and `shell-fault`, which now means what its name says. On the
same window that is 17 sessions of answers-shaped-like-errors against 13 of real
faults.

Class tests may now be predicates as well as regexes, since that split needs the
exit code AND the presence of an error marker, and no single regex states both.

### Fixed — two remedies that would not have helped

From a post-mortem of a session that spent two hours retrying browser calls
against an error whose own text says a user must pick a browser: that class is a
blocked decision, not flakiness. And "Inspected target navigated or closed" is
frequently self-inflicted — a script that calls location.reload() then awaits has
destroyed the context it runs in. Navigate in one call, evaluate in the next.

## [8.83.0] - 2026-08-19

### Added — the learn loop now measures in-session failures, not just committed ones

`mine-fixes` reads git, so it sees only failures that survived long enough to be
committed and then fixed. The expensive ones never get there: an Edit refused
because the file was never read, a browser call made before its precondition
existed, seven queries in a row naming columns that do not exist. Those are paid
for in retries inside a session and leave no trace in history.
`check:patterns` reads the transcript tree, and `learn-from-fixes` now documents
it as the second half of the scheduled measurement — run once per machine, not
once per repo, and ranked by sessions affected rather than gross hits.

The script moved from `tooling/` to `plugins/autodev-core/scripts/` because a
scheduled routine runs against the INSTALLED plugin, which ships agents, hooks,
scripts, skills and templates — not `tooling/`. A skill citing a path that does
not exist at the install location is a step that fails the first time it fires,
unattended, with nobody reading.

### Changed — the taxonomy now names what it could only shrug at

Triaged the 65 shell-nonzero-exit and 25 unclassified errors from 24h rather
than trusting the ranking. 14 of the 25 were browser failures and all were one
mistake in different wording — a call made before its precondition existed or
after it expired — so they are now one class with one fix, with renderer hangs
split off because retrying is the one response that cannot help there.
`tmp-path-split` matched only the `C:	mp` spelling and so missed
`Cannot find module '/tmp/...'`, the commonest form and exactly the case the
rule exists for; fixed, it is visible at 13 sessions in 24h. Three classes had
no entry at all: shell quoting collapse, subagent schema violations, and
querying non-existent columns.

Unclassified falls from 14 sessions / 22 hits to 3 / 5 over the same window.

## [8.82.0] - 2026-08-19

### Fixed — telemetry recorded a failure exactly zero times, and its suite agreed

Both PostToolUse hooks read `tool_output` and `tool_error`. The CLI sends
`tool_response` and no error flag at all — the payload it builds is
`{ hook_event_name, tool_name, tool_input, tool_response, tool_use_id,
duration_ms, session_id, ... }`, read out of the shipping binary rather than
inferred. So `output_size` was 0 and `ok` was true in 878 of 878 rows written on
one machine: the field whose only job is to mark a FAILED tool call had never
once fired, and every quiet reading taken from it described the reader.
`memory-capture` fed the same dead key to its classifier, so every stored
observation was classified against an empty result string.

The suite could not have caught it. It hand-fed `tool_output`/`tool_error` and
asserted `ok:false` against a shape that does not exist — a fixture cannot test a
contract it gets wrong. Every case now uses the real key names, with paired
negatives so the new assertions cannot pass by `ok` simply being always false.
Verified by mutation: restoring the old key turns exactly three assertions red,
and the mutant emits `output_size:0, duration_ms:null, ok:true` — the signature
of all 878 real rows.

`duration_ms` is now recorded; the CLI measures it and the hook was discarding
it, which left the harness unable to say which tool calls cost wall-clock.

### Added — `check:patterns`, the other half of the learn loop

`mine-fixes` ranks what shipped broken and got fixed afterwards. Nothing ranked
what goes wrong DURING a session and never reaches a commit: an Edit refused
because the file was never read, a hook-blocked command, a browser probe against
a pane that is not composited, a two-minute timeout. `check:patterns` reads the
transcript tree — the only surface that sees every session on a machine at once,
subagents included — and ranks failure classes by SESSIONS AFFECTED, because
gross hits let one stuck session set the agenda for the whole fleet.

Two measurement bugs were found by running it and disbelieving the output, and
both are now the properties its suite holds. The denominator counted tool
results only on lines that had already matched the error filter, reporting "783
of 783 errored" — a share of itself. And it windowed by file mtime, then counted
every event in the file: a transcript is appended to for months under one name,
so a "last 2 days" scan counted failures from five weeks earlier and invented a
runaway session. Windowing is per-event now, off the event's own timestamp.

`--by-day` answers the question a refinement loop needs: did the change move the
class it targeted? It already paid for itself — `hook-blocked-command` runs 40,
34, 2, 1 across Aug 16-19 while the daily error total held at 180, 89, 100, so
the Bash denylist removal worked and it is not an artifact of a quiet day.

Population is printed first and an empty root reports PROBE BLIND with a
non-zero exit, so a zero is never mistaken for a clean bill of health.

## [8.81.0] - 2026-08-18

### Added — plugin drift now surfaces where the user actually looks

Grounded in a same-day incident: core ran 62 minor versions behind for two days
while every layer reported healthy. The marketplace auto-pull had silently
stopped, an interrupted `/plugin update` wrote the cache but never flipped the
manifest, and the nightly drift audit filed the result as `warn`, which its
policy correctly leaves alone. Detection worked; no surface anyone reads ever
said a word.

`session-start` now runs two local checks — installed version against the
marketplace clone's catalog (strictly newer only, so a rolled-back catalog stays
silent), and the clone's `FETCH_HEAD` age for the stopped-auto-pull class. Both
are file reads: 0.8ms measured on a 31ms hook, zero added bytes when clean. The
drifted banner names both versions; the context carries the exact fix command
and a reminder to verify the update actually took, because the motivating
incident was precisely an update that reported nothing and changed nothing.

### Added — a heartbeat that distinguishes a quiet schedule from a dead one

`drift-audit` judged scheduled tasks by their SKILL.md mtime, which a healthy
task stops touching forever — every stable task started warning a week after its
last edit, firing or not. Tasks that touch `.last-run` at the end of every run
now get judged on that instead: fresh stamp suppresses the mtime heuristic
entirely, stale stamp is reported as a stopped run with the cadence it was
judged against. Stamps may declare `{"cadence_days": N}`; junk cadences fall
back to daily rather than being believed, because a negative cadence would read
a minutes-old stamp as overdue. The nightly template and memory-maintenance now
both instruct writing the stamp unconditionally.

### Added — the learn loop gets its missing trigger, and only that

Measured before building, per `rule-ab-testing`: the loop itself already existed
(`mine-fixes` → `project-rules.md` → `review`/`audit` all read it). The missing
piece was that nothing runs the mining unattended. `learn-from-fixes` documents
its scheduled entry point, and the nightly template gains a weekly report-only
mining step. Deliberately not built, recorded in
`docs/rfc-self-heal-heartbeat-learn-loop.md`: unattended auto-update (the
marketplace is this repo; a bad push auto-installing into every session start is
worse than drift) and a fourth pattern store next to the three that exist.

## [8.80.0] - 2026-08-17

### Fixed — 8.79.0 removed a safety net for a tool that is still installed

`agent-browser-cleanup.js` and its suite are restored, and the SessionStart
registration with them. Dropping the agent-browser *skills* was right — nothing in
the plugin launches that CLI now. But the **binary is still installed**, and it has
a live consumer with nothing to do with this plugin: kb-factory's `crawl_js.py`
drives it to render JS-heavy documentation sites, which is how the `meta-ads-kb` and
`reddit-ads-kb` corpora are refreshed. Both skills correctly still name it.

So 8.79.0 removed the guidance and left the cause. The hook exists for two Windows
failure modes that come from the bundled Chromium outliving a session — zombie
`agent-browser-win32-x64.exe` processes, and the Win+Shift+S Snipping Tool hotkey
being stolen — and a KB refresh can still produce both. Nothing was broken when this
was found (zero processes live, the pid file stale since Jul 26), but the net was
gone while its cause was not.

The rule this violated is already written down: enumerate a thing's consumers before
deleting it. It was applied to the *skills* and not to the *binary*, and only a
follow-up sweep of other projects surfaced the difference. The restored file carries
that reasoning in its header so the next cleanup does not repeat it.

The migration banner in the 8 skills is corrected too. It said the CLI "was removed
in 8.79.0", which reads as the binary being gone and would make someone treat the KB
refresh path as broken. It now says the `browser` skill and the agent-browser steps
were dropped, names the binary as a separate consumer, and still tells you not to
reach for it for page verification.

### Fixed — the exemption vocabulary did not know two ordinary deprecation words

Correcting that banner made all 8 copies fire. "The `agent-browser` steps were
dropped in 8.79.0 — do not reach for that CLI here" is a deprecation notice followed
by a prohibition, and the vocabulary knew neither `dropped` nor `reach for`; it had
`removed`/`gone`/`retired` and the literal verb `use`. That is the same failure the
positional exemption was built for in 8.76.0, one synonym further out.

Both words are added, and the fix is the synonym rather than rewording the doc — a
detector that only passes prose written to suit it is measuring itself. Three
fixtures pin it, including the negative half: widening the vocabulary must not
exempt a line that still *prescribes* the old tool, so `agent-browser snapshot -i`
followed by "instead of read_page" is still a finding. A synonym list is exactly
what rots silently, since nothing fails until a doc happens to use the missing word.

Verified: 26/26 suites, `test-superseded` at 51 assertions (up from 48), validate
16 PASS / 0 FAIL, hook coverage back to 14 wired hooks all driven by a suite, and 10
of 10 hook spawn sites setting `windowsHide`.

## [8.79.0] - 2026-08-17

### Removed — the agent-browser harness, migrated to the built-in browser tools

The CLI predates the desktop app having both `mcp__Claude_Browser__*` and
chrome-devtools MCP, so it was a second driver for a job the session already does.
Deleted: `agent-browser-cleanup.js` (230 lines), the `browser` skill and its 365-line
CLI reference, and `test-agent-browser-cleanup.js` — 896 lines, plus the hook's
`SessionStart` registration. Wired hooks go 14 to 13, hook files 10 to 9, and hook
spawn sites 10 to 3, since the cleanup hook held six of them.

This was a migration rather than a deletion because 249 references across 22 files
included the UI-verification step in 12 skills. Deleting without repointing would
have left the workflow matrix's "UI (public)" row with no verifier, which degrades
silently to "typecheck + build". Each rewritten step now names the tool that replaces
it: `navigate` and `read_page` for structure, `computer` `screenshot` for the visual
check, `resize_window` for width, chrome-devtools `emulate` when a *device* gate must
fire, `read_console_messages` for errors, and `form_input` plus a `ref` click for
form flows.

The rewrites carry the traps with them rather than leaving them in a rules file the
skill's reader may not have loaded: assert the build before measuring (a service
worker serves the previous one and `ignoreCache` does not help); assert
`window.innerWidth` in the same call that measures, because a resize can report
success without changing anything; check 390 **and** 414; dismiss a tour or consent
overlay before the screenshot and confirm it is gone; measure contrast on the
rendered surface, since a static checker assumes a white background and a dark theme
then reports every token as failing.

A sixth detector rule, `agent-browser-cli`, is the completion gate. The risk is not
the references that were fixed but a new skill copying the old shape from an older
sibling — which is exactly how the dev-server contradiction spread. It is scoped to
`plugins/`, so historical mentions in CHANGELOG, MIGRATION and README stay legal: a
changelog that cannot name what it removed is useless. The eight deprecation notes
left in the migrated skills pass through the positional exemption, which is that
exemption's designed purpose.

### Added — validate refuses a hook spawn that can pop a console window

`execSync` routes through `cmd.exe` and Node's `windowsHide` defaults to `false`, so
a console child of a parent that owns no console gets a real window.
`checkHookSpawnsHidden` scans `hooks/` only: those are the spawners that run
unattended, while the other ~90 sites in the repo are test suites that run from a
shell which already owns a console, and flagging them would ship a gate that is red
on arrival — the failure mode `checkUntestedHooks` documents. It prints the
population it scanned, so a zero is distinguishable from a probe that matched
nothing, and `test-validate.js` fixtures both sides: the same call with and without
the option, asserted on the check's own output line rather than the exit status,
since a fixture file in `hooks/` can make other checks fail for unrelated reasons.

Verified: 25/25 suites, validate 16 PASS / 0 FAIL, detector clean across 84 files and
6 patterns, `test-validate` at 18 assertions.

## [8.78.0] - 2026-08-17

### Added — how to write PowerShell blocks, and the detector enforces the labels

`rule-windows/SKILL.md` now documents fence labelling as a *mechanism*, not a style
preference: `check-superseded` scans `powershell`/`ps1`/`pwsh` fences and exempts
`bash`/`sh`/`zsh`/`shell`/`console` ones even inside a file whose name matches
`windows`, so the label is the switch that decides which ruleset applies. An
unlabelled fence is scanned by nothing. The note covers CommonMark closing rules
(same character, at least as long, no info string), why a fence nested inside a
longer wrapper is content rather than an instruction, and the content conversions
in a table.

Writing that note produced a finding in the note itself. The first draft spelled
out the banned form in a "don't do this" table cell, and the detector flagged
`rule-windows/SKILL.md:96` — correctly, since a bare `curl` followed by a flag is
an instruction wherever it sits. Documentation that shows a banned form has to name
it rather than invoke it. That episode is now part of the note.

### Fixed — a suite run that overlapped a mutation sweep, and the negative half of the self-test

`test-all.js` refuses to run while any `tooling/*.vacuity-backup` exists. The
mutation sweep overwrites its subject in place, so a suite run overlapping a sweep
reports on a file that no longer exists on disk by the time the result prints. That
happened here: a backgrounded `check:vacuity` was still sweeping when `npm test`
was run, and 25/25 passed against a half-mutated `check-superseded.js`. Minutes
later a `git diff` taken during a second sweep showed a `|| -> &&` in a file nobody
had edited, which reads exactly like a harness leaking a mutant — it was the
in-flight mutant, and the crash-recovery path restored it correctly.

`validate.js` has checked for a stale `.vacuity-backup` since 8.71.0, and that check
is sound — fixtured here, it fails 14 PASS / 1 FAIL. It could not help, because
**it runs last**. A sweep that finishes part-way through a test run leaves every
suite that already reported bogus, and validate then reads a clean tree and passes.
That is exactly what happened: the sweep's completion notification arrived in the
same batch as the 25/25. Ordering, not detection, was the hole — so the same check
now also runs *before* the first suite.

The guard reuses the backup file the sweep already writes before its first mutation
and removes on clean exit, rather than adding a lockfile that could disagree with
it. It exits 2, so "refused" is distinguishable from "ran and failed", and it names
the file it found. Asserted in a new `test-runner-guard.js` (5 assertions), one
sided on purpose: the pass-through side would need a nested full runner spawn to
fixture, and every ordinary `npm test` exercises it.

The detector's own self-test asserted its negative fixtures with a
`.filter((f) => f.id === s.id)`, and the sweep flipped that `===` to `!==` without
the suite noticing — the mutant counted every *other* rule's findings, which is
also zero. The filter is gone: a corrected form must now trip **no** rule, which is
stronger than the filtered version and leaves no comparison to mutate. Measured
across all 5 rules first — every negative fixture produces zero findings from any
rule, so nothing was given up.

### Fixed — hooks could pop a visible console window on Windows

`execSync` routes through `cmd.exe`, and Node's `windowsHide` defaults to `false`,
so a console child spawned by a parent with no console of its own gets a real
window. `post-tool-typecheck.js` now passes `windowsHide: true` on both the
typecheck and lint calls; the lint call keeps the shell because its eslint fallback
uses `||`. `session-start.js` moves to `execFileSync` with an argv array, which
skips `cmd.exe` altogether and also removes its exposure to the `^`-eats-the-ref
bug. Six of 96 spawn sites in the plugin set `windowsHide`; the remainder are test
suites that only run under `npm test`.

Verified: 26/26 suites, `test-superseded` at 48 assertions, `test-runner-guard` at
5, detector clean on the live tree, mutation score 61 of 65 (up from 58/65). Three
of the four survivors are inside message strings and change only wording; the
fourth was the self-test filter fixed above.

## [8.77.0] - 2026-08-17

### Fixed — fence tracking, and `/dev/null` reading as a dev server

The last four verified findings from two adversarial reviews. All were latent —
no live instance in the tree — which is why only a review found them.

Fence tracking was a bare toggle and got three markdown shapes wrong:
`~~~powershell` is a valid CommonMark fence and was invisible; a ````markdown
wrapper containing a ```powershell opener read the inner opener as a *closer*,
inverting fence state for the rest of the file so genuine blocks after it were
missed; and an unclosed fence leaked its language to EOF, so prose twenty lines
below was scanned as PowerShell.

It now records the opening marker's character and length and closes only on the
same character, at least as long, with no info string — the CommonMark rule, which
handles tildes and nesting together. `` ```{powershell} `` info strings are
stripped rather than read as an empty language. Deliberate consequence: a
```powershell block nested inside a ````markdown wrapper is *content*, not an
instruction, so it does not fire.

`\bdev\b` matched the `dev` in `/dev/null`, so
`Bash({ command: "npm run build > /dev/null", run_in_background: true })` fired as
a half-migrated dev server. The repo carries ~20 `2>/dev/null` lines and 3
backgrounded dev servers, so the collision was one edit from live. The rule now
requires `run dev` or a `dev` not followed by a slash, and also matches `npx`,
`vite` and `next`.

`fileScope` overrode fence scoping entirely — any file whose *path* matched it
ignored the fence, so a ```bash block inside `rule-windows/SKILL.md` fired. That
is the exact false positive the fence exists to prevent, and one that
`rules/windows.md` explicitly blesses. `fileScope` now yields to a shell-language
fence.

Verified: an 11-case shape matrix passes 11/11, the 24-case exemption matrix still
passes 24/24, the suite is 44 assertions with 0 failed, and mutation score is 58 of
65 — holding at 89% while adding a fence state machine.

### Added — two independent review passes before a release

The `review` skill now prescribes reviewing twice rather than once, deeper.
Measured 2026-08-17: two reviewers, byte-identical prompt, same model, same two
files, converged on about six findings while each surfaced about six more the other
missed entirely. One caught a `git rev-parse HEAD^` that silently returned HEAD's
own sha; the other caught two live instructions in shipped skills that contradicted
a rule in the same plugin.

The skill is explicit that this is a pre-release gate, not a routine one — it
doubles review cost and false positives for a yield that only matters when a
mistake ships — and that `/code-review ultra` is the better path where available.

## [8.76.0] - 2026-08-17

### Fixed — the exemption disabled the detector on the prose it was built to catch

Each rule carried an `exempt` regex tested against the whole line, with a
vocabulary of `never|don't|do not|instead|avoid|scratchpad|firewall`. That is the
vocabulary of prescriptive prose, not only of prohibitions — so the highest-value
violation shape was exempt by construction:

> "Don't use preview_start for Vite; run `start cmd /k` in a second window."

A stale sibling teaching an old convention almost always argues *against* the new
path while prescribing the old one. So the one sentence shape this file exists to
find was the one it could not see, and the header reported the rule as healthy.

It leaked the other way too: the register real docs use for prohibitions carries
none of those keywords, so `` `start cmd /k` was removed in 8.72.0 ``, "is
deprecated", and this repo's own CHANGELOG line "is gone rather than demoted" all
fired. A curly apostrophe in "Don’t" fired as well — the pattern only had the
straight quote.

The replacement is positional and ordered: deprecation after the match exempts
(checked first, since such lines often also say "rather than"); prescription after
the match is an unrescuable violation, because "use X instead of Y" teaches X;
a prohibition **adjacent** before the match exempts, so "Never skip auth — `curl
-H ...`" still fires; and a prohibition anywhere after exempts. Adjacency is
measured against the text before the code span opened as well as the raw prefix,
because a rule's regex can anchor deep inside the construct being forbidden.

Rule 2 gains a real exemption too — `requiresNearby` had been doing double duty as
both the half-migration test and the prohibition escape hatch, and those are not
the same predicate.

Every rule now carries several fixture shapes instead of one. Single-shape
fixtures are why the old exemption survived review: the mutant and the correct
code agreed on every input the suite supplied.

Verified — a 24-case matrix drawn from both reviews passes 24/24 (7 shapes that
must fire, 17 that must be spared), the suite is at 38 assertions with 0 failed,
and the mutation score is 53 of 59, up from 48. The zero-population refusal added
in 8.75.0 turned out to be untested: both `if (!filesScanned)` and its `exit(2)`
survived mutation until these cases existed.

## [8.75.0] - 2026-08-17

### Added — `rule-options-protocol` skill, and a Fable reviewer

The options protocol ships as a plugin rule skill, which is the only tier that
reaches other machines and accounts. It carries the panel contract: four vetted
paths in one question, a recommendation in every block, complementary options
under multi-select and genuinely distinct alternatives under single-select, and a
**delivery contract** — a selection is a work order, so the following turns
execute the picks in order rather than treating them as direction.

`plan-reviewer` is a new read-only agent on Fable. It exists to put the expensive
model where the context is small: measured across 125,390 real calls, a
main-thread turn carries ~534k prompt tokens with 92% of cost input-side, while a
subagent turn carries ~161k — so the same review work prices at ~$0.28/call in a
subagent against ~$0.96 on the main loop.

### Fixed — two silent-wrong-answer paths in `check-superseded`

`--ref HEAD^` scanned the wrong tree while labelling it correctly. On Windows
`execSync` runs through `cmd.exe /d /s /c`, where `^` is the escape character, so
`git rev-parse HEAD^` returns HEAD's own sha — measured here as af3bd7b against
execFileSync's faa3c21. That defeats the only thing `--ref` exists for. Both git
calls now use `execFileSync` with an argv array.

A zero-file population reported clean and exited 0, because `git ls-tree` exits 0
with empty output when the pathspec matches nothing. The header printed the
denominator and nothing acted on it — the file's own discipline applied to
everything except itself. It now exits 2 on the `DETECTOR BROKEN` channel.

That fix immediately exposed a vacuous assertion, which is the better find: the
suite's disk-walk case deleted the fixture's only `.md` first, so it scanned zero
files and `status === 0` could not tell "found nothing bad" from "read nothing". A
clean second fixture now stays in the tree and the case asserts exactly 1 file
scanned. 30 assertions, 0 failed.

### Fixed — agent frontmatter: dead key, and per-role effort

`preloadSkills` is not a valid field; the correct name is `skills`. So
`code-reviewer` and `security-scanner` never had their skill content injected at
startup — they could still reach those skills through the Skill tool, so it was a
missing preload rather than missing access, but silent either way because nothing
validates unknown keys. Both now use `skills`.

`effort` is documented (`low|medium|high|xhigh|max`) and is now set per role:
`architect` at xhigh, the other three at high. **Its effect is unverified** — see
below.

### Measured — subagent model pinning does not take effect

Worth recording because it was believed on the strength of the tool contract for
months. Requested `model: fable` ran `claude-opus-5`; requested `model: haiku`
(control) also ran `claude-opus-5`; and `scout`, whose definition pins
`model: haiku`, ran `claude-opus-5`. Across **all 37,795 subagent calls on disk**
there are 22,893 `claude-opus-5` and 14,875 `claude-opus-4-8` and **zero** haiku,
sonnet or fable — while main-session transcripts show six distinct models, so the
probe can see variety.

Neither the Agent tool's `model` parameter nor definition-level pinning is
honoured here; every subagent runs the session model. Mechanical agents chosen to
be cheap have been billing at Opus rates throughout. Cause undetermined, likely a
session-level override. `effort` rides the same frontmatter path, so treat it as
inert until a transcript shows otherwise.

## [8.74.0] - 2026-08-17

### Added — the superseded detector runs in the gate

`check-superseded` shipped in 8.73.0 as a manual `npm run` script, which is how a
check rots — nobody runs it, and it drifts until it reports zero for a reason
nobody notices. It is now **suite 25**, so `npm test` fails when a skill picks up
a convention the harness outgrew.

The suite was then mutation-tested, and the first version caught only 31 of 48
mutants. Reading the survivors found two real gaps and one embarrassment. The
embarrassment first, because it is the same defect class the detector exists to
catch: both curl cases asserted `/bare-curl-on-windows/.test(stdout)` to prove a
rule had fired — but the population header prints that rule id on **every** run,
so the assertion matched the tool's own output and could never fail. Confirmed by
hand: with fence tracking replaced by `if (false)`, the powershell case still
passed. Both now assert the exit status and the `file:line` arrow.

Gap one: fence tracking was untested — the bash case passed for the wrong reason,
because that fixture also fails the `fileScope` check. Gap two: `--ref` was
untested in both `skillFiles()` and `readFile()`, despite being the path every
"does this still catch the old defect" check runs through; the fixture now commits
a file, **deletes it from the working tree**, and asserts `--ref` still finds it.

The module-level self-test cases moved into a child process, and that is not
tidiness. With `require.main !== module` inverted, requiring the gate executes the
CLI and its `process.exit()` replaces the suite's exit code — so the suite reported
success while its own earlier assertions had failed. A suite that can be made to
lie about its result is worse than a missing test. Final score: **44 of 48 mutants
caught**, the four survivors being fixture-string and cosmetic-grouping mutations.

### Added — `npm run check:agent-cost`

Measures, from real session transcripts, where model spend actually concentrates:
latency against prompt size, whether prompt caching decays over a long session,
and how much smaller a subagent's context is than its parent's. It exists because
those numbers move as usage shifts, and a model-placement rule written against
stale measurements is worse than no rule.

It carries a guard for the bug that produced it. Subagents do **not** write into
the parent transcript — they write to
`<project>/<session-uuid>/subagents/agent-*.jsonl`, which a one-level glob misses
entirely. The first version of this analysis did exactly that, found zero subagent
records across 362 subagent files, and reported "no subagents used": confident,
plausible, and completely wrong. So the walk is recursive, and the tool **refuses
to print its headline ratio** when the subagent set is empty while main
transcripts exist, because that means the walk is broken rather than that nobody
delegated. Verified two-sided: exit 2 with zero subagents, exit 0 and a full
report when one exists.

### Fixed — `npm run check:vacuity` was unrunnable

The tool takes `<subject.js> <suite.js>` and the npm script passes neither, so
`path.resolve(undefined)` threw `ERR_INVALID_ARG_TYPE` with a stack trace and no
hint of the contract. Found by running the meta-gates over this change. It now
prints usage and exits 2; `npm run check:vacuity -- <subject> <suite>` still
forwards arguments, so the script itself is unchanged.

## [8.73.0] - 2026-08-17

### Added — a detector for conventions the harness outgrew

8.72.0 found its cascade by reading: one skill had moved to `preview_start` and
three siblings had not, so the plugin shipped three mutually exclusive
dev-server instructions and nothing surfaced the contradiction.
`tooling/check-superseded.js` now finds that shape. `npm run check:superseded`.

Five rules, each with a positive **and** a negative fixture, both run through
`scanLines` — the same function that scans the tree, so the self-test cannot pass
while the scanner is broken. A rule failing either fixture exits 2 as a broken
detector rather than reporting a clean repo. Every run prints the population it
scanned, because a verdict without a denominator looks exactly like a finder that
returned nothing.

Mutation-tested against real history rather than asserted: `--ref 81b43fd`
returns 7 findings and independently rediscovers all five sites 8.72.0 fixed by
hand, including the three half-migrated ones at `auto:219`, `scan:57` and
`test:143`. The working tree is clean, and that only means something because the
pre-fix run fires.

Four more candidate rules were checked and **rejected**: stale model ids, `/tmp`
leakage, bash-isms inside the 8 powershell fences, and a suspect
`Test-NetConnection` call that is a real cmdlet. All measured zero. A rule that
cannot fire is worse than no rule, because the count then reads as coverage.

### Fixed — the image-scan suite's intermittent failure

It failed twice in ~8 full `test-all` runs and never standalone. The cause was
not contention: measured baseline drift across a run is 0.2ms on a 32-core box.
Each of the 7 budget assertions rested on **one** wall-clock sample, and the same
invocation sits at 33–37ms with observed spikes to 68 and 84ms — so one rare
outlier failed a suite whose subject was healthy.

Now min-of-3 per case against a min-of-3 baseline: floor against floor, neither
depending on machine load. Over 84 samples the worst single value was 68ms and
the worst min-of-3 was 36.2ms, while the floor still rises on a real regression.
Raising the 150ms constant was rejected — it hides regressions and still flakes.

Stated plainly: 18 consecutive full runs were clean *before* this change, so it
addresses a measured tail-risk mechanism, not a reproduced failure.

## [8.72.0] - 2026-08-17

### Fixed — the plugin shipped three dev-server conventions at once

`rule-windows` forbade `npm run dev` from Claude Code and prescribed
`start cmd /k`, on the premise that a backgrounded server dies at session end.
The premise is now false twice over: `run_in_background` detaches the process
across turns, and `preview_start` supervises it outright.

`browser` had already moved to `preview_start` with `.claude/launch.json`, but
`auto`, `test` and `scan` still instructed a detached Bash, and the rule still
forbade both. Three conventions, mutually exclusive, all live. Fixing only the
rule would have left the harness inconsistent, so the three pipeline skills now
name `preview_start` as the preferred path with detached Bash as the documented
fallback. `start cmd /k` is gone rather than demoted — it opens a window no tool
can read, which makes a failed compile indistinguishable from a slow one.

### Fixed — the Supabase workaround told you to run the wrong `curl`

`rule-windows` claimed `curl` works in PowerShell but not in plain cmd. Both
halves are wrong. `curl.exe` ships in `C:\Windows\System32`, so cmd is fine, and
in Windows PowerShell 5.1 `curl` is an alias for `Invoke-WebRequest` —
`Get-Command curl` returns `CommandType: Alias`.

That made it a live bug rather than a stale note. The section exists because
`supabase db query --linked` hangs behind the Windows firewall, and its three
replacement commands all used bare `curl` with `-H`, which `Invoke-WebRequest`
rejects with a parameter-binding error that never mentions curl. All three now
say `curl.exe`, and the gotcha explains the alias instead of denying it.

## [8.71.0] - 2026-08-17

### Added — a success criterion on every user-invocable skill

Fourteen skills had no verification language at all, including `security`,
`perf`, `a11y`, `monitoring`, `standards` and `status` — the ones whose output
someone reads and acts on. Each now has a **Proving the run** section naming one
observable and, where one exists, a command that can fail. Twelve sections, all
different: `archive-prd` asserts story-count conservation, `perf` refuses a claim
without a before number, `monitoring` requires a thrown error to actually arrive,
`design` requires a screenshot at 390 and 414.

The recurring theme is that a clean result and a probe that never ran produce the
same text, so `security`, `standards`, `mem-search` and `knowledge-agent` must
show the check can see something before reporting that it saw nothing. After:
39 user-invocable skills, 0 without a criterion. The three always-on `rule-*`
skills are excluded — they are background rules, not runs.

### Added — the learning loop reaches the pipeline skills

37 of 52 skills never wrote anything back. For `fix`, `review`, `test`, `ship`,
`deploy`, `iterate` and `refactor` that meant every lesson died with the session.
They now feed the mechanism that already exists — the story `resolution` field
and conventional `fix:` subjects that `mine-fixes.js` ranks into
`.claude/project-rules.md`, which `review` and `audit` read.

Each carries a **threshold**, which is what decides whether this helps: a store
where most entries say "fixed a typo" is one nobody searches twice. `fix` records
only when the first hypothesis was wrong; `review` when a finding appears twice
and becomes a class; `test` when a test was green and wrong; `iterate` when an
iteration undoes an earlier one.

### Restored — telemetry, which 8.0 dropped entirely

No hook, no skill, no mention anywhere in `plugins/`. Ported back with three
fixes: the session id now comes from the hook payload (7.x read an env var 8.x
never sets, so every event ever written recorded `"session": null`), the skill
reports through `scripts/telemetry-report.js` instead of two inline `node -e`
blocks, and disabling is `CLAUDE_TELEMETRY_DISABLED=1` rather than editing a
settings file that no longer holds the entry.

The suite's load-bearing case is privacy: a canary secret is fed through every
field a tool call carries and the written line is grepped for it, because
"metadata only" is the claim that makes this safe to leave on.

## [8.70.0] - 2026-08-17

### Added — `spec`, the front of the pipeline

`setup-project` scaffolds and then deliberately skips `prd.json` unless a plan
already exists; `brainstorm` only writes stories on an explicit apply. So "build
me X" had nowhere to land. `spec` turns one sentence into `SPEC.md`, a schema and
a backlog `auto` can work — schema first, assumptions stated rather than
interviewed for, and printed in the handover so a wrong one costs a line instead
of a sprint.

`check-spec-output.js` is the half that makes it more than prose. A planning
skill fails by emitting confident filler — *Auth flow*, *Dashboard layout*, *Set
up the database* — which looks like a plan and fits any product ever conceived.
The checker rejects layer-named titles, malformed ids, stories born already
passing, acceptance criteria too vague to check, and tables created without RLS.

Its criterion rule is a **denylist of vagueness, not an allowlist of approved
verbs**. The first version demanded a verb from a fixed list and rejected its own
reference example ("inserts a check-in", "the count increments") — the same shape
as the `npx` allowlist removed in 8.69.0, which passed `npx create-next-app` and
blocked `npx -y create-next-app`. Its suite pairs every rejection with a positive
case, which is how that defect surfaced a minute after being written.

### Fixed — the nightly audit discovered zero projects on Windows, silently

Discovery reversed a slug back into a path, and slugs are not reversible: any
directory containing a dash gained extra path segments, and a Windows slug
(`C--Users-…`) became `/C//Users/…`, which cannot exist. `existsSync` returned
false and the surrounding catch hid it, so the audit reported cleanly while
finding nothing. It now reads the real cwd out of the session transcripts already
sitting in each slug directory, and keeps reversal as a fallback.

## [8.69.0] - 2026-08-17

### Removed — the Bash denylist, after measuring what it actually caught

Across 656 transcripts and 57,599 Bash calls it produced 807 blocks: 591 were
`node -e`/`-p` reading local JSON, 73 were `npx` (one of them a production
deploy), 27 were `curl` piped into `node -e` to parse a response, 56 were agents
doing git cleanup in throwaway worktrees. The rules written for catastrophe —
`mkfs`, `format c:`, `diskpart`, `rm -rf ~`, `curl | bash`, `find / -delete` —
fired **zero** times.

Driven with 22 crafted cases, 7 came back wrong, all refusing legitimate work.
`npx create-next-app` passed but `npx -y create-next-app` was blocked: the
20-entry allowlist sat behind a negative lookahead that any flag defeats, so it
only worked when you passed no flags — and the command it exists to permit is the
one `setup-project` prescribes. `git checkout -- .gitignore` was blocked as if it
were `git checkout .`. Grepping migrations *for* "drop table" was blocked.
`--force-with-lease` was blocked while `--force` was the thing feared.

A denylist over command text cannot tell executing a dangerous thing from
mentioning one. **Kept:** the write guard on the installed plugin tree and the
private-name check — those catch structural mistakes, not bad judgment, and
between them produced 8 blocks in 634,893 lines.

### Added — `npm run check:versions`

The pinned-version table in `setup-project` was five majors behind (TypeScript
^5.8 against a released 7.0.2, Next 15, Zod 3, pnpm 10, Stripe 21) and nothing in
the repo could see it: the file was internally consistent and every risk note read
as fact when written. The new gate is the only check here that reads outside the
repo, because this kind of staleness is invisible from inside it. Majors fail,
minors warn, an unreachable registry exits 0.

New pins are evidence-led, not recency-led — the test was whether the previous
major is still being patched — and Next 16 + React 19 + TS 7 were proven by
scaffolding and building on them under `strict` and `noUncheckedIndexedAccess`.

### Fixed — `npm test` could never pass on Windows

`test-drift-audit` built its slug by replacing forward slashes only, so on Windows
it asked mkdir for an absolute path nested inside another and crashed during
setup, before any assertion ran. Production discovery has the mirror-image bug and
is left alone deliberately, with the reasoning recorded at the call site.

### Added — the real Windows browser failure modes

Recovered from the 7.x skill during migration; the cleanup hook shipped in 8.0 but
the prose explaining it did not.

## [8.18.0] - 2026-08-16

### Fixed — `find-orphan-checks` cried wolf about the suites that prove it works

It reported four of **this repo's own test suites** as unreferenced, under a
heading saying they touch prod or money and were kept out of CI on purpose. All
four run on every build. `tooling/test-all.js` finds them with
`readdirSync(dir).filter(f => /^test-.*\.js$/.test(f))` — the reference is a
regex evaluated at run time, so there is no literal filename anywhere to match.

Now treats a runner that **discovers its work by pattern** as a reference.
Measured across three repos, with identical counting:

| repo | before | after |
|---|---|---|
| this one | 7 orphaned assertions + 4 manual | **0 + 0** |
| a media app | 1 + 11 | 1 + 11 *(no dynamic runner — correctly unchanged)* |
| a health app | 37 + 14 | **9 + 9** |

The health app's drop is corroborated independently: its own preflight prints
*"74 harness scripts swept"*, and `harness-sweep.js` is what discovers them.

### The guard took three attempts, both early ones failing the same way

Judging the pattern by hit rate or by a trailing extension, when what matters is
whether it **names** anything:

1. *discard if it matches >50% of candidates* — killed `/^test-.*\.js$/` in a
   `tooling/` directory that is mostly tests. The legitimate case. The fix
   silently did nothing and the four false positives stayed.
2. *require 3+ literal word chars after stripping one trailing extension* — let
   `/\.(js|html|css)$/` through, because "html" is three word characters. That
   suppressed **67 of 120** scripts in a real repo: far worse than the 4 false
   positives it was built to remove.
3. *require a literal that is not a file extension* — `^test-` names something;
   `\.(js|html|css)$` names every file there is.

Four new assertions. **The second canary did not fire until the fixture grew**:
with only two scripts the extension pattern matched 100% and the breadth guard
rejected it, so the test passed with the discriminator guard removed and proved
nothing. Three `.mjs` files were added to isolate the property. A test can be
vacuous for one assertion while passing.

## [8.17.0] - 2026-08-16

### Retracted — "that P0 is marked done and the fix exists nowhere"

It was not. The fixes had shipped **two minutes before** the duplicate that went
looking for them, in a commit closing all four findings from the audit wave.
`passes: true` was accurate the whole time. The claim was stated forcefully,
twice, including in a handoff document, and 8.14.0 was built on it.

**How the false negative was manufactured**, which is the part worth keeping:

```
"is the handler now below authCheck?"                 → no
grep sanitis|sanitiz|generic.*fallback|strip.*PII     → no hits
∴ "the fix exists nowhere"
```

The real implementation was a third shape neither pattern matched — split the
copy into `text` (personal, rides in the encrypted push) and `pubText` (generic,
written to the public file). It is *better* than either thing searched for, and
it is the design later recommended independently here, already shipped.

**An absence search is only as good as its enumeration of what would count as
presence.** Two misses became "nowhere".

`rule-ab-testing` rule 5 is rewritten from "a result of zero is a result" to
demand the same reading a count gets: write down what you would accept as
evidence of presence before reporting absence, and **search for the effect, not
for the fix you had in mind.** The tally goes to sixteen, with the new row
flagged as the one to read twice — the two detectors built for this class were
sound; the premise that motivated them was not, and measuring a detector never
checks the story behind it.

`rule-verification`'s two rules are unchanged and now rest on their own
reasoning rather than on a retracted anecdote.

### Also

The superseded fix branch was removed locally. The other session's work is
better on every point: `[img-consent]` now requires `consentV` to be **enforced
in a 403 refusal** rather than merely present — stronger than the
comment-stripping version proposed here.

## [8.16.0] - 2026-08-16

### Fixed — the name check could not see a new file, which is when it matters most

It caught its author, and only after the push. A handoff doc naming all three
private codebases was written into `docs/`, `validate.js` was run and reported
13 PASS 0 FAIL, and the file was **then** `git add`ed and pushed to the public
remote. `check-no-private-names.js` scanned `git ls-files` — tracked files only
— so at the moment it ran, the new file did not exist as far as it was
concerned.

That window is every new file, every time. A gate that inspects only what is
already committed cannot stop anything from being committed. Now scans tracked
plus `--others --exclude-standard`, so untracked files count while `.gitignore`
is still honoured.

The handoff is removed from the repo rather than anonymised: a document whose
job is telling the next session which private repos are in what state does not
belong in a public marketplace, and stripping the names would leave it useless.

### Added

`validate.js` is now covered by `check-suites-can-fail.js`. It guards plugin
structure, version sync, hook wiring and the denylist above, and nothing had
ever proved it could fail — it is not a `test-*.js` file, so the loop never saw
it. Its mutation is a repo mutation: desync `VERSION` from every manifest and
assert it goes red. **14 gates checked, 0 vacuous.** That check earned itself
immediately — reporting `validate.js` as RED is what surfaced the leak above.

## [8.15.0] - 2026-08-16

### Added — `npm run check:suites`: prove every test suite can fail

This repo keeps writing *"a gate nobody has watched fire is a hypothesis"* and
then hand-canarying one change at a time. This runs that check for all of them,
in CI.

For each suite it derives the source files that suite exercises, replaces each
with a stub that parses and does nothing, and asserts the suite goes red. A
suite that stays green against a stub is testing nothing.

**Result on the current tree: 12 of 12 suites can fail, 0 vacuous.**

The runner is checked differently — one child suite is made to exit 1 and
`test-all.js` must notice. That is the exact bug this repo has already shipped
once: `run(label, file, args)` called as `run(label, [...])` left `args`
undefined, so every suite spawned a bare `node`, twelve reported PASS having
executed nothing, and CI was green on an empty test run.

### Three bugs it found in itself, in order

1. **The stub called `process.exit(0)`.** For a suite that `require()`s its
   subject that runs in the test runner's own process and kills it before a
   single assertion — so the suite "passed", and two suites were reported
   VACUOUS when neither was. A checker whose failure mode is a false accusation
   is worse than no checker.
2. **The subject map was hand-written and wrong for 3 of 12.** Two pointed at
   files that do not exist; one accused a suite of vacuity when the real fault
   was mapping it to a file it never touches. Subjects are now **derived** from
   what each suite actually references — including bare basenames, because four
   suites build their path in two steps and derived nothing without that.
3. **"Every subject must kill the suite" was too strict.** A suite legitimately
   references files it does not exercise — one names a module in a comment
   explaining that it deliberately does *not* copy it. The property under test is
   "this suite can fail", and one killed subject proves it.

Verified non-vacuous by neutering a real suite and confirming it is reported
VACUOUS, then restoring. Refuses to run on a dirty tree, since it overwrites
source files and restores them from git. Linux-only in CI — one clean checkout
answers the question, and three would triple a 40-second job for the same result.

## [8.14.0] - 2026-08-16

### Added — closing a task is a claim, and it has to be true

`rule-verification` gains two rules for marking `passes: true`:

1. **Name the change, so a reader can falsify it.** "Fixed" is not a record.
2. **Do not close a story until the change is somewhere a reader can reach it.**
   Committed and pushed, or the story stays open.

> **Corrected in 8.17.0.** This entry originally justified those rules with an
> instance — two P0 stories marked done while the fix existed nowhere. **That was
> false.** The fixes had shipped two minutes before the duplicate that went
> looking for them; `passes: true` was accurate throughout. The rules stand on
> their own merits; the anecdote was retracted and replaced with the more useful
> lesson, which is about how a confident false negative gets manufactured. See
> 8.17.0.

### Not added — two detectors for it, both measured and dropped

| Signal | Result |
|---|---|
| "no commit message references the story id" | **100% of done stories, all three repos.** None put ids in commit messages, so this is the normal state |
| "the story cites file paths that no longer exist" | 4 hits across 371 done stories, **0 real** — three path-prefix artifacts, one file the story's own fix deliberately deleted |

What caught the real instance was reading the claim and checking the fact it
asserted. That stays a review step. `rule-ab-testing` records both dead ends so
a third guess does not get built, and now says plainly that **"no detector fits"
is a legitimate conclusion** — cheaper than a checker nobody trusts.

Its running tally goes from eleven overturned recommendations to **fifteen**.

## [8.13.0] - 2026-08-16

### Fixed — carrier branches compare to the DEFAULT branch, not HEAD

Found by using the tool: merging one of the two real carriers and watching the
finding fail to clear, because the checkout was on a docs branch at the time. So
`origin/main` — which now had the merge — reported as "a branch carrying
prd.json changes you do not have", which is simply what working on a branch
means.

`defaultRef()` resolves `refs/remotes/origin/HEAD`, falls back through
`origin/main` and `origin/master`, then HEAD. The base is excluded from its own
candidate list and named in both the finding and its fix line — which also makes
the fix line correct, since it used to print `git diff HEAD...<branch>`, a
command that gives a different answer depending on the reader's checkout.

The first canary **did not fire**, which was itself informative: the mechanism
has two halves (the `rev-list` and the `diff`), and reverting one left the other
suppressing the false positive. It fails 1 of 19 when fully reverted.

## [8.11.0] - 2026-08-16

### Changed — the repos this framework learned from are anonymised

This repo is public. Four tracked files named three private codebases — one of
them a client deliverable — next to their per-repo defect rates. Nothing was
secret, and that was never the point: **a team's defect rate is theirs to
publish, and this tool had published it for them.**

Now `Project A` / `B` / `C`. Every number and conclusion is unchanged, and each
project's *shape* is kept, because it is load-bearing for reading the table — a
consumer health app, a B2B audit platform and a consumer media app fail
differently. `docs/failure-evidence.md` says so up front, and points readers at
`/learn-from-fixes` for their own numbers, which was always the point of the
document.

Found by asking whether the repo should be private, not by anything failing.
Going private was the wrong lever: it breaks `/plugin marketplace add` for
everyone else and does not address what was actually exposed.

### Added — `tooling/check-no-private-names.js`

So it cannot happen again. Scans every tracked file for a denylist of private
project and client names; wired into `validate.js`, so CI enforces it.

A **generic** detector was considered and rejected — "a lowercase word that
looks like a project name" has no precision in a repo full of skill, hook and
flag names. A denylist of the names you actually work with is small, exact, and
fails benignly.

The precedent is inverted and worth stating: one of those private repos carries
a tripwire against publishing verbatim internals, reasoning *"every private repo
is eventually public."* **That repo is private and has the guard; this one is
public and had none.**

Verified non-vacuous by planting a name in `README.md` and confirming it fails
naming file and line, then restoring byte-identically. The first version of its
binary-file skip was `includes(' ')` — a space, not a NUL — which would have
skipped every text file and reported clean forever. That is the failure mode
this repo keeps writing rules about, caught in the file enforcing them.

**It catches the working tree only.** The names remain in git history; redaction
is not removal, and a rewrite is a separate, deliberate decision.

## [8.10.0] - 2026-08-16

### Added — the gate that a comment satisfies

A new failure class in `preflight` and `rule-ramifications`, from two real
instances in one repo in one week: an owner-only exemption granted by a **block
comment describing a check deleted three months earlier**, and an image-consent
gate over Art. 9 health data satisfied by a comment twelve lines above the guard
it had lost. Both reported PASS for the entire time the thing they guarded was
gone.

**Documented as a review lens and a narrow assertion, not as a scanning gate** —
because it was measured. A detector for "regex tested against raw file contents"
found **54 hits across the two gate files, of which 2 were bugs**. Most
raw-source tests are correct; a gate at that precision is one people learn to
skip. The shippable version names the security-critical checks and asserts each
reads a lexed view.

Includes the variant table that matters in practice: a comments-only strip keeps
string literals, while one that also blanks literal *contents* is stronger but
blinds any gate whose pattern matches inside a string. The two real gates needed
one each.

`rule-ramifications` gains a section on the gate itself being wrong — comment-
satisfied, never run, or never seen to fail — with one discipline for all three:
**prove it fails.** Delete what it guards, confirm it goes red naming file and
line, restore, verify byte-identical.

*(Version note: 8.10.0 is the first release where a lexical `ls | tail -1` picks
the wrong directory — it sorts 8.10.0 before 8.8.0. The nightly routine's plugin
path resolution was switched to `sort -V` in this session, before this bump.)*

## [8.9.0] - 2026-08-16

### Changed — `auto` stops blocking on stories nobody is working

A pending story nobody has edited in months is a decision not to do the work
that nobody wrote down. One repo had 14 of 15 pending stories untouched for over
a month and 3 for over three months — several blocked on a person, a vendor, or
a console nobody had opened — and `auto` blocked on all of them. Measured on
that repo's real backlog:

```
before   15 tasks remaining. Next: S1-021   <- blocked on a colleague since May
after     1 tasks remaining. Next: S1-060   <- the one story edited this week
```

`stop-auto-check` now treats a story untouched for >30 days like `deferred`, and
**names every story it set aside**, in the block reason Claude reads as well as
on stderr. Silently skipping work is how a backlog rots without anyone deciding
to let it.

**Ages are read, never computed.** The walk costs 1,652ms against this hook's
31ms, on every Stop, for a number that changes by days — so the nightly
`drift-audit` publishes them to `$CLAUDE_CONFIG_DIR/autodev/prd-story-ages.json`
and the hook reads that. Hook cost after the change: still 31ms.

Every failure path fails **open** — skips nothing — because the damage from
skipping real work exceeds the damage from blocking on stale work. Covered: no
cache, cache older than 14 days, corrupt cache, cache keyed to another repo, and
a story the audit never measured. 13 new assertions, 41 total; verified
non-vacuous by removing the cache-age guard.

The cache is written under `CLAUDE_CONFIG_DIR`, never into the repo — "nothing
was modified" is a promise `drift-audit` makes about the repos it inspects.

### Added

- **`CHANGELOG` entries for 8.2.1 through 8.7.0**, which shipped without any.

### Note

Widening the unmerged-branch check beyond `prd.json` was measured and **not**
shipped: scoped to `prd.json` it found 2 carriers across 224 branches, both real;
unscoped at ≤45 days it surfaced ~30 branches across 4 repos, mostly one-commit
debris. The scope was the precision.

## [8.8.0] - 2026-08-16

### Changed — `drift-audit` ages the prd BACKLOG, not the prd FILE

Four changes were proposed. Measuring against current behaviour on three real
repos killed two; implementing the survivors exposed a bug in one of them.

- **Per-pending-story age** replaces whole-file age as the finding. The file-level
  number does not discriminate — it read 4d / 0d / 1d across three repos whose
  median *pending story* was 61d / 15d / 1d. One had 14 of 15 pending stories
  untouched for over a month while its file was four days old. Also drops the
  `age < 3 → return` early-out, which meant the repos whose files looked fresh
  were never examined.
- **Unmerged branches carrying `prd.json` changes** are surfaced. Built because a
  backlog looked abandoned for weeks while the finished reconciliation sat on a
  branch nobody merged — a check aimed at the working tree concludes the
  opposite of the truth. 224 remote branches scanned, 2 carriers, 0 false
  positives.
- **Commit counts use `<sha>..HEAD`, not `--since=<ts>`.** `--since` filters on
  committer date, so rebased commits fall outside a window the range includes.
  Measured +2, −1, 0 — it errs both ways.
- **Rejected, recorded in the source so it is not rebuilt:** "age from the last
  commit that changed a `passes` value" returned the identical answer in all
  three repos. And the story-less commit ratio measured 95–100% everywhere, so
  it discriminates nothing as a recurring finding.

### Added

- **`tooling/test-drift-audit.js`** — 16 assertions against real git repos rather
  than fixtures, since both signals are defined in terms of git history. Covers
  the motivating case (file touched today, backlog 120 days old) and the two
  negative cases that keep the branch detector honest.

### Fixed

- **Story comparison parses instead of slicing text.** The first implementation
  sliced from `"S-1": {` to the next `\n    },`; the last story in the object has
  no trailing comma, so its slice ran to end-of-file and every story read as
  freshly edited on the day a story was appended after it. Under-reported one
  repo by two stale stories and four days of median age.

## [8.7.0] - 2026-08-16

### Added — `drift-audit` and `rule-ab-testing`

- **`scripts/drift-audit.js`** — finds local state that reports healthy while
  being stale. Written after an install sat pinned four releases behind the
  marketplace, a plugin was never installed at all, and an allowlist's broad
  rules made the deny list beneath them unenforceable.
  - Scoped deliberately: the first version reported every uninstalled plugin in
    every known catalog — 39KB naming hundreds nobody had asked for. Not
    installing something is the normal state of a catalog. It is only worth
    saying when you already use that marketplace.
- **`rule-ab-testing`** — every proposal is measured against current behaviour
  and one alternative before adoption, and the measurement is reported. Carries
  the running table of overturned recommendations.

## [8.6.0] - 2026-08-16

### Added — out-of-band file inbox

Save anything into `~/…/CloudDocs/claude-inbox` (iCloud, so an iOS Shortcut can
drop a screenshot in one tap) and the next prompt announces it with filename,
path and arrival age.

Chosen by measurement over three alternatives:

```
variant                     per prompt   context when 5 files waiting
A  no hook (baseline)             0ms    0 tokens
B  notify-only, subprocess       56ms    ~248 tokens
C  notify-only, in-process       30ms    ~248 tokens   <- shipped
D  auto-inject every arrival     30ms    ~5,500 tokens
```

Silent when empty, which is almost every turn; flat whether one file waits or
twenty-five, because the hook stats the directory and never opens a file. Each
arrival is announced exactly once. `AUTODEV_INBOX`, `AUTODEV_INBOX_DISABLED=1`,
and `/inbox` to list.

## [8.5.0] - 2026-08-16

### Added — `claudemd-audit`

Finds stale references in `CLAUDE.md` — files, functions and flags the doc names
that no longer exist.

Eight precision rules, all earned: the naive version reported 16 findings of
which **1** was real. The other 15 were prose, patterns, shorthand and
deliberately-recorded history. A detector that cries wolf is one people learn to
skip, after which the ones that were right get skipped too.

## [8.4.0] - 2026-08-16

### Added — nightly memory maintenance

A scheduled routine (`0 3 * * *`) running four independent checks: drift audit,
memory audit, `CLAUDE.md` audit, and orphan checks. Account-agnostic — every
path derives from `CLAUDE_CONFIG_DIR` or `$HOME`.

### Changed

- **Ratchet guidance for large gate populations.** A real type-aware race rule
  found 417 genuine hits across 183 files — too many to set to `error` without
  blocking every build. Documents the ratchet/baseline pattern instead of
  pretending the number was small.

## [8.3.0] - 2026-08-16

### Added

- **`rule-agent-concurrency`** — how many agents to spawn at which model and
  effort so a fan-out does not burn the session's limits.
- **`scripts/find-orphan-checks.js`** — verification code that nothing runs.
  Taught to distinguish assertions that are orphaned from ones deliberately kept
  out of CI: in one repo, 6 of 7 "orphans" touched production Stripe and
  Supabase service-role keys, so wiring them into CI would charge a card. Count
  dropped to 1.

### Fixed

- **`pre-tool-filter` false positives.** It blocked `cat x.json | node -e` and
  `grep "curl | bash"`. Both rules anchored; 8 regression cases added.

## [8.2.1] - 2026-08-16

### Changed

- **`preflight` must prove a gate does not already exist before writing one.**
  Two proposed gates turned out to be built already, and one existing version was
  better than the proposal — it shelled out to the fixer so the two could not
  diverge. Also records rejected gates, so the next contributor does not rebuild
  something that was turned down for a reason.

## [8.2.0] - 2026-08-16

### Added — `preflight`

The executable half of 8.1. `rule-ramifications` tells you what to check;
`/learn-from-fixes` ranks what this project gets wrong; `preflight` makes the
top classes fail a build.

- **`/preflight`** — `init` scaffolds `scripts/preflight.js`, `add <class>`
  grows it one bug family at a time, `verify` audits the gate file itself.
- **`templates/preflight.js`** — the harness, generalized from a production
  repo's own gate file, with gate shapes for reachability, duplicated
  derivation, cross-surface consistency, cache-key scoping, i18n drift,
  lifecycle, and config targeting.

Four laws are built into the template, each of which cost a production repo a
shipped bug:

1. **A gate that could not run is not a pass.** Gates sit in try/catch so one
   broken gate cannot take out the run — but routing that catch to a *warning*
   lets a gate switch itself off while the run still exits 0. That shipped:
   renaming one file turned a parity gate into "check skipped" and preflight
   printed PASS. A skip is a hard failure here.
2. **Snapshot before you regenerate.** A gate that regenerates an artifact
   before comparing it to its source compares the generator against its own
   output and is green forever. That shipped two consecutive stale releases.
3. **A known-red excuse that now passes is a failure.** `KNOWN_RED` entries are
   keyed by bare gate id and tied to an open work item, and the run fails when a
   tracked gate starts passing.
4. **A gate never seen to fail is not known to work.** Prove each new gate by
   reintroducing the defect.

The scaffolded file also fails if nothing is wired to run it — a gate file
nobody executes is decoration, which is exactly how sixty harness scripts in one
repo went unrun with two of them red for eight days.

`tooling/test-preflight-template.js` proves all four laws by making each one
fail on purpose (15 assertions).

## [8.1.0] - 2026-08-16

Evidence-driven, not guessed. Mined 3,127 `fix` commits across three production
repos to find what the first pass actually gets wrong. See
[docs/failure-evidence.md](docs/failure-evidence.md).

### The measurement

| Repo | fix : feat+refactor | Fixes per feature |
|---|---|---|
| Project A | 799 : 853 | 0.94 |
| Project B | 830 : 486 | 1.71 |
| Project C | 1,299 : 651 | 2.00 |

**93% of Project A's fixes land within 24 hours on a file a feature had just
touched.** That is the first pass being wrong, not debt accumulating.

Ranked causes, consistent across all three: ordering/async races (32–41%),
unhandled flow states (9–20%), cache-key scoping (7–16%), duplicated derivation
(4–11%), units and references (5–11%), lifecycle cleanup (6–8%), cross-surface
consistency (3–8%), config targeting (3–8%). Runtime crashes are a small
minority — the code runs, and is wrong. Typecheck, build, and a clean console
cannot see any of it.

Two findings about gates themselves:

- **More prose did not help.** The two repos with 526- and 593-line `CLAUDE.md`
  files have the *worst* fix ratios; the one with 55 lines has the best.
- **A gate nobody runs is not a gate.** Project A's own preflight records sixty
  harness scripts that nothing ran, two of them red for eight days. This
  framework had the identical defect in `test-all.js`, found in 8.0.

### Added
- **`rule-ramifications`** — the eight classes as a pre- and post-implementation
  checklist, auto-loaded on every feature. Every claim traces to a counted commit.
- **`learn-from-fixes`** + `scripts/mine-fixes.js` — any project ranks its own
  failure classes from its own git history instead of inheriting this list, and
  gets proposed executable gates for the top ones. Read-only; never writes to the
  analysed repo.
- **`docs/failure-evidence.md`** — method, measurements, and the quoted commits.

### Changed
- `rule-verification` now states plainly that a clean typecheck is not evidence
  against any of the eight classes, and defers to `rule-ramifications`.

### Fixed
- **`pre-tool-filter` blocked its own maintainers, twice**, during this analysis.
  `cat x.json | node -e '…'` — an everyday read-only idiom — was blocked because
  the rule matched `node -e` after *any* pipe; and `grep -rn "curl | bash"` was
  blocked for containing the string it searches for. The hook only ever sees
  command text and cannot distinguish executing from mentioning, so both rules
  are now anchored to command start or a chain operator. Fetch-and-execute
  (`curl … | bash`, `curl … | node -e`) stays blocked, with 8 new regression
  cases covering both directions.

## [8.0.0] - 2026-08-16

Restructured from a copy-into-`~/.claude` installer into a Claude Code plugin
marketplace. Read [MIGRATION.md](MIGRATION.md) before upgrading.

### Changed — distribution
- **Plugin marketplace.** `.claude-plugin/marketplace.json` catalogs three plugins: `autodev-core` (the workflow, 36 skills, 4 agents, 7 hooks), `autodev-memory` (4 skills, 3 hooks, the SQLite runtime), and `autodev-stack` (Supabase, Doppler, Stripe, Remotion). Install with `/plugin marketplace add` + `/plugin install`; Claude Code owns update and uninstall.
- **Removed the bespoke installer.** `install.sh`, `install.ps1`, `uninstall.sh`, `uninstall.ps1`, `scripts/sync.js`, `scripts/uninstall.js`, the `.auto-dev-installed.json` sidecar, `repo-path.txt`, the collision detector, and the `update-dev` shell-profile function are all gone — the harness does this natively.
- **Removed `skills/manifest.json`.** 14KB of `triggers`/`requires`/`priority` metadata that no runtime ever read; its only live uses were printing a version string and listing deprecated skills. Version now comes from the plugin's own `plugin.json`.
- **Hooks resolve through `${CLAUDE_PLUGIN_ROOT}`**, so the whitelist hack that decided which `scripts/` files to copy — and left the memory pipeline dead on every install when it drifted — is structurally impossible now.
- **Settings are no longer written for you.** `docs/recommended-settings.json` is opt-in and drops the `Bash(bash *)`, `Bash(sh *)`, `Bash(source *)`, `Bash(curl *)`, `Bash(export *)`, `Bash(chmod *)`, `Bash(rm -f *)`, and `WebFetch(domain:*)` allow rules, each of which made the deny list beneath it unenforceable. The global `model: opus` pin is gone.

### Fixed — latent bugs the restructure exposed
- **The test suite never ran.** `test-all.js` declared `run(label, file, args)` but every call site passed two arguments, so `args` was `undefined` and each "suite" launched a bare `node` with no script. Every suite reported PASS without executing; CI was green on an empty run.
- **Memory captured only the first turn of a session.** Session close ran on `Stop`, which fires at the end of every assistant turn — it ended the session and deleted the session-id file, so every later turn's observations were dropped. Moved to `SessionEnd`.
- **`core` and `standards` were unreachable.** Both set `user-invocable: false` and `disable-model-invocation: true`, which blocks user and model invocation alike. They now load by file context via `paths`.
- **`PostCompact` never fired.** `post-compact.js` was registered as a `PostToolUse` hook with matcher `"compact"`. It is a real event and is now wired to it.
- **`agent-browser-cleanup.js` was orphaned.** Its header claimed `session-start.js` invoked it; nothing did. Now registered on `SessionStart`.
- **Knowledge surfacing broke under symlinked paths.** The area calculation compared a raw `file_path` against `process.cwd()`; on macOS (`/var/folders` vs `/private/var/folders`) every edit looked outside the project. Both sides now go through `realpathSync`.
- **The image-scan perf assertion flaked.** A fixed 150ms wall-clock budget is mostly Node startup, which swings ~10x under load. It now measures this machine's baseline and budgets the hook's own work against it.
- **The memory-backup scheduled task did nothing.** It invoked `~/.claude/hooks/memory-backup.sh`, which was never shipped.

### Fixed — second review pass

- **`.env.local` loading was a no-op that claimed success.** The SessionStart hook parsed the file into `process.env` and printed `[Env] .env.local loaded`. A hook runs in its own process and **cannot** set environment variables for the session, so nothing was ever loaded — it read a secrets file for no effect. Removed.
- **The hook rewrote the user's MEMORY.md.** It patched a version number inside `~/.claude/projects/<guessed-slug>/memory/MEMORY.md` on every session start. A dev tool has no business silently editing the user's memory files. Removed.
- **SessionStart now uses the structured channel.** Sprint state goes to `additionalContext` (where Claude reads it) and the banner to `systemMessage` (where the user sees it), instead of both going to plain stdout. Deferred stories are counted separately from pending, and a malformed `prd.json` is surfaced instead of swallowed.
- **The observation classifier never received a prompt.** It derives both the observation TYPE and its concept text from `userPrompt`, which was read from `AUTO_DEV_LAST_PROMPT` — a variable nothing ever set. Every observation ever captured fell back to a generic type and a generic concept, which is why `mem decisions` and `mem bugs` returned so little. A new `UserPromptSubmit` hook records the prompt (with `<private>` blocks redacted) for the classifier to use.
- **Concurrent sessions clobbered each other's memory.** The session id lived in a single `.claude/memory-session-id` file per project, so a second Claude session overwrote the first's id, and whichever ended first deleted the file — silently ending capture for the other. Replaced with `.claude/memory-sessions/<session>`, keyed by the harness session id, each cleared by its own SessionEnd. Session ids are sanitized so a hostile one cannot escape the directory.
- **Hooks now read `cwd` and `session_id` from the payload** rather than `process.cwd()`, which is the shell that spawned the hook and not necessarily the project Claude is working in.
- **Telemetry logged `session: null` for every event** (same dead env var). It now uses the payload session id.
- **Telemetry is opt-in.** It was on by default, appending a line to `.claude/reports/` in every project on every tool call. Set `AUTODEV_TELEMETRY=1` to enable; `CLAUDE_TELEMETRY_DISABLED=1` still wins for anyone who opted out before.
- **The typecheck hook could be killed mid-lint.** Typecheck and lint ran back to back with 30s budgets each inside a single 60s hook timeout. Both are 25s now.
- **Hook-tampering protection had stopped covering the hooks.** `PROTECTED_FILE_PATTERNS` matched `.claude/hooks/`, but 8.0 hooks live under `.claude/plugins/`. Added, scoped to the install location so editing a plugin's own source repo stays ordinary development.
- Stale remediation text in `pre-tool-filter` (`Use 'update dev'`) and a stale registration comment in `post-compact` corrected. `docs/memory-system-design.md` marked as intent-only where it documents the env-var mechanism that never worked.

### Added — tests for the paths that rotted
- `tooling/test-session-carrier.js` — 21 assertions covering per-session isolation, the concurrent-session regression, path-traversal safety, prompt redaction, and both memory session hooks (previously untested).
- `tooling/test-session-start-hook.js` — 21 assertions covering the structured output contract, sprint counting, payload `cwd` handling, and regression guards asserting `.env.local` and `MEMORY.md` are never touched again.
- Telemetry suite extended for the opt-in gate and the payload session id.

### Changed — Desktop-first browser automation
- **New `browser` skill** (replaces `agent-browser`) selects a driver: the built-in Browser pane tools where available, the `agent-browser` CLI otherwise. The 300-line CLI reference moved to `references/agent-browser-cli.md` so it costs nothing on the default path.
- `scan` documents the built-in path first, with the CLI as the terminal-only fallback. Nine other browser-using skills carry the selection rule.
- Authenticated pages now prefer having the user log in directly in the Browser pane over the localStorage token-injection workaround.

### Fixed — the `auto` loop could not terminate

`stop-auto-check.js` is the hook that blocks the end of a turn to keep `auto`
running. It shipped with no tests, and writing them surfaced three defects:

- **A sprint whose remaining stories were all `deferred` blocked forever.** The
  pending filter was `passes !== true`, which counts `"deferred"` as outstanding
  work — but deferred is a decision *not* to do it. The only escape was the 2-hour
  stale-flag timeout. `auto/SKILL.md` had the same filter, so the skill and the
  hook agreed on the wrong answer.
- **An unparseable `prd.json` sent it into idle detection** instead of stopping,
  looping the session against a file it could not read. It now leaves auto mode
  and says why.
- **It ignored the payload `cwd`**, reading flags and `prd.json` relative to the
  shell that spawned the hook rather than the project Claude is working in.

Rewritten with every path guaranteed to reach `approve`, and covered by
`tooling/test-stop-auto-check.js` — 28 assertions across blocking, the idle
one-shot, the exit signal, stale flags, deferred-only sprints, malformed input,
and payload-cwd handling.

### Added — `autodev-init`

Generates `.claude/project-rules.md` by **measuring** the codebase — component
style, data-fetching library, semantic tokens versus raw colors, where auth is
enforced, where external data is validated — instead of shipping a default. Every
rule it writes cites a count; anything genuinely split is recorded as
`Undecided` and explicitly must not be flagged in review. Splits worth a decision
are put to the user with the counts in the options.

`review`, `audit`, and `standards` now defer to that file wherever it disagrees
with the shipped defaults. This inverts the plugin's model: it stops being a
knowledge dump that ages as models improve, and becomes a capture mechanism for
what a project actually decided.

### Added — validator guard for shell glob quoting

`--include=*.tsx` unquoted in a skill's shell snippet is expanded by zsh before
grep sees it, and errors when nothing matches locally — so a measurement command
silently returns 0 instead of failing loudly. This bit `autodev-init` during
testing: every count came back zero against a fixture that plainly had matches.
`validate.js` now rejects unquoted globs in `--include`, `--exclude`, and
`--exclude-dir` across every shipped doc.

### Removed — superseded by Claude Code itself

The tool was written when models needed reminding that `<div onClick>` should be a `<button>`. That is no longer where the value is, and restating it costs context on every session.

- **`smart-explore`** (skill + 565-line script + suite) — the built-in Explore agent does structural code exploration better, and reads real excerpts rather than a signature outline.
- **`telemetry`** (skill + hook + suite) — Claude Code has native OTEL support, and this wrote a JSONL line into every project on every tool call.
- **`update`** — its entire content was two slash commands; they live in the README now.
- The generic bulk of **`a11y`**, **`seo`**, **`perf`**, and **`standards`**. What remains is the part a general-purpose model cannot know: this project's Core Web Vitals and bundle budgets, its design-token rules, its query-key shape, its report formats, and its anti-pattern list. `standards` matters most here — it auto-loads on every code file, so its length was a per-session context tax.

### Changed — `review`, `security`, and `fix` delegate

Each now runs the matching built-in command first and adds only the project-specific delta:

| Skill | Delegates to | Adds |
|---|---|---|
| `review` | `/code-review` | prd.json story alignment, design tokens, UI-state completeness, whether verification actually ran |
| `security` | `/security-review` | secrets in Supabase migrations, RLS policy quality (not just the enabled flag), cloud key hygiene |
| `fix` | `/debug` | how this project reproduces a bug, and what counts as verified |

`security` also stops "auto-fixing" a leaked credential by deleting the line — the value is already in git history, so it reports and tells the user to rotate.

Net: 7,075 → 5,847 skill lines, 3,131 → 2,450 lines of runtime code, 44 → 41 skills.

### Changed — skills
- **`triggers:` → `when_to_use:`** across all 39 migrated skills. `triggers` was never a Claude Code frontmatter field.
- **`config/rules/*.md` became five auto-loading skills** (`rule-security`, `rule-design-system`, `rule-file-organization`, `rule-windows`, `rule-verification`). `rules/` is not a plugin component type, so those files would never have loaded; as skills with `paths` globs they apply automatically.
- **`update` skill** now hands over `/plugin marketplace update` instead of pulling a git repo and re-running a sync script.

### Changed — repo layout
- `tooling/` holds `validate.js`, the test suites, and `bump.js`, and ships to no one.
- `validate.js` rewritten for the plugin layout: version sync, marketplace/plugin manifests, skill frontmatter (including the unreachable-skill and unquoted-YAML traps), hook wiring, and `${CLAUDE_PLUGIN_ROOT}` path resolution.
- `bump.sh` → `tooling/bump.js`: one writer for `VERSION`, `package.json`, `marketplace.json`, and all three `plugin.json` files, replacing nine sed targets across two platform branches.
- CI runs on Linux, Windows, and macOS, and syntax-checks every hook.

## [7.6] - 2026-08-12

### Added — CI
- **`scripts/test-all.js`** — new zero-dependency `npm test` runner. Discovers every `scripts/test-*.js` suite, runs each in its own child process, then runs `validate.js` as a final consistency gate; prints a `SUITE pass/fail` summary and exits non-zero if any suite or validate fails. Wired as the `test` script in `package.json`.
- **`.github/workflows/ci.yml`** — new GitHub Actions workflow. Runs `npm test` on `ubuntu-latest` with Node 22 (where `node:sqlite` is available so the DB-backed suites run, not skip) on every push and pull request. Least-privilege `contents: read` permissions.

### Added — semantic search fallback (roadmap §3.1, "lighter weight, no daemon" path)
- **`scripts/semantic-search.js`** — new pure-JS, zero-dependency, offline, deterministic ranker. This is **lexical-semantic** (TF-IDF token cosine similarity + conservative stemming + a small dev-domain synonym expansion), **not** neural embeddings — no ChromaDB, no external API, no network. Exports `{ tokenize, stem, expandQuery, rank }`.
- **`scripts/memory-db.js`** — two new API functions. `searchSemantic(query, projectPath, limit)` ranks recent project observations (last 500) via the ranker. `searchSmart(query, projectPath, limit)` runs FTS5 first and, only when it returns fewer than 3 results, merges in semantic results (dedup by id, FTS first). The ranker is required lazily inside a try/catch so a load failure degrades gracefully like FTS does.
- **CLI** — new `semantic` command; the existing `search` command now calls `searchSmart` (output formatting unchanged). `skills/mem-search/SKILL.md` documents the auto-fallback and adds a `mem why` trigger (synced to `skills/manifest.json`).

### Added — knowledge-agent (roadmap §3.2, "domain brains" — dependency-free path)
- **`skills/knowledge-agent/SKILL.md`** — new user-invocable skill. Distills the accumulated memory for a code **area** (a path prefix / directory / fragment such as `src/auth`) into a focused Markdown brief: observations touching that area are grouped into decisions, bug fixes, gotchas & discoveries, and changes & features, then deduped by title. Triggers: `knowledge`, `what do we know about`, `brief me on`, `domain knowledge`. Registered in `skills/manifest.json` and `skills/commands.md`.
- **`scripts/memory-db.js`** — new `knowledge(projectPath, area, limit)` API plus a `renderKnowledgeBrief(result, area)` renderer, and a `knowledge <area>` CLI command (`node scripts/memory-db.js knowledge "$(pwd)" "src/auth"`). This **queries the existing memory store** — no new database, no parallel knowledge files, no external API — and is bounded to the recent-500-observation window like semantic search. An area with nothing recorded renders "no accumulated knowledge yet" rather than erroring; a missing DB returns null and the CLI degrades gracefully.
- **Auto-injection of area briefs** (roadmap's "auto-injected when Claude touches auth files") now ships in the existing `hooks/post-tool-typecheck.js` PostToolUse (Write|Edit) hook — no new hook file and no change to the settings files. On the **first** edit of an area in a session, the hook derives the area from the edited file's directory (first 1-2 path segments, e.g. `src/auth`), calls `knowledge()`, and, when `total > 0`, prints a compact `[Memory] Domain knowledge for <area> (<n> notes):` header plus the top ~3 items (decisions → gotchas → bugfixes → changes, each truncated to ~100 chars) to stderr. It is **throttled to once per (session, area)** via a git-ignored `.claude/knowledge-surfaced` state file that is checked first, so at most one brief is computed per distinct area per session; the injection runs in its own try/catch after capture and can never disturb typecheck or capture.
- Area matching is **path-boundary aware** (`src/auth` matches `src/auth/login.js` but not `src/authentication/…`, and `auth` matches a whole path segment / whole word but not `author`), and dedup is **type-aware** — the key is `(type, title)` so a decision and a bugfix sharing a title are no longer collapsed into one.

### Tested
- **`scripts/test-knowledge.js`** — new suite. DB-backed cases (skipped cleanly on Node without `node:sqlite`): a brief renders grouped observations for a matching area; path filtering restricts to the area (an observation in a different area does **not** appear); an empty area yields a graceful "no accumulated knowledge yet" brief instead of crashing.
- **`scripts/test-knowledge-injection.js`** — new suite. Drives `hooks/post-tool-typecheck.js` as a subprocess against a temp `HOME` + temp project (skipped cleanly without `node:sqlite`): seeding observations for `src/auth` and editing a `src/auth/*` file emits the `[Memory] Domain knowledge for src/auth` line on stderr; a second edit in the same area/session does **not** re-emit (throttle); editing a file in an area with no knowledge emits nothing and does not crash.

### Added — smart-explore (roadmap §3.3, "structural code exploration" — dependency-free path)
- **`scripts/smart-explore.js`** — new pure-JS, zero-dependency, offline structural code outliner. Emits a **compact structural outline** (imports/requires, top-level function signatures with params + line numbers, arrow-function consts, class names + their methods, `interface`/`type` names, `export`/`module.exports` names, notable top-level consts) instead of full file contents — ~95% smaller than raw source on this repo. This is **honest heuristic/regex line-based extraction, NOT a real AST**: robust for JS/TS/JSX/TSX, decent for Python (indentation-based top-level detection), and a generic keyword scan for other languages that honestly reports `[no structure detected]` rather than fabricating symbols. It never throws on malformed input, and guards against binary (NUL-byte) and huge (>1MB) files. A true **Tree-sitter AST** (24+ languages, higher fidelity) remains an optional future upgrade. Exports `{ extractSymbols, summarizeFile, summarizeDir }`.
- **CLI** — `node scripts/smart-explore.js <path> [--json]`: a file prints its outline; a directory (walked recursively, skipping `node_modules`/`.git`/`dist`/`build`/`.next`/`coverage`/dotdirs, bounded to ~500 files) prints a per-file outline plus a final `Outline: X chars vs Y source chars (~Z% smaller)` line. `--json` prints the structured object.
- **`skills/smart-explore/SKILL.md`** — new user-invocable skill (triggers `smart explore`, `explore code`, `outline`, `map the codebase`, `code outline`) that shells to the CLI and documents the heuristic's limitations (multi-line signatures, dynamic exports, unusual syntax). Registered in `skills/manifest.json` (now 39 active skills) and `skills/commands.md`.

### Tested
- **`scripts/test-smart-explore.js`** — new suite (37 cases, no DB). Asserts specific symbol names/params for JS (function/arrow/class+methods/exports), TS (interface/type/typed function/class methods), and Python (top-level `def`/`class`/`import`, with a nested def **not** mislabeled top-level); a realistic multi-function file's outline is a meaningful fraction of source size; and robustness — unknown extension → generic, no-structure → `unstructured`, empty string → no crash, malformed input never throws, and a NUL-byte file is marked binary.

### Security — privacy hardening
- **`scripts/memory-db.js`** — `saveObservation` now redacts every user-controlled field before persisting: `raw_data` and `source_files` are run through `stripPrivate` after `JSON.stringify`, and the dedup `content_hash` is computed over the already-redacted `title`/`concept` so no hash of secret content is stored. Together with the previously redacted `title`, `concept`, and session summary fields, this closes every path by which `<private>…</private>` content could reach the DB. (`source_files` and the `content_hash` were the two fields not covered by the initial `raw_data`-only fix; both are now redacted.)

### Tested
- **`scripts/test-semantic-search.js`** — new suite. Pure-ranker tests (always run, no DB): conceptual ranking, stemming, synonym bridging, empty-input handling. DB tests (skipped cleanly on older Node without `node:sqlite`): `<private>` redaction across title/concept/raw_data, and `searchSmart` surfacing a paraphrased match that exact FTS would miss.

### Fixed — smart-explore extraction & auto-injection hardening
- **`scripts/smart-explore.js`** — an adversarial review found real extraction bugs, now fixed (regex-scoped): Python `async def` (top-level **and** methods) is captured; TS/JS generic functions `foo<T>(x)` (and the `const f = <T>(x) =>` arrow form) are no longer dropped; `export default function X`/`class Y` no longer emit a phantom export literally named `"function"`/`"class"` while the real symbol is still captured; `#private()` methods and TS `enum` declarations are captured; TS constructor-parameter modifiers (`public`/`private`/`protected`/`readonly`) are stripped so a param reads `http` not `private http`; and `savedPct` is clamped at 0 so tiny inputs never print a negative "% smaller". Comments/strings are still not parsed as symbols and the binary/huge/malformed guards are unchanged. New regression cases added to `scripts/test-smart-explore.js` (now 53 cases).
- **`hooks/post-tool-typecheck.js`** — the knowledge auto-injection throttle file (`.claude/knowledge-surfaced`) is now rewritten to keep only the **current session's** markers before appending, so it stays bounded to the session's areas instead of growing unbounded across sessions (matching its documented "session-specific" intent). A **transient** DB failure (`knowledge()` returns `null`) is no longer recorded as surfaced, so the next edit retries; a real empty result (`total === 0`) is still recorded to avoid recompute. Monorepo over-broadening at the 2-segment area granularity is now documented in code and in `skills/knowledge-agent/SKILL.md`. A capture-active injection case was added to `scripts/test-knowledge-injection.js`.

## [7.5] - 2026-04-22

### Added — telemetry (audit finding 3.2)
- **`hooks/telemetry.js`** — new PostToolUse hook. On every tool call, appends one JSONL line to `.claude/reports/telemetry-YYYY-MM-DD.jsonl`. Logs metadata only (tool name, input/output sizes, cwd, session, timestamp, success heuristic) — never tool input/output **contents**. Privacy-safe by design. Exit 0 always; 500ms timeout cap.
- **`skills/telemetry/`** — read-side skill. Commands: `telemetry`, `usage stats`, `tool stats`, `token stats`. Reports top tools by event count + total bytes, per-day activity, week view. Runs on Haiku.
- **Optional OTLP export** — set `CLAUDE_OTEL_ENDPOINT` env var to also POST each event to an OTLP JSON endpoint (Honeycomb, local collector, Jaeger). Fire-and-forget, 500ms HTTP timeout, won't slow sessions if endpoint is down.
- **Opt-out** — set `CLAUDE_TELEMETRY_DISABLED=1` or remove the hook from settings.
- **`scripts/test-telemetry-hook.js`** — 15-case suite: field coverage, privacy (no secret leakage), error detection, opt-out, malformed stdin resilience, unreachable-endpoint resilience, speed (<500ms). 15/15 pass. Local run: 39ms end-to-end.

### Registered
- Added a second `PostToolUse` entry with matcher `.*` in both `settings.json` and `settings-unix.json` so telemetry fires on every tool call (existing `Write|Edit` typecheck entry unchanged).

### Context
Closes audit finding 3.2 ("No OTEL / telemetry — industry standard in 2026"). The design choice: local JSONL by default so there's zero-config visibility on day one, with OTLP forwarding available to anyone who wants to wire a collector later. Honeycomb and Jaeger both accept OTLP JSON directly; no vendor lock-in.

## [7.4] - 2026-04-22

### Changed — Progressive disclosure on three more skills
Continuing v7.3's Anthropic-idiomatic split pattern. Three more heavy skills now load long reference sections on demand instead of inlining everything.

- **`audit/SKILL.md`** — 398 → 280 lines (~4765 → 3675 tokens, 23% reduction).
  - New `references/known-safe-patterns.md` — false-positive list (shadcn nesting, React 19 server actions, Supabase RLS, etc.) that every audit agent prompt needs
  - New `references/persist-findings.md` — the 8-step prd.json persistence flow (read, dedupe, batch, add, session tasks, report, score tracking, npm audit)
  - Dropped the one remaining `MUST` in the body

- **`setup-project/SKILL.md`** — 417 → 217 lines (~2948 → 1806 tokens, 39% reduction — biggest win).
  - New `references/monorepo-scaffold.md` — full directory layout + pnpm-workspace.yaml + root package.json + shared-package template
  - New `references/tooling-config.md` — TypeScript strict flags, Biome config, shadcn init, .gitattributes, .gitignore, .npmrc ready-to-paste templates
  - New `references/version-defaults.md` — the April 2026 pinned version table

- **`doppler/SKILL.md`** — 255 → 218 lines (~2353 → 2074 tokens, 12% reduction).
  - New `references/extract-to-hub.md` — shared-key and Supabase extraction command sequences with safety rules (the migration steps are rare but dense)

### Not done
- Consolidation of `clean` / `status` / `archive-prd` — `clean` (68 lines) and `status` (42) are already lean; `archive-prd` (141) has a clear user-facing responsibility called from auto. Consolidation would break muscle memory without meaningful token savings.
- OTEL telemetry exporter — needs a design decision on destination (local collector vs Honeycomb free tier vs Jaeger). Deferred.

### Aggregate impact
Running `auto` with `audit` and `setup-project` triggered (common combo) saves ~2,500 tokens per session vs v7.2. Over a typical multi-session day, meaningful.

## [7.3] - 2026-04-22

### Added
- **`scripts/test-pre-tool-filter.js`** — 33-case test suite for the PreToolUse hook. Caught a real bug on first run: `rm -rf ~/` (home-dir wipe) was not being blocked. Now blocked.
- **Auto-lint loop in `post-tool-typecheck.js`** (Aider-style) — after typecheck, runs the project's linter (Biome > ESLint, via package.json `lint` script or `biome check .` / `eslint .` fallback). Lint failures get printed to stderr (first 30 lines, truncation notice) so Claude can self-fix in the next turn. Skipped silently if no linter is configured.

### Changed
- **`auto/SKILL.md`** — split into `references/generation-constraints.md` + `references/verify-tags.md` (Anthropic-idiomatic progressive disclosure). Main body dropped from 590 lines / ~7k tokens to 501 lines / ~6k tokens. Also dropped all 12 `MUST` / `NEVER` ALL-CAPS directives — rewritten as reasoned prose explaining the failure mode each rule prevents. Follows Anthropic's [skill-creator guidance](https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md): "yellow flag — if possible, reframe and explain the reasoning."
- **Haiku tier for mechanical skills** — `status`, `archive-prd`, `clean`, `update`, `env-vars` moved from Opus to Haiku. ~12× cheaper per token on operations that don't require reasoning.

### Fixed
- **`hooks/session-start.js`** — added `process.exit(0)` at end so the hook can't exit non-zero if an unhandled error slips past the try/catch. Every other hook had this; session-start was the one gap.
- **`hooks/pre-tool-filter.js`** — `rm -rf ~` and `rm -rf ~/` are now blocked. Tests caught the gap on first run.

### Removed
- **Deprecated skill dirs deleted:** `skills/verify/`, `skills/checkpoint/`, `skills/browser-auth/`. Manifest entries in `deprecated` retained so rename history stays discoverable.

### Context
Post-audit pass (see `.claude/reports/AUDIT-2026-04-22.md`). Findings were cross-referenced against Anthropic's official Agent Skills spec ([agentskills.io](https://agentskills.io)) and 10 popular 2026 Claude Code frameworks.

## [7.2] - 2026-04-22

### Added
- **`doppler` skill** — Hub/spoke secret management via Doppler. Handles install detection (`winget install doppler.doppler` on Windows, brew on macOS, curl on Linux), login guidance (`doppler login`), per-project linking via `doppler.yaml`, command wrapping (`doppler run -- npm run dev`), and shared-key extraction to hub projects with cross-project `${ref://hub.config.KEY}` references. Fits the Developer plan's 10-project cap by consolidating supabase accounts into branch configs. Rotate once in a hub, all spokes pick up the new value.
- **`memory-backup` skill** — Private GitHub repo mirroring `~/.claude/projects/*/memory/`. One-command setup creates `<your-username>/claude-memory` (private), on-demand `memory backup now`, Windows Task Scheduler recipe for daily auto-commits, one-command `memory restore` after Windows reinstall. Explicitly excludes `sessions/`, `tasks/`, and other ephemeral state.

### Changed
- **`env-vars` skill** — Doppler is now the recommended pattern. Skill defers to the `doppler` skill when `doppler.yaml` is present, otherwise falls back to `.env.local` flow. Added "Migrate to Doppler" option.
- **`auto` Context Loading** — Step 6 added: detect `doppler.yaml` and prepend `doppler run --` to dev/build/test commands automatically. Installs CLI if missing, guides login if not authenticated.
- **`setup-project` onboarding** — Gap check now suggests Doppler migration when `.env.local` has 3+ vars and no `doppler.yaml` exists yet.

### Notes
- Doppler Developer plan is free; cross-project secret references work on it (confirmed 2026-04-22)
- Project cap is 10 on free tier — skill enforces this check before creating new projects
- `doppler login` is a browser OAuth flow; Claude cannot run it autonomously — always guide user

## [7.1] - 2026-04-09

### Added
- **Collision-safe install** — `scripts/sync.js` enumerates shipped items and refuses to overwrite user-owned files/dirs with the same name unless they're byte-identical. Use `--force` to back up collisions to `.user-backup-<timestamp>/` and install on top.
- **Install sidecar** — `~/.claude/.auto-dev-installed.json` records exactly what this install put on disk, enabling symmetric uninstall. Legacy installs without a sidecar are auto-detected via `skills/manifest.json`.
- **Surgical uninstall** — `scripts/uninstall.js` + `uninstall.sh` / `uninstall.ps1` remove only items the install created. User skills, hooks, agents, and user-modified rules are preserved. Strips auto-dev hook entries from `settings.json` without touching other entries. Supports `--dry-run`.
- **Image auto-scan hook** — `hooks/user-prompt-image-scan.js` (UserPromptSubmit). When you attach an image, Claude surfaces every distinct issue it sees, not just what you asked about. Tail-reads transcript JSONL (~35 ms flat regardless of size). Auto mode logs findings to `.claude/reports/image-scan-*.md` instead of acting. Skip with `[focus]` marker in your prompt.
- **`auto-exit` flag** — Writing `.claude/auto-exit` unconditionally releases the Stop hook on the next cycle. Gives the auto skill a clean exit path without fighting the idle detector.

### Fixed
- **Auto-active flag path divergence** — Stop hook was reading `$HOME/.claude/auto-active` while the auto skill and writers used `<project>/.claude/auto-active`. All three flags (`auto-active`, `auto-exit`, `auto-idle-triggered`) are now project-relative under `process.cwd()/.claude/`.
- **Install was silently destructive** — Previous install wiped `~/.claude/skills/` and `~/.claude/hooks/` on every run, destroying any user-added content. Fixed at the root: install now tracks what it owns and leaves everything else alone.
- **README uninstall instructions** — Old `rm -rf ~/.claude/skills ~/.claude/hooks` would have blown away unrelated user work. Replaced with the scripted uninstall flow.
- **README staleness** — Removed obsolete `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` reference (replaced by `teammateMode: "auto"` in v6.9).

### Removed
- **Symlink install mode** — Fundamentally incompatible with user-owned skills (users couldn't add their own). `--copy` / `-Copy` flags kept as silent no-ops for back-compat.

## [7.0] - 2026-04-05

### Added
- **Generation constraints in auto** — Security, a11y, design anti-slop rules applied at code-generation time, not just post-hoc audit
- **Self-critique step** — 8-question checklist auto runs after writing code, before typecheck
- **Hardening check** — 12-pattern per-task diff scan (fail-open auth, unsafe casts, fire-and-forget fetch, missing labels, stock UI, dark mode, chart colors)
- **Per-story verify tags** — `"verify": ["visual", "a11y", "design", "security", "auth", "test", "api"]` in prd.json stories for targeted checks
- **Design token compliance check** — Auto verifies UI output uses project tokens, not stock shadcn defaults
- **Test generation table** — Auto writes tests for API routes, auth, hooks, data mutations, RLS policies
- **Risk-shaped testing** — Test effort matches risk (100% auth/billing, 70% hooks, optional for static pages)
- **Coverage thresholds** — 70% lines, 60% branches, 100% auth/billing paths
- **Deferred task distinction** — `passes: "needs-setup"` + `blockedReason` separates infrastructure blockers from skipped tasks
- **Security checks 6-11** — SSRF prevention, fail-open auth, HTTP headers, open redirect, rate limiting, npm audit
- **Score tracking** — Audit logs scores to sprint-history.md with delta from previous audit
- **Migration safety** — Deploy checks for destructive SQL operations, nullable defaults rule
- **Simplify suggestion** — Auto recommends simplify after 5+ task sprints

### Changed
- **audiq MCP removed from all skills** — Replaced with agent-browser (preferred) and Playwright (fallback) across ship, commit, design, brainstorm
- **Ship: blocking quality gates** — npm audit critical/high now blocks deploy alongside typecheck/build/tests
- **Ship: expanded security checklist** — 11 items including fail-closed auth, SSRF, middleware coverage, HTTP headers, rate limiting
- **Review: tests run in default mode** — Not just deep mode; also adds npm audit, breaking change detection, hardening scan
- **Audit: reduced noise** — A11y agent skips transition-all (perf not a11y), type agent skips console.error and test files
- **Audit: expanded security agent** — RLS policy logic, fail-open auth, SSRF, middleware gaps, unsafe casts, fire-and-forget fetch
- **Fix: regression tests mandatory** — For auth/billing/RLS paths after fix; escalation after 3 failures
- **Commit: story ID in messages** — `feat(S13-001): description` format; tests added to safety checklist
- **Standards: anti-patterns reorganized** — Split into accessibility, design system, security/data safety categories
- **Standards: fail-closed patterns** — Auth deny-by-default, fetch error handling, Zod validation for external data
- **Supabase: RLS runtime verification** — REST API test after migrations to verify policies actually restrict access
- **Supabase: migration rollback pattern** — Nullable defaults, separate drop migrations
- **Design: quality gate expanded** — Dark mode, a11y focus rings, reduced motion, form UX checks
- **Workflow rules: cross-cutting verification** — 6 patterns applied to all task types regardless of category
- **Auto: exactOptionalPropertyTypes** — Generates `foo?: string | undefined` on first pass in strict projects

## [6.9.1] - 2026-04-05

### Fixed
- **Auto skill: use Write tool for auto-active flag** — Bash echo to `.claude/auto-active` triggered sensitive file permission prompt every time. Now uses Write tool which is already in the allowlist.

## [6.9] - 2026-04-05

### Added
- **scripts/sync.js** — Single source of truth for syncing repo files to ~/.claude. Handles symlink/copy, settings merge, rules, agents, deprecated cleanup, and validation in one cross-platform Node.js script.

### Changed
- **install.sh / install.ps1** — Sync logic delegated to sync.js, removing ~90 lines of duplicated copy/symlink code
- **scripts/update.sh** — Reduced from 114 lines to 12, delegates to sync.js
- **Embedded update-dev functions** — Both bash and PowerShell versions now call sync.js instead of manual copy blocks
- **Brainstorm dedup threshold** — Fixed drift: standardized to 25-char match (was 20 in brainstorm, 25 in audit)
- **Settings: removed CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS** — Redundant since teammateMode: "auto" is set

### Removed
- **5 dead files** — templates/progress.txt, templates/settings.local.json, templates/env.local.template, templates/task-patterns.json, skills/prd-schema.json
- **Dead chmod in install.sh** — Was targeting *.sh hooks but all hooks are .js

## [6.8] - 2026-04-04

### Added
- **setup-project: greenfield mode** — Full scaffolding from description to working build. Monorepo support (pnpm workspaces), package manager detection, Biome over ESLint, shadcn v4, TS strict defaults, .gitattributes, version table with risk notes
- **setup-project: onboard mode** — Gap detection (.gitattributes missing, TS strictness, missing .env.example)
- **Audit size gate** — Scales agent count by codebase size: 1 agent (<50 files), 3 agents (50-200), full 7-swarm (200+)

### Changed
- **Typecheck hook detects package manager** — Reads lockfile (pnpm-lock.yaml/yarn.lock/bun.lockb) instead of hardcoding `npm run typecheck`
- **Commit: solo projects stay on main** — Checks contributor count + remote before forcing feature branches. Solo devs commit to main.
- **Auto: /compact threshold raised** — "Do NOT suggest unless >70%" (was "after 10+ tasks"). 1M context makes premature compaction wasteful.
- **setup-project triggers narrowed** — `"setup"` → `"setup project"` to avoid false matches on "set up the database"

### Fixed
- **bash -c filter narrowed** — Only blocks at command position or after chain operators, not inside quoted arguments (e.g., `docker exec` wrapping)

## [6.7.3] - 2026-03-31

### Changed
- **Windows: Supabase CLI rule** — `supabase db query --linked` blocked (triggers firewall, times out). Use REST API with curl instead.

## [6.7.2] - 2026-03-30

### Changed
- **Auto: removed unused sections** — Worktree parallel execution (never used), decisions.md logging (nobody reads it), mistakes.md reference
- **Auto: tool-aware verification** — Audiq/agent-browser instructions now check if MCP is connected before suggesting visual scans. Falls back gracefully to WebFetch or skipping with a note.

## [6.7.1] - 2026-03-30

### Fixed
- **npx regex false positive** — Anchored pattern to command position (like `node -e` fix from v6.6.3). No longer triggers inside quoted strings like `git commit -m "...npx..."`
- **config/rules/ out of sync** — Updated repo config templates (security, design-system, file-organization, workflow) so `update dev` preserves v6.7.0 rule changes instead of overwriting them
- **config/CLAUDE.md template** — Added `@rules/workflow.md` to includes

## [6.7.0] - 2026-03-30

### Added
- **Auto integration test gate** — API/edge function tasks require real request verification (curl + response shape check) before marking done
- **Auto sprint transitions** — Automatically archives completed stories, carries forward deferred, bumps sprint number, logs to `.claude/sprint-history.md`
- **Auto deploy phase** — Detects changed `supabase/functions/` files after commit and auto-deploys edge functions
- **Sweeping change verification** — Self-review step 4b: grep for old patterns after bulk find-and-replace to confirm full elimination
- **`rules/workflow.md`** — New global rule documenting audit/brainstorm scope split and verification requirements by task type

### Changed
- **Audit = bugs/fixes** — Absorbs quality scans (console.log, empty catch blocks) from brainstorm. Type Safety agent expanded to include code quality.
- **Brainstorm = features/architecture** — Removed quality scans. Now runs 3 agents (dead code, complexity, unused deps) instead of 5. Competitor research is optional.
- **Agent tool call cap** — All scan agents capped at ~80 tool calls to prevent rate limits
- **Pre-flight simplified** — Replaced `node -e` one-liners with simpler checks that don't trigger security filter on Windows
- **Size-gate** — Removed Plan Mode suggestion (dead path). Large tasks get inline 3-sentence plan instead.
- **Commands.md** — Reorganized into Primary / On-Demand / Specialized tiers
- **Manifest descriptions** — Synced audit and brainstorm descriptions to reflect scope boundary
- **Design system** — Added gradient/themed surface exception for hardcoded colors
- **Security rules** — Added edge function testing and bulk change verification
- **npx allowlist** — Added `tsx`, `shadcn`, `shadcn-ui`, `create-next-app`, `prisma`
- **File organization** — Replaced unused `decisions.md`/`mistakes.md` with `sprint-history.md`

## [6.6.4] - 2026-03-22

### Fixed
- **npx allowlist expanded** — Added `npm-check-updates`, `axe-core-cli`, `@next/bundle-analyzer`, `lighthouse`, `netlify`, `remotion` to pre-tool filter. These were referenced in skills but would be blocked at runtime.

## [6.6.3] - 2026-03-22

### Fixed
- **pre-tool-filter: node -e false positive** — pattern now only matches at command start, not inside grep/echo arguments. Fixes the filter blocking searches for "node -e" strings.
- **Contradictions resolved across skills:**
  - commit: "never git add -A" softened to "prefer targeted adds" (batch mode with exclusions is acceptable)
  - core: "don't read full prd.json" updated for 1M context (fine for <50 stories)
  - review: "go beyond acceptance criteria" → "flag opportunities but don't implement during review"

## [6.6.2] - 2026-03-22

### Added
- **`brainstorm quick`** — Diff-based scan that only checks files changed since last brainstorm (~10s vs ~3min). Skips full agent scan for recently-cleaned codebases.
- **Size-gating for stories** — Tasks touching 5+ files or needing UI design flagged as `size: "large"` with Plan Mode suggestion instead of auto-executing
- **Progress output** — Auto mode now outputs `[3/8] ✓ S6-003 | Next: S6-004` between tasks for visibility
- **Resource validation** — Self-review step 3 validates external URLs (images, fonts, API endpoints) with curl before committing
- **Worktree cleanup** — Auto pre-flight now runs `git worktree prune` to clean orphaned worktrees from previous sessions

## [6.6.1] - 2026-03-21

### Security
- **pre-tool-filter: outer catch now fail-closed** — exit 2 instead of exit 0 on unexpected errors
- **pre-tool-filter: block `node -e`/`node --eval`/`node -p`** — closes the `Bash(node *)` bypass vector
- **pre-tool-filter: block `npx` except allowlisted tools** (tsc, supabase, vercel, next, vite, vitest, jest, playwright, eslint, prettier)
- **pre-tool-filter: tightened `bash -c` regex** — `\s*` instead of `\s+` catches `bash -c"cmd"` without space
- **pre-tool-filter: tightened `eval` regex** — `[\s"']` catches `eval"cmd"`, avoids false positives on `evaluate`
- **pre-tool-filter: block `cp`/`mv` targeting `.claude/hooks/` and `.claude/settings`**
- **session-start: expanded PROTECTED_VARS** — added LD_PRELOAD, LD_LIBRARY_PATH, DYLD_INSERT_LIBRARIES, BASH_ENV, ENV, PROMPT_COMMAND, CDPATH, NODE_EXTRA_CA_CERTS, GH_TOKEN, VERCEL_TOKEN, SUPABASE_ACCESS_TOKEN

### Fixed
- **pr-review: stale `browser-auth` reference** → changed to `agent-browser`
- **update skill: ALL-CAPS "NOT" and "SINGLE"** → lowercased per tone moderation
- **commands.md: version and migrate entry** — bump.sh handles version; migrate row was missing

## [6.6] - 2026-03-20

### Added
- **Migrate skill** — Dependency updates, major version upgrades, and breaking change resolution. Safety tiers (patch→minor→major), one-at-a-time major updates with changelog checks, security audit integration.
- **PreCompact promoted to .js file** — `hooks/pre-compact.js` with error reporting, replacing inline `node -e` one-liner

### Changed
- **Merged browser-auth into agent-browser** — Auth token injection, security rules, and test patterns now in one skill. browser-auth is deprecated. Saves 229 lines from 4 requires chains (auto, test, audit, ship).
- **Requires chains updated** — auto, test, audit now require `agent-browser` directly instead of `browser-auth`

## [6.5.2] - 2026-03-20

### Security
- **pre-tool-filter: fail-closed on parse error** — was exit 0 (allow), now exit 2 (block). Malformed input can no longer bypass security checks.
- **pre-tool-filter: block `bash -c`, `sh -c`, `eval`** — prevents shell escape wrappers that bypass regex patterns
- **session-start: expanded PROTECTED_VARS** — now blocks NODE_ENV, CI, HTTP_PROXY, HTTPS_PROXY, NODE_TLS_REJECT_UNAUTHORIZED, ANTHROPIC_API_KEY, GITHUB_TOKEN, GITHUB_PAT from .env.local override
- **bump.sh: env vars instead of shell interpolation** — version strings passed via `process.env` instead of string interpolation in `node -e`

### Fixed
- **post-tool-typecheck: 10-second debounce** — skips typecheck if last run was <10s ago, preventing dozens of redundant 30s runs during rapid edits
- **session-start: strip trailing \r from .env.local values** — CRLF files on Windows no longer leave carriage returns in env values
- **clean skill: added .typecheck-stamp** to cleanup targets

## [6.5.1] - 2026-03-20

### Fixed
- **allowed-tools mismatches** — 5 skills (auto, brainstorm, ship, commit, design) referenced audiq MCP tools they couldn't call. Added the specific tools each skill needs.
- **auto: added Agent + SendMessage** to allowed-tools — parallel worktree execution was dead code
- **auto: removed ghost `simplify` references** — replaced with `refactor` (actual skill)
- **auto: consolidated duplicate audiq verification blocks** — single reference instead of repeated code
- **auto: fixed `date -I` (GNU-only)** — replaced with portable `date +%Y-%m-%dT%H:%M:%S`
- **auto: quoted glob in find command** — prevents shell expansion of `*/node_modules/*`
- **iterate: trimmed 12 unused audiq tools** from allowed-tools — sub-skills handle audiq calls
- **audit: removed unused TaskUpdate, TaskList** from allowed-tools
- **ALL-CAPS cleanup** — lowercased NOT, BOLD, UNFORGETTABLE across auto, ship, design skills
- **Stale skill counts** — README and commands.md now say "35 skills (33 active + 2 deprecated)"

## [6.5] - 2026-03-20

### Added
- **Smart pre-flight** — Auto `npm install` when package.json is newer than node_modules, detect test runner (vitest/jest/playwright) instead of hardcoding `npm test`, detect monorepo structure, auto-create feature branch if on main
- **Error pattern recognition** — Tracks recurring errors across tasks; after 3+ occurrences, saves fix recipe to auto-memory for instant resolution. Includes common pattern→fix table.
- **Post-commit quick scan** — After every commit, runs build check + console error scan (~5s) to catch regressions immediately
- **PR description from prd.json** — Auto-generates PR body from completed stories with titles, resolutions, and test plan
- **Auto feature branch** — Commit skill auto-creates feature branch when on main/master instead of committing directly
- **Screenshot baseline** — First scan saves as `baseline-YYYY-MM-DD.json` (never overwritten); all future `scan compare` diffs against it
- **CLAUDE.md from real data** — setup-project reads actual package.json scripts, detects dev port, maps src/ structure, finds env vars — no guessing
- **Expanded project knowledge saving** — Auto skill saves environment quirks, build gotchas, test setup, deploy requirements, and error patterns to auto-memory

## [6.4.1] - 2026-03-20

### Added
- **README Tips & Tricks** — Comprehensive guide covering /btw side questions, parallel work patterns, convergence loop, visual verification, agent teams, context management, design anti-slop, and quick fix workflow
- Updated commands table with scan/qa, iterate, design skills
- Fixed stale "30 skills" references to "33 skills"

## [6.4] - 2026-03-19

### Added
- **Iterate skill** — Convergence loop that chains brainstorm→apply→auto in one command. Runs until codebase is clean (typically 3-4 rounds). Supports focus modes (`iterate auth`, `iterate design`) and configurable round limits. Safety check: stops if a round finds more issues than previous.
- Triggers: `iterate`, `deep work`, `converge`

## [6.3.2] - 2026-03-19

### Changed
- **Brainstorm product thinking** — Feature ideation now requires product identity analysis, competitor research with differentiation focus, and rejects generic SaaS playbook suggestions
- **Auto visual enforcement** — UI tasks cannot be marked complete without visual verification (audiq screenshots). Added explicit step 7 in execution flow and hard gate at step 5.
- **Auto archive check** — Pre-flight now checks prd.json size and auto-archives when >50KB
- **Core archive trigger** — Archive runs automatically (no prompt) when starting new sprint with completed previous sprint

## [6.3.1] - 2026-03-19

### Fixed
- **Audit skill** — Removed /compact prompt gate (unnecessary with 1M context)
- **validate.js** — Fixed version check failing for X.Y.Z semver (was only handling X.Y)

## [6.3] - 2026-03-18

### Added
- **Scan skill** — Live site QA via audiq MCP (17 tools): visual bugs, console errors, a11y, perf, SEO, design quality analysis, baseline comparison, fix plan generation
- **Brainstorm Phase 1 Scan 5** — Live QA scan runs in parallel with code scans; surfaces visual, design, and a11y issues alongside code issues
- **Auto visual verification** — UI/UX tasks verified with audiq screenshots (desktop + mobile) + console error check before marking complete
- **Design AI slop checklist** — 9-point detection checklist (safe font, purple gradient, card grid, etc.) with audiq visual analysis integration
- **Design reference sites** — linear.app, vercel.com, stripe.com, raycast.com, notion.so, cal.com as quality benchmarks

### Changed
- **Auto IDLE detection** — Added "dev server + UI changes" and "scan score <70" as signals to trigger QA scan and fix stories
- **Ship post-deploy** — Now uses audiq MCP for verification (preferred over agent-browser)
- **Deploy skill** — Added Read, Grep, Glob to allowed-tools
- **Token management** — Relaxed for 1M context; removed aggressive /compact suggestions

### Fixed
- **Hook paths** — `%USERPROFILE%` replaced with `$HOME` (Claude Code 2.1.69 runs hooks via Git Bash)
- **Stop hook schema** — `ALLOW`/`REJECT` replaced with `approve`/`block` (new CC schema)
- **Stop hook infinite loop** — Added idle marker to prevent re-blocking after IDLE detection runs
- **Pre-tool filter** — Block `rm --recursive --force` (reversed flag order) and `git restore --staged .`
- **Settings sync** — Both config files now identical (unified on `$HOME`); validate.js does deep equality
- **bump.sh** — X.Y.Z input no longer creates invalid semver X.Y.Z.0
- **Install scripts** — Removed misleading "auto-pull on session start" claim
- **session-start.js** — Fixed quote stripping (matching pairs only), hoisted PROTECTED_VARS outside loop, fixed section numbering
- **brainstorm** — Stronger deduplication against prd.json AND native Tasks
- **browser-auth** — Fixed agent-browser `--task` syntax, added Windows fallback note
- **sprint** — Fixed stale "quality skill" reference
- **seo/supabase** — Resolved "schema" trigger overlap
- **Parallel agents** — Added file ownership rules, worktree commit requirement, overhead guidance (<3 files skip worktree)
- **Auto retry** — Auto-fix trivial errors (missing import, type mismatch) before counting as retry
- **Supabase/design** — Use `${CLAUDE_SKILL_DIR}` for portable reference paths

## [6.2] - 2026-02-09

### Added
- **Stripe skill** — Stripe integration patterns (API keys, webhooks, checkout, subscriptions) based on stripe/ai (MIT)
- **SEO skill** — SEO audit and structured data patterns (meta tags, Open Graph, JSON-LD schema) merged from marketingskills repo (MIT)

### Changed
- **Setup-project rewritten** — smart stack detection from package.json dependencies, project type classification, automatic skill recommendations, environment scaffolding based on detected services

## [6.1] - 2026-02-08

### Fixed
- **disable-model-invocation blocks Skill tool** — removed flag from all 11 user-invocable skills; kept only on passive/deprecated (core, standards, checkpoint, verify)
- **Supabase deploy uses wrong token** — deploy skill now sources project `.env` first; 401 flagged as wrong token, not retried

### Changed
- **Brainstorm rewritten** — architecture-level scans (dead code, unused deps, splittability, client-vs-server fetch) replace linter-level checks (TODOs, any types). Adds competitor web search, user journey walkthrough, validation-before-claiming. "Codebase is clean" is a valid outcome.

## [6.0] - 2026-02-08

### Changed
- **Merged quality + code-quality into standards** — single passive reference skill, not in system prompt listing
- **Merged review + verify into review** — depth levels: `review`, `review quick`, `review deep`
- **Brainstorm reports first** — presents findings table, user decides whether to create stories (`brainstorm apply`)
- **Tone moderation** — replaced ALL-CAPS aggressive language with natural prose (44 instances across 13 files) for Opus 4.6 compatibility
- **"Just do it" mode** — < 5 tasks skip sprint/story overhead entirely
- **Archive threshold** — auto-suggests at 4+ sprints, keeps last 3 active

### Removed
- **Checkpoint skill deprecated** — Claude's built-in memory and `/compact` handle persistence now
- **quality, code-quality directories deleted** — merged into standards
- **verify reduced to redirect** — points to `review deep`

### Improved
- **System prompt listing reduced** — ~25 visible skills down to ~17 via `disable-model-invocation: true` on niche skills
- **Token savings** — ~200 tokens/turn fewer in system prompt, cleaner context

## [5.5] - 2026-02-08

### Fixed
- **prd.json dual-shape support** — all 7 dynamic injections across 5 skills now handle both flat (`p.stories`) and nested (`p.sprints[].stories`) shapes
- **Force-push short flag blocked** — `git push -f` now caught alongside `--force` in settings and pre-tool-filter

### Changed
- **Browser verification upgraded** — auto mode now checks console errors and network requests alongside visual snapshots (mirrors real DevTools workflow)
- **Update skill reminder** — reminds user to restart session for CLAUDE.md changes to take effect

## [5.4] - 2026-02-06

### Added
- **Custom agents** — 4 read-only Opus agents in `agents/` directory
  - `code-reviewer` — Reviews changes, learns project patterns (project memory)
  - `security-scanner` — Vulnerability scanning with cross-project learning (user memory)
  - `architect` — Feature planning, dependency mapping, architecture decisions (project memory)
  - `researcher` — Deep codebase/web research, bug investigation (project memory)
  - All use `permissionMode: plan` (read-only enforcement, no Write/Edit)
  - Synced via install scripts and `update dev` (copy mode, preserves user agents)

### Security
- **Shell injection prevention** — bump.sh validates version format, update.sh passes paths via `process.env` instead of string interpolation
- **Expanded deny rules** — `rm -r`, `git stash drop/clear`, `git branch -D` blocked in settings and pre-tool-filter
- **Env var protection** — session-start blocks overriding `PATH`, `HOME`, `NODE_OPTIONS` from .env.local
- **Fallback validation** — update.sh validates JSON before fallback copy

### Changed
- **All agents now use Opus** — 27 skills on Opus, 5 simple commands on Haiku (update, status, clean, archive, env)
- **Audit compact detection** — skips `/compact` suggestion if user already compacted this session
- **Pre-tool-filter refactored** — patterns moved to module-level constants (compiled once, not per call)
- **Error logging** — all empty catch blocks now log parse errors to stderr

### Fixed
- **README badge** — was stuck on 5.0, now auto-bumped
- **README skill count** — 34 → 32 (actual)
- **README Quick Start** — added PowerShell instructions, example session
- **`git branch -D` pattern** — case-sensitive to not block safe `git branch -d`
- **validate.js** — safe regex match, escaped special chars in trigger matching
- **.gitignore** — added `settings.backup.json`, `.claude/pre-compact-state.json`

## [5.3] - 2026-02-06

### Added
- **Agent Teams** enabled via `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` env var in settings
- **Settings merge** — `update dev` deep-merges permissions (user-added allow/deny rules preserved)
- **Settings backup** — `settings.backup.json` created before every merge
- **Post-install validation** — checks manifest, hooks, settings, commands after sync
- **`.gitattributes`** — CRLF normalization, no more warnings on commit

### Changed
- **Removed prompt-type Stop hook** — only command-type `stop-auto-check.js` remains (saves tokens every session)
- **Audit skill** — launches immediately, tells user to type `/compact` themselves (not invoke as skill)
- **Removed fake token estimates** from audit skill

## [5.2] - 2026-02-06

### Changed
- **Update logic moved to `scripts/update.sh`** — deterministic execution, no model improvisation
- **Deprecated skills list** in manifest.json — stale cleanup only removes known deprecated skills, never user-created ones
- **`${HOME:-$USERPROFILE}` fallback** in update script for Windows compatibility

### Fixed
- **update dev exit code 1** — three root causes fixed:
  - Git Bash `$HOME` paths (`/c/Users/...`) passed to Node.js — fixed with `cygpath -m`
  - `[ "$REPO" = "/tmp/..." ] && rm` returns exit 1 when test is false — removed from SKILL.md
  - Haiku combining bash steps caused variable loss — single Bash call + external script

## [5.1] - 2026-02-06

### Security
- **Remove auto-pull from session-start hook** — updates now manual via `update dev` only
- **Write/Edit protection** for `~/.claude/hooks/` and `settings.json` in pre-tool-filter.js
- **Settings backup** — `update dev` backs up settings.json before overwrite

### Changed
- **Node.js hooks** — all 4 hooks converted from .sh/.ps1 pairs to unified .js files
- **Skill consolidation** (34 -> 32): `react-patterns` into `code-quality`, `preserve-ui` into `design`
- **Preserve-ui extracted** to `design/references/preserve-ui.md` (loaded on demand, saves ~400 tokens)
- **Manifest cleaned** — removed 20 empty `context: []` arrays
- **CLAUDE.md deduplicated** — `~/CLAUDE.md` slimmed from 49 to 6 lines
- **Windows settings** use `%USERPROFILE%` instead of `$HOME` for hook paths

### Fixed
- **Git Bash path translation** in session-start.js (`/c/Users/...` -> `C:/Users/...`)
- **Bash `!` escaping** in update skill stale cleanup (`=== false` instead of `!`)
- **validate.js** updated for .js hooks and CRLF normalization
- **All frontmatter complete** — 0 WARN (was 2)

## [5.0] - 2026-02-05

### Breaking Changes
- **Skill consolidation** (40 -> 34): 6 skills merged into parent skills
  - `supabase-postgres` + `supabase-schema` merged into `supabase`
  - `browser-test` + `auth-token-injection` merged into new `browser-auth`
  - `security-patterns` merged into `security`
  - `self-review` merged into `review`
  - `ci-cd` merged into `deploy`
- **Requires chains updated**: All downstream skills (auto, ship, audit, test, review, pr-review) reference new consolidated names
- **Deleted directories**: supabase-postgres/, supabase-schema/, browser-test/, auth-token-injection/, security-patterns/, self-review/, ci-cd/

### Added
- **Dynamic context injection** (`!`command`` syntax) on 5 skills
  - `auto` - Pre-injects git status and prd.json sprint stats
  - `status` - Pre-injects sprint data (project, done/pending/deferred counts)
  - `commit` - Pre-injects working tree status, diff stats, recent log
  - `audit` - Pre-injects existing task list from prd.json
  - `brainstorm` - Pre-injects existing task list from prd.json
  - Estimated savings: 18-24 tool calls, 23-37K tokens per auto session
- **`argument-hint` frontmatter** on 6 user-facing skills
  - `commit` -> `[type] [message]`
  - `fix` -> `[error or file]`
  - `security` -> `[scope: full|quick|file]`
  - `refactor` -> `[target file or pattern]`
  - `brainstorm` -> `[focus area]`
  - `sprint` -> `[new|advance|close]`
- **Skill-scoped Stop hook** in `auto/SKILL.md` frontmatter (forward-looking: blocked by Claude Code bug #19225)
- **PreCompact hook** in all 3 settings files - preserves prd.json to `.claude/pre-compact-state.json` before context compaction
- **Permission deny rules** in all 3 settings files - blocks `rm -rf /`, `rm -rf ~`, `git push --force origin main/master`, `git reset --hard`
- **New skill**: `browser-auth` (merged browser-test + auth-token-injection)

### Changed
- **Supabase triggers expanded**: now includes `postgres`, `rls` (absorbed from merged skills)
- **Deploy triggers expanded**: now includes `ci`, `deploy` (absorbed from ci-cd)
- **Security priority**: changed to 0 (auto-loaded with review, audit, ship)
- **Sprint skill**: now user-invocable with argument-hint
- **Manifest description**: updated to reflect 34 skills
- All version files bumped to 5.0

Total skills: 34 | Version: 5.0

## [4.9.4] - 2026-02-05

### Fixed
- **CRITICAL: Stop hooks disabled** - Installed settings.json had empty Stop array; auto-mode protection was non-functional
- **CRITICAL: Unwired hooks** - PreToolUse (security filter) and PostToolUse (typecheck) now wired in all settings files
- **Orphaned build/ skill** - Deleted dead directory (not in manifest, unreachable)
- **6 invalid skill names** - Uppercase/spaces fixed to lowercase-hyphens per Anthropic spec (agent-browser, archive-prd, env-vars, fix, ship)
- **Settings divergence** - Installed, repo, and unix configs now aligned (ExecutionPolicy, WindowStyle, hook wiring)
- **README missing commands** - Added sprint and verify to command table (18 commands)
- **Install script fallbacks** - Updated from 4.9.0 to 4.9.4

### Added
- **disable-model-invocation** on 8 side-effect skills (auto, commit, ship, deploy, clean, setup-project, update, archive-prd)
- **PreToolUse hook** - Blocks dangerous commands (rm -rf, DROP TABLE, git push --force) and skips large file reads
- **PostToolUse hook** - Auto-runs typecheck after TS/JS edits
- **.gitignore** - Added node_modules/, .env*, dist/, build/, .next/

### Changed
- **Manifest descriptions** improved with "use when..." context for 7 skills (sprint, fix, self-review, auth-token-injection, clean, verify, security)
- **Skill count** 40 → 39 (build removed)

Total skills: 39 | Version: 4.9.4

## [4.9.3] - 2026-02-05

### Added
- **Commit Skill** - Standardized git commit, push, and PR workflow
  - Conventional commits format (feat|fix|refactor|chore|docs|test|perf)
  - Safety checks: no .env, no console.log, no hardcoded secrets
  - Batch commit pattern for auto mode (every 3 tasks)
  - Full PR flow with gh CLI
  - Triggers: "commit", "push", "pr", "commit-push-pr"
- **Perf Skill** - Web performance audit patterns
  - Core Web Vitals targets (LCP, INP, CLS, FCP, TTFB)
  - Bundle size rules and common fixes (images, code splitting, React.memo, fonts)
  - Supabase query optimization
  - Audit report format
  - Triggers: "perf", "performance", "lighthouse", "bundle size", "core web vitals"
- **A11y Skill** - Accessibility audit (WCAG 2.1 AA)
  - Keyboard navigation, focus management, color contrast
  - Images/media, forms, ARIA, semantic HTML patterns
  - Bad vs good code examples for each pattern
  - Audit report format with scoring
  - Triggers: "a11y", "accessibility", "wcag", "screen reader"
- **Refactor Skill** - Code refactoring patterns
  - Split large file, extract component, extract hook
  - Replace prop drilling, consolidate duplicates
  - Safety checklist (typecheck before/after each step)
  - Triggers: "refactor", "extract", "split", "restructure"

### Changed
- **Requires Chains Updated** - New skills integrated into critical workflows
  - `auto` now requires: commit (for batch commits)
  - `ship` now requires: commit (for clean commits before deploy)
  - `audit` now requires: perf, a11y (comprehensive quality audit)
- **Auto Skill Fixed** - No longer auto-creates new sprints when all tasks done
  - Explicit STOP rule added to IDLE Detection
  - Suggests `brainstorm` or `sprint` for next work

### Fixed
- **Duplicate "pr" trigger** - removed from commit, kept in pr-review
- **Missing YAML frontmatter** - added to auth-token-injection and design skills
- **Trigger mismatches** - synced pr-review and setup-project with manifest
- **Orphaned hooks** - removed unused auto-continue.ps1/.sh
- **Dead build skill** - removed from manifest (directory kept as reference)
- **Missing jq checks** - added to stop-auto-check.sh, pre-tool-filter.sh, post-tool-typecheck.sh
- **Auto skill language** - dialed back aggressive caps/bold for Opus 4.5+ compatibility

**Total skills:** 40 | **Version:** 4.9.3

---

## [4.9.2] - 2026-02-05

### Added
- **Update Skill** - Say "update dev" to sync latest changes
  - Pulls from GitHub
  - Mirrors skills/ and hooks/ to ~/.claude
  - Removes stale files (robocopy /MIR on Windows, rsync --delete on Mac/Linux)
  - Reports version and changes
  - Triggers: "update dev", "update auto-dev", "update skills", "sync skills"

### Changed
- Session-start hook now has 5s timeout (no hang offline)
- Copy mode auto-detects and re-syncs on updates

**Total skills:** 37 | **Version:** 4.9.2

---

## [4.9.0] - 2026-02-05

### Added
- **Zero-Maintenance Updates** - Symlink-based installation
  - Skills/hooks symlinked to repo (changes auto-sync)
  - `update-dev` command added to shell profile
  - `repo-path.txt` stores clone location for portability
  - `--copy` flag for systems where symlinks fail
- **Plan Mode Integration** - brainstorm and audit now suggest plan mode for complex work
  - `brainstorm` suggests plan mode for features spanning 3+ files
  - `audit` suggests plan mode when 5+ critical/high issues found
- **Enhanced Triggers** - More natural language activation
  - `fix` now responds to: "broken", "error"
  - `env-vars` now responds to: "environment", "credentials", "secrets", "api key"
  - `agent-browser` now responds to: "browser", "web test", "ui test"

### Changed
- **Install Scripts Rewritten** - Now use symlinks by default
  - `install.ps1` / `install.sh` create symlinks instead of copying
  - Automatic fallback to copy if symlinks fail (Windows without admin/dev mode)
  - Adds `update-dev` function to PowerShell profile / bashrc / zshrc
- **Complete Synergy Chains** - All critical workflows now fully connected
  - `auto` requires: code-quality, quality, react-patterns, verify, browser-test, security-patterns
  - `ship` requires: review, security-patterns, test
  - `audit` requires: quality, code-quality, design, security-patterns, browser-test
- **Built-in Command Conflicts Resolved**
  - `status` skill trigger changed to "progress" (status is Claude Code built-in)
  - `deploy` marked internal-only (use `ship` for user-facing deploys)
- **Enhanced Clean Skill** - Age-based cleanup
  - Screenshots: all deleted on clean
  - Backups: delete older than 7 days
  - Handoffs: delete older than 7 days
  - Archives: prompt before deleting (30+ days)

### Fixed
- **prd.json Schema** - Corrected skills referencing stories as array (now object)
- **Deprecated MCP Reference** - Removed from settings.local.json template

**Total skills:** 36 | **Requires chains:** 14 | **Version:** 4.9.0

---

## [4.8.0] - 2026-02-05

### Added
- **Security Skill** - Pre-deploy security audit (user-invocable)
  - Secrets scan, env file check, RLS validation, XSS detection
  - Trigger: `security`
  - Auto-runs before ship

### Fixed
- **Version sync** - All version files now 4.8.0 (VERSION, package.json, manifest)
- **status skill** - Now uses TaskList + prd.json (removed project-meta.json reference)
- **prd.json template** - Fixed to match schema (projectName, stories as object)
- **ship skill** - Added security check step before deploy
- **Auto requires** - Added verify to chain (ensures completion quality)
- **Deduplication** - audit/brainstorm now check existing tasks before creating

### Changed
- **Quality skills consolidated** - Clear boundaries, no overlap
  - `quality` = Core principles (judgment, UI states)
  - `code-quality` = Production patterns (learned rules)
- **deploy skill** - Now internal only (use `ship` for deploys)
- **Single-word commands** - All triggers simplified

### Removed
- Unused templates (ab-test, context, learnings, project-meta)
- Plugin files (marketplace not approved yet)
- Redundant QUICKSTART files
- **Stale scripts** - setup-keys.ps1, setup-keys.sh, scripts/, bin/install.js
- **MCP template** - config/mcp.template.json (not using MCPs)

### Changed (Install Scripts)
- **Simplified install.ps1/sh** - From ~200 lines to ~80 lines
- **Removed credential setup** - No longer saves API keys during init
- **README simplified** - From 772 lines to 120 lines (accurate, concise)

**Total skills:** 39 | **Requires chains:** 14

---

## [4.6.3] - 2026-02-05

### Added
- **CI/CD Skill** - GitHub Actions workflows and CI/CD patterns
  - Standard CI workflow template
  - Vercel deploy workflow
  - Supabase Edge Functions deploy
  - Matrix builds for multi-version testing
  - Triggers: `ci`, `github actions`, `workflow`, `pipeline`
- **Monitoring Skill** - Observability patterns for production
  - Structured JSON logging
  - Error boundaries with logging
  - Vercel Analytics integration
  - API route monitoring
  - Health check endpoint
  - Triggers: `monitoring`, `logging`, `observability`, `analytics`
- **New requires chain**: `deploy` → `ci-cd`

### Changed
- **Directory structure normalized** - All skills now use `skill-name/SKILL.md` format
  - Migrated 12 flat files to directory structure
  - Updated manifest.json with new paths
- **supabase-schema split** - Was 361 lines, now modular:
  - `SKILL.md` - Main reference (~80 lines)
  - `rules/rls-patterns.md` - RLS policy examples
  - `rules/security-patterns.md` - Security hardening
  - `rules/multi-account.md` - Multi-account CLI setup
- **Total skills**: 39 (was 37)
- **Total requires chains**: 12 (was 11)

---

## [4.6.2] - 2026-02-05

### Added
- **Supabase Postgres Skill** - Official Postgres best practices from Supabase
  - Query performance (missing indexes, composite indexes)
  - Connection management (pooling, limits)
  - Security & RLS (basics, performance optimization)
  - Schema design (foreign key indexes, data types)
  - N+1 query prevention
  - 8 detailed reference files included
  - Source: [supabase/agent-skills](https://github.com/supabase/agent-skills)
- **CONTRIBUTING.md** - Skill authoring guide
  - Directory structure conventions
  - SKILL.md format specification
  - Manifest entry guidelines
  - Best practices and checklist
- **New requires chain**: `supabase` → `supabase-postgres`
- **Total skills**: 37 (was 36)
- **Total requires chains**: 11 (was 10)

---

## [4.6.1] - 2026-02-05

### Added
- **Remotion Skill** - Best practices for video creation in React
  - Compositions, animations, sequencing, timing
  - Subtitles and captions
  - Media embedding (videos, images, audio)
  - 5 detailed rule files included
  - Source: [remotion-dev/skills](https://github.com/remotion-dev/skills)
- **Total skills**: 36 (was 35)

### Changed
- Updated three consuming projects to v4.6
- Removed a stale skills folder from one of them

---

## [4.6.0] - 2026-02-05

### Added
- **Security Patterns Skill** - Vulnerability detection patterns from Anthropic's security-guidance
  - Command injection (GitHub Actions, child_process, os.system)
  - Code injection (eval, new Function, pickle)
  - XSS patterns (dangerouslySetInnerHTML, document.write, innerHTML)
  - Auto-loaded with review, audit, ship, pr-review
- **PR Review Skill** - Comprehensive PR review using specialized agents
  - Triggers: `pr-review`, `review-pr`, `code-review`
  - CLAUDE.md compliance checking
  - Bug hunting with validation
  - Security scanning
  - Requires: security-patterns, code-quality

### Changed
- **Renamed** `frontend-design` → `design` (simpler, clearer)
  - Triggers: `design`, `ui`, `landing page`, `marketing page`
  - Creates distinctive UI, avoids generic AI aesthetics
- **Total skills**: 35 (was 33)
- **Total requires chains**: 10 (optimized from 6 in v4.4)
- Updated all skills referencing `frontend-design` to use `design`

### Requires Chain Updates
```
review     → quality + code-quality + security-patterns (NEW)
pr-review  → security-patterns + code-quality (NEW skill)
audit      → quality + code-quality + design + security-patterns (design renamed)
ship       → review + security-patterns (security added)
brainstorm → quality + design (design renamed)
```

---

## [4.5.0] - 2026-02-05

### Added
- **Skill Synergy Chains** - Critical missing connections now in place
  - `test` → requires `browser-test` → requires `agent-browser`
  - `ship` → requires `review` (pre-deploy quality check)
  - `verify` → requires `quality` (standards enforcement)
- **Improved Descriptions** - Third-person, specific, with trigger words per API best practices
- **Trigger Deduplication** - Removed conflicting triggers between skills
  - `setup-project` triggers: `init`, `new project`, `scaffold` (removed `setup`)
  - `test` triggers: `test`, `e2e`, `browser` (removed duplicate `verify`)
  - `ship` triggers: `ship` only (removed duplicate `deploy`)

### Changed
- Total `requires` entries: 10 (was 6)
- Quality skill description now specific about what it enforces
- Workflow skill description clarifies it's for reference
- Browser-test now chains to agent-browser automatically
- Version: 4.5.0

### Optimized (from API best practices review)
- **Progressive Disclosure**: Skills load only when needed via requires chains
- **Token Efficiency**: Metadata always loaded (~100 tokens), SKILL.md on-demand
- **Cross-references**: ONE level deep maximum (e.g., test→browser-test→agent-browser)
- **Trigger Specificity**: Each trigger maps to exactly one skill

---

## [4.4.0] - 2026-02-05

### Added
- **Frontend Design Skill** - Anthropic's official skill for high-quality UI design
  - Avoids "AI slop" (purple gradients, Inter/Roboto, generic layouts)
  - Guides toward intentional design choices (typography, color, motion, composition)
  - Pro tips: generate 5 variants, iterate on favorites
  - Triggers: `design`, `frontend`, `ui`, `landing page`, `marketing page`
  - Source: [anthropics/claude-code](https://github.com/anthropics/claude-code/blob/main/plugins/frontend-design/skills/frontend-design/SKILL.md)
- **Skill Synergy System** - Skills now cross-reference each other
  - `audit` → references `quality`, `code-quality`, `frontend-design`, `preserve-ui`
  - `review` → references `quality`, `code-quality`, `self-review`
  - `brainstorm` → references `quality`, `frontend-design`, `preserve-ui`
  - `auto` → requires `code-quality`, `quality`, `react-patterns`
  - Design validation step in brainstorm for UI features

### Changed
- Total skills: 33
- Manifest now has 6 `requires` entries (was 1)
- Skills include "Quality Framework Reference" sections
- Design system principles flow into audit/review checks

---

## [4.3.0] - 2026-02-04

### Added
- **32 skills now registered** - Consolidated all skills from installed versions
  - agent-browser (browser automation CLI reference)
  - archive-prd (archive completed stories)
  - auth-token-injection (auth patterns for testing)
  - build (build commands and error handling)
  - build-reference (build documentation)
  - env-vars (environment variable patterns)
  - help (list available commands)
  - supabase-schema (schema reference)
- **6 hooks added** - Full hook system for all platforms
  - auto-continue.ps1/.sh - Auto-continues if tasks remain
  - post-tool-typecheck.ps1/.sh - Runs typecheck after TS/JS edits
  - pre-tool-filter.ps1/.sh - Blocks dangerous commands
- **Brainstorm Phase 2** - Feature ideation after cleanup proposals
- **Skills vs Plugins architecture** - Documentation clarifying the two systems

### Changed
- Repository is now single source of truth for all skills and hooks
- Installer synced to v4.3
- prd.json removed from repo (project-specific file)

### Fixed
- 8 missing skills now registered in manifest.json

---

## [4.0.0] - 2026-02-03

### Breaking Changes
- Archived v3.9 (19 commands, 14 skills, 8 hooks → archive/v3.9/)
- New skill structure using SKILL.md in directories
- Native TaskCreate/TaskUpdate replaces prd.json for active work

### Added
- **Native Tasks Integration** - Uses Claude Code's built-in task system
  - TaskCreate/TaskUpdate/TaskList/TaskGet with metadata
  - blocks/blockedBy dependencies built-in
  - Session-scoped persistence - no file I/O during work
- **Hybrid Task System** - Two-layer architecture
  - prd.json = Long-term memory (sprint history, verification notes)
  - Native Tasks = Short-term memory (current session work)
  - 92% token reduction (~35K → ~2.6K per session start)
- **Resolution Learning** - Documents HOW issues were fixed
  - `resolution` field in prd.json schema
  - Pattern format: `[CATEGORY]: [SPECIFIC FIX]`
  - Auto-inject warnings on similar errors
- **Parallel Swarm Audit** - 6 specialized agents run simultaneously
  - Security (secrets, XSS, CORS, injection)
  - Performance (memo, effects, re-renders, N+1)
  - Accessibility (WCAG, keyboard, contrast, aria)
  - Type Safety (any, ts-ignore, type conflicts)
  - UX/UI (loading states, empty states, error handling)
  - Test Coverage (critical paths, untested hooks)
  - Produces severity-rated report with scores
- **Proactive Brainstorm** - YOU propose, user doesn't ask
  - Parallel scans for TODOs, console.logs, hardcoded colors
  - Presents concrete improvement scenarios with impact/effort
  - Never asks "what do you want?" - proposes based on findings

### Changed
- **skills/audit/SKILL.md** - Parallel swarm architecture
- **skills/brainstorm/SKILL.md** - Proactive proposals
- **skills/core/SKILL.md** - Hybrid task system documentation
- **Auto mode** - No more Ralph Loop dependency

### Philosophy
- Context is expensive - minimize prd.json reads
- Learn from mistakes - document resolutions
- Parallel execution - 6 agents faster than 1 comprehensive scan
- Use native tools when available (TaskCreate over prd.json)

---

## [3.9.0] - 2025-01-25

### Added
- **Auto Mode v2** - Self-bootstrapping autonomous development
  - Detects Ralph Loop for true non-stop execution
  - Bootstrap from project context if no prd.json exists
  - Auto-verify UX tasks with browser checks
  - Outputs `<promise>` tag for Ralph completion
- **Brainstorm auto mode** - Generates tasks without asking when called programmatically
- **Ralph Loop integration** - Suggests `/ralph-loop` if not already running

### Changed
- **auto.md** - Complete rewrite with entry point flow diagram
- **brainstorm.md** - Added auto mode vs interactive mode distinction
- Never use `AskUserQuestion` in auto mode - make decisions autonomously

### Philosophy
- "Walk away" development - start it and come back to finished work
- Bootstrap intelligently from CLAUDE.md, README.md, package.json context

---

## [3.8.0] - 2025-01-25

### Added
- **Verification requirement** - Tasks need actual testing, not just build passing
  - `verified: "browser"|"test"|"e2e"` = truly complete
  - `verified: null|"build"` = code complete but unverified
- **Verification matrix** - Different task types require different verification
  - UX: Browser test required
  - Feature: Browser OR unit test
  - Bugfix: Reproduce and verify fix
  - AI: Test with real/mock data
- **Status shows verification** - Verified vs unverified counts

### Changed
- **auto.md** - Verification step required before marking complete
- **core.md** - Schema includes `verified` field
- **status.md** - Shows verification quality metric

### Philosophy
- Build passing is NOT done
- Unverified code is technical debt
- Story quality matters more than velocity

---

## [3.7.0] - 2025-01-25

### Added
- **code-quality.md** - Learned patterns from production mistakes
  - 5 type safety rules (single source of truth, complete Records, Supabase typing)
  - 2 React patterns (no nested interactives, hooks at top level)
  - Error handling patterns (auth errors, storage quota)
  - Query key factory pattern
  - Mistake logging format with categories

### Changed
- **core.md** - Enhanced prd.json schema
  - Added `type` as required field
  - Task scoping rules (split if >5 files, >8 criteria)
  - Field validation rules with examples
  - ID format: `TYPE-NAME##`
- **auto.md** - Added learned code quality rules section
  - Type safety checklist from recurring mistakes
  - Enhanced decision logging format with rationale/trade-offs
- **manifest.json** - Added `requires` field for skill dependencies

### Context Optimization
- code-quality.md auto-loads with auto/review commands
- Prevents recurring mistake patterns before they happen

---

## [3.6.0] - 2025-01-25

### Changed
- **94% context reduction** - Slimmed build.md from 548 to 61 lines
- **Granular skill loading** - Each command loads only its specific file
- **Archived build-reference.md** - 1074 lines of redundant content removed
- **New core.md** - Minimal 43-line prd.json schema reference

### Context Savings
- "status" command: ~3K → ~300 tokens
- "auto" command: ~3K → ~1K tokens
- Estimated 60-70% reduction in initial context per command

---

## [3.5.0] - 2025-01-25

### Added
- **Sprint mode** - Time/milestone-based development cycles
  - `sprint 3h` - Run for 3 hours
  - `sprint "all P1 done"` - Run until milestone
  - Cycles through: brainstorm → auto → review → polish → security → docs
- **Session lock** - Prevents parallel session conflicts via `.claude-lock`
- **Mistake tracking** - `/mistakes` command to view error patterns
- **Smart retry** - Auto-retry failed tasks with different approach (max 2)
- **Task templates** - Pre-built patterns: auth, crud, api, component, hook, supabase
  - `template auth` - Adds 6 authentication tasks
  - `template crud users` - Adds 5 CRUD tasks
- **Batch commits** - Commit every 3 tasks instead of per-task
- **Preflight check** - Validates git, build, types before auto mode
- **Handoff export** - `/handoff` generates session summary for continuity
- **Context audit** - Analyze and optimize context window usage

### Changed
- **Auto mode hardened** - Explicitly forbidden from using AskUserQuestion
- Decisions logged to `.claude/decisions.md` instead of asking user
- Ralph Loop integration for true non-stop operation

---

## [2.4.3] - 2026-01-22

### Fixed
- **Cross-platform archive** - Use Read/Write tools instead of shell copy commands
- Prevents `copy` vs `cp` command errors on Windows
- Fixed emoji encoding in install.ps1 (replaced with ASCII)

---

## [2.4.2] - 2026-01-22

### Added
- **Skill index injection** - SessionStart hook now outputs command→file mapping
- manifest.json now actively used for skill discovery at session start
- Claude can now instantly look up which skill file to read for any command

---

## [2.4.1] - 2026-01-22

### Fixed
- **QUICKSTART.md**: Fixed Windows path syntax in troubleshooting section
- **install.sh**: Added plugin installation for Mac/Linux users (was missing)
- **auto-continue hook**: Changed from blocking to informing behavior
  - Now respects user's "stop" command instead of forcing continuation
  - Shows remaining tasks as info message, not blocker

---

## [2.4.0] - 2026-01-22

### Added
- **Local plugin** for slash commands (`/auto`, `/status`, `/brainstorm`, etc.)
  - Auto-registered during install
  - Works alongside natural language commands
  - 8 commands: auto, status, brainstorm, continue, archive, clean, stop, reset
- **Archive system** for large prd.json files:
  - `archive` command moves completed stories to `prd-archive-YYYY-MM.json`
  - Keeps only active/QA stories in main prd.json
  - Adds `archived` section with summary for context
  - Reduces token usage by 60%+ on large projects
- **Clean command** to remove Claude Code artifacts:
  - Deletes `.claude/screenshots/*.png`
  - Removes `prd-backup-*.json` older than 7 days
  - Cleans `.playwright-mcp/` folder
- **Screenshot convention**: Save to `.claude/screenshots/` (auto-gitignored)
- **archive-prd.md** skill with detailed archival documentation

### Changed
- Updated `build.md` with archive and clean commands
- Updated `test.md` with screenshot folder convention
- Updated README with inline changelog
- Install script now auto-registers plugin in Claude Code

---

## [2.3.0] - 2026-01-22

### Added
- **Hooks system** for token optimization and automation:
  - `auto-continue.ps1/.sh` - Stop hook that auto-continues if tasks remain in prd.json
  - `session-start.ps1/.sh` - Injects task progress context at session start
  - `pre-tool-filter.ps1/.sh` - Blocks dangerous commands, skips large/generated files
  - `post-tool-typecheck.ps1/.sh` - Runs typecheck only for TS/JS files
- `config/settings.json` - Pre-configured hooks for Windows
- `config/settings-unix.json` - Pre-configured hooks for Mac/Linux
- Hooks documentation in README

### Changed
- Install scripts now copy hooks and settings.json
- Token savings of 30-60% through context injection and filtering

---

## [2.2.0] - 2025-01-22

### Added
- `agent-browser.md` skill - Browser automation CLI (5-6x more token-efficient than Playwright MCP)
- Browser testing section in README

### Changed
- `test.md` now uses agent-browser CLI instead of Playwright MCP
- Simplified README - focus on "brainstorm" and "auto" commands
- Simplified `config/CLAUDE.md` and `config/QUICKSTART.md` templates
- Updated install scripts to remove scripts directory references

### Removed
- `scripts/start-server.ps1` - No longer needed (use background bash instead)
- `scripts/start-server.sh` - No longer needed
- `scripts/` directory - Empty after removing start-server scripts

---

## [2.1.0] - 2025-01-15

### Added
- Heartbeat monitoring (3-min intervals for faster work stealing)
- Dependency tracking (`dependsOn` field in tasks)
- Pattern storm detection (detects same error across 3+ tasks)
- Rollback command (`rollback S42` to undo task changes)
- Enhanced status dashboard with emojis and ANSI colors
- ASCII dependency tree (`deps` / `tree` command)

### Changed
- Stale work detection reduced from 30min to 10min
- Task schema updated with `heartbeat`, `dependsOn`, `blockedBy` fields

---

## [2.0.0] - 2025-01-10

### Added
- Multi-agent coordination with claim system
- `claimedAt` field for task locking
- Offset algorithm for parallel agent starts
- `stop` command to release claims before closing
- `reset` command to clear all claims after crash

### Changed
- Complete rewrite of build.md for autonomous operation
- Simplified task schema

---

## [1.0.0] - 2024-12-01

### Added
- Initial release
- `prd.json` task management
- `progress.txt` learnings log
- Basic skills: build, ship, test, fix, setup-project
- Supabase MCP integration
