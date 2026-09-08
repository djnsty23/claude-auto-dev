# RESUME — greenfield run session, 2026-09-08

Branch `claude/zealous-bhaskara-12b623`, base `origin/main` b8eae1f. Context depth passed 300k after the gate; this session stops here.

## Done, and how each was verified

| what | verified by |
|---|---|
| The run itself: spec → setup-project → auto → ship on `~/Code/greenfield-run-2026-09-08` (throwaway, 11 commits, preview + one accidental production deploy) | `docs/evidence-greenfield-run-2026-09-08-log.txt`, 80 lines, every transition timestamped |
| `docs/evidence-greenfield-run-2026-09-08.md`, the log beside it, `docs/decisions.md` entry (commit 904cbbc) | `node tooling/check-no-private-names.js` → names clean; `check-no-home-paths.js` → clean |
| `npm run gate` on the clean tree at 904cbbc | 110/113 suites, 3 FAILED: test-rendered-layout-gate (2 of 282), test-validate, validate (`hooks module ./fn/autodev-fn.mjs failed the host's scan`). Re-run serially: all three still red, so not load. They are the three local reds recorded in `docs/evidence-ecc-comparison-2026-09-07.md`, fixed in 5fa045b on PR #182, not on main; this commit touches only docs. |

## Next, in order

1. Merge PR #182 (5fa045b) to main; then this branch's gate goes green without a change.
2. The three harness changes in the decisions entry, each one skill edit + one suite, each with a log line to test against: ship reads `target` from the deploy JSON; setup-project scaffolds into a scratch dir and ships `next typegen && tsc`; auto/stop hook follow the project path instead of cwd.
3. Handbacks #1–#3 in the log are the operator's, if the throwaway product is ever to run: Supabase project, Deployment Protection, production promotion.

## Not done, deliberately

No harness code change, no VERSION bump, no production promotion (the first `vercel --yes` was assigned to production by Vercel; documented, not reverted).
