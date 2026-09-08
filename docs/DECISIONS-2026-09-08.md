# Decisions — 2026-09-08, the `--no-verify` ask-guard (PR #199)

Reversible calls made without asking, per the away rules in force until
2026-09-08T16:33:45Z. Session worktree `affectionate-shaw-5e5b35`, branch
`claude/affectionate-shaw-5e5b35`, base `origin/main` b8eae1f.

## D1. Pushed with `--no-verify`, over the same trunk red as D7 of 2026-09-07

`tooling/githooks/pre-push` runs `tooling/validate.js`, which fails the hooks-module scan
on a host whose `claude` is 2.1.233. `[measured 2026-09-08]` a detached worktree of untouched
`origin/main` at bdf149d fails the same three suites with the same lines (`validate`,
`test-validate` 3 of 28, `test-rendered-layout-gate` 2 of 282); this branch fails exactly
those three and no others, `npm test` 110 of 113 with `tree-inert` green. The plain push
was attempted first and refused by that hook, then pushed with `--no-verify`. This is the
case the hook in this PR asks about, and this paragraph is the record it asks for.

One red in the first run WAS this change's: the ask path's `spawnSync` lacked
`windowsHide`, which validate's spawn check caught. Fixed before the first commit.

## D2. The ask lives in the Bash hook that already runs, not in a new one

`[measured 2026-09-08]` interleaved medians on this Mac: a bare `process.exit(0)`
subprocess 52.8 ms at load 38 and 32.1 ms at load 13, so any new PreToolUse hook on Bash
pays that on every call. A branch in `coordinator-write-guard.js` costs one regex on the
quiet path (32.9 → 34.1 ms, within noise) and 10–50 µs when it tokenises. Widening
`pre-tool-filter.js` to Bash would reverse the 2026-08-17 decision its suite asserts.

## D3. No in-hook trunk A/B

`[measured 2026-09-08]` `node tooling/validate.js` is 1.8 s at load 38; the PreToolUse
budget in `hooks.json` is 5 s and would be shared with a worktree add; load reached 162
the same night. A timed-out hook drops the ask silently on the case it exists for. The
reason names the check and the model runs it.

## D4. A PostToolUse record note, because an ask can be answered by nobody

The Brain's context mid-build: with self-resolving panels the ask auto-takes the
recommended option and its reason is never read. `telemetry.js` now carries a third rider
that, after a SUCCESSFUL bypass call, asks for the record. Not on a failed call, which
skipped nothing.

## D5. No commit-body checker

`[measured 2026-09-08]` `git log --all -i --grep=no-verify`: autodev 4 hits that are 2
messages each seen twice (branch commit and squash merge), one the recorded D7 bypass and
one prose; qr 0 hits against controls of 28 for "verify" and 171 for "fix". A population
of one, already compliant, is not a gate's subject.

## D6. Live-fired in a throwaway repo, taken under branch 2 of the away rules

The end-of-turn panel recommended live-firing the guard in an installed session; the panel
hook held it (operator away) and its branch 2 applies: reversible, not covered by a standing
rule, so taken and logged here. A scratch repo with a local bare remote and a pre-push hook
that fails on purpose, this branch's two hooks wired through `--settings`, three headless
runs of the `claude` CLI on this host (2.1.233, which does run `-p`):

- **Default permissions, `--allowedTools Bash`:** the ask became a denial, the push did
  not run, and the model received the full reason verbatim as the tool error, then proposed
  running validate to learn whether the gate was red at all. That is the A/B the reason
  names, proposed unprompted.
- **`--permission-mode bypassPermissions`, both hooks:** still a denial. A hook `ask`
  denies headlessly whatever the permission mode. The run ended on the turn cap while the
  model retried.
- **PostToolUse only, bypass mode:** the push ran, and `[no-verify] This call ran …
  Record it now …` arrived as PostToolUse additional context, quoted back verbatim. The
  model then declined to invent a justification because it had not run validate, which is
  the behaviour the note exists to produce.

Nothing outside the scratch directory was written; the throwaway remote holds two commits.

## D7. `VERSION` untouched

No release. The plugin cache key must move only when a tree is cut for install.
