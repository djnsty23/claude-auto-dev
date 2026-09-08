# Is the memory store ever recalled? Measured 2026-09-08

The autodev-memory plugin captures an observation on most tool calls and, at
session start, injects one line telling the model the store exists. The ECC
comparison of 2026-09-07 scored both memory systems 6 and left the question
this document answers unmeasured: **does anything ever read the store back,
and would injecting more of it at session start help?**

Short answer: no, and no. Across 281 transcripts there is one genuine query,
it was malformed, and it returned nothing. Of a 40-row sample, zero rows hold
a fact a later session would need and could not get from git in a minute.
Ranked injection at 2 KB or 8 KB, built and run against the four real
project paths, injected zero such facts and 28 of 40 (2 KB) or 118 of 154
(8 KB) lines that mislead. The deliverable is this record and a pruning
proposal, not a new hook. `rule-ab-testing` rule 5 applies throughout: a zero
from a search is a claim about the search, so every count below carries the
population it was taken from and the command that produced it.

The three product repos in the store are labelled P1, P2, P3 here rather than
named, so this file passes the private-name gate on a machine that is not this
one. P1 is the largest (2,687 observations), P2 has 1,214, P3 has 724.

## The store, at the time of measurement

`~/.claude/auto-dev-memory.db`, read with `sqlite3 -readonly`. Nothing in this
session wrote to it: the hook runs below went through a `.backup` copy under a
sandboxed `HOME`.

| | count |
|---|---|
| observations | 6,072 (5,814 on 2026-09-07; the brief's figure) |
| sessions | 477, of which 396 have an `end_time` |
| oldest / newest observation | 2026-08-18 10:38 / 2026-09-07 21:13 (21 days) |
| by type | discovery 5,152 · change 503 · feature 239 · bugfix 143 · refactor 18 · decision 17 |
| by project | P1 2,687 · autodev 1,447 · P2 1,214 · P3 724 |
| `raw_data` non-empty | 0 |
| `sessions.user_request` non-empty | 0 |
| `sessions.learned` non-empty | 0 |
| `sessions.next_steps` non-empty | 121, every one of the form `N tasks remaining: <story ids>` |
| sessions with `project_path` = the home directory | 203 of 477 |

The `learned` column the session-start hook reads and fences has never been
written. `next_steps` is the pending-story list from `prd.json`, which
`summarise()` in `prd-states.js` produces from the file itself in well under a
second.

## Question 1: is anything ever recalled?

### What would count as evidence, written before searching

Six shapes, so a zero on one cannot be read as a zero on the class:

| | shape | where it would appear |
|---|---|---|
| E1 | a `Skill` tool call whose `skill` names `mem-search`, `mem-dashboard`, `knowledge-agent`, `memory-maintenance` or `memory-backup` | assistant `tool_use` blocks |
| E2 | a user turn invoking `/mem-search` or typing `mem search`, `mem recent`, `mem decisions`, `mem bugs`, `mem timeline`, `mem stats`, `mem why`, `mem sessions` | user messages, `~/.claude/history.jsonl` |
| E3 | a `Bash` call running `memory-db.js` with a read subcommand, `semantic-search.js`, or opening `auto-dev-memory.db` | assistant `tool_use` blocks, `~/.claude/bash-commands.log` |
| E4 | a `Read` of `memory-db.js` or `semantic-search.js` (nearest false-positive shape: reading the code is not recall) | assistant `tool_use` blocks |
| E5 | assistant text quoting the injected line (`Project memory:` or `Last session's next steps`), meaning the injection was at least noticed | assistant messages |
| E6 | a memory session id (`ses_<base36>_<8 hex>`) anywhere in a transcript | any message |

### Population

Every `*.jsonl` under `~/.claude/projects/`, this session's own transcript
excluded because it matches by construction.

| | |
|---|---|
| transcript files scanned | 281 (102 top-level sessions, the rest subagent transcripts) |
| bytes / lines | 481,135,799 / 120,812 |
| date range (first `timestamp` field) | 2026-08-15 23:24 to 2026-09-07 21:14 |
| `~/.claude/history.jsonl` | 11 lines, 0 matches |
| `~/.claude/bash-commands.log` | 2 lines, 0 matches |

The scan: `scan-recall.js` walks the directory, parses each line, and tests
the six patterns against `tool_use` inputs and message text. The script is
reproduced at the end of this document.

### Results, every hit read

| shape | hits | what the hits were, on reading |
|---|---|---|
| E1 Skill call | **0** | |
| E2 user invocation | 3 | all three are tool RESULTS carried in user-role messages: a frontmatter dump of the skill, a changelog, and a grep of the CLI's `case` labels. None is a person or a model asking for recall. |
| E3 Bash read of the store | 31 | 27 are the 2026-08-16 session that moved the memory scripts under `plugins/` and ran vacuity on them; 2 are the 2026-08-28 session that built `mem-dashboard`; 1 is the 2026-09-07 ECC comparison reading the schema for its table. **One** is a genuine query, below. |
| E4 Read of the code | 3 | two from the `mem-dashboard` session, one from a Brain session reading the CLI. Development, not recall. |
| E5 injected line quoted | **0** | no assistant message ever mentioned the `Project memory:` line. |
| E6 session id in a transcript | 1 | a probe in the 2026-08-16 refactor session printing the id it had just created. |

**The one genuine query**, 2026-08-28 17:54, a Brain session working in P2
looking for a conversation that had been captured the day before:

```
node .../memory-db.js search "<first name>" "$HOME/Code/<P2>"
node .../memory-db.js search "partner conversation" "$HOME/Code/<P2>"
```

Both returned `[]`. The CLI takes `search <project> <query>`; this call put the
query in the project slot, so it searched a project called by a first name for
a query that was a path. The skill's own example has the order right. Re-run
the right way round against today's store, read-only: 3 rows match
`partner`, all captured AFTER that query was made (18:45 the same day, and
2026-09-07), and 0 match the name. So the empty answer was correct that
afternoon, by accident, and the session read it as "nothing there" rather than
"the search was wrong". That is the only recall in 21 days, and it is a
negative example of rule 5.

### Sessions with no transcript to check

`sessions` rows and transcripts do not share a key: the carrier file mapping
harness id to memory id is deleted at session end. Joining on `start_time`
within 120 s and a matching normalised cwd:

| | memory sessions | matched to a transcript |
|---|---|---|
| home directory as cwd | 203 | 0 |
| P1 | 101 | 36 |
| autodev | 90 | 57 |
| P3 | 40 | 18 |
| P2 | 35 | 20 |
| scratch cwds from the ECC probe | 8 | 2 |
| total | 478 | 133 |

The 203 home-directory sessions have no transcript at all under
`~/.claude/projects/`: whatever starts them is not writing one there, and they
contribute 0 observations (every observation row sits under a `~/Code` path).
The 134 unmatched project sessions are resumes and compactions (SessionStart
fires on each, creating a new memory session against the same transcript) plus
transcripts since archived. So the transcript population covers roughly a
third of memory sessions by row, and every session whose transcript survives.
A recall in an archived transcript would not show here; see "could not check".

### The 40-row sample

Stratified so every type is read (uniform sampling gives 34 discoveries and
no decisions): decision 6, bugfix 8, refactor 4, feature 7, change 7,
discovery 8, `ORDER BY random()` within type, project restricted to the four
real paths. Ids are recorded so the scoring can be disputed row by row.

Scoring: **(i)** something a later session would need and could not derive
from the code or git in under a minute; **(ii)** derivable; **(iii)** noise.

| # | type | project | date | id | title | score | why |
|---|---|---|---|---|---|---|---|
| 1 | decision | P2 | 2026-08-29 | `obs_mtebeyqs_786fc37d` | Created supabase-js-returns-errors-never-throws.md | ii | records that a memory .md was written; the file itself is the knowledge |
| 2 | decision | P2 | 2026-08-29 | `obs_mteaessj_d80b5ab7` | Decided on HANDOVER.md | ii | a Write to a handover file; git shows it |
| 3 | decision | P2 | 2026-08-29 | `obs_mteaaj4u_036901f9` | Decided on .gitignore | ii | a Write to .gitignore, labelled a decision |
| 4 | decision | P2 | 2026-08-29 | `obs_mteaeor7_7fa349f3` | Decided on README.md | ii | a Write to README, labelled a decision |
| 5 | decision | P2 | 2026-08-29 | `obs_mteb8nb7_a40e6517` | Decided on route.ts | ii | a Write to a route file, labelled a decision |
| 6 | decision | P2 | 2026-08-29 | `obs_mteafxeq_91629c5e` | Decided on DECISIONS.md | ii | a Write to DECISIONS.md, labelled a decision |
| 7 | bugfix | autodev | 2026-08-18 | `obs_msz4tacb_af3b0897` | Created fix_targets.py | iii | scratchpad file, labelled bugfix because the prompt said fix |
| 8 | bugfix | P3 | 2026-08-28 | `obs_mtd7jf6u_18424ac2` | Fixed contrast-tinted-fill.spec.ts | ii | the commit carries this |
| 9 | bugfix | P3 | 2026-08-29 | `obs_mtedh2lq_05c5356e` | Fixed migration-ledger-drift.ts | ii | the commit carries this |
| 10 | bugfix | P3 | 2026-08-29 | `obs_mtedmh3a_979fe37b` | Created no-ci-runs-the-unit-tests.md | ii | memory .md written; the file is the knowledge |
| 11 | bugfix | autodev | 2026-08-18 | `obs_msz3sz9l_7464b743` | Created add_ledger.py | iii | scratchpad file |
| 12 | bugfix | autodev | 2026-08-18 | `obs_msz55brs_575d2f62` | Created msg-appbar.txt | iii | scratchpad file |
| 13 | bugfix | autodev | 2026-08-18 | `obs_msz364rs_cd008b2a` | Created geom-suite.mjs | iii | scratchpad file |
| 14 | bugfix | autodev | 2026-08-29 | `obs_mtebsr8f_20abeeee` | Created project-risk-tiers.md | ii | memory .md written |
| 15 | refactor | P3 | 2026-08-29 | `obs_mtdx7173_15cce399` | Created copyGuard.ts | ii | the commit carries this |
| 16 | refactor | P2 | 2026-08-29 | `obs_mtec8g1y_9c1ef533` | Refactored HANDOVER.md | ii | a handover file edit |
| 17 | refactor | P2 | 2026-08-29 | `obs_mtebq1l1_83091651` | Refactored env-scan.mjs | ii | the commit carries this |
| 18 | refactor | P2 | 2026-08-29 | `obs_mtebp7nm_42ddbbe2` | Refactored route.ts | ii | the commit carries this |
| 19 | feature | P1 | 2026-08-19 | `obs_mszq5jez_c56722c5` | Created desk-b.mjs | iii | probe file under .claude/probe |
| 20 | feature | autodev | 2026-08-18 | `obs_msz1clxt_5098e739` | Created EV-DESIGN-1-quotes.html | iii | scratchpad file |
| 21 | feature | P2 | 2026-08-29 | `obs_mteag2am_da4d9a57` | Added plan-card.tsx | ii | the commit carries this |
| 22 | feature | P2 | 2026-08-29 | `obs_mtef3ngi_1dde9acc` | Added qr-ci-does-not-run-the-gate.md | ii | memory .md written |
| 23 | feature | autodev | 2026-08-18 | `obs_msz2u7un_111df38a` | Created HARNESS-AUDIT.md | ii | a P1 file recorded under autodev; git shows it |
| 24 | feature | autodev | 2026-08-18 | `obs_msz1apiu_3e547ed5` | Created EV-SPEC-2-pillar.md | iii | scratchpad file |
| 25 | feature | autodev | 2026-08-29 | `obs_mte8j2a5_ebad7aaf` | Created SESSION-PROMPTS.md | ii | a file outside any repo, no content recorded |
| 26 | change | P1 | 2026-08-19 | `obs_mszprx7b_99133377` | Build/Deploy: python3 - <<'PY' p='design/MOCKUP-MINE.md' | iii | a python heredoc labelled Build/Deploy |
| 27 | change | P2 | 2026-08-29 | `obs_mtea2i7l_3c5d0d4c` | Build/Deploy: grep -rn "SUPABASE_URL\|supabase.co" | iii | a grep labelled Build/Deploy |
| 28 | change | P2 | 2026-08-29 | `obs_mted9rn6_48088a20` | Modified MEMORY.md | ii | an index edit |
| 29 | change | autodev | 2026-08-28 | `obs_mtd26krr_97b1a72a` | Modified brain-panels.js | ii | the commit carries this |
| 30 | change | autodev | 2026-08-18 | `obs_msyk8e17_27de1c82` | Git: S=/private/tmp/claude-501/... | iii | a truncated shell command echo |
| 31 | change | P1 | 2026-08-18 | `obs_msyzfrkm_94198f0a` | Build/Deploy: npm run deploy -- "progression-shape-ladder" | iii | a deploy command echo, no outcome |
| 32 | change | P1 | 2026-08-29 | `obs_mteed96k_38574207` | Git: git push origin sweep/anchor-batch-1:... | ii | a push; the remote shows it |
| 33 | discovery | P2 | 2026-08-28 | `obs_mtd96py3_c81c7da9` | Ran: sed -n '155,170p' src/app/dashboard/page.tsx | iii | a sed echo |
| 34 | discovery | autodev | 2026-08-29 | `obs_mtea0bcj_fa3a4510` | Ran: grep -rn '\[\${' plugins/autodev-core/scripts/*.js | iii | a grep echo |
| 35 | discovery | autodev | 2026-09-07 | `obs_mtrqqh4c_e2b63df1` | Ran: S=/private/tmp/claude-501/... | iii | an ls echo |
| 36 | discovery | P2 | 2026-08-29 | `obs_mtee3ei7_47fa780e` | Ran: grep -nE "src\|scripts\|readdir\|ROOT\|dirs" scripts/env-scan.mjs | iii | a grep echo |
| 37 | discovery | P1 | 2026-08-18 | `obs_msz9vusr_f9813f7b` | Ran: sed -n '135,250p' docs/lcd/lcd.css | iii | a sed echo |
| 38 | discovery | autodev | 2026-08-18 | `obs_msytrgxc_dd4ed2c5` | Tests passed: python3 - <<'PY' | iii | a python heredoc labelled Tests passed |
| 39 | discovery | P1 | 2026-08-19 | `obs_msztvjn3_2ccb76ac` | Tests passed: SP=/private/tmp/claude-501/... | iii | a shell variable assignment labelled Tests passed |
| 40 | discovery | P2 | 2026-08-28 | `obs_mtd5h56l_1fa356eb` | Ran: python3 - <<'PYEOF' import pathlib | iii | a python echo |

| score | in the stratified 40 | weighted by the store's type mix |
|---|---|---|
| (i) needed and not derivable | **0** | 0 % |
| (ii) derivable from git or disk | 21 | ~8 % |
| (iii) noise | 19 | ~92 % |

Why the rows look like this, from `observation-classifier.js`: the **title**
is a verb plus a basename or the first 60 characters of a command. The
**type** comes from a keyword regex over the user's last prompt, so a session
whose prompt contained "fix" files every Write it makes as a bugfix (88 of 143
bugfix rows are "Created ..."), and one whose prompt said "switch" or "select"
files every edit as a decision (5 of 17). The **concept** field is not a
concept: it is the last prompt, or for `Ran:` rows the first 150 characters of
stdout. 383 rows carry another session's `<cross-session-message>` or a
`<task-notification>` as their concept. Nothing in the pipeline ever writes a
sentence about what was learned, and nothing reads `raw_data`.

The one row that came closest to (i) was #8: its concept quotes a prompt
saying two Playwright specs flake on an unchanged tree, measured across three
runs. That IS a fact worth carrying. But the row records the fix of that
flake, so a fresh session reading it would learn the opposite of the current
state. It scores (ii) because the commit that fixed it says so.

## Question 2: would relevance-ranked injection help?

Q1 said no material exists, but the brief asked for the table and a
recommendation reasoned about is still a hypothesis (rule 7), so the variant
was built and run.

### The variant

A scratch `memory-session-start-ranked.js` (not committed) that, given cwd:

1. takes the last N=400 observations for the normalised project path;
2. runs one FTS5 query over the branch name and the last five commit subjects
   (tokens of four or more characters, minus git noise words, OR-ed);
3. drops any observation whose `source_files` names a path that no longer
   exists;
4. scores `typeWeight × exp(−ageDays/14) × (ftsHit ? 3 : 1)` with weights
   decision 5, bugfix 4, feature 2, refactor 2, change 1, discovery 0.5;
5. emits `- [type] date title — concept(140 chars) (basenames)` lines under a
   byte cap, at most K of them, with a header line.

Three variants, four real project paths, N=7 runs each, median wall time of
the subprocess measured by the caller, `HOME` pointed at a `.backup` copy of
the store. Bytes are the `additionalContext` string.

| variant | project | bytes injected | observation lines | median ms | min ms |
|---|---|---|---|---|---|
| A current one-liner (+ fenced `next_steps` when set) | autodev | 91 | 0 | 166 | 105 |
| | P1 | 692 | 0 (a 9-line fence holding the pending-story list) | 230 | 135 |
| | P2 | 91 | 0 | 250 | 108 |
| | P3 | 695 | 0 (same shape as P1) | 251 | 89 |
| B ranked, cap 2,000 B, K=12 | autodev | 1,971 | 10 | 545 | 387 |
| | P1 | 1,994 | 10 | 422 | 336 |
| | P2 | 1,965 | 10 | 491 | 372 |
| | P3 | 1,995 | 10 | 470 | 376 |
| C ranked, cap 8,000 B, K=40 | autodev | 7,949 | 39 | 570 | 392 |
| | P1 | 7,929 | 37 | 594 | 447 |
| | P2 | 7,982 | 38 | 498 | 321 |
| | P3 | 7,361 | 40 | 499 | 360 |
| no store, A | autodev | 0 (0 B on both streams) | 0 | 141–195 | 81 |
| no store, B | autodev | 0 (0 B on both streams) | 0 | 141 | 81 |
| floor: `node -e 0` | | | | 96 | |
| floor: `node -e 'require("node:sqlite")'` | | | | 119 | |

The machine was carrying other sessions: the `node -e 0` floor of 96 ms is
roughly twice what the 2026-09-07 ECC record measured for the same hook, so
compare within this table, not against that one. B and C cost about 300 ms
over A, from two `git` subprocesses, the FTS query and up to 900 `existsSync`
calls. That is fixable and irrelevant, because of what the bytes contain.

One thing the no-store row hides: "no store" lasts one run. `getDB()` creates
`~/.claude/auto-dev-memory.db` on first use, so the hook never has a no-op
path on a machine where `node:sqlite` loads. The zero bytes are real; the
"nothing happened" is not.

### Every injected line, read

Three categories: **(a)** true, current, and something a fresh session could
act on; **(b)** a true event record with no content beyond what `git log`
gives; **(c)** misleading: a wrong type label, a scratchpad or probe file, a
repeat of a line already in the block, a prompt snippet describing a state the
observation itself changed, or a file recorded under the wrong project.

| variant | project | lines | (a) | (b) | (c) |
|---|---|---|---|---|---|
| B | autodev | 10 | 0 | 1 | 9: `p3.py`…`p11.py` and `mutate.js`, scratchpad files labelled bugfix |
| B | P1 | 10 | 0 | 3 | 7: a scratchpad copy of an autodev test file ×3 recorded under P1, `MEMORY.md` and `prd.json` edits labelled bugfix, a `sed` labelled "Tests passed" |
| B | P2 | 10 | 0 | 2 | 8: the same `Fixed rls-posture.test.ts` line ×7, a prompt describing a false positive the row's own session fixed |
| B | P3 | 10 | 0 | 6 | 4: `.probe-tmp` labelled bugfix, `MEMORY.md` labelled bugfix, the Playwright-flake prompt ×2 attached to the rows that fixed it |
| **B total** | | **40** | **0** | **12** | **28** |
| C | autodev | 39 | 0 | 8 | 31: the ten scratch files, 17 `Ran:`/`Tests passed:` echoes including `git config core.hooksPath` as a passed test |
| C | P1 | 37 | 0 | 6 | 31: six autodev `archive-prd` files recorded under P1, ten git/build command echoes, six `Ran:` echoes |
| C | P2 | 38 | 0 | 8 | 30: the ×7 repeat, 17 `Ran:` echoes, one of which carries a production Supabase host from a captured command line |
| C | P3 | 40 | 0 | 14 | 26: `settings.local.json` ×4 as refactor and bugfix, three production `doppler run … --config prd` command echoes, probe files, the flake prompt ×2 |
| **C total** | | **154** | **0** | **36** | **118** |

The stale-file filter (step 3) removed 0, 8, 6 and 15 rows from the four
pools of 400 before ranking, which is why no line above names a file that is
gone. It did not help: the lines that survive are true and useless, or true
and mislabelled, and the ones with a sentence in them describe the world as
it was before the row's own session changed it. That is the CLAUDE.md
"dated claim" failure delivered mechanically into every session start, and
the 8 KB variant also delivers a production hostname and production secret
manager invocations that a captured prompt happened to contain.

## Pruning, measured first, then done on confirmation

`[executed 2026-09-08, later the same day]` The counts below were taken with
nothing deleted. After the operator confirmed the count on a panel, proposal 7
ran: a `.backup` of the store (7,444 rows, integrity ok) went to
`~/.claude/backups/auto-dev-memory-2026-09-08-pre-prune.db`, then one DELETE
with the predicate reproduced at the end of this section removed **6,972 of
7,480 rows, leaving 508**, followed by a WAL checkpoint. The store had grown by
36 rows between the backup and the delete because other sessions were still
capturing with the installed build, so any of those 36 that matched the
predicate are not in the backup. Restore is one `cp` of the backup over the
database with the `-wal` and `-shm` files removed.

Before that, nothing was deleted. `cleanup(90)` exists in `memory-db.js` and has
nothing to delete: the store is 21 days old. `memory-audit.js` and the
`memory-maintenance` skill audit the markdown memory files under
`~/.claude/projects/*/memory/`, not this database. No suite or script grades
the sqlite store's contents.

| shape | rows | of 6,072 |
|---|---|---|
| title is a command or file-read echo (`Ran:`, `Tests`, `Read`, `Git:`, `Build/Deploy:`, `Dependency:`) | 5,493 | 90 % |
| exact-duplicate title within the same project, beyond the first | 1,785 | 29 % |
| title or `source_files` under a scratchpad or `/tmp/claude-501` path | 911 | 15 % |
| `source_files` set and every listed file gone | 294 of 903 with files | 33 % of those |
| of the gone files under a `.claude/worktrees/` path, present at the main checkout path | 63 of 102 | |
| `source_files` under a different `~/Code/<repo>` than `project_path` | 60 | 1 % |
| concept is another session's `<cross-session-message>` or a `<task-notification>` | 383 | 6 % |
| title is a production `doppler … prd` command | 72 | |
| title or concept carries a Supabase host | 6 | |
| title or concept carries a JWT-shaped string (one `gh pr view --json` echo; not verified to be a secret) | 1 | |
| WAL file | 13.4 MB against a 5.2 MB database; nothing checkpoints | |

**Proposal, in order of what it removes.** Each is a change to capture, so
the store stops filling with the shape above, followed by one deletion by
shape rather than by age. All need the count re-taken on the day and the
deletion run by a person after reading a sample:

1. Stop recording `Ran:`, `Tests`, `Read`, `Git:`, `Build/Deploy:` and
   `Dependency:` echoes. `classify()` returns null for them. Removes 90 % of
   future rows and the entire `discovery` type as it currently exists.
2. Stop recording writes under a scratchpad, `/tmp`, `.claude/probe`, or a
   `.claude/projects/*/memory` path (the memory file IS the memory). Removes
   the 911 and the 66 memory-dir rows.
3. Store the observation's own description in `concept`, never the prompt,
   and never a `<cross-session-message>`. Until something writes a
   description, leave it null rather than filling it with the wrong text.
4. Derive `type` from what the tool did, not from a keyword in the prompt. A
   Write is a `change` unless something says otherwise.
5. Dedupe on `(project_path, title)` within a session at capture time.
6. Make the CLI refuse a swapped `<project> <query>`: if the second argument
   is not an existing directory and the third one is, say so and exit 1
   rather than searching a project called by the query.
7. Then, once: delete rows matching 1 and 2, with the count printed first.
   Today that is about 5,900 of 6,072 rows, which is the honest size of the
   store.

Whether the remaining rows justify keeping the capture hooks at all is a
separate measurement: they are `Created`/`Modified`/`Fixed` records of real
repo files, which `git log --stat` already holds.

The predicate the prune ran with, so the deletion can be disputed row by row
against the backup:

```sql
title LIKE 'Ran: %' OR title LIKE 'Tests %' OR title LIKE 'Read %' OR title LIKE 'Git: %'
OR title LIKE 'Build/Deploy: %' OR title LIKE 'Dependency: %' OR title LIKE 'Searched for %'
OR title LIKE '%scratchpad%' OR title LIKE '%/tmp/claude-501%'
OR source_files LIKE '%scratchpad%' OR source_files LIKE '%/tmp/claude-501%'
OR source_files LIKE '%/.claude/probe/%' OR source_files LIKE '%/.claude/projects/%'
```

## Decision

Keep the current one-liner. Do not ship ranked injection at any cap. Record
this and the pruning proposal; leave the store untouched.

The ECC comparison's "memory: 6 v 6" stands corrected to: ECC injects 8 KB
of the same kind of material and nobody has measured whether it is read; this
plugin injects 91 bytes that nobody has read either. Level, and both at zero.

## Could not check

- **Archived transcripts.** 134 project sessions in the store have no
  surviving transcript; a recall in one of them is invisible here.
- **The 203 home-directory sessions.** No transcript, no observations, no
  known launcher. They are a third of the sessions table and nothing in this
  session explains them.
- **Other machines.** The store and the transcripts are per machine. A
  second machine's store was not read.
- **Subagent recall.** Subagent transcripts were scanned (179 of the 281
  files), but a subagent that queried the store through a tool not named
  here would be missed.
- **Whether the injected line changes model behaviour.** E5 counts the line
  being quoted, not read. A model can read a line and never mention it. The
  test would be an A/B over sessions with and without the line, which this
  session did not run.
- **The 40-sample's (ii) scores** assume the relevant commit exists. Row 23
  and the six autodev files under P1 in variant C show `project_path` is the
  cwd, not the repo the file belongs to, so "git shows it" may mean a
  different repo's git.
- **The JWT-shaped row** was counted, not opened. Its title is a `gh pr view
  --json` echo, so it is most likely a GitHub node id; verify before treating
  it as a leak.

## Reproduce

Population and the six shapes (paths relative to `$HOME`):

```bash
sqlite3 -readonly ~/.claude/auto-dev-memory.db "select count(*) from observations; select type,count(*) from observations group by 1"
find ~/.claude/projects -name '*.jsonl' | wc -l
```

`scan-recall.js`, as run (the session id excluded is this session's):

```js
const fs = require('fs'), path = require('path');
const ROOT = path.join(process.env.HOME, '.claude', 'projects');
const files = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
  const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.jsonl')) files.push(p); } })(ROOT);
const E = { E1: 0, E2: 0, E3: 0, E4: 0, E5: 0, E6: 0 };
const text = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.map(b => b.text || (b.content && text(b.content)) || '').join('\n') : '';
for (const f of files) for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
  let o; try { o = JSON.parse(line); } catch { continue; }
  const m = o.message; if (!m) continue;
  if (Array.isArray(m.content)) for (const b of m.content) {
    if (b.type !== 'tool_use') continue; const inp = b.input || {};
    if (b.name === 'Skill' && /mem-search|mem-dashboard|knowledge-agent|memory-maintenance|memory-backup/.test(String(inp.skill))) E.E1++;
    if (b.name === 'Bash' && (/memory-db\.js"?\s+(search|semantic|recent|decisions|bugs|timeline|sessions|stats|knowledge|dashboard)\b/.test(inp.command || '') || /semantic-search\.js|auto-dev-memory\.db/.test(inp.command || ''))) E.E3++;
    if (b.name === 'Read' && /memory-db\.js|semantic-search\.js/.test(String(inp.file_path))) E.E4++;
  }
  const t = text(m.content);
  if (m.role === 'user' && (/<command-name>\/?(mem-search|mem-dashboard|knowledge-agent|memory-maintenance)/.test(t) || /\bmem (search|recent|decisions|bugs|timeline|stats|why|sessions)\b/i.test(t))) E.E2++;
  if (m.role === 'assistant' && /Project memory:|Last session's next steps/.test(t)) E.E5++;
  if (/\bses_[0-9a-z]{6,}_[0-9a-f]{8}\b/.test(t)) E.E6++;
}
console.log(files.length, E);
```

The pruning counts:

```bash
sqlite3 -readonly ~/.claude/auto-dev-memory.db "select sum(c-1) from (select project_path,title,count(*) c from observations group by 1,2 having c>1)"
sqlite3 -readonly ~/.claude/auto-dev-memory.db "select count(*) from observations where title like '%scratchpad%' or title like '%/tmp/claude-501%' or source_files like '%scratchpad%' or source_files like '%/tmp/claude-501%'"
sqlite3 -readonly ~/.claude/auto-dev-memory.db "select substr(title,1,instr(title||' ',' ')-1) p, count(*) from observations group by p order by 2 desc"
```

Hook timing used a `.backup` copy of the store under a sandboxed `HOME`,
`CLAUDE_PLUGIN_ROOT` pointed at `plugins/autodev-memory`, a `{cwd, session_id}`
payload on stdin, seven runs per path, wall time around `spawnSync`.
