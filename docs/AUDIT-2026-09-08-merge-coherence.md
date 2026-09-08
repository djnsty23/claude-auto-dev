# Audit — 2026-09-08 — is the merged result coherent?

Seventeen PRs landed on 2026-09-07/08 from sessions that could not see each
other. Each was verified against the base it was cut from. **Nothing had checked
the merged result.** This is that check. It adds no features.

## Scope, and how the population was established

`gh pr list --state merged --limit 220` returns **every merged PR (#1–#207)**, so
the window is complete rather than truncated by the default limit. Filtering on
`mergedAt >= 2026-09-07T00:00Z` gives **17**:

    #178 #179 #180 #181 #184 #186 #187 #188 #189 #191 #192 #195 #197 #200 #202 #205 #207

Landing was decided by each PR's `baseRefName` and `mergeCommit` and confirmed by
reading the merged content out of the tree — never by `git cherry` or a three-dot
diff, which report squash-merged work as unlanded. That distinction is not
theoretical here; it produced Finding 1.

**Base moved mid-audit.** The first pass ran against `1813e0a`; `#181`, `#205`
(release 8.165.0) and `#207` landed during it and the host rebooted, so everything
below was re-verified against **`38ab642`** on a clean tree. Every finding survived
the move. Where a fact could have changed — the `CLAUDE.md` counts, the hook
inventory — it was re-measured, and the re-measurement is what is reported.

**Only three files were touched by more than one PR** in the original window:
`CLAUDE.md` (#180, #191, #192), `docs/DECISIONS-2026-09-07-landed-check-rescue.md`
(#179, #186) and `docs/decisions.md` (#195, #200, later #181, #207). Textual
collision was therefore not the risk. **Every finding below is a semantic collision
between files no two PRs shared** — which is why per-PR review could not have caught
any of them.

---

## The four highest-value findings

### Finding 1 — #197 is reported MERGED and is not in `main` (11 files)

**Severity: high. This is the finding the audit existed to catch.**

`gh pr list --state merged` lists #197, *"fix(suites): nine more suites that read a
killed child as a verdict"*. Its 11 files are not in `main`. No marker from its diff
survives anywhere in the tree:

| marker from #197's diff | occurrences in `main` |
|---|---|
| `maxTimeout` | 0 |
| `spans a killed attempt` | 0 |
| `status=null signal=SIGTERM` | 0 |
| `docs/DECISIONS-2026-09-08-timeout-budget-sweep.md` | file does not exist |

The cause is its base branch:

```
#183  OPEN    base=main                             head=claude/suspicious-turing-04a310
#197  MERGED  base=claude/suspicious-turing-04a310  head=claude/timeout-budget-sweep
#193  OPEN    base=claude/suspicious-turing-04a310  head=claude/stoic-mendel-75b02a
```

#197 merged into **#183's head branch**, and #183 is still open. Sixteen of the
seventeen PRs in this window have `base=main`; #197 is the one that does not, and
nothing in `gh pr list`'s default output shows it. A session asking "did it land?"
is told `MERGED`.

Two consequences worth naming.

First, the suite fixes are absent from the tree the gate grades — and the first
gate run for this audit spent **~11 minutes inside `test-hook-execution-evidence` at
load average 84–110**, which is precisely the contention class #197 was written to
stop being read as a verdict.

Second, the generalisation. **`state: MERGED` is a claim about a base, not about
`main`.** The repo already learned the mirror-image lesson in #179 — ancestry is not
content — and built `check-branch-landed.js` for it. The same question asked of a
*PR* has no such tool, and the default `gh` output actively hides the answer.

> **For the operator.** #183 is the blocker for both #197 and #193. Landing #183
> lands all three; leaving it open leaves eleven files of suite fixes reading as
> merged and behaving as absent.

### Finding 2 — #202 (merged) documents a hook that exists only in #199 (open)

**Severity: high — it ships to strangers' sessions.**

#202 added to `plugins/autodev-core/skills/commit/SKILL.md`:

> "A `commit-msg` or `pre-push` hook that exits non-zero is a gate, and
> `--no-verify` skips it. **The PreToolUse guard asks before that flag runs, and its
> reason names the hook file and the script it runs.**"

and:

> "**The PostToolUse note after the push asks for exactly this line.**"

Measured against the tree at `38ab642`:

- **No hook anywhere mentions `--no-verify`.** `grep -rn "no-verify" plugins/*/hooks/*.js`
  returns nothing.
- The only PreToolUse hook matching `Bash` is `coordinator-write-guard.js`. It is
  **inert unless a Brain role file names this session** (its own `--help`: *"Absent =
  inert"*), it **denies with `exit(2)`** rather than asking, and its reason names the
  role file and the repo — not "the hook file and the script it runs".
- The PostToolUse hooks are `post-tool-typecheck.js` (matcher `Write|Edit`) and
  `telemetry.js`, whose commit branch reports the **options-protocol queue**. Neither
  fires on a push; neither asks for a bypass record.

The mechanism described is **PR #199, still open**: *"feat(hooks): ask before
`--no-verify` and ask for the record after, in hooks that already run"* — which adds
exactly a `coordinator-write-guard.js` branch, a `telemetry.js` rider and
`plugins/autodev-core/scripts/hook-bypass.js`.

Two sessions split one change. #202 shipped the prose, #199 holds the code, and only
#202 merged. **The skill now instructs a stranger to rely on a guard their install
does not contain** — and the advice it gives on that authority is to reach for
`--no-verify`.

> **Recommended:** land #199, or reword #202's two sentences to the conditional until
> it does. `commit/SKILL.md` is under `plugins/`, so the merge policy requires review
> — deliberately not fixed here.

### Finding 3 — `CLAUDE.md` says force-push is blocked; nothing blocks it

**Severity: medium. Reported by a peer session, independently re-measured here —
including one of its supporting facts, which was wrong.**

`CLAUDE.md:248`:

> "**`git commit -F <file>`, never `-m`** — the shell eats backticks as command
> substitution, **and force-push is blocked so the message cannot be amended.**"

**The claim conflates two different mechanisms, and only one of them is absent.**

| probe | result |
|---|---|
| `gh api …/branches/main/protection` | **404 Branch not protected** |
| `gh api …/rulesets` | **`[]`** — zero rulesets |
| any hook blocking `--force` / `--force-with-lease` | none; `pre-tool-filter.js:25` records that blocking `--force-with-lease` was a past defect, *since corrected* |
| `tooling/githooks/pre-push` | **exists, tracked, executable (1606 bytes)** |
| `git config core.hooksPath` | **`…/autodev/tooling/githooks`** — so it is **live in this clone**, and in every worktree of it |
| `grep -E 'force\|\+refs\|delete'` over that hook | **0** — it runs `validate` and polices nothing about force |

So: **server-side, nothing is blocked.** *Locally*, a real pre-push gate is armed and
fires — a session hit it earlier today (*"pre-push: validate failed — not pushing"*),
which is the only reason it reached for `--no-verify`.

**Keeping those apart is the whole safety of the fix.** A session told the flat
"force-push is not blocked and there is no pre-push hook" may force-push straight over
a validate gate that is live in its own worktree. The correction deletes the false
clause and adds nothing implying the hook is absent.

**A methodology note, because it produced the wrong half.** The first report of this
finding said the hook did not exist, from:

```bash
grep -c 'force' tooling/githooks/pre-push 2>/dev/null || echo 'file absent'
```

`grep -c` **exits 1 when the count is zero**, so `||` fired on *no matches* and printed
"file absent" next to a perfectly good `0`. Reproduced here exactly: prints `0`, exits
1. This is the same family as `$?`-after-a-pipe, which `CLAUDE.md` already warns about:
**an exit code meaning "no matches" is not an exit code meaning "no file".**

**Why this one is instructive, and why the fix is narrow.** The false clause is
*rationale inside a rule that is itself correct*. `git commit -F <file>` is right,
everyone follows it, and the backtick trap is its real and sufficient reason. The
false half rode along unexamined **because the sentence it lives in still gives good
advice** — the same shape as the "rewrites sources in place" claim that survived five
days, and the same shape as Finding 6 below. A sentence that still works does not get
re-read.

One trap in fixing it, which the peer's write-up did not name: **deleting the clause
must not read as licence to amend.** `CLAUDE.md` separately forbids `git commit
--amend` here for an unrelated and still-valid reason — several sessions commit to
this clone at once, and an amend can land on a commit that stopped being yours. The
fix below removes the false mechanism and leaves that prohibition standing on its own
reason.

> **A better search than hunting wrong sentences:** look for true rules propped up by
> false justifications. Wrong sentences inside wrong rules get caught quickly; a wrong
> reason under a right rule is load-bearing for nobody and invisible to everybody.

### Finding 4 — two blocking Stop hooks now share one retry flag

**Severity: medium. Introduced by #181, which landed mid-audit.**

#181 added `stop-typecheck.js`, so `Stop` now carries five hooks and **two of them
can block**: `stop-auto-check.js` and `stop-typecheck.js`.

`stop-typecheck.js` limits itself to one retry by reading a harness-supplied field
(`stop-typecheck.js:107`):

```js
if (data.stop_hook_active) {           // "still failing after the retry"
    console.log(JSON.stringify({ systemMessage: ... }));
    process.exit(0);                   // downgrades to a note, does not block
}
console.log(JSON.stringify({ decision: 'block', reason }));
```

`stop_hook_active` is set by the harness when a Stop was *already* blocked — it is
not scoped to the hook that blocked. `stop-auto-check.js` blocks and never reads the
field. So during an `auto` run, `stop-auto-check.js`'s block raises the flag, and
`stop-typecheck.js` then takes its "still failing after the retry" branch on its
**first** attempt, emitting a note instead of the block it was written to emit. The
type errors reach the operator as a `systemMessage` rather than reaching the model.

**Stated as a question rather than a fix, because it rests on one harness fact I
could not verify from inside this repo:** whether `stop_hook_active` is session-scoped
or per-hook. If session-scoped, the interaction above is real and `stop-typecheck.js`
needs its own retry marker instead of the shared flag. If per-hook, there is no
defect. Both hooks are under `plugins/`; either way it needs review.


---

## Q1 — contradictory rules

### First, a correction to the question's premise

The brief assumes "the `rule-*` skills are always-on and auto-loaded, so two rules
that disagree both reach every session." **That is true of eight of the sixteen.**

- **Three are not always-on at all** — `rule-diagnosis`, `rule-options-protocol` and
  `rule-workflow-spine` carry `user-invocable: true` and **no `paths:` key**. They
  load when invoked, not automatically.
- **Five more are path-scoped to file types this repo does not contain.** Tracked
  extensions here are 238 `.js`, 150 `.md`, 32 `.json`, 5 `.html`, 2 `.ps1` — and
  **zero** `.tsx`, `.jsx`, `.ts`, `.vue`, `.svelte`, `.css`, `.rs`, `.go`, `.sql`.
  So `rule-ab-testing` (`**/*.tsx`, `**/*.jsx`, `**/experiment*.ts`, `**/ab-*.ts`),
  `rule-design-system`, `rule-ramifications`, `rule-record-size` and
  `rule-thumb-first` **can never auto-load while working on this repo.**

Both rules `CLAUDE.md` names as required reading before proposing a cause or a
detector are in that set: `rule-diagnosis` is not auto-loaded, and `rule-ab-testing`
cannot match a file here. Only `rule-gate-integrity` (`**/check-*.js`,
`**/find-*.js`, `**/test-*.js`) actually fires.

This is #188's own lesson applied to the rule library instead of a veto: **a rule
scoped to a glob nothing matches is indistinguishable from a rule nobody needed.**
`CLAUDE.md` is fixed for this below; the globs themselves are under `plugins/` and
are left as a question.

> **Question.** Should `rule-ab-testing`'s `paths:` gain `**/*.js` and `**/check-*.js`?
> It is the one rule whose subject matter is *this* work — measure a detector before
> adopting it — and it is the one that cannot load here.

### C1 — pushing and merging: `rule-local-first` vs the 2026-09-08 merge policy

`plugins/autodev-core/skills/rule-local-first/SKILL.md`:

> "Commits stay local. **An ad-hoc `git push`, PR or merge needs Andy to say so in
> that turn.** 'It is ready to push' is a status line, not a licence."

`~/claude-memory/MERGE-POLICY.md`, decided 2026-09-08:

> "**A SESSION MAY MERGE ITS OWN PR** when ALL of these hold …"

Flatly opposed on the same subject. The policy is dated one day later and is the
operator's own decision, so **the policy wins**; `rule-local-first` was not updated
when it changed.

> **Recommended:** `rule-local-first` gains a scoping sentence — the
> ask-in-that-turn rule stands for client and product repos, and defers to
> `MERGE-POLICY.md` for this repo and the other no-user internal repos it names.

### C2 — is a CI result evidence? The sharpest of the three

`rule-local-first`:

> "## GitHub Actions — Do not add a workflow. Do not diagnose a bug by pushing and
> reading the run. **Do not wait on one. If a repo already carries workflows, their
> result is not evidence here** and their absence is not a blocker."

`MERGE-POLICY.md`, self-merge condition 1:

> "**Job-level CI green** — `gh api repos/OWNER/REPO/commits/<sha>/check-runs`.
> NEVER the run rollup … Measured 2026-09-07."

One says a CI result is not evidence and must not be waited on. The other makes a CI
result the **first precondition for merging at all**.

This window strengthened the case against `rule-local-first`'s position. #191 found a
defect only a platform difference exposes — `process.exit()` truncating stdout at
64 KiB through a pipe on darwin, under exit status 0 — and the fix was to **re-add
`macos-latest` to the CI matrix**, now `[ubuntu-latest, windows-latest, macos-latest]`.
`CLAUDE.md` says in as many words that CI and the local gate grade different sets, and
all three of its claims verify today: CI runs a `node --check` loop over
`plugins/*/hooks/*.js` that the gate lacks, the gate runs `check:probe-shapes` that CI
lacks, and exactly four CI steps are `if: matrix.os == 'ubuntu-latest'`.

**Recommendation: the merge policy wins, and `rule-local-first`'s Actions section
should be narrowed rather than deleted.** Its measured claim survives intact — *do not
diagnose by pushing and reading the run; a blocked run and a red test look identical*.
What no longer holds is the flat *"their result is not evidence here"*, now that a
job-level `check-runs` query is a merge gate and the matrix carries the platform that
caught #191.

### C3 — `brain/SKILL.md` still says sessions do not merge

`plugins/autodev-core/skills/brain/SKILL.md:1470`:

> "So the Brain merges and does not implement, and **the sessions implement and do not
> merge.**"

`docs/DECISIONS-2026-09-08-quota-wall.md:11`, landed in #200 the same day:

> "the Brain holds merge authority on qr and autodev; **sessions still do not merge
> their own PRs**."

Against `MERGE-POLICY.md`: *a session may merge its own PR.*

**Recommendation: the policy wins for this repo and the other internal repos the
policy names; the brain skill's rule
survives for product and client repos**, where its stated reasoning — sequencing merges
across a fleet is coordination no single session can see enough to do — is untouched by
the policy change. The skill states the rule **unconditionally**, and that is the part
needing narrowing. #200's decisions entry is a dated record of a call made under the
old rule and should stay as written.

### C4 — the merge policy itself exists in two versions, and they disagree on skills

**This is the contradiction that let Finding 2 ship.**

`~/claude-memory/MERGE-POLICY.md`, under *REVIEW IS STILL REQUIRED for*:

> "**Anything under `plugins/` that ships** — hooks, skills, plugin.json."

The formulation circulating verbally between sessions is narrower:

> "review is required only for hooks, gate steps, command execution, and
> money/auth/prod/schema"

The two lists agree on everything except one category — **skills** — and that is the
largest category in the repo (58 in core alone). Under the written policy, a `SKILL.md`
change is review class. Under the verbal one it is not.

Measured consequence in this window: **#202 (two `SKILL.md` files) and #188 (a
`rule-*` `SKILL.md`) were both merged under the narrow rule, and both are review class
under the written one.** #202 is Finding 2 — the merged prose describing an unmerged
hook. A review that read `commit/SKILL.md` against the tree would have asked where the
PreToolUse guard was.

So the ambiguity is not academic; it selected exactly the PR that carried the defect.

**Recommendation: the written policy wins** — it is the operator's own wording, and it
is the one that would have caught the defect. If a `rule-*` skill ever encodes this
policy, it must not ship with the ambiguity: the two formulations differ on one
category and it is the one that ships to strangers.

> This audit applied the written list to itself. Its file list — `docs/` and
> `CLAUDE.md`, nothing under `plugins/` — was checked against that rule rather than
> against the PR's title.


### Checked and found NOT contradictory

Reported because a clean result needs reading too:

- **#188's new `rule-gate-integrity` section vs `rule-ab-testing`.** #188 added *"a
  zero in a census is two claims wearing one number"*; `rule-ab-testing` rule 5 says
  *"A result of zero is a result — and it needs reading, like any other."* These
  **agree** and reinforce each other.
- **`rule-diagnosis` vs `rule-ab-testing`** — no opposed instruction found.
- **The `prd.json` five-state table in `CLAUDE.md` vs `prd-states.js`** — exact match,
  including the `unrecognised` bucket.

---

## Q2 — duplicated mechanisms

`node plugins/autodev-core/scripts/find-orphan-checks.js .` reports **147 scripts, 145
reachable, 0 orphaned assertions**, so no duplicate surfaced as an orphan. Checked by
hand instead:

| suspected pair | verdict |
|---|---|
| `workflow-liveness.js` vs `workflow-run-triage.js` (#200) | **Not duplicates.** Cron liveness vs `Workflow` agent journals. `stop-workflow-wall-note.js` calls `triageRun()` from the triage script — *"one reading of a run directory and not two that disagree"*. |
| `check-doc-staleness.js` (#187) vs `check-superseded.js` vs `check-claim-provenance.js` | **Not duplicates.** Open-state claims at Brain boot / skills teaching outgrown conventions / provenance of absence claims. Each header names the others' territory. |
| `check-branch-landed.js` (#179) vs `brain-brief.js`, `fleet-overlap.js` | **Not duplicates.** `brain-brief.js` *recommends* the script rather than reimplementing it. |
| `prd-states.js` vs `memory-session-end.js` | **A deliberate, marked duplicate.** `${CLAUDE_PLUGIN_ROOT}` resolves per plugin, so memory cannot require core's file. The copy carries `// DELIBERATE DUPLICATE of autodev-core's prd-states.js isOutstanding()` and matches `isOutstanding()` exactly. Correct as-is. |
| `post-tool-typecheck.js` vs `stop-typecheck.js` (#181) | **Not a duplicate — a producer/consumer split.** Until 2026-09-07 the PostToolUse hook ran typecheck and lint itself; it now only appends edited paths to `.claude/.typecheck-pending`, and the Stop hook consumes the list and runs each tool **once per response**. This is a de-duplication, correctly done. (Its retry flag is Finding 4.) |
| Five Stop hooks | **No duplication.** See Finding 4 for the one real interaction. |

**The one real Q2 finding is an absence, not a duplicate:**

### Finding 5 — the repo's contradiction detector is never run against the repo

`tooling/check-superseded.js` exists for exactly the failure this audit was
commissioned to find. Its header:

> "The failure this catches is a documentation cascade: one skill gets updated to a
> new harness capability and its siblings do not, so **the plugin ships two or three
> mutually exclusive instructions for the same job** and the model follows whichever
> it loaded."

`check:superseded` is in `package.json` and appears in **neither `npm run gate`, nor
`.github/workflows/ci.yml`, nor `validate.js`**. Its suite, `tooling/test-superseded.js`,
drives it over **fixtures only** — so nothing ever points it at the repo's own skills.
It is not an orphan by `find-orphan-checks.js`'s definition (a suite does run it), which
is why it has stayed invisible: **it is a detector that is exercised without ever being
applied.**

Run by hand for this audit it is clean — *103 markdown files, 16292 lines, 7 patterns,
no superseded convention found*, exit 0. That is a real result and a narrow one: its
patterns are a closed denylist of specific superseded strings, so it could not have
caught C1, C2, C3 or Finding 2. **It is worth wiring for what it does cover, and wiring
it must not be mistaken for a safety net for this class.**

> **Question.** Wire `check:superseded` as a seventh gate step, scanning the tree rather
> than a selftest? It is a gate-step change, so the merge policy requires review.

---

## Q4 — the gate still gates

**Green, all six steps, on a clean tree at `38ab642` with nothing of this PR's
applied.** Each step was run separately and its exit status captured to its own file —
never through a pipe, because `$?` after a pipe is the pipe's status.

| # | step | exit | wall | load at start |
|---|---|---|---|---|
| 1 | `npm test` | **0** | 6m 53s | 4.70 |
| 2 | `npm run check:suites` | **0** | 24m 21s | 6.35 |
| 3 | `npm run check:probe-shapes` | **0** | <1s | 12.19 |
| 4 | `npm run check:population` | **0** | 1s | 12.19 |
| 5 | `npm run check:entrypoints` | **0** | 9s | 12.19 |
| 6 | `npm run check:skill-tools` | **0** | 1s | 11.45 |

What each actually reported, rather than just its colour:

- **Step 1** — `118/118 suites passed`, including `validate` and **`tree-inert`**, so
  no suite rewrote what it grades.
- **Step 2** — `118 suite(s) · 117 verified able to fail · 0 NOT verified · 1 canaried
  elsewhere, not stubbable here · sweep worktree clean, source tree refs unmoved`.
  **Exit 0, not 2** — this is a real verdict, not the INDETERMINATE state, and the
  no-new-unverifiable-suite condition the merge policy names is met.
- **Step 3** — 17 passed, `population: 9 planted positives, 8 negatives, 9 rules`.
- **Step 4** — advisory, as designed: 211 scripts read, 22 report an absence, **2 lack
  a population line or control** (`test-hooks-module.js` among them). It prints its own
  scope caveat — control detection is per-file, so a clean result means a control
  exists, not that every absence is guarded.
- **Step 5** — grades hangs only; the non-zero exits it lists (`validate.js` exit 1,
  `find-vacuous-assertions.js` exit 2) are reported, never failed on.
- **Step 6** — clean, and says in its own output that a clean run means no *detectable*
  undeclared mandate, not that none exists.

### Two traps, and how each was handled

**The `&&` chain.** `npm run gate` is six commands joined by `&&`, so a red step 1
silently skips five. The chain was not used. Each step ran on its own, wrote stdout and
stderr to separate files, and its exit code was appended to a ledger — so "green" here
is six measured statuses, not one.

**`check:suites` exit 2 is INDETERMINATE, not failure.** It refuses a dirty tree and
grades HEAD in a private worktree under tmpdir. It returned **0**, so the distinction
did not have to be exercised — but it nearly did. The first attempt at this gate ran at
**load average 84–110** and was still inside a single suite at 11 minutes when the host
rebooted and killed it. The rerun, at load 4.7–12, cleared the same suite in under
seven minutes. Under load this step is the sweep working, not a red; the answer is to
re-run quiet, not to raise a timeout.

### One thing the green does not cover

The gate graded a tree that is **missing #197's eleven files** (Finding 1) — the fixes
for ten suites that read a killed child as a verdict. The first gate attempt failed in
exactly that way. So this green says the gate passes on the tree as it stands; it says
nothing about the tree the repo believes it has.

---

## Q3 — prose that no longer matches code

Every mechanical claim in `CLAUDE.md` was re-verified against `38ab642`. **Most of it
holds**, including all four counts #192 corrected. Confirmed correct:

| claim | verified |
|---|---|
| the gate is six steps, `&&`-chained, in that order | matches `package.json` `gate` exactly, step for step |
| `npm test` = every `tooling/test-*.js`, then validate | `test-all.js` discovers on `/^test-.*\.js$/`, runs `validate.js` last |
| CI adds a `node --check` loop over `plugins/*/hooks/*.js`; the gate runs `check:probe-shapes`, CI does not | both true |
| exactly four CI steps are `if: matrix.os == 'ubuntu-latest'` | exactly 4 |
| `check:suites` grades HEAD in a private worktree, refuses a dirty tree, exits 2 | confirmed, and reproduced — see Q4 |
| `test-all.js` snapshots `git status` and fails `tree-inert` | present |
| core: **58 skills, 5 agents, 10 hook events**; memory: **4** | all four exact, re-measured after #181 added a fifth `Stop` hook (the event count is unchanged) |
| the `prd.json` five-state table | matches `prd-states.js`; `summarise()` and its `unrecognised` bucket both present. **No sixth state**: `ready` does not appear in `summarise()` on `main` — PR #194, which adds it, is still open |
| `stop-auto-check.js` escape hatches, in order | matches, hatch for hatch |
| `pre-tool-filter.js` fails closed; its private-name block fails open | both confirmed at the source |
| `check-no-private-names.js --digest` prints one hex line | confirmed |
| "Version is six files" | VERSION + `package.json` + marketplace + 3 × `plugin.json` = 6 |

Three claims did not hold. Two are fixed in this PR; one is left deliberately.

### Finding 6 — the `rule-*` always-on claim is wrong for three of sixteen (FIXED)

`CLAUDE.md:161`:

> "**`rule-*` skills are always-on** (`user-invocable: false`, auto-loaded by a
> `paths:` glob) and encode conventions derived from real failures — read
> `rule-diagnosis`, `rule-ab-testing` and `rule-gate-integrity` before proposing a
> cause, a detector or a gate."

`rule-diagnosis`, `rule-options-protocol` and `rule-workflow-spine` are
`user-invocable: true` with no `paths:` key. The sentence recommends `rule-diagnosis`
in the same breath as asserting it is always-on. Fixed **as a property, not a count**,
per this file's own doctrine — the replacement tells the reader to check the
frontmatter, and names the command that answers it.

### Finding 7 — the version-file paths do not exist as written (FIXED)

`CLAUDE.md:231` names `marketplace.json` and `plugins/*/plugin.json`. The real paths
are `.claude-plugin/marketplace.json` and `plugins/*/.claude-plugin/plugin.json`;
`plugins/autodev-core/plugin.json` does not exist. The count of six is right. Fixed.

### Finding 8 — one hazard sentence outran its own fix (not fixed; judgement)

`CLAUDE.md`'s macOS-pipe-truncation bullet lists what hides the defect: *"run it on
Linux CI and the write is synchronous so CI is green"*, and *"CI stayed green on
`[ubuntu, windows]`"*. Both were true when written. **#191, in this same window,
re-added `macos-latest`**, so the matrix is now
`[ubuntu-latest, windows-latest, macos-latest]` and this repo's CI no longer hides that
class.

The sentences are past-tense and remain accurate as history; as *present advice about
this repo* they understate the protection. **Left alone deliberately** — the general
lesson is portable, and correcting it risks trading a true general statement for a
dated specific one, which is the trade `CLAUDE.md` itself warns against. Flagged so the
next reader is not surprised.

### Finding 9 — the gate's step count is stated in five places and checked in none

Not currently wrong — the gate **is** six steps, and all five sites agree today. It is
recorded because it is primed to rot, and `CLAUDE.md` is the file that warns about
exactly this shape.

| site | text |
|---|---|
| `CLAUDE.md:16` | "THE GATE: **six steps** chained with &&" |
| `CLAUDE.md:17` | "Step **1 of 6**" |
| `CLAUDE.md:22` | "`npm test` is **ONE SIXTH** of the gate" |
| `CLAUDE.md:37-40` | the literal six-line chain |
| `CLAUDE.md:44` | "run the **remaining five** yourself" |

Five statements of one number, in four grammatical forms — a cardinal, an ordinal, a
fraction and a remainder — so no single search finds them all. **PR #198 (open) adds a
seventh gate step.** On the day it lands, all five are wrong, and the gate that would
catch it does not exist: nothing in this repo grades prose against `package.json`.

This is the same failure `CLAUDE.md` already documents about the architecture line
("43 skills, 4 agents, 7 hook events" — three of four wrong within three weeks), and
the file's own prescription applies: *a number in prose is correct only on the day it
is typed.* The difference is that here the number is load-bearing — it is how a reader
knows five steps were skipped.

**Not fixed here.** Collapsing five sites into one is a rewrite of the file's most-read
section, and the right moment is the commit that makes the gate seven — #198's, where
the change is forced anyway.

### Checked, and clean: substring matching over structured data

A peer session flagged bare substring matching as this week's recurring defect. Checked
across the gate steps and every script in this window; **nothing in scope does it.** The
nearest case is a counter-example of the pattern done right —
`workflow-run-triage.js:182-186` uses `indexOf` purely as a **prefilter**
(`if (!hasTs && !hasTool && !hasSynth && !hasInt) continue;`) and then makes every
decision on parsed structure (`row.type === 'assistant'`, `msg.model === '<synthetic>'`,
`c.type === 'tool_use'`). The substring narrows; the structured field decides.

---

## Fixes applied in this PR

Three edits, all to `CLAUDE.md`, all unambiguous, none under `plugins/`:

1. **The `rule-*` always-on sentence** — replaced with the property and the command
   that checks it, rather than a claim the tree can falsify (Finding 6).
2. **The version-file paths** — corrected to `.claude-plugin/marketplace.json` and
   `plugins/*/.claude-plugin/plugin.json` (Finding 7).
3. **The force-push clause** — deleted, leaving the `git commit -F` rule standing on
   the backtick reason that is actually true, and leaving the separate `--amend`
   prohibition untouched and on its own reasoning (Finding 3).

**Everything else is a question, not a fix**, and deliberately so. `MERGE-POLICY.md`
requires review for *anything under `plugins/` that ships* — which is broader than
"hooks and gate steps" — so C1, C2, C3, Finding 2, Finding 4 and the
`rule-ab-testing` glob all touch files this PR must not silently change. The file list
of this PR was checked against that rule rather than its title.

## Open questions, in the order they cost something

| # | question | recommendation |
|---|---|---|
| 1 | Land #183, so #197's eleven files and #193 stop reading as merged? | **Yes.** Nothing else recovers them, and the gate is grading a tree that lacks them. |
| 2 | Land #199, or reword #202's two sentences? | **Land #199.** The prose is right about where the repo is going; the code is one merge away. Reword only if #199 is being abandoned. |
| 3 | Which wins on merge authority — `rule-local-first` / `brain/SKILL.md`, or `MERGE-POLICY.md`? | **The policy**, scoped: the two skills keep their rule for client and product repos and defer for this repo and the other internal repos the policy names. |
| 4 | Is a CI result evidence (C2)? | **Narrow `rule-local-first`, do not delete it.** Keep "do not diagnose by pushing"; drop "their result is not evidence here". |
| 5 | Is `stop_hook_active` session-scoped or per-hook? | Confirm against the harness. If session-scoped, `stop-typecheck.js` needs its own retry marker. |
| 6 | Give `rule-ab-testing` a `paths:` glob that matches this repo? | **Yes** — `**/*.js` and `**/check-*.js`. It is the rule most relevant to this work and it cannot currently load here. |
| 7 | Wire `check:superseded` as a tree scan in the gate? | **Yes, with its limits stated.** It is cheap and clean today; it is not a safety net for the contradictions above. |
