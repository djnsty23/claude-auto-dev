---
name: sessions
description: Sweep Claude Code Desktop sessions — classify which are finished, check their worktrees are safe to discard, write resume stubs, and archive the safe ones. Use for "archive finished sessions", "session cleanup", "how many sessions do I have open".
when_to_use: "Invoked when the user says \"sessions\", \"archive sessions\", or asks to clean up finished sessions."
allowed-tools: Bash, Read, Write
model: haiku
user-invocable: true
---

# Sessions

Archive sessions whose work is done, without destroying work that isn't.

## Why this is not a one-liner

`archive_session` stops the session process **and cleans up its git worktree**.
So the risky part is never "which sessions look finished" — it is "which
worktrees are actually disposable". On the first real run, two sessions that
looked finished held live work: one had 2 uncommitted files, one had a branch
that existed nowhere but that disk. A naive sweep deletes both.

The sweep therefore fails closed. A worktree it cannot read is unsafe, not safe.

## Step 1 — classify (read-only, archives nothing)

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/session-sweep.js"
```

Verdicts:

| verdict | meaning |
|---|---|
| `MERGED` | every PR settled (merged or closed) — finished |
| `STALE` | no PR, and idle past its threshold |
| `PR-OPEN` | at least one PR still open — **not** finished |
| `ACTIVE` | recent activity — leave alone |

Three thresholds, because "finished" and "cold" are different questions:

- **`--stale-days` (default 14)** for hand-started work.
- **`--ephemeral-days` (default 2)** for sessions the app launched from a
  schedule. These are disposable by construction — the task regenerates them
  tomorrow — and they dominate the population: on the machine this was built
  for, 261 of ~480 records carried a `scheduledTaskId`.

- **`--merged-min-minutes` (default 30)** floors the MERGED verdict. A settled
  PR bypasses the idle clock entirely, so without this a session whose PR merged
  three minutes ago reads as finished while its author is still working in it —
  measured on two real sessions. Finished is not the same as cold; it needs both.

  The floor is in **minutes** because what it guards is a liveness ping.
  `lastActivityAt` is refreshed by the app only while a session is actually
  running, and it freezes the moment one stops — so a record hours stale is not
  someone typing slowly, it is a session the app is no longer running. The floor
  was 12 **hours** until 2026-08-22, which conflated the two: measured over 42
  live records, four sessions with every PR settled and clean pushed worktrees
  sat unarchivable at 1-9h idle, and not one record in the population fell
  between 4h and 24h — so the extra eleven hours bought no discrimination, only
  false ACTIVEs. `--merged-min-hours` is still accepted as the retired spelling.

Detection is structural (`scheduledTaskId`), never a title regex. A regex would
miss renamed tasks and catch hand-started work that happens to be called
"daily digest".

Disposition is separate from verdict, and it is the one that decides:

- `SAFE` — finished, own repo, worktree clean, branch pushed. Archivable.
- `dirty(N)` / `unpushed(N)` / `branch-not-on-remote` / `stashed(N)` — finished
  but holds work that exists nowhere else. **Never archive.** Report it and let
  the user commit or push first.
- `third-party` — remote is not the operator's own account. Excluded entirely;
  client work is not swept by a tool.

BLOCKED and EXCLUDED are reported separately, and the split matters. BLOCKED
means work exists in exactly one place — act on it. EXCLUDED (third-party or
`autoArchiveExempt`) is permanent and identical every run, so it is counted and
not listed; `--list-excluded` names them. They shared one list originally, and
five permanent rows appeared under BLOCKED every single run, which teaches a
reader to skip the one section where a real warning can appear.
- `exempt` — the session carries the app's own `autoArchiveExempt` flag.

## Step 2 — resume stubs before archiving, not after

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/session-sweep.js" --write-resume
```

Writes one `.claude/handoffs/resume-<slug>.md` per SAFE row: session id, branch,
worktree, PR links, verdict, and how to pick the work back up.

Prefer restarting from the repo over reopening a long transcript. The transcript
is intact either way, but a deep one re-bills its whole context on every turn and
carries its own accumulated wrong turns; `RESUME.md` and `DECISIONS.md` carry the
conclusions without the cost.

## The reach limit, and the one case where the script writes

`archive_session` reaches only the workspace directory the app currently tracks
— measured at ~70 of 482 records, and `limit` does not change it. The cause is
structural, not a cap: sessions live under `<store>/<workspace>/`, the app holds
one workspace, and everything in the others returns "not found".

Age does NOT predict this. Four-day-old records were unreachable while older ones
were not. The directory decides.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/session-sweep.js" --archive-orphaned
```

This is the ONLY mode in which the script mutates anything. It marks SAFE records
archived by string-replacing `"isArchived":false` in the store JSON, and **only**
for orphaned workspaces. It still never touches a git worktree.

Why it is safe there and nowhere else: the app never loaded those records, so it
holds nothing to overwrite them with. Records in the live workspace are skipped
and still require `archive_session`. If two workspaces are both recently active,
the script treats neither as orphaned — that is a shape it does not model, and
the safe reading is to leave both alone.

A string replace, not parse-then-stringify: reserializing rewrites field order
and escaping across a file the app owns, so any breakage would be
indistinguishable from the change being made. Take a copy of the store first;
it is around 50MB.

## Step 3 — archive, only the SAFE list

For each SAFE row, call `archive_session` with its `sessionId`. Never archive a
row the script did not mark SAFE, and never archive `self` unless asked.

Show the user the list and the count before acting. This is a bulk mutation of
their workspace: a big number is a reason to confirm, not a reason to hurry.

## Do NOT then start a session per archived item

The reflex is to pre-warm replacements so they "share cached context". Measured
over 158 transcripts, that is backwards:

- A fresh session's first request reads ~34k tokens from the shared prefix and
  **writes ~95k** of its own. Only ~26% of the opening prompt is shared, and that
  share is a fixed ceiling — it does not grow by starting more sessions.
- The expensive part is the per-session cache, which nothing shares: the median
  request re-reads **333k** tokens, 10x the shared portion.

So N pre-warmed sessions is N independent caches, each re-read on every turn. A
resume doc pasted into a prompt makes it worse, because it lands in the *unique*
part of the prefix and is re-billed every turn. Put context in the repo, where it
is read on demand, and start a session when there is work for it.

## Config

`~/.claude/session-sweep-denylist.txt` — one substring per line, matched against
the git remote and origin path. Third-party repos go here. Local only; never
committed, which is why no client name appears in this plugin.

`SESSION_SWEEP_OWNER` — the operator's GitHub account. Any `github.com` remote
not containing it is treated as third-party.
