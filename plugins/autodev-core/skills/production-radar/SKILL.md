---
name: production-radar
description: "Read the production signals a repo already emits — error tables, Sentry issues, cron heartbeats, failed deployments — and turn the ones that cross a threshold into candidate prd.json stories with the evidence attached. Use when asked what production is saying, whether errors or dead monitors should be in the backlog, or to run the production radar."
when_to_use: "Invoked when the user says production radar, asks what is failing in production, asks whether the backlog reflects real errors or dead monitors, or wants production signals turned into stories. Not on every turn: this reads live systems and is run on demand, never from a hook."
allowed-tools: Bash, Read, Grep, Glob, Write
user-invocable: true
argument-hint: "[--days N | --apply | --summary]"
---

# Production Radar

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

The collector reads `.claude/production-signals.json` in the repo root. That
directory is gitignored in the repos this operator runs, so the config never
ships; copy the shape from `references/config-template.json` and fill in what
the repo actually has. Every credential is named by its ENVIRONMENT VARIABLE
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
- a heartbeat candidate is a dead monitor, which outranks any error group: a
  monitor that is quiet because it died is indistinguishable from a healthy one.

Report real / noise / unsure counts, per candidate, with your reading. Never
report the candidate count as the finding.

## 4. Move the survivors into the backlog

For a repo with users, the collector never writes prd.json. Copy the accepted
stories from the report's JSON blocks into prd.json by hand or through the
Brain, keep `passes: null`, and record the story id in the ledger entry so the
signal is not re-proposed. For the noise, add the signal key to `ignore` in the
config with a dated comment in the story that closed it.

`--apply` writes candidates straight into prd.json and is permitted ONLY when
the repo's origin `owner/repo` digest is on the allowlist inside the script.
That list holds one entry, a repo with no users. It refuses everything else with
the reason and still writes the proposal file, so nothing is lost. Do not add a
live product to that list while it has users.

## 5. Thresholds are decisions, not constants

The defaults live in `DEFAULT_THRESHOLDS` with the date and the measurement that
chose them. Error groups need 5 events, 24 hours of age (a deploy in progress
is a burst under an hour old) and 24 hours of SPAN between first and last row
(a burst that never recurred is an incident, and the product's own critical
error monitor owns incidents; a story is for a chronic defect). Heartbeats are
dead at 48 hours unless the config's `intervals` map declares a slower job
(`"weekly_*": 192`); the first real run proposed a weekly job as dead at 86 h.
A failed production deployment is a candidate at count 1. A signal already
proposed returns only after 30 quiet days or a tenfold escalation. Override per
repo under `thresholds` and `intervals` in the config, and when you do, write
the measurement that justified it beside the override.

Completion: the report exists, every candidate in it has been read, and the
reading (real / noise / unsure, with the reason) is in the reply alongside the
population line. A count of candidates is not a completion.
