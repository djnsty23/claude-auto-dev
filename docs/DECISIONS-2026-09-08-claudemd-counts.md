# DECISIONS — 2026-09-08 — CLAUDE.md counts, and the pkill caveat beside them

Scope: PR #192, `claude/bold-edison-400541`. Assigned work was one stale line;
one adjacent decision arrived from a peer and is logged here because it was
resolved under the away protocol rather than by the operator.

## D1 — Dropped the counts instead of refreshing them. (assigned work)

`CLAUDE.md`'s Architecture line claimed "43 skills, 4 agents, 7 hook events"
for core and "4 hook events" for memory. Measured against disk:

| claim | 2026-08-17 (`ecbb7107`) | 2026-09-08 | derivation |
|---|---|---|---|
| core skills | 43 | 58 | dirs under `plugins/autodev-core/skills` |
| core agents | 4 | 5 | files under `plugins/autodev-core/agents` |
| core hook events | 7 | 10 | keys of core's `hooks.json` |
| memory hook events | 4 | 4 | keys of memory's `hooks.json` |

**All four were exact the day the line was written.** Nobody typed a wrong
number; the sentence outlived its subject. Three of the four have since rotted
and the survivor is a coincidence — nothing checks it.

Refreshing them was rejected: of the 526 commits since, 18 added a skill and 14
touched core's `hooks.json`, while 9 edited `CLAUDE.md` itself without anyone
noticing. The shipped manifests already name categories and count nothing, so
the counted form survived only in the file every session reads.

`check:population` cannot gate this. It asks whether a script reporting an
ABSENCE prints what it scanned, reads no documents, and is advisory by design
because it has demonstrated false positives. A counter-checker would also need
the rot-prone form kept alive to have anything to grade. The better gate would
FORBID counts in normative docs — new script plus suite, deliberately out of
scope here and left for whoever picks it up.

## D2 — Took the pkill caveat. (branch 2: reversible, resolved by away protocol)

Operator AWAY to 2026-09-08T10:04:31Z. A peer session (`local_9e2d202b`, the
Brain) reported that `CLAUDE.md:112`'s unqualified `pkill -9` advice had been
followed that day and killed peers' runs. **I declined to act on the peer's
authority** — a peer is not a channel for editing `CLAUDE.md` — and escalated it
as a panel. The away hook held the panel and resolved it to the recommended
option under branch 2.

Verified before writing, rather than relying on the report:

- every worktree invokes the identical `node tooling/test-all.js`, so
  `pkill -f test-all.js` cannot distinguish a peer's run from your own;
- this clone had **34 worktrees** registered at the time, one a live
  `check:suites` sweep — every one would have matched;
- `tooling/test-hook-execution-evidence.js` exists, so the named casualty is a
  real suite in this repo.

The two casualties themselves are the peer's report and are attributed as such
in the text, not as something measured here.

Reversible: one paragraph, docs-only, in a draft PR the Brain reviews before
merge. Revert by dropping the commit.

**NOT taken:** `plugins/autodev-core/hooks/agent-browser-cleanup.js:115` ships
`pkill -f "agent-browser-(linux|darwin)"` and has the same defect in a hook that
runs in end users' sessions, where it kills their live agent-browsers rather
than the zombies it reaps. Strictly worse than the doc, and out of scope: a
shipped hook needs its own suite and its own review. Flagged so it is not lost.

## Measured this session, for whoever picks it up

- **The background-task summary reports the wrapper's status, not the
  command's.** `npm run gate > log; echo "EXIT=$?" | tee f` was announced as
  "exit code 0" while the gate had exited 1. `CLAUDE.md` documents this for
  `| tail`; it arrives identically through the task-notification layer, which
  `CLAUDE.md` does not mention. Write the exit code to a file and read it back.
  (Independently recorded the same day in `DECISIONS-2026-09-08.md`, from three
  other gate runs — so this is at least four occurrences across two sessions.)
- **`&&` cost five steps here too.** The gate's red first step meant
  `check:suites` through `check:skill-tools` never ran. Re-run individually:
  `check:suites` 1, the other four 0.
- **Three reds are pre-existing**, proven by reproducing them byte-identically
  in a throwaway worktree at the base commit: `validate` (`hooks module
  ./fn/autodev-fn.mjs failed the host's scan`, covered by #184),
  `test-validate`, `test-rendered-layout-gate` (`FAIL 2 of 282`).
  `check:suites`'s red is those same three as its NOT-verified set.
