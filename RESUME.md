# RESUME — greenfield run session, 2026-09-08

Branch `claude/zealous-bhaskara-12b623`, base `origin/main` b8eae1f. Context depth passed 300k after the gate; this session stops here.

## Done, and how each was verified

| what | verified by |
|---|---|
| The run itself: spec → setup-project → auto → ship on `~/Code/greenfield-run-2026-09-08` (throwaway, 11 commits, preview + one accidental production deploy) | `docs/evidence-greenfield-run-2026-09-08-log.txt`, 80 lines, every transition timestamped |
| `docs/evidence-greenfield-run-2026-09-08.md`, the log beside it, `docs/decisions.md` entry (commit 904cbbc) | `node tooling/check-no-private-names.js` → names clean; `check-no-home-paths.js` → clean |
| `npm run gate` on the clean tree at 904cbbc | 110/113 suites, 3 FAILED: test-rendered-layout-gate (2 of 282), test-validate, validate (`hooks module ./fn/autodev-fn.mjs failed the host's scan`). Re-run serially: all three still red, so not load. They are the three local reds recorded in `docs/evidence-ecc-comparison-2026-09-07.md`, fixed in 5fa045b on PR #182, not on main; this commit touches only docs. |

## Next, in order

1. (Superseded 2026-09-08: PR #182 was closed in review; #184 and #191 fixed the same two reds and are on main, so a rebase onto main makes this branch's gate green.)
2. The three harness changes in the decisions entry, each one skill edit + one suite, each with a log line to test against: ship reads `target` from the deploy JSON; setup-project scaffolds into a scratch dir and ships `next typegen && tsc`; auto/stop hook follow the project path instead of cwd.
3. Handbacks #1–#3 in the log are the operator's, if the throwaway product is ever to run: Supabase project, Deployment Protection, production promotion.

## Not done, deliberately

No harness code change, no VERSION bump, no production promotion (the first `vercel --yes` was assigned to production by Vercel; documented, not reverted).

---

# RESUME — ecc harness evaluation session, 2026-09-07

Branch `claude/ecc-harness-evaluation-dd005b`, worktree `ecc-harness-evaluation-dd005b`,
base `origin/main` 5ed39fb. Context depth passed 300k, so this session stopped
after the step below; a fresh session continues from here.

## Done, and how each was verified

| commit | what | verified by |
|---|---|---|
| 5fa045b (superseded by #184 and #191, dropped from this branch) | validate.js version-gates the hooks-module scan (host < 2.1.259 → WARN, not FAIL); rendered-layout-gate.js uses `process.exitCode` so a >64 KiB `--json` report survives a macOS pipe | `node tooling/test-validate.js` → 36 passed, 0 failed; `node tooling/test-rendered-layout-gate.js` → PASS 283 assertions; `node tooling/validate.js` → 19 PASS, 0 FAIL, 1 WARN |
| 51c03e0 | three ECC ports: typecheck batched at Stop with `decision: block` (post-tool-typecheck.js + stop-typecheck.js), lint-config `ask` inside pre-tool-filter.js, `hooks_profile=minimal` via plugin userConfig | test-post-tool-typecheck 17/17, test-stop-typecheck 33/33, test-hooks-profile 32/32, test-pre-tool-filter 44/44; suites for every guarded hook green; `node tooling/find-untested-hooks.js` → 24 wired, 24 executed |
| e408c49 | docs/evidence-ecc-comparison-2026-09-07.md + decisions.md entry | `node tooling/check-no-private-names.js` clean, `check-no-home-paths.js` clean |

`npm run gate` was started on the clean tree at e408c49 (see "Next").

## Next, in order

1. The local `npm run gate` at e408c49 was killed after `npm test` finished 110/112 suites under a 13-session load; CI runs the same gate on both PRs. (It was at 43 of 112 suites when the
   session stopped; the log was in the session scratchpad, so re-run it if the
   log is gone: `npm run gate` on a clean tree, tens of minutes).
2. PR A #182 (5fa045b alone) was CLOSED in review: its validate half would have turned a genuinely failing module into a WARN on an old host; #184 and #191 landed instead. PR B #181 was rebased onto them with its own 5fa045b dropped. Originally:
   via the panel ("Commit the evidence doc … opens a PR"). Commit with
   `-c user.email=djnsty23@users.noreply.github.com`.
3. Not a release: no `VERSION` bump was made. The ported hooks run on nobody's
   machine until one is cut; cut it separately, re-reading `VERSION` first.

## Proposed after that (measured, not started)

- `--no-verify` ask-guard for `git commit` / `git push`: 5 commit bodies in the
  live product and this repo's 2026-09-07 triage bypassed a gate. Same shape as
  the lint-config branch in pre-tool-filter.js (in-process, `ask`).
- AGENTS.md generator from the 16 `rule-*` skills: 128 KB of rules reach a
  Claude session, 4 KB of hand-written AGENTS.md reaches a Codex session here.
- One measured greenfield run through spec → setup-project → auto → ship. Never
  exercised on this machine (0 of 4 products). Full analysis with sources:
  scratchpad `brain-idea-to-production-2026-09-07.md` (copy it into docs/ if
  it should outlive the session).

## Not done, deliberately

- No release. No push before the gate.
- Memory-injection idea not measured (recall use unknown), so not proposed as work.

## Spawned after this session stopped (2026-09-08, operator-started, each in its own worktree)

Nine sessions carry the follow-ups, so nothing here is for a fresh session to re-derive; check `gh pr list` and the session list before starting any of them again:

1. `--no-verify` ask-guard in pre-tool-filter (bypass must be deliberate and recorded, never impossible).
2. One measured greenfield build, spec → setup-project → auto → ship, throwaway product, evidence doc is the deliverable.
3. AGENTS.md generator from the 16 `rule-*` skills, with a drift gate and a Codex before/after.
4. Memory recall measurement: is anything ever recalled, then ranked injection only if the sample warrants it.
5. Coverage threshold in the gate at today's measured floor, zero new dependencies preferred.
6. Production signals → candidate stories, read-only on the live product, direct writes only on the no-users repo.
7. needs-setup made first-class: spec emits the setup manifest, auto marks on wizard handback, status says "blocked on you: N".
8. Quota-wall survival: triage script over run directories, phase-shape rule, non-blocking resume note.
9. Deploy pre-authorisation: three drafted sentences with measured consequences, decision put to the operator, never made by a session.

Each was briefed to open its own PR against main with an evidence doc under docs/ and a decisions.md entry, no VERSION bump, and to leave the live product and client repos read-only.
