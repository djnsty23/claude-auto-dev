# A probe is bound to its command form

This file holds section 8 of rule-gate-integrity: the measured `git merge-tree` probe table and why a probe must be pinned to the invocation it was measured on.

## 8. A probe is bound to the command form it was measured on

> Two spellings of one command. Each is discriminated by exactly one probe, and
> that probe reports clean on the other spelling.

`[measured 2026-09-02]` git 2.54.0.windows.1, two throwaway repos, both forms of
`git merge-tree` against a real conflict and against a clean merge of the same
file in non-overlapping regions:

| probe | 3-arg, conflict | 3-arg, clean | `--write-tree`, conflict | `--write-tree`, clean |
|---|---|---|---|---|
| exit code | **0** | 0 | 1 | 0 |
| `grep -c '^<<<<<<<'` | **0** | 0 | 0 | 0 |
| `grep -c '<<<<<<<'` | 1 | 0 | **0** | 0 |
| `grep -c 'changed in both'` | 1 | **1** | n/a | n/a |
| `grep -c 'CONFLICT'` | 0 | 0 | 1 | 0 |

Every bold cell is a plausible probe returning the reassuring answer. The 3-arg
form exits **0 with conflicts present**, and prints its markers indented inside a
diff hunk, so a line-anchored grep finds none. The `--write-tree` form prints no
markers at all and signals by exit status and a `CONFLICT` line. And
`changed in both` fires on a merge that is clean, so it means both branches
touched the file, not that they disagree.

So: 3-arg needs the unanchored marker grep and nothing else works. `--write-tree`
needs the exit code or a `CONFLICT` grep and the marker grep does not work. A
check that pairs one form with the other's probe is green by construction.

Two sessions found this from opposite ends and neither had it alone. One blamed
the command form when its own probe had failed on the line-start anchor; the
other offered the exit code as the fix, which is correct for one form and wrong
for the other. **The joint result only appeared because both published the
marker count, the exit code and a known-negative control together.** Any one of
the three alone reads as clean.

Generalise past git: a probe is calibrated against the exact invocation it was
measured on. Change a flag, a subcommand, a version, or a platform, and the
signal may move to a different channel without anything erroring. **Pin the form
and the probe on the same line**, and re-measure when either moves.

The remedy that survives both forms is to stop reading status and read the
RESULT: perform the merge in a throwaway worktree and parse the output. For a
JSON file, parse the actual merged result and independently assert the expected
record identities and values. Valid JSON alone does not prove records survived;
a successfully parsed empty object is the counterexample.
