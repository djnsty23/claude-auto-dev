# Decisions

Non-obvious choices, and where the work that implements them actually landed.
One entry per decision, newest first.

## 2026-08-19 — slug reversal restores the drive letter

**The CI failure.** `test-drift-audit` failed on `windows-latest` on every run
for a stretch of releases, while `ubuntu-latest` passed. 12 of its 26 assertions
failed and the other 14 passed.

**Root cause, and it is not Windows.** `drift-audit.js` rebuilt a project path
from its slug as `'/' + slug`. On Windows a rooted path with no drive letter is
drive-*relative*: it resolves against whichever drive the process is on. A
developer machine has cwd and `%TEMP%` on the same drive, so it worked. A
GitHub runner checks out to `D:\a\…` while `%TEMP%` is on `C:`, so every fixture
resolved to a nonexistent `D:\Users\…`.

Discovery therefore returned **zero projects** and the audit emitted no findings
at all. That is why the split was 12/14 rather than a clean failure: every
assertion expecting a finding failed, and every assertion expecting *no* finding
passed vacuously. Half the suite was structurally incapable of firing.

**Fix.** `pathFromSlug` in `plugins/autodev-core/scripts/drift-audit.js` now
restores the drive letter — `C--Users-x` becomes `C:/Users/x` — and leaves the
POSIX branch untouched. The leading `-` is the discriminator and needs no
platform check: a POSIX slug always has one, a Windows slug never does.

`decodeProjectDir` in `plugins/autodev-memory/scripts/memory-audit.js` carried
the identical defect and got the identical fix. Keep the two in step.

**This also fixed production, not just CI.** The old code's own comment recorded
that Windows project discovery "discovered zero projects and said nothing, for
as long as it has existed". The drive letter was being discarded, not merely
misrouted, so no Windows install had working project discovery.

**Regression gate.** `checkSlugReversalRestoresDrive` in `tooling/validate.js`
scans every plugin script for the slug reversal and fails if one omits the drive
restore. It prints its population (`4 site(s) across 2 file(s)`) so an empty
scan cannot read as clean, and it was mutation-tested: deleting the drive branch
turns it red and names the file.

Scoped to the reversal rather than to bare-slash concatenation on purpose —
measured against this tree, a `'/' + x` scan returned 4 hits and all 4 were
legitimate.

**Where the code actually is.** Two sessions were working in the same clone, and
`git add -A` from the other one swept these changes into its commits. The work
is therefore under messages that do not mention it:

| Commit | Message it shipped under | What it actually carries |
|---|---|---|
| `1cd5e03` | `fix(tooling): the miner says which machine it can see` | the `pathFromSlug` fix, the `memory-audit` fix, the test fixture rebuilt to the real production slug |
| `2192918` | `feat(tooling): rank failure classes by wall-clock cost, and cap the advisory` | `checkSlugReversalRestoresDrive`, the fixture-shape assertion |
| `cb0e12c` | `chore(release): 8.89.0` | the `actions/checkout` and `actions/setup-node` bump to `v7` |

The history is public and already pushed, so it was not rewritten to relabel it.
This entry exists so the fix is findable by something other than the commit log.

**Verification.** Reproduced before fixing, by pointing a substituted drive at
the checkout so cwd and `%TEMP%` differed: 14 passed / 12 failed, the same twelve
as CI. After the fix, 26/26 under that same cross-drive condition and 27/27 for
the full suite. Then confirmed live — CI run `32261659867`, both `windows-latest`
and `ubuntu-latest` green.

**Related.** The runners force `actions/checkout@v4` and `actions/setup-node@v4`
onto Node 24 and annotate every run about it. Both are pinned to `v7` now. This
job uses neither action's optional surface, so the intervening majors do not
apply to it.
