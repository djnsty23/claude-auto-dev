# RESUME — memory recall measurement and fixes, 2026-09-08

Session worktree `unruffled-faraday-86e0c3`, branch
`claude/unruffled-faraday-86e0c3`, PR
[#190](https://github.com/djnsty23/claude-auto-dev/pull/190) against `main`.
Written at a context depth past the restart line; the session stops after
this file. Re-read `gh pr view 190` before acting: the two facts most likely
to have moved are whether the Brain merged it and whether main moved again.

## Done, and how each was verified

| commit | what | verified by |
|---|---|---|
| 73ab0f4 | `docs/evidence-memory-recall-2026-09-08.md` + `decisions.md` entry: recall measured at zero across 281 transcripts, ranked injection built and rejected | `node scan-recall.js` over `~/.claude/projects` (script reproduced in the doc); 40 rows read by id; hook timings N=7 on a `.backup` copy under sandboxed HOME |
| e848299 | capture fixed at source: Write/Edit inside the project only, type from the tool, concept never the prompt, dedupe per (session, type, title) | `node tooling/test-observation-classifier.js` 43/43; `node tooling/test-observation-dedupe.js` 16/16; `check:suites` verified both able to fail |
| 31a818d | UserPromptSubmit prompt-capture hook removed with its carrier functions; `clear()` removes a stale `.prompt`; CLAUDE.md says 3 hook events | `test-session-carrier.js` 25/25, `test-memory-session-end.js` 29/29; validate: "autodev-memory: 3 hooks wired"; `check:suites` verified both |
| b80fc7d | CLI refuses swapped `<projectPath> <query>` for search/semantic/timeline/knowledge | `node tooling/test-memory-db-cli.js` 51/51; `check:suites` verified it, sweep INDETERMINATE on an untouched suite at load 41 |
| e3affdf | docs: the prune ran on the operator's confirmation | `sqlite3 -readonly ~/.claude/auto-dev-memory.db "pragma integrity_check; select count(*) from observations"` → ok, 508 |

Every commit: `npm test` 111/114, the three reds pre-existing on this Mac
(host `claude` 2.1.233 predates hooks modules → `validate` and
`test-validate`; macOS pipe truncation in `test-rendered-layout-gate`,
intermittent). Open #184 fixes the first. Every push used `--no-verify` for
that one reason, stated in the PR body. `check:functions` refuses to measure
while any suite is red, so it never ran here.

The store: 508 rows after the prune, backup with 7,444 rows at
`~/.claude/backups/auto-dev-memory-2026-09-08-pre-prune.db`, 36-row gap
between backup and delete named in the evidence doc. Restore is one `cp` of
the backup over the database with `-wal` and `-shm` removed.

Decisions D1–D7 in `docs/DECISIONS-2026-09-08-memory-recall.md`. D2–D6 taken under the
away window's recommended-option branch; D7 on the operator's confirmation
after the window ended.

## Not done, and why

- **Quiet `check:suites` rerun for b80fc7d.** Load stayed above 30 all
  session while other sessions ran their gates. The Brain has the request
  (message sent to its desktop session; `~/.claude/brain-role.json` names
  it) to run one serial sweep before merging.
- **Release.** The operator selected "release the fix after #190 merges".
  #190 was OPEN with no review when this was written. Do not bump VERSION
  before the merge; re-read `VERSION` immediately before `bump.js`.
  Until the release, installed sessions keep writing the echo-shaped rows
  the prune removed.
- **Re-measure after a week of new capture** was offered and not selected.

## Next, for whoever picks this up

1. `gh pr view 190 --json state,mergedAt`. If merged: `cat VERSION`, then
   `node tooling/bump.js <next>`, `npm run gate`, commit with `-F`, push,
   tag. If not merged: nothing to do here; the Brain holds merge authority.
2. When this Mac's `claude` is at or past 2.1.259 (or #184 lands), the
   pre-push hook and `validate` go green and `--no-verify` is no longer
   needed on this branch.
3. If the prune needs disputing: the predicate is in the evidence doc's
   pruning section; diff any row against the backup by `id`.
