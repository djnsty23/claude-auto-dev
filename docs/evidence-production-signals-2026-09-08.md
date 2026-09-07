# Production signals → candidate stories: what exists, what was built, what one real run found

`[measured 2026-09-08]` on this machine, read-only against the live product. Product
names are withheld because this repo is public; they are referred to as **A** (the
live product, roughly 3k MAU), **B** (the QR product, no users) and **C** (the
personal fitness app, no users). Nothing below was typed into a chat as a credential
and no credential value was printed; every variable is named, never valued.

## 1. Why this stage was missing

Across `plugins/autodev-core/skills`, before this change, "sentry" appeared only in
`setup-project`, "uptime"/"monitor" only as mentions in `brain` and `setup-project`,
and no skill or hook read a production signal. The Brain capability analysis on
PR #181 (`RESUME.md` step 6 there) named this as the stage that does not exist; its
stage table is still a scratchpad file (`brain-idea-to-production-2026-09-07.md`)
and is not under `docs/`, so there is nothing to update here yet. ECC has no
equivalent; its canary-watch skill is prose.

## 2. Baseline: how many production observations reached the backlog by hand

Method: for product A, every commit touching `prd.json` since 2026-06-10 (90 commits
in 90 days) was replayed and the first appearance of each story id recorded. 121 of
the 213 current stories were filed in the window. Each was then READ, not counted:
a first keyword pass matched "monitor" on accessibility stories and "dashboard" on
admin-page bugs, so the count below is from reading the filing text of all 121.

| origin of the story, at filing | count | examples |
|---|---|---|
| production observation, total | **22 / 121 (18%)** | |
| — the product's own error/attempt tables, read by hand via SQL | 10 | 33 client errors from one function; 92 rate-limit rows; 111 × HTTP 401 from one cron |
| — Search Console or field CLS beacons, read from a dashboard | 5 | 280 indexed vs 4,880 not; /auth p75 CLS 1.485 |
| — deploy or release-gate health | 3 | last 3 release-gate runs failed; smoke fails on a transient 502 |
| — other live observation (an admin-page error, a live probe of a rate limiter, prod content) | 4 | |
| **from Sentry** | **0** | Sentry appears in 4 stories only as a DESTINATION for alerts |
| **from a monitor alert** | **0** | |
| **from an MAU or analytics figure** | **0** | |
| code reading, audit, tests, config | 94 | |
| audit finding measured against the live DB at filing (grants, RLS), not an error/usage signal | 5 | |

Borderline, counted as code reading: five stories whose RESOLUTION carried a
production measurement (a 90-day count of one row; a paywall funnel of 331 → 17 → 1)
but whose filing was an audit. Counting those makes it 27 / 121.

So the baseline "signals reaching the backlog today" is 22 in 90 days, all
hand-typed, none from the two channels the product pays for (Sentry, monitors).

## 3. What each product already emits, and how a script reads it

### Product A (live)

| source | present | how a script reads it | credential NAME | on this machine? |
|---|---|---|---|---|
| Sentry SDK (browser, Vercel Node, Deno edge) | yes, three runtimes initialised | write-only from the app | `VITE_SENTRY_DSN`, `SENTRY_DSN` | n/a |
| Sentry Issues API | yes; the repo has its own admin proxy over it | `GET /api/0/projects/<org>/<project>/issues/?query=is:unresolved&statsPeriod=14d` | `SENTRY_AUTH_TOKEN` (`event:read project:read`) | **NO** — not in Doppler `prd` (44 names, only the DSN), not in shell env, no `~/.sentryclirc`, no `sentry-cli`. HANDBACK 1 |
| `server_errors` table (`function_name`, `error_code`, `message`, `resolved`) | yes | PostgREST GET, paginated | `VITE_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | **yes**, via `doppler run` |
| `client_errors` table (`error_type`, `message`, `url`) | yes | same | same | **yes** |
| cron heartbeats: 32 `*_last_run` rows in a key-value table, `value->>'at'` | yes; peer-checked, alerts to Sentry + throttled email | PostgREST GET with `key=like.%_last_run` | same | **yes** |
| the repo's own critical-error gate script (10 rows / 30 min, blocking) | yes, on a GitHub schedule | already runs; not a backlog writer | same | — |
| Vercel deployments | yes | `vercel ls <project> --json` | logged-in CLI | **yes** |
| Vercel Analytics + Speed Insights, GA4 (id lives in a DB row), first-party analytics tables, Lighthouse runs table | yes | dashboards; the tables via PostgREST | service role for tables; none for the vendor dashboards | tables yes; vendor APIs no |
| Google Search Console | verification meta only; **no API client anywhere** | would need the Search Analytics API | a GSC service account — no such name exists in any repo | **NO**. HANDBACK 2 |
| pg_cron | SQL-only jobs; the HTTP-posting ones were retired (0% lifetime success) | `cron.job_run_details` via the management API | `SUPABASE_ACCESS_TOKEN` | in the repo's GitHub secrets, not needed here |

### Product B (QR)

No Sentry, no health route, no monitor commit, **no prd.json** (work is tracked in
markdown). Live signals: Vercel Web Analytics (wired, dashboard-only), scan tables
and a Stripe event ledger with a partial index for stuck rows, both behind the
Supabase management API with `SUPABASE_ACCESS_TOKEN` — which B's own scripts fetch
from **A's** Doppler config, not B's (B's `prd` holds 11 names, none of them a
Supabase URL or service key). GA4/GTM is wired but inert (container id unset).
Search Console property is not verified, by the repo's own notes. Vercel deploys
readable via the CLI. `.claude/reports/` would be gitignored (`.gitignore:48`).

### Product C (personal)

No Sentry; Firebase Crashlytics on native iOS/Android (console-only). Web errors go
into a first-party `events` table whose base table is RLS insert-only; the readable
surface is 11 `usage_*` views via the management API with a per-product management
PAT held under one Doppler name (`supabase/prd`). Vercel Analytics live,
dashboard-only. 18 Vercel crons + 3 scheduled workflows. `prd.json` exists (flat,
9 stories, `S4-` prefix). Read only in this session, as instructed.

### `.claude/reports/` is gitignored in all three

`git check-ignore -v` on the candidates file and the ledger path: A `.gitignore:73
.claude/`, B `.gitignore:48 .claude/`, C `.gitignore:101 **/.claude/`. The ledger and
proposals never ship.

## 4. Handbacks (recorded, not requested in chat)

1. **Sentry read token for A.** ~3 min. Sentry → Settings → Auth Tokens → create a
   token with `event:read` and `project:read` only → `doppler secrets set
   SENTRY_AUTH_TOKEN --project app-<A> --config prd` from a silent prompt (the
   `wizard` skill's `read -rsp` shape). Done looks like: `doppler secrets --only-names
   -p app-<A> -c prd | grep SENTRY_AUTH_TOKEN` prints the name. Then the `sentry`
   source stops printing `COULD NOT CHECK`.
2. **Search Console API access for A** (and B once verified). ~15 min, Google Cloud
   console: enable the Search Console API, create a service account, add its email as
   a user on the property, store the JSON key under one Doppler name. No adapter
   exists yet; this handback records what one would need. Not built: the baseline
   shows 5 GSC-originated stories in 90 days, all from dashboard reads, so it is the
   second-largest hand-typed channel after the error tables.
3. **A prd.json for B** before `--apply` can do anything there. The collector
   refuses to invent one.

## 5. Design, against the five failure modes

| failure mode | design | suite case |
|---|---|---|
| (a) a story per noisy event | unit is the Sentry ISSUE, the `(function_name, error_code)` GROUP, the heartbeat KEY, the DEPLOYMENT; `min_count` | "12 events of one group produced ONE candidate" |
| (b) a stale story re-proposed | ledger under `.claude/reports/` keyed `source:id`; re-proposed only after 30 quiet days (regression) or a 10× count (escalation) | second identical run: zero bytes both streams, report not rewritten; requiet and escalation cases |
| (c) writing into a live prd.json | never without `--apply`; `--apply` checks a sha256 allowlist of the origin `owner/repo` (one entry, B) and refuses everything else with the reason, still writing the proposal file | live-remote refusal, prd byte-identical; allowlisted apply; no-prd refusal; no-remote refusal |
| (d) a deploy in progress or a flake | `min_age_hours 24` (first row must be a day old), `min_span_hours 24` (first→last must span a day), `ignore` patterns | 40 rows under 2 h held; 60 rows in 9 min held as a burst; ignore glob |
| (e) secrets in the ledger or proposal | every `*_env` value is registered for redaction before any source runs, and candidates themselves are scrubbed before `--apply` | canary in env AND in a fixture message: absent from stdout, stderr, report, json, ledger, applied prd.json; present as `[REDACTED]` |

Also: a source that cannot be checked is named on stderr with exit 2 and recorded
in the ledger run; a quiet run writes only the ledger; `--summary` prints the
population on demand; no hook wires it (asserted in the suite).

**The suite found a real defect on its first run.** The canary planted in a fixture
error message came out of `--apply` inside prd.json: the rendered report and the
ledger were scrubbed, the candidate OBJECTS were not. Fixed by scrubbing the
candidates before anything consumes them. Everything downstream of that point had
looked correct.

## 6. The real run, read-only, product A, 14 days

Run from a scratch directory with `--config`, `--reports-dir` and `--prd` pointing
outward, under `doppler run -p app-<A> -c prd`, so the live repo received no
writes. Two client-error groupings were run side by side as an A/B on the grouping
key. Sentry was configured deliberately so its failure would be recorded.

```
COULD NOT CHECK sentry: env SENTRY_AUTH_TOKEN is not set
production-signals: 5/6 sources checked, 65 signals, 52 held back, 13 new candidate(s)
```

### Every candidate, read

| # | signal | count / 14 d | span | reading |
|---|---|---|---|---|
| 1 | research fn, no code: "All Gemini paths failed — no AI provider available" (78 of 84 share it) | 84 | 08-31 → 09-07, continuous | **REAL.** A recurring AI-provider outage class; an incident of this shape is on file from 08-16, no open story. |
| 2 | spotify→youtube converter, no code: "YouTube is rate-limiting… will retry automatically" | 36 | 08-25 → 09-07 | **REAL, regression.** Story S16-AUD-153 closed this row class on 08-21 having established the rows are failures a user saw. Still written at ~2.5/day. The ledger's requiet rule exists for exactly this. |
| 3 | curator-playlist fn / `SPOTIFY_CURATOR_429` (message varies per row: Retry-After seconds) | 484 | 08-25 → 09-05 | **REAL.** The single curator account is rate-limited for hours at a time; S16-AUD-124 fixed the recovery path, not the capacity. Grouping by message would have shattered this into 480 groups; by code it is one. |
| 4 | curator-playlist fn, no code: "All 1 active curator(s) are in a rate-limit cooldown… This is transient" | 729 | 08-25 → 09-04 | **NOISE row** (duplicate of 3): an expected transient state written as a server error 729 times. Same class as S16-AUD-123. The story, if any, is "stop writing it". |
| 5 | spotify→youtube converter / `HTTP_429`: "Spotify is rate-limiting… still limited" (61 of 63) | 63 | 08-25 → 09-04 | **REAL** (user-facing failure after retries), overlapping 3's lockout windows. |
| 6 | analytics-batch fn: "invalid input syntax for type json" | 60 | **9 minutes** on 09-02 | **UNSURE → held after the fix.** A malformed-payload burst, never again. A real validation gap, but an incident, not a chronic defect. |
| 7 | youtube→spotify converter: "Failed to create Spotify playlist" | 6 | 08-27 → 08-30 | **UNSURE.** Low, inside 3's lockout days, nothing since. |
| 8 | analyze-playlist / `HTTP_429` | 5 | **45 minutes** on 08-30 | **NOISE → held after the fix.** One rate-limit burst. |
| 9/11 | client: "get-vibes-collection returned no volumes: Failed to send a request to the Edge Function" (both groupings) | 16 / 17 | 08-25 → 09-07 | **UNSURE, likely residual of S16-AUD-151** (closed 08-14 as a CORS fix). ~1.2/day continues; "failed to send" is the client's network error, so offline/blocked clients are a competing cause. Worth a story that names both. |
| 10/12 | client: "An error occurred processing your request" on the generate page | 16 / 13 | 08-31 → 09-01 (22 h) | **UNSURE.** Generic message; the by-message group spans 21.9 h and is held as a burst after the fix; the by-url group still passes. |
| 13 | heartbeat `weekly_mix_send_last_run` at 86 h | 1 | — | **FALSE POSITIVE.** A weekly job against a 48 h default. |

Distinct signals 11 (two were the A/B duplicate). **Real 4, noise 3, unsure 4.**

### What the reading changed, and the second run

Two knobs did not exist before the reading and do now:

- `min_span_hours 24` for error groups and Sentry issues. Holds 6, 8 and the
  by-message half of 10 as bursts. The product's own critical-error monitor owns
  bursts at 10 rows / 30 min; a backlog story is for a chronic defect.
- `intervals` map for heartbeats (`"weekly_*": 192`), default still 48 h. All 31
  other heartbeats were under 20 h old, so 48 h is right for them and the fix is to
  declare slow jobs, not to loosen the default to eight days.

Second run, same 14 days, corrected config, by-message client grouping only:

```
COULD NOT CHECK sentry: env SENTRY_AUTH_TOKEN is not set
production-signals: 4/5 sources checked, 55 signals, 48 held back, 7 new candidate(s)
```

Held: 15 by `min_count` (the whole population under 5 is 1–3 rows each: a GTM
error, "Script error.", "Load failed", a recovered inbox retry), 3 as bursts (0.1 h,
0.8 h, 21.9 h), 30 heartbeats fresh (max 86 h, the weekly one). Count distribution
of every error group seen: `1×8, 2×6, 3, 5, 6, 13, 17, 36, 60, 63, 84, 484, 729`.
The gap between 3 and 5 means `min_count 5` is not sitting on a cliff here;
raising it to 10 would drop only 7 (6 rows, unsure) and 8 (already held as a
burst).

Of the 7 remaining candidates: 4 real (1, 2, 3, 5), 1 noise-row that points at a
real problem (4), 2 unsure (7, 9). None of the 4 real ones is an open story in A's
backlog today; two are regressions of closed ones, which is the finding the
baseline predicted: signals reach the backlog once, by hand, and nothing tells the
backlog when they come back.

### Grouping key A/B (client errors)

`(error_type, url)` and `(error_type, message)` found the same two top groups (16 vs
17, 16 vs 13). By url merges different messages on one page (13 of 16 shared a
message); by message splits one message across pages but does not fragment on
variable content in this table. The template uses by-message for client errors and
by `(function_name, error_code)` for server errors, where messages carry
Retry-After seconds and would shatter (candidate 3: 2 of 484 rows share a message).

## 7. Not built, and why

- **Search Console adapter.** No credential exists anywhere (handback 2); building
  an adapter nobody can run is the orphan-check failure. The baseline says it is the
  next channel worth adding once the credential exists.
- **A hook.** Reading live systems on every turn is the wrong cost model and the
  brief forbade it; the suite asserts `hooks.json` does not mention the script.
- **Parsing the product's heartbeat registry for intervals.** A TypeScript file in
  another repo is not a stable interface; a config map is, and the product's own
  peer monitors already alert per-interval into Sentry — which is handback 1.
- **Vercel deploy source in the real config beyond a listing.** It ran (READY on
  every production deployment in the window, so zero signals); it stays because a
  failed production deploy is the one signal with no other reader here.

## 8. Reproduce

```bash
node tooling/test-production-signals.js          # 79 checks, hermetic, fixtures only
node plugins/autodev-core/scripts/production-signals.js --help
```

The real run needs the config in §6 (template at
`plugins/autodev-core/skills/production-radar/references/config-template.json`) and
`doppler run` for the two Supabase names. Run it from a scratch directory with
`--reports-dir` and `--prd` pointing at the product, never from inside a live repo.
