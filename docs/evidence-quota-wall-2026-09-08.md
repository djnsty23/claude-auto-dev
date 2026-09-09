# Evidence: the quota wall, re-measured, and what today's resume already recovers

`[measured 2026-09-08]` on the same machine as
[`evidence-workflow-runs.md`](evidence-workflow-runs.md) (`[measured 2026-08-25]`),
read directly from `<claude-home>/projects/*/*/subagents/workflows/wf_*/` and from
the main-thread transcripts beside them. Product repos are anonymised per this
repo's public-name gate; run ids are unchanged. Nothing under the Claude home was
written to.

## 1. The population has shrunk, and nothing has run since

| thing | 2026-08-25 | 2026-09-08 |
|---|---|---|
| project directories under `projects/` | 90 | 60 |
| `.jsonl` transcripts on disk | 895 | 290 |
| project directories holding any workflow run | 8 | 3 |
| **workflow run directories (`wf_*`)** | **52** | **12** |
| `Workflow` tool calls in any main transcript, by date | — | 10 on 2026-08-18, 3 on 2026-08-19, **0 since** |
| runs with an agent active on or after 2026-08-25 | — | **0** |

Every one of the 12 surviving runs is in the 2026-08-25 population; the 40 that
are gone went with their whole session directories (the sessions' main
transcripts are gone too). **COULD NOT CHECK why**: nothing under `~/.Trash`,
no `cleanupPeriodDays` in settings, and the deleted sessions left no marker.
The likeliest candidate is a session archive/cleanup from the desktop app, and
that is a guess.

So the re-measurement the brief asked for — the same table for runs since
2026-08-25 — has an empty window. That is an answer, not a failure: **the loss
rate has not dropped to noise, it has not been sampled at all**, because no
workflow has run here in two weeks. The work is scoped as the brief said to
scope it when the number cannot be re-derived: detection first, the phase rule
stated with its measured cost, and the resume note only because Step 1 shows
the resume is correct.

## 2. The 12 runs that remain, triaged

`node plugins/autodev-core/scripts/workflow-run-triage.js --all`, output read in
full before these counts were written (rule-ab-testing rule 3):

| run | agents | shape | journaled | lost | of which quota wall |
|---|---|---|---|---|---|
| `wf_05b5b611` | 6 | mixed, max 4 | 6 | 0 | 0 |
| `wf_082ec284` | 19 | mixed, max 9 | 19 | 0 | 0 |
| `wf_0ad0573c` | 8 | parallel, max 8 | 8 | 0 | 0 |
| `wf_8dbfa87d` | 6 | mixed, max 4 | 6 | 0 | 0 |
| `wf_a691f679` | 12 | mixed, max 10 | 12 | 0 | 0 |
| `wf_fcb7a71f` | 15 | mixed, max 12 | 15 | 0 | 0 |
| `wf_0e8f5e87` | 5 | mixed, max 4 | 5 | 0 | 0 |
| `wf_21df3dd3` | 4 | mixed, max 3 | 4 | 0 | 0 |
| `wf_26ca16f4` | 6 | mixed, max 4 | 6 | 0 | 0 |
| `wf_6117b07b` | 5 | mixed, max 3 | 5 | 0 | 0 |
| `wf_f1941bbb` | 5 | mixed, max 4 | 5 | 0 | 0 |
| **`wf_f9e30118`** | 9 | mixed, max 4 | 3 | **6** | **5** |
| **total** | **100** | 11 mixed, 1 parallel, 0 serial | **94** | **6** | **5** |

What the 6 lost agents cost, from their own transcripts:

| cause | agents | agent-seconds | tool calls | transcript bytes |
|---|---|---|---|---|
| quota wall (`<synthetic>` "You've hit your session limit") | 5 | **190** | 56 | 3,338,781 |
| user interrupt (`[Request interrupted by user for tool use]`) | 1 | **2,305** | 127 | 11,547,959 |
| other | 0 | — | — | — |
| **total** | **6** | **2,495** | **183** | **14,886,740** |

Two things the 2026-08-25 document could not say:

- **The wall is cheap when it lands early.** The five walled agents had run
  40–59 s each (one had run 0 s: it was the judge, started after the four
  variants returned null, and walled on its first request). The expensive loss
  in the same run was the interrupted agent, at 2,305 s. What a wall costs is
  width × elapsed-at-wall, and elapsed is the term the 2026-08-25 tables could
  not see.
- **A second machine-readable marker exists.** A user interrupt leaves
  `[Request interrupted by user for tool use]` in the transcript. The 22
  "cause not recorded on disk" losses of 2026-08-25 could not be re-examined
  (their directories are gone), so how many were interrupts is COULD NOT CHECK.
  The triage now reports it as its own outcome.

## 3. What `resumeFromRunId` actually did, on the one real resume

Session transcript and run directory of `wf_f9e30118-799`, a product-repo
worktree, read row by row:

| when (UTC) | what |
|---|---|
| 2026-08-18 23:07:05 | run starts: 4 variant agents in parallel (phase "Variants") |
| 23:07:51 – 23:08:05 | all 4 receive `"model":"<synthetic>"` · "You've hit your session limit · resets 5:50am" · `error: rate_limit` · status 429 · each is the agent's last row |
| 23:08:17 | the judge starts on the four `null`s and walls on its first request (0 s, 0 tools) |
| 23:08:17 | task notification to the main thread: `<status>failed</status>`, the script's own `null is not an object (evaluating 'judged.winner')`, a `<failures>` list naming each walled agent, and a **`<recovery>` block naming the exact `Workflow({scriptPath, resumeFromRunId})` call** |
| 23:08:19 | **the main thread's own next request returns the same `<synthetic>` row.** The notification arrived at the one moment nothing could act on it |
| 23:11:48 | a second `<synthetic>` row on the main thread |
| 2026-08-19 05:26 | operator returns; model reasons from memory: "All five agents failed … retrying right now would just hit the same wall" |
| 05:27:24 | `Workflow({scriptPath, resumeFromRunId: "wf_f9e30118-799"})` — and the model writes *"Nothing cached from the failed run — all five agents errored before returning, so it's a clean start"* |
| 05:27:33 – 05:27:35 | **exactly the 4 variant keys re-start, with byte-identical `v2:` key hashes** (`d98a…`, `3c22…`, `24cf…`, `8836…`), appended to the same `journal.jsonl` in the same run directory |
| 06:02 – 06:04 | 3 of the 4 journal results of 24,680–26,810 chars each |
| 06:05:59 | the 4th (`a879a65d`, 2,305 s, 127 tool calls, 11.5 MB) is killed by a user tool-use rejection; no result |
| 13:16:35 | task notification `<status>stopped</status>`: "No completion record was found … relaunch with `Workflow({scriptPath, resumeFromRunId: "wf_f9e30118-799"})` — completed agent() calls return cached" |
| after | **no further `Workflow` call in that session.** The main thread cleaned up the variants' scratch directories instead |

Findings, each against the brief's question:

1. **Resume re-ran only the lost calls.** 4 keys had no result; 4 keys
   re-started; the judge key did not (its inputs had not resolved). Cache keys
   are content hashes of `(prompt, opts)`, and the harness forbids
   `Date.now()`/`Math.random()` in scripts, so the second attempt's keys matched
   the first's exactly. **COULD NOT CHECK the cache-hit half on a real run**: at
   05:27 no key had a result, so "completed calls return cached" was not
   exercised on this disk. The triage's arithmetic for it (`keys.rerun` /
   `keys.resulted`) is asserted by fixture, not by a harness run.
2. **Nothing in this repo or the harness calls it automatically.**
   `grep -rn resumeFromRunId plugins/ tooling/ docs/` found nothing before this
   change. The harness names the call in two notifications; the first lands on
   a walled thread and the second went unread.
3. **A second resume would have recovered the run.** After 06:05 the journal
   holds 3 of 5 keys; `resumeFromRunId` would re-run 2 calls (one variant, the
   judge) plus the synthesis stage, and keep **6,497 journaled agent-seconds**.
   It was never issued. That is the headline of section 5.
4. **The model's belief about the cache was wrong in form and right by
   accident.** "Nothing cached" was true only because nothing had finished. A
   model that believed it after 06:05 would have relaunched fresh and re-run
   three 35-minute agents. This is why the hook's note says *resume, never
   relaunch*, in those words.

## 4. What the three changes cost, each against doing nothing and a variant

### (a) Detection: `scripts/workflow-run-triage.js`

| variant | what it reads | cost |
|---|---|---|
| A — nothing (today) | the operator greps `<synthetic>` by hand, as the 2026-08-25 document did | 0 until a wall; then a session's worth of re-derivation |
| B — this script, one run | `journal.jsonl` + every `agent-*.jsonl` of that run | all 12 runs, 100 transcripts, 81 MB, in 2.9 s wall (0.6 s CPU); a 12-agent 22 MB fixture in ~320 ms |
| C — variant: journal only, no transcripts | `journal.jsonl` | ~1 ms, but cannot tell a wall from a kill, cannot cost the loss, and cannot see an agent whose start row never got a result |

B ships. C is the variant that looks cheap and answers the wrong question: the
journal has no timestamps and no cause, which is the gap the 2026-08-25 document
listed first under COULD NOT CHECK.

### (b) The phase rule: serial cost versus wall cost

Wall-clock of each surviving run against its serial floor (the sum of its
agents' own durations), from agent start/end rows. Busy time is the union of
agent intervals, so the six-hour wait between `wf_f9e30118`'s two attempts is
not counted as wall-clock:

| run | agents | width | busy wall s | Σ agent s | serial ÷ actual |
|---|---|---|---|---|---|
| `wf_6117b07b` | 5 | 3 | 1,671 | 2,299 | 1.38 |
| `wf_26ca16f4` | 6 | 4 | 2,488 | 3,800 | 1.53 |
| `wf_21df3dd3` | 4 | 3 | 3,597 | 5,982 | 1.66 |
| `wf_f1941bbb` | 5 | 4 | 1,737 | 3,372 | 1.94 |
| `wf_8dbfa87d` | 6 | 4 | 2,803 | 5,643 | 2.01 |
| `wf_05b5b611` | 6 | 4 | 816 | 1,866 | 2.29 |
| `wf_0e8f5e87` | 5 | 4 | 4,595 | 11,192 | 2.44 |
| `wf_f9e30118` | 9 | 4 | 2,367 | 8,992 | 3.80 |
| `wf_a691f679` | 12 | 10 | 168 | 629 | 3.74 |
| `wf_0ad0573c` | 8 | 8 | 82 | 321 | 3.90 |
| `wf_082ec284` | 19 | 9 | 468 | 2,043 | 4.37 |
| `wf_fcb7a71f` | 15 | 12 | 450 | 3,355 | 7.46 |

| width in flight | runs | median serial ÷ actual |
|---|---|---|
| 3–4 | 8 | **2.0** |
| 8–12 | 4 | **4.1** |

So the rule can state what it charges: **going fully serial costs about 2× the
wall-clock of a 3–4-wide phase and about 4× that of an 8–12-wide one**, on this
machine's runs. Against it, a wall costs width × elapsed-at-wall, and with
resume that is also exactly what has to be redone. The rule as shipped in
`rule-agent-concurrency` and `WORKFLOW-STRUCTURE.md` D6:

> Anything that must not be lost runs in a serial chain, or in waves no wider
> than what you can afford to redo. A wide parallel phase is only for work that
> is cheap to re-run.

with the `phase()` convention that each `meta.phases[].detail` states width and
re-run cost, and a `waves(items, width, fn)` helper for a must-keep phase wider
than its width. The variant considered and not taken: a hard concurrency cap in
a hook. It would cost every workflow the 2–4× above whether or not a wall was
plausible, and the brief already said no hook here.

Note the built-in `workflow-authoring` reference is part of Claude Code, not
this repo, so the convention lives in `rule-agent-concurrency` (auto-loaded on
`**/*.workflow.js`) and in `WORKFLOW-STRUCTURE.md`, not in that skill.

### (c) The Stop hook: `hooks/stop-workflow-wall-note.js`

Per-Stop cost, N=15 medians, subprocess wall time on this machine:

| variant | ms | note |
|---|---|---|
| A — `node -e ""` (process floor) | 54 | what any hook costs to exist |
| B — `context-depth-nudge.js`, an existing Stop hook | 57 | for scale |
| **C — this hook, session with no workflow runs** | **64** | every ordinary turn: one failed `readdir` |
| D — this hook, 12-agent run (22 MB), 6 walled, already noted | 63 | stamp of mtimes+sizes matches the ledger; transcripts not read |
| E — same run, first fire | 380 | reads 12 transcripts once, then remembers the stamp |
| F — variant: scan the whole projects home per turn instead of this session | 181 | and it would fire on another session's run |

Scope is per session by construction: the Stop payload's `transcript_path` and
`session_id` locate `<slug>/<session_id>/subagents/workflows/` directly
(0.13 ms) where the whole-home scan is 6.6 ms over 60 project directories and
grows with the home. The hook speaks only when the latest run has a
`lost-quota-wall` agent, only once per loss set (a resume that loses a
*different* agent, as this one did, gets one more note), never while an agent
transcript changed in the last 5 minutes, never with a `decision` key, and with
zero bytes on both streams on every quiet path.

Why Stop and not StopFailure: the wall ends the walled turn through
StopFailure, and that is the one moment a resume cannot run. This fires at the
end of the first turn that ends normally after the reset. Known limit: a fresh
session after the wall has a different session id and cannot see the old
session's run; `--all-since` is for that.

## 5. Headline: what today's resume would recover, over every run on this machine

| | value |
|---|---|
| runs on disk | 12 |
| runs with at least one lost agent | 1 (`wf_f9e30118-799`) |
| of those, runs whose script file still exists (resumable) | **1 of 1** |
| agent() calls resume would re-run | 2 of 5 (plus stages that never started) |
| journaled agent-seconds resume keeps | **6,497** |
| lost agent-seconds resume re-runs | 2,495 (190 of them from the wall) |
| resumes that were actually issued after the second loss | 0 |

One run, because one run is what is left. On the 2026-08-25 population the
same arithmetic would have applied to 15 lost runs and 20,680 lost
agent-seconds, and cannot be re-derived because those directories are gone.

## 6. Could not check

- **Why 40 run directories and 605 transcripts disappeared.** No trash, no
  cleanup setting, no marker.
- **The cache-hit half of `resumeFromRunId` on a real run.** Never exercised on
  this disk; asserted by fixture only.
- **How many of the 2026-08-25 document's 22 uncaused losses were user
  interrupts.** The marker exists; the directories do not.
- **The hook against a live wall.** No wall has landed here since the hook was
  written. The suite drives it against fixture run directories shaped from the
  real one, with a control that strips the `<synthetic>` row.
- **Whether a Stop hook's `systemMessage` renders in every client.**
  `context-depth-nudge.js` emits the same shape and has not been reported
  silent, which is the only evidence.
- **Machine-local**, one operator, and now one run with a loss.
