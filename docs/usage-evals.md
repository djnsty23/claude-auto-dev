# Usage evals: mining our own transcripts for failures

`usage-mine.js` streams every Claude Code transcript on this machine, extracts failure events
without keeping any text, and ranks the failure classes by sessions, events, tokens and retries
per ISO week. The ten classes at the top became replayable cases under `evals/usage/`, each
graded by code. The ranking is led by a shell alias nobody chose: `ls -F` suffixes a script path
with `*`, which accounts for 523 of the 826 events in the top class.

Read [evals/usage/README.md](../evals/usage/README.md) to run the cases.

## What it is for

A change to a rule, skill, hook or launcher is a claim that some failure gets rarer. This loop
turns that claim into a number twice: once as the weekly count of the class in real sessions,
and once as a case that is red before the change and green after it.

## Populations `[measured 2026-11-05]`

| Population | Count | Probe |
|---|---|---|
| Transcript files under the projects root | 7,564 (about 20 GB) | `usage-mine.js mine --full` |
| Full re-mine time | 79 s on an idle machine, up to 11 min under load | same |
| Events in the index, all time | 28,538 | same |
| Top-level sessions since 2026-10-08 | 1,681, plus 733 subagent files | `report --since 2026-10-08` |
| Failure events since 2026-10-08 | 6,608, after 222 forked-transcript copies were dropped | same |
| Eval-harness transcripts left out | 1,969 files, 3,927 events | same, `--include-synthetic` counts them |

The index is three JSONL files under `<config>/autodev/usage/`. A row holds a class, date,
week, project name, model, tool, target category, token cost and short hashes. It holds no
message text and no path. The selftest asserts that on every fixture.

## The top ten

Ranked by sessions affected, since 2026-10-08. Weekly is W41 to W45 (W45 is partial).

| Code | Case | Class | Sessions | Events | Weekly | Kind | State on main |
|---|---|---|---|---|---|---|---|
| C1 | ls-alias-substitution | tool-error/shell-fault | 642 | 826 | 61 231 234 201 99 | harness | knownRed F1 |
| C2 | fix-failing-test | gate-red | 305 | 534 | 60 94 45 282 53 | replay | model-graded |
| C3 | script-with-regex | hook-block/autodev-fn:heredoc-backslash | 299 | 494 | 82 127 75 157 53 | replay | model-graded |
| C4 | find-then-read | tool-error/file-missing | 164 | 232 | 27 49 31 86 39 | replay | model-graded |
| C5 | quotes-in-shell | tool-error/shell-quoting | 160 | 203 | 47 40 19 74 23 | replay | model-graded |
| C6 | context-depth-once-per-band | hook-block/checking-context-depth | 149 | 401 | 46 88 81 137 49 | harness | green |
| C7 | worker-report-outbox | permission-denied/mode:dontAsk | 127 | 590 | 0 0 1 569 20 | harness | knownRed, fix in flight |
| C8 | worker-prompt-authority | hook-block/worker-authority | 101 | 302 | 0 45 5 251 1 | harness | knownRed F2 |
| C9 | stop-hook-latency | hook-timeout/checking-for-unreported-work | 69 | 136 | 8 70 41 14 3 | harness | knownRed F4 |
| C10 | failing-command-no-repeat | retry-identical | 64 | 169 | 17 44 15 35 58 | replay | model-graded |

Classes above the cut that got no case, and why:

- `permission-denied/user-reject` (265 sessions): a human said no. No code checker can say whether they should have.
- `tool-error/unclassified` (254): a bucket. Its largest shapes were promoted to classes of their own (worktree isolation, a locked browser profile, autodev-fn refusals).
- `permission-denied/subcommandResults` (117) and `hook-block/headless-guard` (67): already fell to 0 by W45.
- `permission-denied/rule:userSettings` (92): the permission rules working as configured.

## What the cases found

**C1, the `ls -F` alias** `[measured]`. The Bash tool loads the user profile, where `ls` is
`ls -F --color=auto`. So `W=$(ls -d <cache>/*/scripts/unattended-worker.js | sort -V | tail -1)`
yields a path ending in `*`, and `node "$W"` fails with MODULE_NOT_FOUND. Reproduced live.
458 of the 523 also gave node an MSYS `/c/Users/...` path, which node resolves as `C:\c\Users`.
The case asks the tree's `bash-rules.mjs` about the command. A plain `ls -la` control must pass
untouched, so a rule refusing every `ls` is not a pass.

**C7, the smoke worker's report** `[measured]`. The index holds the 2026-11-05 smoke worker
(session d4b4f6a5, claude-auto-dev, Sonnet 5.5) with two dontAsk denials aimed at the config
dir, one Bash and one Write. The case composes the real worker prompt with `launch --dry-run`.
It is red on main (the prompt names `<config>/autodev/reports/worker-smoke-a/REPORT.md`) and
green on the conveyor-unstick fix tree (two report paths, none under the config dir).

**C8, the worker prompt invites a push** `[measured]`. The composed prompt says "Before any
commit, push or merge, ...", and worker-authority refuses a builder's push. Its largest refusal
shapes since 10-08 were `git config extensions.worktreeConfig` (51), a credential file (50) and
`git push` (45). The privileged verbs are a hand-written list, so weakening the guard cannot
shrink the check with it.

**C9, a Stop hook outliving its budget** `[measured]`. Every cancelled Stop hook in the
transcripts carries `timedOut: true`, and 159 of 214 were stop-brain-report. I first suspected
its git calls. Measured, they take about 35 ms each. The time goes to `checkBrainRole`: when
the role file's desktop id is in the session store, a name-only walk finds it in 17 ms. When it
is not, the walk parses all 2,818 records (815 MB), which took 4.77 s of a 5 s budget. The case
is hermetic: a 400-record scratch store, a missing coordinator id, and a preload counting the
records each hook parses. The class is falling (70 to 3), most likely because the role record
is present again `[inferred]`, so the slow path is latent rather than fixed.

**The replay cases on Haiku 5.5** `[measured 2026-11-05]`. One run each, so a verdict is a
sample, not a rate.

| Case | Verdict | Detail |
|---|---|---|
| C2 fix-failing-test | pass | 0 reruns past the first red, done-marker present |
| C3 script-with-regex | could not run | the headless run met 3 permission prompts (a script in a scratchpad outside its folder) it cannot answer |
| C4 find-then-read | fail | 1 file-missing event: it read the guessed path before searching |
| C5 quotes-in-shell | pass | 0 quoting faults, done-marker present |
| C10 failing-command-no-repeat | pass | 0 identical retries, done-marker present |

C3 was first graded a plain fail. The grader now calls a run that a permission prompt stopped
could-not-run, and replays pass `--strict-mcp-config`, because the machine's MCP tool lists were
part of what filled Haiku's context.

**C6 is by design.** The context-depth hook blocks once per 50k band past the soft line. The
case pins that cost at one block per band, so a change that makes it fire every turn goes red.

## How precise the extraction is

- **User corrections** `[measured]`: 22 of 26 sampled hits of the correction lexicon were real
  corrections. They are counted per session and are not one of the ten cases.
- **Synthetic sessions**: skill trigger evals and these replays run headless sessions that land
  in the same transcript store. Projects named `trigger-eval-*`, `skill-trigger-eval-*`,
  `usage-replay-*` and `usage-eval-*` are left out of the report unless asked for.
- **Hook labels**: a hook refusal carries no hook name, so the class comes from the script path,
  the autodev-fn rule id or the hook's status message in the text. A timeout's status message
  (`Checking for unreported work...`) names the hook, which is why C9 has a precise class.
- **Skill attribution is weak evidence.** The skill field sticks to the last skill loaded in a
  session, so one skill appears on events it had nothing to do with.

## Session digests

`usage-digest.js` writes one short Markdown file per session so memory-kb can answer "which
session dealt with this". The local 4B writes the topic line and nothing else. Code writes the
date, project, model, minutes, the failure classes counted by usage-mine's extractor, the tool
error count, PR links, commit shas and edited files.

Two designs were graded by Opus on the same 20 real sessions `[measured 2026-11-05]`:

| Design | Passed | Invented a fix | Invented a claim | Privacy hit |
|---|---|---|---|---|
| 4B prose, each claim checked against a cited log line | 7 of 20 | 2 | 5 | 1 |
| 4B topic only, every other line from code | 20 of 20 | 0 | 0 | 0 |

The second costs about 13k tokens and 2.5 s per session on the local 4B. Every one of its 20
digests passed the secret scanner.

The topic is refused, and `<project> session, edited <files>` used instead, when it is empty,
quotes any ten-word run of a human turn, has under 60% of its word stems in the log, or names a
person. A name is caught by a denylist or by a capitalised word that the log never writes in
lowercase and no tool call contains. That heuristic replaced 0 of 18 real topics and catches a
planted name on no list. Its gap is a name the log also writes in lowercase, in a handle or a
path. Only the denylist covers that, so edited files whose path carries a listed name are left
out as well.

PR links come only from `gh pr create`, `merge`, `view` and the other subcommands that act on
one PR, from their output or their command line. `gh pr list` output named PRs the session never
touched in one of the 20 sessions.

The private lists stay out of this public repo. `<config>/autodev/usage/digest-config.json`
holds `clientMarkers` (client projects get no digest), `knownNames` and `userNames` (replaced
with "the user"). Without the first two the script digests nothing and exits 2. A digest is kept
only when `scan-transcript-secrets.js --file` exits 0 and prints its clean line. Otherwise it is
deleted, and a missing scanner counts as a failure. Ingest into memory-kb is off until the same
file says `"ingest": true`, because the embedding key's billing tier is not yet confirmed.

## Commands

```bash
node plugins/autodev-core/scripts/usage-digest.js run --limit 20  # newest first, skips what the ledger has
node plugins/autodev-core/scripts/usage-digest.js one <transcript.jsonl> --print
node plugins/autodev-core/scripts/usage-digest.js status
node tooling/test-usage-digest.js
node plugins/autodev-core/scripts/usage-mine.js mine            # incremental, by file size and mtime
node plugins/autodev-core/scripts/usage-mine.js report --since 2026-10-08 --weeks 5
node plugins/autodev-core/scripts/usage-mine.js observe         # the weekly brain-clock observer
node plugins/autodev-core/scripts/usage-mine.js --selftest
node evals/usage/run.js
node tooling/test-usage-mine.js
```

## Follow-ups

| Code | What | Turns green |
|---|---|---|
| F1 | A bash-rules rule that refuses or rewrites `$(ls ...)` used as a path | C1 |
| F2 | The worker prompt says push and PRs stay with the coordinator, and its worktreeConfig step agrees with worker-authority | C8 |
| F3 | MSYS `/c/...` paths handed to node: a rewrite or a refusal in bash-rules | part of C1's class |
| F4 | The Stop-path role lookup stops parsing the whole store when the coordinator id is missing | C9 |
| F5 | `hook-block/hook` (68 sessions, 51k tokens per event, mostly on `update_plan`) has no label yet | a new class |

## What would change this

- Claude Code's transcript format changes, in particular `permissionDecision`, `hook_cancelled`
  or `toolUseResult`. The selftest fixtures would still pass, so re-read a real file.
- The cleanup period deletes transcripts. The index keeps the rows of a deleted file, so counts
  persist, but a re-mine with `--full` starts from what is left.
- A replay case grades the model under the plugins installed on this machine, not the tree. A
  rule change shows in replay only after it is installed.
- The ranking is by sessions. A class that costs one session an hour is invisible at the top
  and visible in the token column.
