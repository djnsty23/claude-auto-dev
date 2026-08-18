# RFC: self-heal gate, nightly heartbeat, learn-loop trigger

Grounded in one incident, 2026-08-18: the installed plugin set drifted for two
days with every layer reporting healthy. This RFC covers the three fixes that
close the classes involved, and records the measurements behind each choice
per `rule-ab-testing`.

## The incident, reconstructed

- The marketplace clone (`~/.claude/plugins/marketplaces/autodev`) auto-pulled
  per session through Aug 17 02:44 (`6a4eee3`, 8.66.0), then stopped. Aug 18
  sessions refreshed `claude-plugins-official` but not autodev. The CLI logs
  marketplace-refresh failures at warn level and retains no log file, so the
  cause is unrecoverable. Remote moved on to 8.80.0, 34 commits ahead.
- A `/plugin update` for autodev-core wrote the 8.66.0 cache directory but
  never flipped `installed_plugins.json` — the updating session died between
  the cache write and the manifest write. Core stayed at 8.18.0, 62 minor
  versions behind, while the update flow reported nothing wrong.
- The nightly drift audit **had already caught this** on Aug 17: it filed the
  version drift as `warn`, and the nightly's policy correctly leaves plugin
  installs alone. Detection worked; no surface existed where the user would
  actually see it.

Three classes: a background refresh that fails silently, an update transaction
with no post-flip verification, and a warning channel nobody reads. The builds
below map one-to-one.

## Build 1: session-start drift surfacing (the self-heal gate)

The one place the user reliably looks is the session-start banner. Two checks,
both local, no network, added to `session-start.js`:

1. **Installed vs catalog** — compare our own `plugin.json` version against the
   version the local marketplace clone's catalog offers for us. Catches the
   update no-op the moment the next session starts, instead of never.
2. **Catalog freshness** — stat the clone's `.git/FETCH_HEAD`. A clone that has
   not fetched in >7 days is the silently-stopped auto-pull. Catches the
   refresh failure class without recovering its cause.

When clean, the checks add zero bytes to the hook's output. When drifted, the
banner names both versions and the context carries the exact fix command.

### Variants measured

| variant | cost per session | catches update no-op | catches stale clone | offline-safe |
|---|---|---|---|---|
| A. do nothing (baseline) | 0 | never surfaced | never surfaced | — |
| B. extend session-start: local reads only | **0.8ms measured** (median of 15 runs: 31.4ms vs 30.6ms without; node startup dominates both) | yes, next session | yes, >7d | yes |
| C. new dedicated hook | ~50ms (extra node spawn) | same as B | same as B | yes |
| D. network check (`git ls-remote`) at session start | 300ms+, hangs on bad DNS | yes | yes, exactly | **no** |

B shipped. C pays a process spawn per session for identical information. D is
the only variant that can catch "clone is stale *and* remote moved" precisely,
but a session-start hook must not block on the network — that comparison
belongs to the nightly drift audit, which already does it implicitly (the
nightly runs `/plugin marketplace update` guidance and reads the clone).

Deliberately **not** built: unattended auto-update. The marketplace is this
repo; a bad push auto-installing into every session start is a worse failure
than drift. Surfacing loudly and leaving the update to the user keeps a human
between a push and the running set. (The nightly's existing policy line —
"installing a plugin update unattended is not this routine's call" — already
encodes this; Build 1 fixes the *visibility*, which was the actual gap.)

### Gate integrity

Per `rule-gate-integrity`: the suite drives the real hook as a subprocess with
a fixture marketplace tree; the drifted case asserts the message names both
versions (fires, and for the right reason); the clean case uses the same
fixture path with only the version changed, so the negative assertion is known
to reach the code; a catalog *behind* the install must stay silent (a downgrade
is not an update).

## Build 2: nightly heartbeat

The nightly writes to `memory-maintenance.log` only when something changed. A
clean night and a dead schedule are therefore indistinguishable — and worse,
`drift-audit`'s current schedule check reads the **SKILL.md mtime**, which a
healthy task stops touching forever. Today that check is a false-positive
generator: every stable scheduled task starts warning 7 days after its last
edit, firing or not.

Fix: the routine touches `<task-dir>/.last-run` at the end of **every** run,
clean or not. `drift-audit` prefers the stamp when present: fresh stamp → no
finding regardless of SKILL.md age (kills the false-positive class); stale
stamp → a *stronger* warning than the mtime heuristic, because the stamp
measures firing directly. No stamp → existing mtime heuristic unchanged.

The stamp may contain `{"cadence_days": N}` for non-daily tasks; default 1,
warn when age exceeds cadence + 2 days of slack.

### Variants

| variant | log growth | machine-checkable | false-positive class |
|---|---|---|---|
| A. current (SKILL.md mtime) | none | yes | **every stable task, after 7d** |
| B. dated log line even when clean | ~30 lines/month of noise in a signal-only log | needs log parsing | none |
| C. `.last-run` stamp + drift-audit reads it | none | yes, one stat | none |

C shipped. B was the original ask ("a dated line even when clean") and its
spirit survives — the stamp *is* the dated line, moved out of the log so the
log stays signal-only, and read by the tool that already audits schedules.

## Build 3: learn-loop trigger (and what already exists)

Measured before building, per `rule-ab-testing` — and most of this ask
**already exists**:

| asked for | exists today |
|---|---|
| mine failures into rules | `learn-from-fixes` + `mine-fixes.js` (tested) |
| store confirmed classes | `.claude/project-rules.md` (`autodev-init` owns it, `learn-from-fixes` appends) |
| reviewed-pattern store | `.claude/agent-memory/audit-patterns.md` (audit reads/maintains) |
| consume during review | `review` and `audit` both read `project-rules.md`; audit passes it to every agent |

The one missing link: **nothing triggers the mining automatically.** The loop
runs only when a human remembers to ask "what do we keep getting wrong". So
the build is deliberately small:

1. The nightly gains a weekly step (Tuesdays, so Monday's orphan check keeps
   its slot): run `mine-fixes.js --json` per active repo; when a repo's
   fix-share or a single class crosses the tool's reporting threshold, log a
   **proposal** to run `/learn-from-fixes` there. Report-only, consistent with
   the nightly's standing policy; the class ranking is quoted as a floor, per
   the skill's own calibration.
2. `learn-from-fixes` documents the scheduled entry point so future installs
   wire it without archaeology.

No new detector code: the miner exists and is tested. What cannot be measured
this session — whether the trigger improves shipped quality — is stated here
rather than claimed: the change is two SKILL.md sections, cheap to reverse.

## What this RFC deliberately leaves alone

- **Unattended plugin updates** (above).
- **A new snippet database.** The stores exist (`project-rules.md`,
  `audit-patterns.md`, the sqlite observation store); adding a fourth would
  recreate the two-disconnected-stores problem this repo already had once.
- **Update-transaction atomicity** in the CLI's installer — not ours to fix;
  Build 1 makes its failure visible the next session, which is the best an
  installed plugin can do from inside the blast radius.
