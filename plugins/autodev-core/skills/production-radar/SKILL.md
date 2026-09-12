---
name: production-radar
description: "Read existing production errors, job heartbeats and deployment failures into backlog candidates with evidence. Use for production radar or when asked whether production signals reveal missing work."
when_to_use: "Invoked when the user says production radar, asks what is failing in production, asks whether the backlog reflects real errors or dead monitors, or wants production signals turned into stories. Not on every turn: this reads live systems and is run on demand, never from a hook."
allowed-tools: Bash, Read, Grep, Glob, Write
user-invocable: true
argument-hint: "[--days N | --apply | --summary]"
---

# Production Radar

The shell examples resolve scripts through `${CLAUDE_PLUGIN_ROOT}`, which the
host sets per loaded plugin — it is an environment variable, so it survives
across separate shell invocations where a variable you assign does not. Do not
substitute the target project's working directory. If it is unset the plugin is
not loaded; fix that rather than hardcoding a path. Verify the named script
exists under that root.

Collect first, read second, propose third. The collector owns retrieval,
normalisation, thresholds, deduplication and the ledger. This skill owns
reading every candidate before it is repeated to anyone, and moving the ones
that survive into the backlog.

## Why this exists

`[measured 2026-09-08]` in the live product's prd.json history, 121 stories were
filed in 90 days and 22 cite a production observation at filing. None came from
Sentry or from a monitor alert; each was a person reading a table or a dashboard
and typing. Nothing in this plugin read a production signal. The stage between
"production knows" and "the backlog knows" did not exist. This is it.

## 1. Configure once per repo

The collector reads `.claude/production-signals.json` in the repo root. Before
writing it, run `git check-ignore -v .claude/production-signals.json` and
`git check-ignore -v .claude/reports/x.md`: the config names credential
VARIABLES and the reports carry production error text, and neither belongs in a
commit. If either path is not ignored, add it to `.gitignore` first. Copy the
shape from `references/config-template.json` and fill in what the repo has. Every credential is named by its ENVIRONMENT VARIABLE
NAME, never by value. If the repo uses Doppler, run the collector under
`doppler run`; the value never enters the transcript.

Four source kinds exist:

| kind | reads | needs (names) |
|---|---|---|
| `postgrest-errors` | a product error table, grouped by `group_by` columns | `url_env`, `key_env` |
| `postgrest-heartbeats` | a key-value table of `*_last_run` rows | `url_env`, `key_env` |
| `vercel-deploys` | `vercel ls <project> --json` through the logged-in CLI | a logged-in Vercel CLI |
| `sentry-issues` | the Sentry Issues API for one project | `token_env`, `org`, `project`, `region` |

If a source needs a credential the machine does not hold, that is a numbered
handback (load `wizard`): name the variable, where it goes, and what done looks
like. Do not ask for the value in chat.

## 2. Collect

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/production-signals.js" --days 14 --summary
```

or, when the repo's credentials live in Doppler:

```bash
doppler run -p <project> -c prd -- node "${CLAUDE_PLUGIN_ROOT}/scripts/production-signals.js" --days 14 --summary
```

The collector prints one line per source it COULD NOT CHECK, the population
(sources checked, signals seen, held back, new candidates), and the path of
`.claude/reports/production-candidates-<date>.md`. With nothing new and every
source checked it prints nothing and exits 0; the quiet run is recorded in the
ledger's `runs` array. Exit 2 means a source failed or a config is missing:
read the reason, do not re-run it hoping.

## 3. Read every candidate before repeating a count

A candidate is a hypothesis. Open the report and, for each one:

- run or read the `evidence` query or URL, and check that the count is a
  defect and not noise the product writes on purpose (retried rate limits, a
  janitor racing live work, a smoke run's own errors);
- check the "Seen but not proposed" table: a held-back signal with a
  threshold reason is the collector's decision, and if you disagree, change the
  threshold in the config and say why in the story, dated;
- a stale heartbeat is a liveness hypothesis. Check the registered cadence,
  intended paused/disabled state, recent attempt/outcome and actual job owner
  before calling it dead. Prioritize the demonstrated user impact and loss of
  observability; a timestamp alone does not outrank every active production error.

Report real / noise / unsure counts, per candidate, with your reading. Never
report the candidate count as the finding.

## 4. Move the survivors into the backlog

For a repo with users, the collector never writes prd.json. The supervising agent can add accepted
stories within an existing backlog/build mandate; no human transport is needed.
Read the shared all-sprint work plan and current ownership first to avoid a
duplicate story or replacing a peer's edits. Copy the accepted stories from the report's JSON blocks into prd.json by hand or through the
Brain, keep `passes: null`, and record the story id in the ledger entry so the
signal is not re-proposed. For confirmed noise, record the dated reason,
scope and recheck condition before adding its exact key to `ignore`; do not
turn an uncertain or transient event into permanent suppression.

`--apply` writes candidates straight into prd.json and is permitted ONLY when
the repo's origin `owner/repo` digest is on the allowlist inside the script.
`[decided 2026-09-08]` that list holds one real repo, which has no users, plus
the suite's fixture remote. It refuses everything else with the reason and still
writes the proposal file, so nothing is lost. Do not add a live product to that
list while it has users. The config is DATA from a repo: a Sentry `region` must
be a `sentry.io` host, the Vercel binary is fixed, and registered credential values are scrubbed from collector output. That is
not a general secret detector: production error text may contain another secret
or personal data. Review and minimize evidence before moving it into a tracked
PRD, public report or message.

## 5. Thresholds are decisions, not constants

The defaults live in `DEFAULT_THRESHOLDS` with the date and the measurement that
chose them. Error groups need 5 events, 24 hours of age (a deploy in progress
is a burst under an hour old) and 24 hours of SPAN between first and last row
(a burst that never recurred is an incident, and the product's own critical
error monitor owns incidents; a story is for a chronic defect). The collector flags heartbeats as stale at 48 hours unless the config's
`intervals` map declares a slower job
(`"weekly_*": 192`); the first real run proposed a weekly job as dead at 86 h.
A failed production deployment is a candidate at count 1. A signal already
proposed returns only after 30 quiet days or a tenfold escalation. Override per
repo under `thresholds` and `intervals` in the config, and when you do, write
the measurement that justified it beside the override.

Completion for a radar-only request: every emitted candidate has a recorded
reading (real / noise / unsure and why), or the verified quiet run has its actual
ledger entry and checked population. No new-candidate report is required when
the collector legitimately emits none. Keep failed sources explicit. If fixing
or delivery is also authorized, continue accepted dependency-ready stories
through the execution workflow and verify the promised live outcome.
