# Decisions

Non-obvious choices, and where the work that implements them actually landed.
One entry per decision, newest first.

## 2026-08-19 — the mutation gap is 5 of 112, and one was a vacuous assertion

Both suites re-swept against the same subject, because the figures in
`test-drift-audit.js` described a file that had since grown:

| measured against | mutants | caught | survived |
|---|---|---|---|
| prd suite (`test-drift-audit.js`) | 112 | 59 | 53 |
| config suite (`test-drift-audit-config.js`) | 112 | 63 | 49 |
| **either suite** | 112 | **107** | **5** |

**Neither 53 nor 49 is the gap.** The tool takes one suite at a time, so every
mutant the other suite catches is reported as a survivor. Only the intersection
means anything, and it is 5.

The parser that computed it undercounted on the first attempt — 32 of 53 — and
that was caught by making it assert its own total against the sweep's headline
before printing. A count that cannot check itself is a guess.

The five, read individually rather than reported as a number:

- `HOME || USERPROFILE` — both branches hold the same value in any environment
  this runs in. Closable only by an environment no test would otherwise create.
- `if (!lastPrd || !lastPrdTs) return;` and the `|| {}` in the age-cache write —
  guards for states no fixture reaches, one of them inside a `catch`.
- The `&&` in the worktree dedupe's precedence rule — genuinely equivalent here:
  with either operator the main checkout still wins, because both branches agree
  whenever one of the two repos is the main one.
- `if (!market || !market.installLocation)` — **not equivalent, and it exposed a
  vacuous test.** Mutated to `&&`, the audit dereferences an undefined market,
  throws a TypeError and prints nothing. The assertion above it read
  `!/thing@ghost/.test(out)`, which is true of a process that died on line 1 —
  so a test whose own comment said "skipped, not crashed on" only ever checked
  the first half.

That last one is fixed: both negative assertions now also require the report
header `Drift audit —`, which only prints once a run reaches the reporting
stage. Verified by re-injecting the mutant — the suite goes red on the new
assertion specifically. Four remain, and they are the boring kind.

The lesson generalises past this file: **a negative assertion needs a positive
control in the same breath.** "X did not appear" is satisfied by X not appearing
and equally by nothing appearing at all.

## 2026-08-19 — a large catalog is summarised, not enumerated

"Published in a marketplace you use but not installed" had already been scoped
once, from every known catalog down to adopted ones. That was still the wrong
cut. Measured: `claude-plugins-official` carries 286 plugins with 27 installed
and produced **259 of the audit's 277 findings** — 95% of the output, burying
the 14 warnings underneath it.

The scoping conflated two things. Adopting most of a marketplace and missing a
few *is* drift. Cherry-picking from a large general catalog is what a catalog is
for. They are separated by count, not by adoption, so past five uninstalled the
finding collapses to one line naming the ratio.

The case the check exists for survives — a 3-plugin marketplace missing one
still names it. Both sides are pinned, plus a fully-installed marketplace, so
the summary cannot fire on zero.

## 2026-08-19 — each test case gets its own config directory

`test-drift-audit.js` re-audited every repo it had ever created on every `run()`
— fifteen by the end — so cost grew with the square of the file. 112s to 46s by
giving each case its own config, and the CI job went 3m23s to 1m54s.

Profiled first, and the profile killed two plausible theories: memoising `run()`
saved 8s, replacing filler's write-add-commit with a single empty commit saved
about 1s. The real cost was 64.3s inside sixteen audit runs re-walking unchanged
repos against 41.5s of fixture git calls. **This suite is spawn-bound on
Windows**, so the fix is to spawn less, not to spawn faster. Adding fixtures to a
shared config is what would make it slow again.

One trap in the refactor, worth stating because it would have been invisible:
the read-only case asserted "the audit does not modify the repo it inspects"
using *another case's* repo. Under isolation that repo is no longer registered,
and an unregistered repo is trivially unmodified — the assertion would have
passed forever for the wrong reason. It now builds its own fixture and carries a
control asserting the repo **is** audited.

Verified the faster suite did not go blind: deleting the drive branch from
`pathFromSlug` still turns 18 assertions red.

## 2026-08-19 — a permission rule's fix line has to be runnable

The settings check told the reader to "narrow it to the specific command you
need" while matching on the command NAME. So `Bash(export SP=*)` was reported
identically to `Bash(export *)`, and deletion was the only action that ever
cleared a finding. The detection was right; the prescribed cure had never been
run against the detector.

Rules now split in two. Commands whose purpose *is* arbitrary execution — `sh`,
`bash`, `source`, `eval`, and `WebFetch(domain:*)` — stay flagged whatever
argument they carry, and their fix line says delete rather than narrow. Everything
else is flagged only when the argument is a bare wildcard, which is where the
escalation actually lives: a prefix match on `export *` also admits
`export X=1; <anything>`. Flags are not constraints, so `rm -f *` and
`chmod +x *` still fire.

Found by trying to follow the advice on a real settings.json — three
fail-severity findings, none of which narrowing could clear.

## 2026-08-19 — settings.json was never in the backup mirror

The backup protocol says `~/.claude` changes are mirrored to `claude-memory`.
`settings.json` was not in the allowlist, so the single file holding the
permission allow/deny lists was the one file a reinstall would not restore. It
surfaced only because the permission tightening was mirrored and then checked —
the sync reported success and carried none of it.

It cannot be copied verbatim: two hook commands hold an absolute
`C:\Users\<name>\…` path, and committed files must not carry local home paths.
The mirror now rewrites them to `%USERPROFILE%` in the copy only, leaving the
live file untouched.

Two failures on the way in, both caught by verifying rather than trusting the
"pushed" line:

- PowerShell's `-replace '\\', '\\\\'` emits **four** backslashes, not two, so
  the substitution missed and the guard correctly refused to mirror. Use
  `.NET String.Replace` for literal work; `-replace` treats the replacement as a
  pattern.
- `Set-Content -Encoding UTF8` writes a **BOM**, and a BOM makes the file invalid
  JSON. The mirror parsed as garbage — a backup that cannot be restored, which is
  the one thing a backup may not be. Now written with `WriteAllText` and a
  BOM-less encoder.

## 2026-08-19 — CLAUDE_CODE_SUBAGENT_MODEL is set to opus

Recorded here because a session keeps re-deriving it. `~/.claude/settings.json`
sets `env.CLAUDE_CODE_SUBAGENT_MODEL = "opus"`, and the variable is **live in the
running process** — not merely present in a config file.

This is the shape of override that would explain the standing note that subagent
model pinning has no effect: every subagent forced to one model regardless of its
frontmatter or the Agent tool's `model` parameter, which is exactly what 37,795
subagent calls on disk show.

**Not yet proven to be the cause.** Settings-supplied env is applied at session
start, so the discriminating test — unset it, launch a pinned agent, grep that
subagent's transcript for `"model"` — needs a fresh session. Until that runs this
is an active override with the right name and value, which is more than the
previous "cause undetermined" and less than a demonstrated cause.

## 2026-08-19 — a remote's HEAD is filtered by shape, not by name

`prdCarrierBranches` filtered remote refs with `!/\/HEAD$/.test(b)` alongside
`b !== 'origin'`. Both clauses were wrong, and they hid each other.

`for-each-ref --format='%(refname:short)'` renders `refs/remotes/origin/HEAD` as
**`origin`** and `refs/remotes/upstream/HEAD` as **`upstream`**. A short name
therefore never ends in `/HEAD`, so the first clause could not fire at any time.
The second caught origin's HEAD only because of what that remote happens to be
called — **any second remote's HEAD passed through and was scanned as a
branch**, costing a slot against `PRD_BRANCH_SCAN` and skewing the skipped
count.

Now `b.includes('/') && b !== base`: a real remote branch shortens to
`<remote>/<branch>`, a remote HEAD shortens to a bare remote name. One rule
covers every remote instead of one hard-coded name.

**Found by mutation-testing, not by reading.** Deleting the `/HEAD$` clause left
the suite green — the mutant the header had listed as surviving. The first
fixture written to catch it used `origin/HEAD` and also stayed green, because
`b !== 'origin'` was quietly doing the work. Only a *second* remote separated
them. That is [22c] exactly: when a filter looks redundant, ask what it is
compensating for before deleting it — and make the planted negative something
the surviving clause cannot catch by accident.

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
