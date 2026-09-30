# PLAN: archive finished records out of the unattended ledger

## S1 Goal and constraints

`unattended-worker.js` keeps every finished record in `~/.claude/autodev/unattended-workers.json` until its task id is reused. Every `status`, `ready`, brain-judge tick and fleet-view refresh parses a file that only grows, and the fleet board lists months of finished runs. This change adds `unattended-worker.js archive`, which moves finished records older than 30 days into one archive file per month and removes them from the ledger.

- Nothing that can still change state leaves the ledger.
- A record leaves the ledger only after its archived copy has been read back.
- A rerun after a crash at any step converges on the same files.
- An archived id is no longer in the ledger, so `verdict`, `settle` and the other per-task commands answer `unknown-task` for it, and `enqueue --after` refuses it with `unknown-dependency`, as for any unknown id.
- Non-goals: the headless ledger, the brief and report files under `reports/<task id>/`, and a restore command. `brain-judge.js compare` keeps reading the live ledger, so it covers the unarchived window.
- Output keeps the script's contract: `{"ok":true,"value":{...}}` exit 0, `{"ok":false,"error":{...}}` exit 1.

## S2 Inputs and writers

- The ledger comes from `--ledger <file>`, default `defaultLedger()`. The archive directory comes from `--archive-dir <dir>`, default `archive/` beside the ledger, so a suite with a temp ledger never touches the home directory.
- Writers today: `brief`, `enqueue`, `record`, `settle`, `deleted`, `retire`, `launch` and `verdict`. Each holds `<ledger>.lock` through `withLock` around its read, its change and `writeLedger`. Brain turns and the operator run any of them, and the Brain clock runs `settle`, `verdict` and `launch` through `brain-judge.js tick`.
- Readers: `status`, `ready`, `brain-judge.js` and `fleet-view.js`. They read without the lock, which `writeLedger`'s temp file and rename make safe.
- An unreadable ledger stops the job with `ledger-unreadable`, as every other command does. A missing ledger means there is nothing to archive.

## S3 Eligibility

A record is eligible when all four hold:

1. Its state is `closed`, `deleted` or `retired`. `queued`, `composed`, `started` and `settled` are ACTIVE and stay. A `settled` record still waits for `deleted`.
2. Its end timestamp (`settledAt` for closed, `deletedAt` for deleted, `retiredAt` for retired) is more than 30 days before now. A missing or unparseable end timestamp keeps the record, listed under `kept`.
3. A `closed` or `deleted` record carries a verdict, or its end is more than 90 days back. The judge reads unjudged records from the live ledger only, so an unjudged record stays for it.
4. No queued task still names it in `after`. `planStarts` reads a missing dependency as blocked with the reason `no ledger record`, so archiving one would strand its dependent. Dependencies are named at enqueue time, so this scan reads the queued records whose `queuedAt` falls inside the same 30 days.

Eligible records are taken oldest end first, at most 500 per run. The archive key of a record is `<taskId>@<end timestamp>`: task ids are reused (`worker-<slug>` by default) once the earlier record is final, and the end timestamp keeps two runs of one id apart.

## S4 Write the month files

- The job takes `<archive dir>/.lock` with the same `wx` pattern and stale rule as `withLock`, and holds it from S3 to S6, so two archive runs never interleave.
- Records are grouped by the UTC month of their end timestamp into `unattended-workers-YYYY-MM.json`, shaped `{"version":1,"entries":[{"key","archivedAt","record"}]}`.
- For each month the job reads the file (absent means no entries), puts each record under its key, replaces an entry already under that key with the ledger's copy, then writes a temp file and renames it. The ledger stays the source of truth until S6, so a rerun after a crash rewrites the same entries.
- A month file that exists but does not parse stops the job with `archive-unreadable` before any write.

## S5 Read-back proof

- After each rename the job reads the month file again and checks that every key it wrote this run is present, holding a record deep-equal to the ledger copy it archived.
- A missing or different entry stops the job with `archive-verify-failed`, naming the keys. The ledger is not touched.
- If the read itself throws (on Windows an antivirus scan or the search indexer can hold a just-renamed file open for a moment), the job records `archive-verify-skipped` with the file and the error in its output and goes on to S6, since the write in S4 completed without error.

## S6 Remove from the ledger

- The job re-reads the ledger here rather than reusing its S3 copy, so it sees records that changed during S4 and S5.
- It removes each record whose key was written in S4 and whose content still equals the archived copy. A record that changed meanwhile (a verdict replaced by the Brain, say) stays, and the next run copies its new content over the archived entry.
- `version` and every other top-level field are kept as they are.
- It writes the result with `writeLedger`, a temp file then a rename, so a reader never sees a half-written ledger.
- Output: `moved` per month file, `kept` with reasons, `verifySkipped`, and the record count before and after.

## S7 Scheduling and flags

- `brain-judge.js tick` gains a fourth step, archive, after start. It runs on the first tick after 03:00 local time each day, recorded as `archiveDay` in the brain-judge `state.json`, and only when at least 30 s of the tick budget remain.
- `switch` gains `--archive off|dry|live`. An absent switch file means dry, as for judge and start. Dry runs `archive --dry-run`, which prints the plan and writes nothing.
- `status` gains `archived`: the month files it found and their entry counts. A month file it cannot parse is listed as unreadable, and the ledger is still printed.
- USAGE gains the `archive` line, so `--help` and `check:entrypoints` keep passing.

## S8 Tests

`tooling/test-unattended-archive.js`, driven as a subprocess like `tooling/test-unattended-worker.js`, against a temp ledger and archive directory, with now injected through `AUTODEV_ARCHIVE_NOW`:

- Each state: `closed`, `deleted` and `retired` past 30 days move. `settled`, `started`, `queued` and `composed` stay, and so does a closed record 29 days old.
- The verdict rule at 31 and 91 days, and a missing end timestamp listed under `kept`.
- The dependency keep, with a dependent queued yesterday.
- A reused task id with two end timestamps, landing as two entries in one month file.
- The rerun: stop the job after S4 through a test hook, rerun, and compare both files to a clean run.
- A month file that does not parse, and `--dry-run` leaving both files byte-identical.
- The switch default and the once-a-day rule, in `tooling/test-brain-judge.js`.
