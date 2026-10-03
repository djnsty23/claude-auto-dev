# Recovering a timed-out adversary deliverable

This file holds the measured recovery of a lost audit report from a delegate session log, and the guards that made the stitched result trustworthy.

### Recovery is a stitching job, because incremental writing fragments it

`[measured 2026-09-01]` The two halves of this section pull against each other,
and it is worth knowing before you need it. Writing incrementally is what stops
a timeout losing everything. It is also why **no single payload in the log holds
the finished file.**

A 32,327-byte report was destroyed by a `git worktree remove` — the reports
directory is gitignored, so the deliverable was untracked and the removal took
it. Recovering it from the delegate's session log:

| | |
|---|---|
| Longest single payload | 15,871 chars, 7 of 11 findings |
| Payloads carrying a finding | 7, written as successive appends |
| Stitched result | 11 of 11 findings, 27,609 chars |

So a recovery script cannot take the last write or the biggest one. It has to
**collect payloads in event order and distinguish append, replacement and explicit
correction**. Preserve provenance and conflicts when an operation is unclear. A
longer earlier section can contain a defect that a shorter correction removes;
neither longest-wins nor last-wins reconstructs arbitrary edits safely. Byte count will not match the original, because the log
holds what was written and not the file's final assembly; count the SECTIONS
recovered against the sections you expect.

Two guards that made the result trustworthy rather than plausible:

- **Run a known-positive before believing a gap.** The first attempt reported
  the report missing from the log entirely. The control failed too, which meant
  the probe was pointed at the wrong session — `--last` and newest-mtime both
  pick the wrong file when several runs overlap. Address the session by id.
- **Count against the delegate's own closing message.** It said 10 HIGH and 1
  MEDIUM; recovery produced exactly 11 sections. A grep for headings had said
  12, and the grep was wrong. Reconcile against something with a different
  provenance before declaring anything lost.

**This is not licence to move the report.** An audit report belongs under
`.claude/reports/`, gitignored, for the reason SKILL.md states: raw audit output
must not be stageable. The cheap protection is not relocating it — it is
remembering that removing a worktree destroys everything ignored inside it, so
copy the report out before running `git worktree remove`, and treat the
delegate's session log as the recovery path when you forget.
