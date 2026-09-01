---
name: marketing-radar
description: "Research current marketing-platform changes and practitioner videos, extract claims with incentives and boundary conditions, then safely execute every selected hypothesis. Use for recurring marketing research, campaign or funnel ideas, and supplied marketing videos."
when_to_use: "Invoked when the user says marketing radar, asks what marketing practices are worth testing, supplies a marketing video or transcript, or wants recurring evidence-backed marketing improvement."
allowed-tools: Bash, Read, Grep, Glob, Write, Edit, WebSearch, WebFetch
model: opus
user-invocable: true
argument-hint: "[days | YouTube URL]"
---

# Marketing Radar

Collect first, separate claims from promotion, then test only what the available
population can actually answer. Primary, research-method, trade/community and
practitioner-audience evidence are separate populations. Platform narration,
popularity, comments and proxy scores are leads, not proof of business impact.

## 1. Collect

Run the shared collector with this profile:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/framework-radar.js" \
  --config "${CLAUDE_PLUGIN_ROOT}/scripts/marketing-radar-sources.json" \
  --days 14
```

Append `--video <ID-or-URL>` for every supplied YouTube source. The collector
stores transcripts outside the repository, reports source failures and writes a
deduplicated manifest under `.claude/reports/`.

The registry spans first-party changes, research methods, trade/community feeds
and practitioner video discovery. Never use the number of feeds as a confidence
score: ten outlets repeating one vendor announcement are one underlying claim.
Cross-foot both category and authority populations, and require a primary source
before a platform-behavior claim can enter `test`.

Read only manifest items where `requires_review` is true. Read a transcript only
from its recorded local path. Record whether captions are manual, generated or
unknown. Never copy a full transcript into a report or repository.

When `comments.status` is `ok`, read the recorded local comments path. It contains
top and recent samples with author identifiers pseudonymized. Report fetched,
retained, excluded and distinct-author populations plus every exclusion reason.
The filter removes only high-confidence repetitive, engagement-manipulation and
off-platform promotional patterns. Call these `excluded bot/spam-like comments`,
not verified bots: public metadata cannot establish that every retained account
is human or every excluded account is automated.

Summarize audience feedback by theme, with a count and at most one short excerpt
per theme. Separate sentiment toward the presenter/video from sentiment toward
the actual tactic, and list recurring questions and contradictions. Show both
unweighted theme counts and whether top-liked comments would change the reading.
Comments represent commenters after creator and platform moderation, not all
viewers, customers or business outcomes.

Completion: the manifest population and printed population cross-foot, and an
all-source failure is reported as a failure rather than a clean run.

Read the adjacent `marketing-radar-findings-latest.html` dashboard before
selecting claims. It clusters repeated coverage into underlying claims and keeps
the independent-source count separate. Its source utility score is a shrunk
history of executed outcomes, not proof, reach or popularity; keep untested
sources eligible for exploration.

## 2. Build the claim ledger

For every source used, record:

- source URL, publication date, author and channel;
- what the author sells, sponsors or benefits from;
- the claim in falsifiable terms, not the proposed tactic alone;
- evidence tag: primary platform source, measured case, practitioner account,
  sponsored demonstration, opinion or contradiction;
- domain: traffic, creative, offer, funnel, lifecycle, measurement, SEO,
  operations or another explicit domain;
- verdict: `HOLDS`, `CONDITIONAL`, `DEBUNKED`, `REFUTED` or `UNTESTED`.

Before comparing claims, split them on these boundary axes:

1. Efficiency or spend claims: contribution margin, repeat-purchase profile and
   cash-payback constraint.
2. Funnel claims: whether conversion requires a human sales conversation.
3. Creative or targeting claims: existing-demand capture versus interruption.

Also record platform, objective, audience temperature, conversion volume,
attribution window, geography and time period when known. Missing boundaries
make a claim narrower, not universal.

Run these checks before accepting a claim: denominator, selection bias,
attribution leakage, survivorship, seasonality, incentive conflict and whether
the metric is only a proxy for profit or qualified demand.

Completion: every claim has a domain, incentive note, evidence tag, boundary
conditions and verdict. Contradictions remain visible.

## 3. Corroborate

For each plausible practitioner claim, find a current primary platform source
that supports, limits or contradicts the mechanism. Then inspect the current
repository, anonymized dataset or workflow that would be changed.

Classify each lead:

- `already handled`: current evidence shows the process already does it;
- `watch`: plausible, but a representative population or authority is missing;
- `test`: a safe fixture and business-relevant outcome are available now;
- `reject`: mechanism or evidence fails a named check.

State what observation would change the classification. A lead may enter `test`
only with one external source, one current-workflow artifact and a population
that can measure the claimed effect.

## 4. Execute every selected hypothesis

Read the newest prior marketing-radar reports first. An earlier selected
hypothesis without a verdict is pending work and takes priority.

Select at most three hypotheses. Every selected hypothesis must be executed in
this run. Anything that cannot run now stays `watch`; do not disguise it as an
experiment.

Before results, preregister:

- hypothesis and exact population or fixture;
- primary business outcome plus correctness, cost and guardrail measures;
- adoption threshold, failure signal and rollback;
- held-constant variables and the boundary axes above;
- A: current behavior, B: proposed behavior, C: simpler alternative.

Use the strongest safe test available:

1. Historical replay on anonymized event, campaign or funnel data.
2. Read-only shadow analysis against a current export.
3. Draft-only creative, offer, landing-page or lifecycle variants evaluated on
   a preregistered representative task set.
4. Synthetic fixtures only for pipeline correctness, never for a marketing
   performance claim.

An LLM score, click prediction, aesthetic rating, platform-reported ROAS or
engagement rate does not by itself prove profit, incrementality or qualified
demand. Report the inference boundary explicitly.

Predeclare the sample horizon and analysis. Repeatedly checking a generic
significance calculator inflates false winners; use a fixed final analysis or a
valid sequential-testing correction. Treat Ads Library longevity as a creative
candidate signal only, because ordinary-ad visibility does not expose the
performance outcome needed to call it a winner.

### Safety and isolation

Use a dedicated worktree and `codex/marketing-radar-*` branch for framework
changes. Preserve raw commands, exit codes, elapsed time and evidence paths.

Scheduled runs are read-only toward ad accounts, analytics properties, CRM,
email systems, domains and product repositories. They may create local fixtures,
draft artifacts and reports. They must not publish content, send messages,
change tracking, upload audiences, alter campaigns or budgets, or start spend.
Those actions require fresh explicit authorization and their own rollback plan.

### Verdict

Record A/B/C measurements and choose `adopt B`, `adopt C`, `no winner` or
`reject`. When a workflow variant wins, implement only that variant and run its
targeted tests plus the repository gate.

A scheduled run may push a winning `codex/marketing-radar-*` branch and open a
review PR only when its automation prompt explicitly grants that exact standing
authorization. Interactive runs require fresh push authorization. Never merge,
deploy, tag, release, update installed plugins or mutate a live marketing system.

### Record outcomes and adoption state

After every selected hypothesis has a verdict, write
`.claude/reports/marketing-radar-verdicts-YYYY-MM-DD.json` with
`schema_version: 1`, the exact manifest `run_id`, and one `hypotheses[]` row per
experiment. Each row needs a stable `id`, falsifiable `claim`, manifest
`source_keys`, `verdict` (`adopt-b`, `adopt-c`, `no-winner`, or `reject`), string
measurements under `variants.a/b/c`, `tested_at`, and at least one raw `evidence`
location.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/radar-learning.js" \
  --manifest <manifest-path> \
  --verdicts .claude/reports/marketing-radar-verdicts-YYYY-MM-DD.json
```

Read back the printed HTML, Markdown and JSON artifacts. The ledger is
idempotent and rejects evidence keys outside the collected population. Adopted
winners start as `candidate`; use the same command's `--transition` mode to move
them through evidence-backed `shadow`, `canary`, and dated `default` states.
Every default needs `--revalidate-by`; expired defaults are `stale` until they
return to shadow or retire.

Discovered source hosts are proposals only. Add one to the source registry only
after provenance, feed stability and useful yield have been measured across
three runs. Discovery must never edit a registry automatically.

## 5. Report and review

Write `.claude/reports/marketing-radar-YYYY-MM-DD.md` with:

1. Population and source health, by authority and category.
2. Primary platform changes plus independent/trade leads kept separate.
3. Video audience feedback with comment sampling and exclusions.
4. Claim ledger with incentives and boundary conditions.
5. Executed A/B/C experiments, maximum three.
6. Already handled, rejected and contradictory claims.
7. Watch list and missing populations or authority.
8. Winning branches and review PRs.
9. Learning ledger changes, adoption lifecycle and proposed source discoveries.

The count of selected hypotheses must equal the count with executed verdicts.
Zero is valid when no lead is both relevant and safely testable.

After the report is complete and any PR is remotely readable, mark the exact
manifest reviewed:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/framework-radar.js" \
  --mark-reviewed <manifest-path>
```

Completion: report totals cross-foot, every selected hypothesis has a verdict,
all proxy limitations remain explicit, the user-facing HTML/Markdown/JSON
artifacts exist, and the review heartbeat matches the changed-item population.
