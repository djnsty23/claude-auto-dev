---
name: framework-radar
description: "Research coding agents, agent SDKs, orchestration frameworks, harnesses, protocols, evaluations and relevant videos, then execute every selected hypothesis against the current repository. Use when asked what is new, what agent practices are worth testing, or to run the framework radar."
when_to_use: "Invoked when the user says framework radar, asks for recent Claude Code, Codex, Gemini or agent-development ideas, supplies an agent-workflow video, or asks what new platform behavior the framework should test."
allowed-tools: Bash, Read, Grep, Glob, Write, Edit, WebSearch, WebFetch
model: opus
user-invocable: true
argument-hint: "[days | YouTube URL]"
---

# Framework Radar

Collect first, judge second, test third. The collector owns source retrieval,
transcript storage, population counts and deduplication. This skill owns
relevance, corroboration, controlled experiments and evidence-backed adoption.

## 1. Collect

Run the shipped collector from this plugin:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/framework-radar.js" --days 14
```

If the invocation includes a YouTube URL or ID, append one `--video <ID-or-URL>`
for each. A supplied video is always considered even when it falls outside the
discovery window.

The collector prints:

- The number of configured, successful and failed sources.
- The primary, research, community, category, video, transcript and retained-comment populations.
- `COULD NOT CHECK` for each unavailable source.
- The absolute path to its JSON manifest.
- The absolute path to a self-contained HTML findings dashboard, with adjacent
  Markdown and JSON versions under `.claude/reports/`.

It uses `YOUTUBE_API_KEY` when available. Otherwise it tries `yt-dlp`, then
`uvx --from yt-dlp`. Transcript extraction similarly uses
`youtube-transcript-api` directly or through `uvx`. Comment sampling uses the
YouTube Data API or a bounded yt-dlp fallback. Missing tooling is a named source
failure, never an empty success.

Completion: a manifest exists and its population line matches the JSON counts.
If every source failed, write a short failure report and stop without marking
anything reviewed.

## 2. Read the evidence

Read the manifest. Work from items where `requires_review` is true. For a video,
read its local `transcript.path` only when `transcript.status` is `ok`.

When `comments.status` is `ok`, read its local path and cross-foot fetched,
retained, excluded and distinct-author counts. The top and recent lanes answer
different sampling questions. Report exclusion reasons. The deterministic filter
removes high-confidence spam/bot-like patterns, but public metadata cannot prove
humanity, so never claim complete bot removal.

Raw transcripts stay in the collector's local state directory. The report may
contain a paraphrase, source URL and short excerpt, but never the full transcript.

Treat the four YouTube rankings as alternative triage lenses:

| Lens | What it can answer | What it cannot answer |
|------|--------------------|-----------------------|
| raw views | broad reach | current relevance |
| view velocity | recent attention | correctness |
| relevance | keyword overlap | usefulness |
| balanced | which items to read first | recommendation quality |

Do not call the balanced score objectively better. It is a reading order whose
variants are printed so the reviewer can see when the choice changes.

Summarize recurring support, objections, questions and contradictions with theme
counts and short representative excerpts. Separate feedback about the presenter
from feedback about the proposed workflow. Comments reflect commenters after
platform and creator moderation, not all viewers or correctness.

Completion: every transcript used in a recommendation has a source URL and a
recorded manual/generated/unknown caption kind, and every used comment sample
states both its retained denominator and filter limitation.

## 3. Corroborate every claim

An official changelog entry is evidence that a behavior changed. A video is a
lead about how to use that behavior, not proof that it helps this framework.

For each plausible video claim:

1. Find the official documentation or repository for the coding agent, SDK,
   framework, harness, protocol or evaluation tool that supports or contradicts
   it. If no primary source exists, label it community-only.
2. Read the current repository's `AGENTS.md` or `CLAUDE.md`, README, activating
   config and relevant implementation.
3. Search for the effect, not only the implementation shape suggested by the
   source. Classify the claim as `already handled`, `watch`, `test`, or `reject`.
4. State what observation would change the classification.

Requested model, advertised feature and video narration are not execution
evidence. Prefer logs, config, runtime behavior and executable tests.

Completion: every item entering `test` cites one primary external source and one
current-repository artifact. A lead missing either side stays `watch`; it is not
a hypothesis yet.

Before choosing leads, read the dashboard's claim clusters and source outcome
scorecard. Repeated coverage of one announcement is one underlying claim; keep
the independent-source population visible. The outcome score is a shrunk history
of tested utility, not a truth or popularity score, and a source with no outcomes
must remain eligible for exploration.

## 4. Execute every hypothesis

First read the newest prior radar reports. An earlier candidate experiment with
no recorded result is pending work and takes priority over a new idea.

Select at most three testable hypotheses for this run. **Every selected
hypothesis must be executed in this run.** Do not create a heading called
"hypothesis" for an idea that cannot be tested now; keep it under `watch` with
the missing prerequisite.

Before seeing results, record:

- Hypothesis and affected workflow.
- Exact fixture or representative task population.
- Correctness, cost and user-facing measures.
- Adoption threshold, expected failure signal and rollback.
- What is held constant across variants.

Each hypothesis compares three variants:

- A: current behavior.
- B: the proposed change.
- C: one simpler alternative.

If C is genuinely impossible, record why before running A and B. "B versus
nothing" is otherwise incomplete.

### Isolation

Never experiment in the shared checkout. Fetch the remote, verify the exact
default-branch commit, and create a dedicated worktree and `codex/radar-*`
branch from that commit. Run A before editing. Run B and C on the same fixtures
and environment. Preserve raw commands, exit statuses, elapsed time and output
paths in the report.

The test must exercise the behavior, not merely inspect the proposed file.
Prefer replayable prompts, fixture repositories, subprocess execution, mutation
canaries and existing telemetry. Read every finding before reporting a count.

### Verdict and artifact

For each executed hypothesis record:

- A/B/C measurements against the preregistered threshold.
- `adopt B`, `adopt C`, `no winner`, or `reject`.
- Confidence, limitations and the exact evidence location.

When B or C wins, implement only the winning variant in the isolated worktree
and run its targeted verification plus the repository gate. Commit explicit
paths. A scheduled run may push the winning experiment branch for review and
open a PR only when its automation prompt explicitly grants standing
authorization for that exact `codex/radar-*` branch. In an interactive run,
obtain fresh push authorization from the user. No radar run may merge, deploy,
tag, release or update installed plugins. When neither variant wins, leave no
framework change or PR behind.

Completion: the count of selected hypotheses equals the count with executed
verdicts. Zero hypotheses is valid when no lead is both relevant and testable.

### Record the executable verdict

Write `.claude/reports/framework-radar-verdicts-YYYY-MM-DD.json` after every
selected hypothesis has run. It must use `schema_version: 1`, the exact manifest
`run_id`, and one `hypotheses[]` row per executed hypothesis with:

- stable `id`, falsifiable `claim`, and the manifest `source_keys` that led to it;
- `verdict`: `adopt-b`, `adopt-c`, `no-winner`, or `reject`;
- `variants.a`, `variants.b`, and `variants.c`, each with a string `measurement`;
- at least one raw `evidence` location and the measured `tested_at` time.

Then update the durable learning ledger and regenerate the user artifacts:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/radar-learning.js" \
  --manifest <manifest-path> \
  --verdicts .claude/reports/framework-radar-verdicts-YYYY-MM-DD.json
```

The command rejects source keys outside the manifest and is idempotent by run
and hypothesis id. Read back the printed Markdown, HTML and JSON paths before
marking the manifest reviewed.

An adopted winner starts as `candidate`; it does not become a default because a
PR merged. Move it through `shadow`, `canary`, then `default` only with evidence
for each transition. `default` requires `--revalidate-by`; an expired default is
reported as `stale` and must return to shadow or retire.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/radar-learning.js" \
  --state-dir <manifest-state-dir> --transition <experiment-id> \
  --to shadow --evidence <evidence-path-or-summary>
```

New hosts cited by collected descriptions appear only as source proposals. Add
one to a registry only after provenance, feed stability and useful yield have
been measured across three runs. Never let discovery edit a registry directly.

## 5. Write the report

Write `.claude/reports/framework-radar-YYYY-MM-DD.md` with these sections:

1. Population and source health by authority and category.
2. New primary changes plus research/community leads kept separate.
3. Video claims and audience feedback checked.
4. Executed experiments and A/B/C results, maximum three.
5. Already handled and rejected ideas.
6. Watch list and blocked prerequisites.
7. Winning branches and PRs, if any.
8. Learning ledger changes, lifecycle status and proposed source discoveries.

Cross-foot the report totals against the manifest. A failed source remains in
the report even when other sources succeeded.

### Scheduled mode

A scheduled run completes the full collect, corroborate and experiment loop.
It may edit only its dedicated worktree. It may push only a winning experiment
branch for review, and only when its automation prompt explicitly grants that
authorization; otherwise stop after the local commit and report the blocker.
It does not create `prd.json`, touch the shared checkout, merge, deploy, tag,
release or update installed plugins. A stale or overlapping radar run exits
with a named blocker instead of competing for the same branch.

After the report contains a verdict for every selected hypothesis and any
winning PR has been read back from the remote, mark exactly that manifest
reviewed:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/framework-radar.js" --mark-reviewed <manifest-path>
```

This writes the review heartbeat. Do not mark reviewed before the report exists,
because an interrupted analysis must return on the next run.

Completion: the report exists, source and hypothesis counts cross-foot, every
hypothesis has an executed verdict, every winning PR is remotely readable, and
the user-facing HTML/Markdown/JSON artifacts exist, and the mark-reviewed command
reports the same changed-item population the report considered.
