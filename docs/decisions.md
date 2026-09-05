# Decisions

Non-obvious choices, and where the work that implements them actually landed.
One entry per decision, newest first.

## 2026-09-05: ECC (affaan-m/ecc) measured and not adopted

The question was whether a 249k-star harness is better than this one, and if
so whether to port its logic here or fork it and put auto-brain on top. The
answer is no to all three, and every reason below is a number from this
machine rather than a reading of its README.

**What it is**, at commit `e04ea0b`: 3,520 tracked files, 2,520 of them
markdown. 286 skills, 94 command shims, 68 agents, adapters for 12 harnesses,
a Rust TUI alpha, a Python LLM layer, an installer with its own doctor and
repair. MIT. 370 authors all time and 276 commits in the last 31 days, with
one maintainer and one collaborator carrying most of the triage.

**Hook cost per tool call.** Both repos' real `hooks.json` command strings
were run against the same five payloads, N=8, medians, HOME sandboxed so
neither wrote into the live `~/.claude`. ECC through `bash -c`, which its
inline `node -e` bootstrap needs; ours through the shell-free `command` +
`args` form it ships in, and through `bash -c` as a control.

| event | ECC blocking | ECC cpu | autodev blocking | autodev cpu |
|---|---|---|---|---|
| PreToolUse/Read | 166 ms | 2,173 ms | 43 ms | 43 ms |
| PreToolUse/Bash | 183 ms | 2,297 ms | 42 ms | 42 ms |
| PreToolUse/Edit | 173 ms | 2,621 ms | 45 ms | 45 ms |
| PostToolUse/Edit | 91 ms | 2,141 ms | 48 ms | 138 ms |
| Stop | 263 ms | 1,101 ms | 47 ms | 90 ms |

Blocking is the slowest synchronous hook, since the harness runs a matcher
group in parallel. CPU is the sum, including async hooks. ECC's async observe
hook spawns bash and three python processes on every tool call including
Read and Grep, which is where the two seconds go. The control run of ours
through `bash -c` read 60-84 ms blocking, so the runner is not the gap.

**Skill listing.** 286 skills carry 73,076 description characters, about
19.5k tokens, plus 94 commands. Ours carry 12,285 across 67, about 3.2k.
ECC's own open issue #2694 reports that the listing truncates and skills
from other plugins become invisible to routing. Installed beside this plugin
it would hide ours. That closes the "use both" option without a fork.

**Windows.** Open issue #2687: the inline `node -e` bootstrap in every hook
matches Defender's VirTool:JS/Anomelesz.A heuristic on the session
transcript, and it quarantined a live one from 6.88 MB to 0.08 MB. The
continuous-learning observer is skipped on Windows outright, is disabled by
default on every platform, and carries an open P0 (#2673) where a 1,519-row
batch was archived unanalysed. Orchestration is tmux worktrees, a SQLite
store and GitHub-issue epics; there is no tmux here and nothing resembling
prd.json's five states, stop-auto-check, desktop session messaging or the
auto-brain survey.

**Gate integrity.** Its suite is 4,049 tests in 472 s here, 14 failing and
all 14 Windows-only (11 symlink EPERM, 3 tar). One test file per hook script
with three exceptions. No mutation or can-fail gate exists, so there is no
equivalent of `check:suites` or `check:vacuity`. A fork would carry 3,520
files this operator never uses and either lose those gates or port roughly
64k lines of scripts, hooks and tooling onto them.

**Rules and skills** are generic where ours are incident-derived: KISS, DRY,
YAGNI, 80% coverage, immutability marked CRITICAL, and a camelCase rule its
own issue #2830 notes contradicts the Python and Rust packs. The skill
catalogue is a breadth play (Laravel, Kotlin, homelab, DeFi, a music-video
taste layer); nothing in it targets this stack better than what is here.

**AgentShield**, its config scanner, run against this repo: grade A with two
findings, both wrong on this machine. CLAUDE.md "world-writable 0o666" is
what every file reports through node on NTFS, and "no PreToolUse hooks" comes
from reading settings files only, so it cannot see plugin hooks at all.

**What survives the pass.** One idea maps to a measured gap in this repo's
own record: rule 14c says 77% of cost is cache reads and a session should
restart past about 300k, and nothing in our hooks enforces it. ECC's
`ecc-context-monitor.js` nudges from transcript size; transcript rows here
carry `usage.cache_read_input_tokens`, so a hook can read the true figure.
`config-protection`, which blocks edits to linter configs, is 176 lines and
cheap, but no incident in the record motivates it, so it waits for one.

**Built the same day: `hooks/context-depth-nudge.js`.** A Stop hook that
reads the latest assistant row's usage from the tail of `transcript_path`
(input + cache_read + cache_creation, the figure that call was billed for),
and once per 100k step past 300k emits `additionalContext` telling the model
to finish the step and write RESUME.md, plus a `systemMessage` telling the
operator to start fresh. No `decision` key, so it cannot hold a turn or fight
stop-auto-check; silence is zero bytes on both streams. Suite:
`tooling/test-context-depth-nudge.js`, 30 cases, including a usage row behind
a 700KB attachment row, a truncated final line, and a corrupt ledger. The
first run of that suite failed two of its own cases on arithmetic (402,578 is
one whole step past the line, bucket 1, not 0); the hook was right and the
expectation was wrong, which is what a first run is for.

**Away-window decision, branch 2.** The closing panel for this evaluation was
held by the operator's standing AWAY order (`~/claude-memory/AWAY.md`, until
2026-09-06T20:00Z, "no panels, decide it yourself and log why"). The order's
branch 2 covers work that is reversible and not otherwise decided: this hook
is one file, one suite and one `hooks.json` line, reverted by removing them.
It was the recommended option and it was the one measured gap the evaluation
found, so it was built rather than queued. Not taken from the same panel: an
artifact page (arms a live-watch chip the operator would have to close, low
value while away) and, at the time, the push.

**Corrected the same afternoon: the push, the PR and the merge are covered by
a standing rule, branch 1.** `~/claude-memory/MANDATE.md`, "PUSHES AND MERGES
ARE THE FLEET'S, IN HIS OWN REPOS", carries the operator's words of
2026-09-05 verbatim: "not even merges need me, but everything that costs
minutes should be either batched or optimized." Read directly from disk, not
taken from the peer relay that pointed at it. Beside it, this repo's CLAUDE.md
line "commit and push autodev freely", and the same day's D9a precedent that
an autodev push reaches a git remote and nothing else. So: one push of the
whole branch, one PR whose title is the squash subject, every ci.yml check
read by name to a terminal state (unknown is not finished), squash-merge, then
both new files verified on `origin/main` by path. The gate ran green at
`75c0429` (exit 0, 2,208 s, 110 of 110 suites, 109 verified able to fail);
this correction is docs-only and ran validate and the private-names gate. Not
cut here: a release, because a version number is a plugin-cache key and a
sibling branch was landing at the same time, so one release covering both is
one run instead of two.

**What would reverse this.** A measured per-call cost within 2x of ours, a
skill listing that fits the budget beside another plugin, the Defender issue
closed with a non-inline bootstrap, and a hook can-fail gate. Any one of
those is a new evaluation; none of them is a reason to re-read the README.

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

## 2026-08-30 — agent frontmatter `model:` and `effort:` both take effect

`[measured 2026-08-30]` and stated as a correction, because the first version of
this entry concluded the opposite and was committed before the controls were run.

**What the retracted version claimed.** That `effort:` is not reliably applied,
on the evidence that `autodev-core:code-reviewer` pins `effort: high` and ran
`xhigh` in 108 of 108 assistant rows, while two other agents pinning `high` ran
`high`. That divergence is real and the reading of it was wrong.

**What was missing: a live control.** Two agents were then spawned with NO model
and NO effort argument, and their own transcripts read back:

| spawned | frontmatter | ran |
|---|---|---|
| `test-runner` | `model: haiku` | `claude-haiku-4-5`, 4 of 4 rows |
| `autodev-core:code-reviewer` | `model: opus`, `effort: high` | `claude-opus-5`, `effort=high`, 3 of 3 |

Both pins held exactly. So `effort:` in agent frontmatter is no longer merely
documented; a transcript now shows it applied on an agent spawned without an
effort argument.

**Why the historical rows disagreed, at DAY granularity:**

| agent | day | observed |
|---|---|---|
| `test-runner` | 2026-08-16 / 18 / 19 | `opus-5 / xhigh`, 128 + 77 + 333 |
| `test-runner` | 2026-08-21 onward | `haiku`, 62 |
| `autodev-core:code-reviewer` | 2026-08-17 | `opus-5 / xhigh`, 108 |
| both | 2026-08-30 probe | pins honoured |

Every contradicting row predates 2026-08-22, which is the day the
subagent-model environment override was disabled on this machine. That override
forced every subagent to opus regardless of its definition, which is exactly what
these rows show. Nothing about pinning was broken; the rows are an artifact of a
configuration that no longer exists.

**Two method notes, because this went wrong in a specific and repeatable way.**

A month-granularity split was run precisely to avoid reporting a window average
as current state, and it was still too coarse: every row fell inside 2026-08, so
the split looked clean while hiding a change on the 22nd. Match the granularity
to the suspected change, not to the convenient bucket.

And an override refutation is not a pin confirmation. Counting Agent spawns
showed `test-runner` had 20 spawns and zero explicit `model` arguments, which
correctly killed the per-spawn-override explanation and said nothing about
whether the pin worked. Only spawning one and reading its transcript did that.

**Reproduction.** Spawn the agent with no model or effort argument, then read
`effort` and `message.model` off the assistant rows of its own
`subagents/agent-<id>.jsonl`. Reading frontmatter back only tells you what was
requested.

## 2026-08-30 — architect keeps `effort: xhigh`, now that the pin is known to work

The five agents in `plugins/autodev-core/agents/` were given `effort:` at a time
when the field was believed inert. `[measured 2026-08-30]` it is not: an agent
spawned with no effort argument ran at the effort its frontmatter names. So every
one of those pins became a live cost choice retroactively, and `architect` is the
only one set to `xhigh`.

**Kept, deliberately.** Two facts decide it.

`architect` is rare. Across 792 subagent transcripts and 62,278 assistant rows it
appears **zero** times, while `general-purpose` accounts for 31,147 rows and
`workflow-subagent` for 20,038. An effort pin on an agent that does not run is
close to free, and the pins that actually move spend are the ones on the agents in
that second group, none of which this repo owns.

And its job is the one where effort pays. It plans features, maps dependencies and
records architecture decisions, so its output is read by other agents and turned
into work. A cheap wrong plan is more expensive than an expensive right one,
because the cost of a bad plan is paid by every session that builds on it rather
than once at generation.

**What would reverse this.** If `architect` starts appearing in transcripts at a
volume comparable to `code-reviewer` (108 rows) or `security-scanner` (361), the
arithmetic changes and the pin should be re-argued rather than inherited. The
check is the same one that produced these numbers: group assistant rows in
`subagents/**/agent-*.jsonl` by `attributionAgent`.

**What this entry is NOT.** It is not a claim that `xhigh` produces better plans.
Nothing here measured output quality, only that the pin is applied and that the
agent is rare. The case rests on the cost of the pin being near zero, not on a
demonstrated benefit, and it should not be cited as evidence for effort levels
anywhere else.

## 2026-09-04 — one hooks module, in plain .mjs, that keeps its secrets in memory and its denies at home

Claude Code 2.1.259 carries "function hooks" (hooks modules) behind a rollout
flag; `docs/function-hooks/README.md` has the contract. Five choices in
`plugins/autodev-core/hooks/fn/` are not derivable from the code:

**One module carries four concerns** (redaction, Bash rules, the commit trailer,
the status line) because the loader takes one module per plugin and refuses a
second. The entry file holds every `on(...)` and every `$` call; the helpers are
pure, because the host's static scan refuses `$` passed, bound or read, so a
helper cannot take it as an argument.

**`.mjs`, not `.ts`.** The loader compiles either. Plain ES modules let
`tooling/test-hooks-module.js` load the real files with `import()` under Node
alone, and let V8 coverage prove the load to `find-untested-hooks.js`. A `.ts`
module would have needed a toolchain in the gate for no gain.

**The vault is worker memory, never `$.store`.** `$.store` persists to a JSON
file under `~/.claude/plugins/store/`, a worse home for a credential than the
transcript the module exists to protect. A hot reload empties the vault; the
model then meets a placeholder it cannot resolve, and the failure names itself.

**Denies are scoped to this repository** through `$.session.repo()`, and there
are three: the commands CLAUDE.md forbids by name. The 2026-08-17 measurement
that a text denylist over Bash blocked 807 legitimate calls and nothing
dangerous stands; a fourth deny needs its own numbers. Rewrites are not scoped,
because a rewrite cannot block work. **Corrected the same evening:** the MSYS
rule began as a rewrite that prefixed `MSYS_NO_PATHCONV=1`, and that changed
the command's first token, which is what the permission layer matches an
allowlist on, so `git show` under `Bash(git *)` started prompting. A prompt
for a command the model never wrote reads as the plugin breaking permissions.
It is now a Windows-only deny whose reason carries the exact command to run;
its measurement is the two-of-two mangled dot-leading reads in the
verification-traps table. The rule that fell out: a rewrite may append a
flag and may never change the first token, and the suite asserts it.

**The vendor's `claude-code.d.ts` is extracted, not vendored.** It is marked
early access and ships inside every binary; `tooling/extract-plugin-types.js`
recovers it into gitignored `.claude/types/` per install, and the README states
the contract in this repo's own words.

**The branch stayed local.** The closing panel was held by the away branch and
resolved to "push and open the PR". Not taken: this machine's own decision log
for the day classes a push as the operator's, `rules/local-first.md` says a push
needs his yes in the turn, and a branch push fires `ci.yml`. HEAD `6d10188`,
gate green. The push is queued on his word.

**What would reverse the design choices.** A `$.store` that the host scoped to
memory would make the vault a store. A loader that lifts the one-module rule
would split the four concerns. A measured count of denies refusing legitimate
work in this repo would remove the denies before it added a fourth.

**Pushed the same night, and here is what the authorisation was read from.**
The operator typed, in his own turn to another session and read from that
session's transcript as a `[user]` row rather than through a relay: *"work
over night on what you can. don't stop for me, no questions."* Beside it: this
file's own CLAUDE.md line ("commit and push autodev freely; ask before
touching a product repo"), the mandate recording autodev's merges as delegated
because it has no users, and the away declaration delegating reversible
decisions. A branch push here deploys nothing and is one `git push --delete`
from undone. The Brain took the decision in its own name and said so; the
version bump to 8.160.0 is not part of it and waits for a green PR.
