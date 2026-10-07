# Learned rules: measured precision

Nine advisory rules in `plugins/autodev-core/scripts/security-checks.js`, wired in `security-gate.js`.
All are `warn`: they print, they do not change the exit code. Build-time defaults for the same classes
and for the ones with no signature are in `plugins/autodev-core/skills/core/references/learned-defaults.md`.

Suite: `tooling/test-security-learned-rules.js`. Each rule has a bad arm (the defect as written, shrunk),
a good arm (the fix as shipped), a mutant arm (a variant a suppressor must still let through) and, where
the rule has a scope filter, a scope arm. The gate's own control also plants each rule on every run.

## Method

A revision of a real repository was exported with `git archive` into a scratch directory and the gate ran
over it with `--root <dir> --json`. The repository was never written to. "Pre-fix" is the parent of the
fixing commit and "post-fix" is the fixing commit. Counts are findings, one per file for the rules that
report per file.

## Pre-fix flagged, post-fix clean

| Rule | Instances flagged pre-fix | Post-fix | Matches the fix |
|---|---|---|---|
| `sql-fk-unindexed` | 3 columns | 0 | All three columns the fix indexed |
| `cron-fetch-no-timeout` | 1 route | 0 | Yes |
| `backup-unbounded-read` | 1 route | 0 | Yes |
| `uncached-stripe-list` | 2 files | 0 | Both files the fix cached |
| `admin-no-role-check` | 1 page | 0 | Yes, the fix added a gate call |
| `esm-inline-require` | 6 files, 9 calls | not available | Matches the count the fix author recorded. No post-fix revision existed in the local clone. |
| `sql-policy-initplan` | 71 files | 27 | The fix landed across three commits. The measured drop covers the first. |
| `select-star` | 38 | 37 | High volume, one fix touched one call. Advisory only. |

## False positives found and fixed by running the corpus

- `admin-no-role-check` flagged 8 of 8 admin entries in one repository whose helper was named
  `isAdminEmail`. The marker list took only exact names. It now takes `isAdmin*`, `requireAdmin*`,
  `assertAdmin*`, `checkAdmin*` and their kin, plus a call to a gate helper such as `passesGate`.
  Result after the change: 0 of 8.
- `admin-no-role-check` missed operator pages that sit outside an `admin` directory. Scope widened to
  `admin`, `debug`, `workers`, `internal` and `staff`.
- `uncached-stripe-list` missed a REST helper form (`stripeApi('prices?...')`) in `lib` files. Scope and
  pattern widened, and a cache marker suppresses it.

## Widened 2026-10-07, measured over 16 local repositories

Old is the 8.182.0 gate, new is this tree, both over the same checkouts.

| Rule | Old | New | Read |
|---|---|---|---|
| `esm-inline-require` | 6 files | 9 files | The 6 are unchanged. The 3 new ones are package `require` calls inside `try` blocks in a `"type": "module"` API run under tsx, where `require` is not defined (tsx 4.21 probe: `require is not defined`). Each catch turns the error into a silent fallback: no-op metrics, no tracing, no OpenAPI request validation. |
| `supabase-types-stale` | new | 8 tables in 2 repos | 7 tables in one generated `database.ts` (5 of them queried by API routes) and 1 in another, used by edge functions. Each is a table the code reads with no column types. |

The first widened run also flagged 2 `tailwind.config.ts` plugin lists. Tailwind loads its config
through jiti, which supplies `require`, so `*.config.*` files are now out of scope. Result after the
change: 0 of 2.

## Open census at current heads

Counts across the local clones, before any triage of the large ones:

| Rule | Count | Read |
|---|---|---|
| `select-star` | 27 to 46 per large repo | Noisy by nature. Wide-row cases are real, narrow-row cases are not. |
| `sql-fk-unindexed` | 1 to 30 per repo | Not triaged beyond the repository the fix came from. |
| `sql-policy-initplan` | up to 71 | Real by definition, since the rewrite is mechanical and safe. |
| `cron-fetch-no-timeout` | 7 in one repo | Each is a fetch with no signal. Whether it hurts depends on the upstream. |
| `uncached-stripe-list` | 12 in one repo | Includes backfill and audit functions that run rarely, where a cache is not wanted. Expect noise there. |
| `backup-unbounded-read` | 1 per repo | One health-monitor read that may be a bounded table. |

## Why none of them blocks

Precision is measured against one repository's fix for each rule, not across the fleet. A rule that
reads a whole file for a suppressor (`select-star` head count, cron timeout, Stripe cache) can miss a
guard written in another module. Promote a rule to `fail` only after a triaged run over the repositories
it would gate shows no false positive that a waiver cannot express. Waive a line with
`security-ok: <reason>`.
