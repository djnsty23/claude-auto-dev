---
name: framework-radar
description: "Research recent Claude Code and Codex changes plus relevant YouTube workflows, then propose measured experiments against the current repository. Use when asked what is new, what agent practices are worth testing, or to run the framework radar."
when_to_use: "Invoked when the user says framework radar, asks for recent Claude Code or Codex workflow ideas, supplies an agent-workflow video, or asks what new platform behavior the framework should test."
allowed-tools: Bash, Read, Grep, Glob, Write, WebSearch, WebFetch
model: opus
user-invocable: true
argument-hint: "[days | YouTube URL]"
---

# Framework Radar

Collect first, judge second. The collector owns source retrieval, transcript
storage, population counts and deduplication. This skill owns relevance,
corroboration and experiment design.

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
- The official-item, video and transcript populations.
- `COULD NOT CHECK` for each unavailable source.
- The absolute path to its JSON manifest.

It uses `YOUTUBE_API_KEY` when available. Otherwise it tries `yt-dlp`, then
`uvx --from yt-dlp`. Transcript extraction similarly uses
`youtube-transcript-api` directly or through `uvx`. Missing tooling is a named
source failure, never an empty success.

Completion: a manifest exists and its population line matches the JSON counts.
If every source failed, write a short failure report and stop without marking
anything reviewed.

## 2. Read the evidence

Read the manifest. Work from items where `requires_review` is true. For a video,
read its local `transcript.path` only when `transcript.status` is `ok`.

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

Completion: every transcript used in a recommendation has a source URL and a
recorded manual/generated/unknown caption kind.

## 3. Corroborate every claim

An official changelog entry is evidence that a behavior changed. A video is a
hypothesis about how to use that behavior.

For each plausible video claim:

1. Find the official Claude Code or Codex documentation that supports or
   contradicts it. If no primary source exists, label it community-only.
2. Read the current repository's `AGENTS.md` or `CLAUDE.md`, README, activating
   config and relevant implementation.
3. Search for the effect, not only the implementation shape suggested by the
   video. Classify the claim as `already handled`, `watch`, `test`, or `reject`.
4. State what observation would change the classification.

Requested model, advertised feature and video narration are not execution
evidence. Prefer logs, config, runtime behavior and executable tests.

Completion: every `test` recommendation cites one primary external source and
one current-repository artifact, or explicitly says which side could not be
verified.

## 4. Design measured experiments

Produce at most three experiments. Each compares three variants:

- A: current behavior.
- B: the proposed change.
- C: one simpler alternative.

For each experiment record:

- Hypothesis and affected workflow.
- Exact fixture or representative task population.
- Correctness measure, cost measure and user-facing measure.
- Expected failure signal, rollback and blast radius.
- Confidence and unresolved evidence.

If it cannot be measured now, label it `unmeasured proposal`; do not upgrade it
to a recommendation through prose.

Completion: every recommended experiment has a baseline, a variant and a
simpler alternative. Zero recommendations is valid.

## 5. Write the report

Write `.claude/reports/framework-radar-YYYY-MM-DD.md` with these sections:

1. Population and source health.
2. New official changes.
3. Video claims checked.
4. Candidate experiments, maximum three.
5. Already handled and rejected ideas.
6. Collection or verification gaps.

Cross-foot the report totals against the manifest. A failed source remains in
the report even when other sources succeeded.

### Scheduled mode

A scheduled run is report-only. It writes the report and returns its summary to
the review queue. It does not edit framework behavior, create `prd.json` stories,
write gates, commit, push or release. Accepted experiments enter those workflows
in a separate interactive turn.

After the report is complete, mark exactly that manifest reviewed:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/framework-radar.js" --mark-reviewed <manifest-path>
```

This writes the review heartbeat. Do not mark reviewed before the report exists,
because an interrupted analysis must return on the next run.

Completion: the report exists, its counts cross-foot, and the mark-reviewed
command reports the same changed-item population the report considered.
