# Changelog

## [8.72.0] - 2026-08-17

### Fixed — the plugin shipped three dev-server conventions at once

`rule-windows` forbade `npm run dev` from Claude Code and prescribed
`start cmd /k`, on the premise that a backgrounded server dies at session end.
The premise is now false twice over: `run_in_background` detaches the process
across turns, and `preview_start` supervises it outright.

`browser` had already moved to `preview_start` with `.claude/launch.json`, but
`auto`, `test` and `scan` still instructed a detached Bash, and the rule still
forbade both. Three conventions, mutually exclusive, all live. Fixing only the
rule would have left the harness inconsistent, so the three pipeline skills now
name `preview_start` as the preferred path with detached Bash as the documented
fallback. `start cmd /k` is gone rather than demoted — it opens a window no tool
can read, which makes a failed compile indistinguishable from a slow one.

### Fixed — the Supabase workaround told you to run the wrong `curl`

`rule-windows` claimed `curl` works in PowerShell but not in plain cmd. Both
halves are wrong. `curl.exe` ships in `C:\Windows\System32`, so cmd is fine, and
in Windows PowerShell 5.1 `curl` is an alias for `Invoke-WebRequest` —
`Get-Command curl` returns `CommandType: Alias`.

That made it a live bug rather than a stale note. The section exists because
`supabase db query --linked` hangs behind the Windows firewall, and its three
replacement commands all used bare `curl` with `-H`, which `Invoke-WebRequest`
rejects with a parameter-binding error that never mentions curl. All three now
say `curl.exe`, and the gotcha explains the alias instead of denying it.

## [8.71.0] - 2026-08-17

### Added — a success criterion on every user-invocable skill

Fourteen skills had no verification language at all, including `security`,
`perf`, `a11y`, `monitoring`, `standards` and `status` — the ones whose output
someone reads and acts on. Each now has a **Proving the run** section naming one
observable and, where one exists, a command that can fail. Twelve sections, all
different: `archive-prd` asserts story-count conservation, `perf` refuses a claim
without a before number, `monitoring` requires a thrown error to actually arrive,
`design` requires a screenshot at 390 and 414.

The recurring theme is that a clean result and a probe that never ran produce the
same text, so `security`, `standards`, `mem-search` and `knowledge-agent` must
show the check can see something before reporting that it saw nothing. After:
39 user-invocable skills, 0 without a criterion. The three always-on `rule-*`
skills are excluded — they are background rules, not runs.

### Added — the learning loop reaches the pipeline skills

37 of 52 skills never wrote anything back. For `fix`, `review`, `test`, `ship`,
`deploy`, `iterate` and `refactor` that meant every lesson died with the session.
They now feed the mechanism that already exists — the story `resolution` field
and conventional `fix:` subjects that `mine-fixes.js` ranks into
`.claude/project-rules.md`, which `review` and `audit` read.

Each carries a **threshold**, which is what decides whether this helps: a store
where most entries say "fixed a typo" is one nobody searches twice. `fix` records
only when the first hypothesis was wrong; `review` when a finding appears twice
and becomes a class; `test` when a test was green and wrong; `iterate` when an
iteration undoes an earlier one.

### Restored — telemetry, which 8.0 dropped entirely

No hook, no skill, no mention anywhere in `plugins/`. Ported back with three
fixes: the session id now comes from the hook payload (7.x read an env var 8.x
never sets, so every event ever written recorded `"session": null`), the skill
reports through `scripts/telemetry-report.js` instead of two inline `node -e`
blocks, and disabling is `CLAUDE_TELEMETRY_DISABLED=1` rather than editing a
settings file that no longer holds the entry.

The suite's load-bearing case is privacy: a canary secret is fed through every
field a tool call carries and the written line is grepped for it, because
"metadata only" is the claim that makes this safe to leave on.

## [8.70.0] - 2026-08-17

### Added — `spec`, the front of the pipeline

`setup-project` scaffolds and then deliberately skips `prd.json` unless a plan
already exists; `brainstorm` only writes stories on an explicit apply. So "build
me X" had nowhere to land. `spec` turns one sentence into `SPEC.md`, a schema and
a backlog `auto` can work — schema first, assumptions stated rather than
interviewed for, and printed in the handover so a wrong one costs a line instead
of a sprint.

`check-spec-output.js` is the half that makes it more than prose. A planning
skill fails by emitting confident filler — *Auth flow*, *Dashboard layout*, *Set
up the database* — which looks like a plan and fits any product ever conceived.
The checker rejects layer-named titles, malformed ids, stories born already
passing, acceptance criteria too vague to check, and tables created without RLS.

Its criterion rule is a **denylist of vagueness, not an allowlist of approved
verbs**. The first version demanded a verb from a fixed list and rejected its own
reference example ("inserts a check-in", "the count increments") — the same shape
as the `npx` allowlist removed in 8.69.0, which passed `npx create-next-app` and
blocked `npx -y create-next-app`. Its suite pairs every rejection with a positive
case, which is how that defect surfaced a minute after being written.

### Fixed — the nightly audit discovered zero projects on Windows, silently

Discovery reversed a slug back into a path, and slugs are not reversible: any
directory containing a dash gained extra path segments, and a Windows slug
(`C--Users-…`) became `/C//Users/…`, which cannot exist. `existsSync` returned
false and the surrounding catch hid it, so the audit reported cleanly while
finding nothing. It now reads the real cwd out of the session transcripts already
sitting in each slug directory, and keeps reversal as a fallback.

## [8.69.0] - 2026-08-17

### Removed — the Bash denylist, after measuring what it actually caught

Across 656 transcripts and 57,599 Bash calls it produced 807 blocks: 591 were
`node -e`/`-p` reading local JSON, 73 were `npx` (one of them a production
deploy), 27 were `curl` piped into `node -e` to parse a response, 56 were agents
doing git cleanup in throwaway worktrees. The rules written for catastrophe —
`mkfs`, `format c:`, `diskpart`, `rm -rf ~`, `curl | bash`, `find / -delete` —
fired **zero** times.

Driven with 22 crafted cases, 7 came back wrong, all refusing legitimate work.
`npx create-next-app` passed but `npx -y create-next-app` was blocked: the
20-entry allowlist sat behind a negative lookahead that any flag defeats, so it
only worked when you passed no flags — and the command it exists to permit is the
one `setup-project` prescribes. `git checkout -- .gitignore` was blocked as if it
were `git checkout .`. Grepping migrations *for* "drop table" was blocked.
`--force-with-lease` was blocked while `--force` was the thing feared.

A denylist over command text cannot tell executing a dangerous thing from
mentioning one. **Kept:** the write guard on the installed plugin tree and the
private-name check — those catch structural mistakes, not bad judgment, and
between them produced 8 blocks in 634,893 lines.

### Added — `npm run check:versions`

The pinned-version table in `setup-project` was five majors behind (TypeScript
^5.8 against a released 7.0.2, Next 15, Zod 3, pnpm 10, Stripe 21) and nothing in
the repo could see it: the file was internally consistent and every risk note read
as fact when written. The new gate is the only check here that reads outside the
repo, because this kind of staleness is invisible from inside it. Majors fail,
minors warn, an unreachable registry exits 0.

New pins are evidence-led, not recency-led — the test was whether the previous
major is still being patched — and Next 16 + React 19 + TS 7 were proven by
scaffolding and building on them under `strict` and `noUncheckedIndexedAccess`.

### Fixed — `npm test` could never pass on Windows

`test-drift-audit` built its slug by replacing forward slashes only, so on Windows
it asked mkdir for an absolute path nested inside another and crashed during
setup, before any assertion ran. Production discovery has the mirror-image bug and
is left alone deliberately, with the reasoning recorded at the call site.

### Added — the real Windows browser failure modes

Recovered from the 7.x skill during migration; the cleanup hook shipped in 8.0 but
the prose explaining it did not.

## [8.18.0] - 2026-08-16

### Fixed — `find-orphan-checks` cried wolf about the suites that prove it works

It reported four of **this repo's own test suites** as unreferenced, under a
heading saying they touch prod or money and were kept out of CI on purpose. All
four run on every build. `tooling/test-all.js` finds them with
`readdirSync(dir).filter(f => /^test-.*\.js$/.test(f))` — the reference is a
regex evaluated at run time, so there is no literal filename anywhere to match.

Now treats a runner that **discovers its work by pattern** as a reference.
Measured across three repos, with identical counting:

| repo | before | after |
|---|---|---|
| this one | 7 orphaned assertions + 4 manual | **0 + 0** |
| a media app | 1 + 11 | 1 + 11 *(no dynamic runner — correctly unchanged)* |
| a health app | 37 + 14 | **9 + 9** |

The health app's drop is corroborated independently: its own preflight prints
*"74 harness scripts swept"*, and `harness-sweep.js` is what discovers them.

### The guard took three attempts, both early ones failing the same way

Judging the pattern by hit rate or by a trailing extension, when what matters is
whether it **names** anything:

1. *discard if it matches >50% of candidates* — killed `/^test-.*\.js$/` in a
   `tooling/` directory that is mostly tests. The legitimate case. The fix
   silently did nothing and the four false positives stayed.
2. *require 3+ literal word chars after stripping one trailing extension* — let
   `/\.(js|html|css)$/` through, because "html" is three word characters. That
   suppressed **67 of 120** scripts in a real repo: far worse than the 4 false
   positives it was built to remove.
3. *require a literal that is not a file extension* — `^test-` names something;
   `\.(js|html|css)$` names every file there is.

Four new assertions. **The second canary did not fire until the fixture grew**:
with only two scripts the extension pattern matched 100% and the breadth guard
rejected it, so the test passed with the discriminator guard removed and proved
nothing. Three `.mjs` files were added to isolate the property. A test can be
vacuous for one assertion while passing.

## [8.17.0] - 2026-08-16

### Retracted — "that P0 is marked done and the fix exists nowhere"

It was not. The fixes had shipped **two minutes before** the duplicate that went
looking for them, in a commit closing all four findings from the audit wave.
`passes: true` was accurate the whole time. The claim was stated forcefully,
twice, including in a handoff document, and 8.14.0 was built on it.

**How the false negative was manufactured**, which is the part worth keeping:

```
"is the handler now below authCheck?"                 → no
grep sanitis|sanitiz|generic.*fallback|strip.*PII     → no hits
∴ "the fix exists nowhere"
```

The real implementation was a third shape neither pattern matched — split the
copy into `text` (personal, rides in the encrypted push) and `pubText` (generic,
written to the public file). It is *better* than either thing searched for, and
it is the design later recommended independently here, already shipped.

**An absence search is only as good as its enumeration of what would count as
presence.** Two misses became "nowhere".

`rule-ab-testing` rule 5 is rewritten from "a result of zero is a result" to
demand the same reading a count gets: write down what you would accept as
evidence of presence before reporting absence, and **search for the effect, not
for the fix you had in mind.** The tally goes to sixteen, with the new row
flagged as the one to read twice — the two detectors built for this class were
sound; the premise that motivated them was not, and measuring a detector never
checks the story behind it.

`rule-verification`'s two rules are unchanged and now rest on their own
reasoning rather than on a retracted anecdote.

### Also

The superseded fix branch was removed locally. The other session's work is
better on every point: `[img-consent]` now requires `consentV` to be **enforced
in a 403 refusal** rather than merely present — stronger than the
comment-stripping version proposed here.

## [8.16.0] - 2026-08-16

### Fixed — the name check could not see a new file, which is when it matters most

It caught its author, and only after the push. A handoff doc naming all three
private codebases was written into `docs/`, `validate.js` was run and reported
13 PASS 0 FAIL, and the file was **then** `git add`ed and pushed to the public
remote. `check-no-private-names.js` scanned `git ls-files` — tracked files only
— so at the moment it ran, the new file did not exist as far as it was
concerned.

That window is every new file, every time. A gate that inspects only what is
already committed cannot stop anything from being committed. Now scans tracked
plus `--others --exclude-standard`, so untracked files count while `.gitignore`
is still honoured.

The handoff is removed from the repo rather than anonymised: a document whose
job is telling the next session which private repos are in what state does not
belong in a public marketplace, and stripping the names would leave it useless.

### Added

`validate.js` is now covered by `check-suites-can-fail.js`. It guards plugin
structure, version sync, hook wiring and the denylist above, and nothing had
ever proved it could fail — it is not a `test-*.js` file, so the loop never saw
it. Its mutation is a repo mutation: desync `VERSION` from every manifest and
assert it goes red. **14 gates checked, 0 vacuous.** That check earned itself
immediately — reporting `validate.js` as RED is what surfaced the leak above.

## [8.15.0] - 2026-08-16

### Added — `npm run check:suites`: prove every test suite can fail

This repo keeps writing *"a gate nobody has watched fire is a hypothesis"* and
then hand-canarying one change at a time. This runs that check for all of them,
in CI.

For each suite it derives the source files that suite exercises, replaces each
with a stub that parses and does nothing, and asserts the suite goes red. A
suite that stays green against a stub is testing nothing.

**Result on the current tree: 12 of 12 suites can fail, 0 vacuous.**

The runner is checked differently — one child suite is made to exit 1 and
`test-all.js` must notice. That is the exact bug this repo has already shipped
once: `run(label, file, args)` called as `run(label, [...])` left `args`
undefined, so every suite spawned a bare `node`, twelve reported PASS having
executed nothing, and CI was green on an empty test run.

### Three bugs it found in itself, in order

1. **The stub called `process.exit(0)`.** For a suite that `require()`s its
   subject that runs in the test runner's own process and kills it before a
   single assertion — so the suite "passed", and two suites were reported
   VACUOUS when neither was. A checker whose failure mode is a false accusation
   is worse than no checker.
2. **The subject map was hand-written and wrong for 3 of 12.** Two pointed at
   files that do not exist; one accused a suite of vacuity when the real fault
   was mapping it to a file it never touches. Subjects are now **derived** from
   what each suite actually references — including bare basenames, because four
   suites build their path in two steps and derived nothing without that.
3. **"Every subject must kill the suite" was too strict.** A suite legitimately
   references files it does not exercise — one names a module in a comment
   explaining that it deliberately does *not* copy it. The property under test is
   "this suite can fail", and one killed subject proves it.

Verified non-vacuous by neutering a real suite and confirming it is reported
VACUOUS, then restoring. Refuses to run on a dirty tree, since it overwrites
source files and restores them from git. Linux-only in CI — one clean checkout
answers the question, and three would triple a 40-second job for the same result.

## [8.14.0] - 2026-08-16

### Added — closing a task is a claim, and it has to be true

`rule-verification` gains two rules for marking `passes: true`:

1. **Name the change, so a reader can falsify it.** "Fixed" is not a record.
2. **Do not close a story until the change is somewhere a reader can reach it.**
   Committed and pushed, or the story stays open.

> **Corrected in 8.17.0.** This entry originally justified those rules with an
> instance — two P0 stories marked done while the fix existed nowhere. **That was
> false.** The fixes had shipped two minutes before the duplicate that went
> looking for them; `passes: true` was accurate throughout. The rules stand on
> their own merits; the anecdote was retracted and replaced with the more useful
> lesson, which is about how a confident false negative gets manufactured. See
> 8.17.0.

### Not added — two detectors for it, both measured and dropped

| Signal | Result |
|---|---|
| "no commit message references the story id" | **100% of done stories, all three repos.** None put ids in commit messages, so this is the normal state |
| "the story cites file paths that no longer exist" | 4 hits across 371 done stories, **0 real** — three path-prefix artifacts, one file the story's own fix deliberately deleted |

What caught the real instance was reading the claim and checking the fact it
asserted. That stays a review step. `rule-ab-testing` records both dead ends so
a third guess does not get built, and now says plainly that **"no detector fits"
is a legitimate conclusion** — cheaper than a checker nobody trusts.

Its running tally goes from eleven overturned recommendations to **fifteen**.

## [8.13.0] - 2026-08-16

### Fixed — carrier branches compare to the DEFAULT branch, not HEAD

Found by using the tool: merging one of the two real carriers and watching the
finding fail to clear, because the checkout was on a docs branch at the time. So
`origin/main` — which now had the merge — reported as "a branch carrying
prd.json changes you do not have", which is simply what working on a branch
means.

`defaultRef()` resolves `refs/remotes/origin/HEAD`, falls back through
`origin/main` and `origin/master`, then HEAD. The base is excluded from its own
candidate list and named in both the finding and its fix line — which also makes
the fix line correct, since it used to print `git diff HEAD...<branch>`, a
command that gives a different answer depending on the reader's checkout.

The first canary **did not fire**, which was itself informative: the mechanism
has two halves (the `rev-list` and the `diff`), and reverting one left the other
suppressing the false positive. It fails 1 of 19 when fully reverted.

## [8.11.0] - 2026-08-16

### Changed — the repos this framework learned from are anonymised

This repo is public. Four tracked files named three private codebases — one of
them a client deliverable — next to their per-repo defect rates. Nothing was
secret, and that was never the point: **a team's defect rate is theirs to
publish, and this tool had published it for them.**

Now `Project A` / `B` / `C`. Every number and conclusion is unchanged, and each
project's *shape* is kept, because it is load-bearing for reading the table — a
consumer health app, a B2B audit platform and a consumer media app fail
differently. `docs/failure-evidence.md` says so up front, and points readers at
`/learn-from-fixes` for their own numbers, which was always the point of the
document.

Found by asking whether the repo should be private, not by anything failing.
Going private was the wrong lever: it breaks `/plugin marketplace add` for
everyone else and does not address what was actually exposed.

### Added — `tooling/check-no-private-names.js`

So it cannot happen again. Scans every tracked file for a denylist of private
project and client names; wired into `validate.js`, so CI enforces it.

A **generic** detector was considered and rejected — "a lowercase word that
looks like a project name" has no precision in a repo full of skill, hook and
flag names. A denylist of the names you actually work with is small, exact, and
fails benignly.

The precedent is inverted and worth stating: one of those private repos carries
a tripwire against publishing verbatim internals, reasoning *"every private repo
is eventually public."* **That repo is private and has the guard; this one is
public and had none.**

Verified non-vacuous by planting a name in `README.md` and confirming it fails
naming file and line, then restoring byte-identically. The first version of its
binary-file skip was `includes(' ')` — a space, not a NUL — which would have
skipped every text file and reported clean forever. That is the failure mode
this repo keeps writing rules about, caught in the file enforcing them.

**It catches the working tree only.** The names remain in git history; redaction
is not removal, and a rewrite is a separate, deliberate decision.

## [8.10.0] - 2026-08-16

### Added — the gate that a comment satisfies

A new failure class in `preflight` and `rule-ramifications`, from two real
instances in one repo in one week: an owner-only exemption granted by a **block
comment describing a check deleted three months earlier**, and an image-consent
gate over Art. 9 health data satisfied by a comment twelve lines above the guard
it had lost. Both reported PASS for the entire time the thing they guarded was
gone.

**Documented as a review lens and a narrow assertion, not as a scanning gate** —
because it was measured. A detector for "regex tested against raw file contents"
found **54 hits across the two gate files, of which 2 were bugs**. Most
raw-source tests are correct; a gate at that precision is one people learn to
skip. The shippable version names the security-critical checks and asserts each
reads a lexed view.

Includes the variant table that matters in practice: a comments-only strip keeps
string literals, while one that also blanks literal *contents* is stronger but
blinds any gate whose pattern matches inside a string. The two real gates needed
one each.

`rule-ramifications` gains a section on the gate itself being wrong — comment-
satisfied, never run, or never seen to fail — with one discipline for all three:
**prove it fails.** Delete what it guards, confirm it goes red naming file and
line, restore, verify byte-identical.

*(Version note: 8.10.0 is the first release where a lexical `ls | tail -1` picks
the wrong directory — it sorts 8.10.0 before 8.8.0. The nightly routine's plugin
path resolution was switched to `sort -V` in this session, before this bump.)*

## [8.9.0] - 2026-08-16

### Changed — `auto` stops blocking on stories nobody is working

A pending story nobody has edited in months is a decision not to do the work
that nobody wrote down. One repo had 14 of 15 pending stories untouched for over
a month and 3 for over three months — several blocked on a person, a vendor, or
a console nobody had opened — and `auto` blocked on all of them. Measured on
that repo's real backlog:

```
before   15 tasks remaining. Next: S1-021   <- blocked on a colleague since May
after     1 tasks remaining. Next: S1-060   <- the one story edited this week
```

`stop-auto-check` now treats a story untouched for >30 days like `deferred`, and
**names every story it set aside**, in the block reason Claude reads as well as
on stderr. Silently skipping work is how a backlog rots without anyone deciding
to let it.

**Ages are read, never computed.** The walk costs 1,652ms against this hook's
31ms, on every Stop, for a number that changes by days — so the nightly
`drift-audit` publishes them to `$CLAUDE_CONFIG_DIR/autodev/prd-story-ages.json`
and the hook reads that. Hook cost after the change: still 31ms.

Every failure path fails **open** — skips nothing — because the damage from
skipping real work exceeds the damage from blocking on stale work. Covered: no
cache, cache older than 14 days, corrupt cache, cache keyed to another repo, and
a story the audit never measured. 13 new assertions, 41 total; verified
non-vacuous by removing the cache-age guard.

The cache is written under `CLAUDE_CONFIG_DIR`, never into the repo — "nothing
was modified" is a promise `drift-audit` makes about the repos it inspects.

### Added

- **`CHANGELOG` entries for 8.2.1 through 8.7.0**, which shipped without any.

### Note

Widening the unmerged-branch check beyond `prd.json` was measured and **not**
shipped: scoped to `prd.json` it found 2 carriers across 224 branches, both real;
unscoped at ≤45 days it surfaced ~30 branches across 4 repos, mostly one-commit
debris. The scope was the precision.

## [8.8.0] - 2026-08-16

### Changed — `drift-audit` ages the prd BACKLOG, not the prd FILE

Four changes were proposed. Measuring against current behaviour on three real
repos killed two; implementing the survivors exposed a bug in one of them.

- **Per-pending-story age** replaces whole-file age as the finding. The file-level
  number does not discriminate — it read 4d / 0d / 1d across three repos whose
  median *pending story* was 61d / 15d / 1d. One had 14 of 15 pending stories
  untouched for over a month while its file was four days old. Also drops the
  `age < 3 → return` early-out, which meant the repos whose files looked fresh
  were never examined.
- **Unmerged branches carrying `prd.json` changes** are surfaced. Built because a
  backlog looked abandoned for weeks while the finished reconciliation sat on a
  branch nobody merged — a check aimed at the working tree concludes the
  opposite of the truth. 224 remote branches scanned, 2 carriers, 0 false
  positives.
- **Commit counts use `<sha>..HEAD`, not `--since=<ts>`.** `--since` filters on
  committer date, so rebased commits fall outside a window the range includes.
  Measured +2, −1, 0 — it errs both ways.
- **Rejected, recorded in the source so it is not rebuilt:** "age from the last
  commit that changed a `passes` value" returned the identical answer in all
  three repos. And the story-less commit ratio measured 95–100% everywhere, so
  it discriminates nothing as a recurring finding.

### Added

- **`tooling/test-drift-audit.js`** — 16 assertions against real git repos rather
  than fixtures, since both signals are defined in terms of git history. Covers
  the motivating case (file touched today, backlog 120 days old) and the two
  negative cases that keep the branch detector honest.

### Fixed

- **Story comparison parses instead of slicing text.** The first implementation
  sliced from `"S-1": {` to the next `\n    },`; the last story in the object has
  no trailing comma, so its slice ran to end-of-file and every story read as
  freshly edited on the day a story was appended after it. Under-reported one
  repo by two stale stories and four days of median age.

## [8.7.0] - 2026-08-16

### Added — `drift-audit` and `rule-ab-testing`

- **`scripts/drift-audit.js`** — finds local state that reports healthy while
  being stale. Written after an install sat pinned four releases behind the
  marketplace, a plugin was never installed at all, and an allowlist's broad
  rules made the deny list beneath them unenforceable.
  - Scoped deliberately: the first version reported every uninstalled plugin in
    every known catalog — 39KB naming hundreds nobody had asked for. Not
    installing something is the normal state of a catalog. It is only worth
    saying when you already use that marketplace.
- **`rule-ab-testing`** — every proposal is measured against current behaviour
  and one alternative before adoption, and the measurement is reported. Carries
  the running table of overturned recommendations.

## [8.6.0] - 2026-08-16

### Added — out-of-band file inbox

Save anything into `~/…/CloudDocs/claude-inbox` (iCloud, so an iOS Shortcut can
drop a screenshot in one tap) and the next prompt announces it with filename,
path and arrival age.

Chosen by measurement over three alternatives:

```
variant                     per prompt   context when 5 files waiting
A  no hook (baseline)             0ms    0 tokens
B  notify-only, subprocess       56ms    ~248 tokens
C  notify-only, in-process       30ms    ~248 tokens   <- shipped
D  auto-inject every arrival     30ms    ~5,500 tokens
```

Silent when empty, which is almost every turn; flat whether one file waits or
twenty-five, because the hook stats the directory and never opens a file. Each
arrival is announced exactly once. `AUTODEV_INBOX`, `AUTODEV_INBOX_DISABLED=1`,
and `/inbox` to list.

## [8.5.0] - 2026-08-16

### Added — `claudemd-audit`

Finds stale references in `CLAUDE.md` — files, functions and flags the doc names
that no longer exist.

Eight precision rules, all earned: the naive version reported 16 findings of
which **1** was real. The other 15 were prose, patterns, shorthand and
deliberately-recorded history. A detector that cries wolf is one people learn to
skip, after which the ones that were right get skipped too.

## [8.4.0] - 2026-08-16

### Added — nightly memory maintenance

A scheduled routine (`0 3 * * *`) running four independent checks: drift audit,
memory audit, `CLAUDE.md` audit, and orphan checks. Account-agnostic — every
path derives from `CLAUDE_CONFIG_DIR` or `$HOME`.

### Changed

- **Ratchet guidance for large gate populations.** A real type-aware race rule
  found 417 genuine hits across 183 files — too many to set to `error` without
  blocking every build. Documents the ratchet/baseline pattern instead of
  pretending the number was small.

## [8.3.0] - 2026-08-16

### Added

- **`rule-agent-concurrency`** — how many agents to spawn at which model and
  effort so a fan-out does not burn the session's limits.
- **`scripts/find-orphan-checks.js`** — verification code that nothing runs.
  Taught to distinguish assertions that are orphaned from ones deliberately kept
  out of CI: in one repo, 6 of 7 "orphans" touched production Stripe and
  Supabase service-role keys, so wiring them into CI would charge a card. Count
  dropped to 1.

### Fixed

- **`pre-tool-filter` false positives.** It blocked `cat x.json | node -e` and
  `grep "curl | bash"`. Both rules anchored; 8 regression cases added.

## [8.2.1] - 2026-08-16

### Changed

- **`preflight` must prove a gate does not already exist before writing one.**
  Two proposed gates turned out to be built already, and one existing version was
  better than the proposal — it shelled out to the fixer so the two could not
  diverge. Also records rejected gates, so the next contributor does not rebuild
  something that was turned down for a reason.

## [8.2.0] - 2026-08-16

### Added — `preflight`

The executable half of 8.1. `rule-ramifications` tells you what to check;
`/learn-from-fixes` ranks what this project gets wrong; `preflight` makes the
top classes fail a build.

- **`/preflight`** — `init` scaffolds `scripts/preflight.js`, `add <class>`
  grows it one bug family at a time, `verify` audits the gate file itself.
- **`templates/preflight.js`** — the harness, generalized from a production
  repo's own gate file, with gate shapes for reachability, duplicated
  derivation, cross-surface consistency, cache-key scoping, i18n drift,
  lifecycle, and config targeting.

Four laws are built into the template, each of which cost a production repo a
shipped bug:

1. **A gate that could not run is not a pass.** Gates sit in try/catch so one
   broken gate cannot take out the run — but routing that catch to a *warning*
   lets a gate switch itself off while the run still exits 0. That shipped:
   renaming one file turned a parity gate into "check skipped" and preflight
   printed PASS. A skip is a hard failure here.
2. **Snapshot before you regenerate.** A gate that regenerates an artifact
   before comparing it to its source compares the generator against its own
   output and is green forever. That shipped two consecutive stale releases.
3. **A known-red excuse that now passes is a failure.** `KNOWN_RED` entries are
   keyed by bare gate id and tied to an open work item, and the run fails when a
   tracked gate starts passing.
4. **A gate never seen to fail is not known to work.** Prove each new gate by
   reintroducing the defect.

The scaffolded file also fails if nothing is wired to run it — a gate file
nobody executes is decoration, which is exactly how sixty harness scripts in one
repo went unrun with two of them red for eight days.

`tooling/test-preflight-template.js` proves all four laws by making each one
fail on purpose (15 assertions).

## [8.1.0] - 2026-08-16

Evidence-driven, not guessed. Mined 3,127 `fix` commits across three production
repos to find what the first pass actually gets wrong. See
[docs/failure-evidence.md](docs/failure-evidence.md).

### The measurement

| Repo | fix : feat+refactor | Fixes per feature |
|---|---|---|
| Project A | 799 : 853 | 0.94 |
| Project B | 830 : 486 | 1.71 |
| Project C | 1,299 : 651 | 2.00 |

**93% of Project A's fixes land within 24 hours on a file a feature had just
touched.** That is the first pass being wrong, not debt accumulating.

Ranked causes, consistent across all three: ordering/async races (32–41%),
unhandled flow states (9–20%), cache-key scoping (7–16%), duplicated derivation
(4–11%), units and references (5–11%), lifecycle cleanup (6–8%), cross-surface
consistency (3–8%), config targeting (3–8%). Runtime crashes are a small
minority — the code runs, and is wrong. Typecheck, build, and a clean console
cannot see any of it.

Two findings about gates themselves:

- **More prose did not help.** The two repos with 526- and 593-line `CLAUDE.md`
  files have the *worst* fix ratios; the one with 55 lines has the best.
- **A gate nobody runs is not a gate.** Project A's own preflight records sixty
  harness scripts that nothing ran, two of them red for eight days. This
  framework had the identical defect in `test-all.js`, found in 8.0.

### Added
- **`rule-ramifications`** — the eight classes as a pre- and post-implementation
  checklist, auto-loaded on every feature. Every claim traces to a counted commit.
- **`learn-from-fixes`** + `scripts/mine-fixes.js` — any project ranks its own
  failure classes from its own git history instead of inheriting this list, and
  gets proposed executable gates for the top ones. Read-only; never writes to the
  analysed repo.
- **`docs/failure-evidence.md`** — method, measurements, and the quoted commits.

### Changed
- `rule-verification` now states plainly that a clean typecheck is not evidence
  against any of the eight classes, and defers to `rule-ramifications`.

### Fixed
- **`pre-tool-filter` blocked its own maintainers, twice**, during this analysis.
  `cat x.json | node -e '…'` — an everyday read-only idiom — was blocked because
  the rule matched `node -e` after *any* pipe; and `grep -rn "curl | bash"` was
  blocked for containing the string it searches for. The hook only ever sees
  command text and cannot distinguish executing from mentioning, so both rules
  are now anchored to command start or a chain operator. Fetch-and-execute
  (`curl … | bash`, `curl … | node -e`) stays blocked, with 8 new regression
  cases covering both directions.

## [8.0.0] - 2026-08-16

Restructured from a copy-into-`~/.claude` installer into a Claude Code plugin
marketplace. Read [MIGRATION.md](MIGRATION.md) before upgrading.

### Changed — distribution
- **Plugin marketplace.** `.claude-plugin/marketplace.json` catalogs three plugins: `autodev-core` (the workflow, 36 skills, 4 agents, 7 hooks), `autodev-memory` (4 skills, 3 hooks, the SQLite runtime), and `autodev-stack` (Supabase, Doppler, Stripe, Remotion). Install with `/plugin marketplace add` + `/plugin install`; Claude Code owns update and uninstall.
- **Removed the bespoke installer.** `install.sh`, `install.ps1`, `uninstall.sh`, `uninstall.ps1`, `scripts/sync.js`, `scripts/uninstall.js`, the `.auto-dev-installed.json` sidecar, `repo-path.txt`, the collision detector, and the `update-dev` shell-profile function are all gone — the harness does this natively.
- **Removed `skills/manifest.json`.** 14KB of `triggers`/`requires`/`priority` metadata that no runtime ever read; its only live uses were printing a version string and listing deprecated skills. Version now comes from the plugin's own `plugin.json`.
- **Hooks resolve through `${CLAUDE_PLUGIN_ROOT}`**, so the whitelist hack that decided which `scripts/` files to copy — and left the memory pipeline dead on every install when it drifted — is structurally impossible now.
- **Settings are no longer written for you.** `docs/recommended-settings.json` is opt-in and drops the `Bash(bash *)`, `Bash(sh *)`, `Bash(source *)`, `Bash(curl *)`, `Bash(export *)`, `Bash(chmod *)`, `Bash(rm -f *)`, and `WebFetch(domain:*)` allow rules, each of which made the deny list beneath it unenforceable. The global `model: opus` pin is gone.

### Fixed — latent bugs the restructure exposed
- **The test suite never ran.** `test-all.js` declared `run(label, file, args)` but every call site passed two arguments, so `args` was `undefined` and each "suite" launched a bare `node` with no script. Every suite reported PASS without executing; CI was green on an empty run.
- **Memory captured only the first turn of a session.** Session close ran on `Stop`, which fires at the end of every assistant turn — it ended the session and deleted the session-id file, so every later turn's observations were dropped. Moved to `SessionEnd`.
- **`core` and `standards` were unreachable.** Both set `user-invocable: false` and `disable-model-invocation: true`, which blocks user and model invocation alike. They now load by file context via `paths`.
- **`PostCompact` never fired.** `post-compact.js` was registered as a `PostToolUse` hook with matcher `"compact"`. It is a real event and is now wired to it.
- **`agent-browser-cleanup.js` was orphaned.** Its header claimed `session-start.js` invoked it; nothing did. Now registered on `SessionStart`.
- **Knowledge surfacing broke under symlinked paths.** The area calculation compared a raw `file_path` against `process.cwd()`; on macOS (`/var/folders` vs `/private/var/folders`) every edit looked outside the project. Both sides now go through `realpathSync`.
- **The image-scan perf assertion flaked.** A fixed 150ms wall-clock budget is mostly Node startup, which swings ~10x under load. It now measures this machine's baseline and budgets the hook's own work against it.
- **The memory-backup scheduled task did nothing.** It invoked `~/.claude/hooks/memory-backup.sh`, which was never shipped.

### Fixed — second review pass

- **`.env.local` loading was a no-op that claimed success.** The SessionStart hook parsed the file into `process.env` and printed `[Env] .env.local loaded`. A hook runs in its own process and **cannot** set environment variables for the session, so nothing was ever loaded — it read a secrets file for no effect. Removed.
- **The hook rewrote the user's MEMORY.md.** It patched a version number inside `~/.claude/projects/<guessed-slug>/memory/MEMORY.md` on every session start. A dev tool has no business silently editing the user's memory files. Removed.
- **SessionStart now uses the structured channel.** Sprint state goes to `additionalContext` (where Claude reads it) and the banner to `systemMessage` (where the user sees it), instead of both going to plain stdout. Deferred stories are counted separately from pending, and a malformed `prd.json` is surfaced instead of swallowed.
- **The observation classifier never received a prompt.** It derives both the observation TYPE and its concept text from `userPrompt`, which was read from `AUTO_DEV_LAST_PROMPT` — a variable nothing ever set. Every observation ever captured fell back to a generic type and a generic concept, which is why `mem decisions` and `mem bugs` returned so little. A new `UserPromptSubmit` hook records the prompt (with `<private>` blocks redacted) for the classifier to use.
- **Concurrent sessions clobbered each other's memory.** The session id lived in a single `.claude/memory-session-id` file per project, so a second Claude session overwrote the first's id, and whichever ended first deleted the file — silently ending capture for the other. Replaced with `.claude/memory-sessions/<session>`, keyed by the harness session id, each cleared by its own SessionEnd. Session ids are sanitized so a hostile one cannot escape the directory.
- **Hooks now read `cwd` and `session_id` from the payload** rather than `process.cwd()`, which is the shell that spawned the hook and not necessarily the project Claude is working in.
- **Telemetry logged `session: null` for every event** (same dead env var). It now uses the payload session id.
- **Telemetry is opt-in.** It was on by default, appending a line to `.claude/reports/` in every project on every tool call. Set `AUTODEV_TELEMETRY=1` to enable; `CLAUDE_TELEMETRY_DISABLED=1` still wins for anyone who opted out before.
- **The typecheck hook could be killed mid-lint.** Typecheck and lint ran back to back with 30s budgets each inside a single 60s hook timeout. Both are 25s now.
- **Hook-tampering protection had stopped covering the hooks.** `PROTECTED_FILE_PATTERNS` matched `.claude/hooks/`, but 8.0 hooks live under `.claude/plugins/`. Added, scoped to the install location so editing a plugin's own source repo stays ordinary development.
- Stale remediation text in `pre-tool-filter` (`Use 'update dev'`) and a stale registration comment in `post-compact` corrected. `docs/memory-system-design.md` marked as intent-only where it documents the env-var mechanism that never worked.

### Added — tests for the paths that rotted
- `tooling/test-session-carrier.js` — 21 assertions covering per-session isolation, the concurrent-session regression, path-traversal safety, prompt redaction, and both memory session hooks (previously untested).
- `tooling/test-session-start-hook.js` — 21 assertions covering the structured output contract, sprint counting, payload `cwd` handling, and regression guards asserting `.env.local` and `MEMORY.md` are never touched again.
- Telemetry suite extended for the opt-in gate and the payload session id.

### Changed — Desktop-first browser automation
- **New `browser` skill** (replaces `agent-browser`) selects a driver: the built-in Browser pane tools where available, the `agent-browser` CLI otherwise. The 300-line CLI reference moved to `references/agent-browser-cli.md` so it costs nothing on the default path.
- `scan` documents the built-in path first, with the CLI as the terminal-only fallback. Nine other browser-using skills carry the selection rule.
- Authenticated pages now prefer having the user log in directly in the Browser pane over the localStorage token-injection workaround.

### Fixed — the `auto` loop could not terminate

`stop-auto-check.js` is the hook that blocks the end of a turn to keep `auto`
running. It shipped with no tests, and writing them surfaced three defects:

- **A sprint whose remaining stories were all `deferred` blocked forever.** The
  pending filter was `passes !== true`, which counts `"deferred"` as outstanding
  work — but deferred is a decision *not* to do it. The only escape was the 2-hour
  stale-flag timeout. `auto/SKILL.md` had the same filter, so the skill and the
  hook agreed on the wrong answer.
- **An unparseable `prd.json` sent it into idle detection** instead of stopping,
  looping the session against a file it could not read. It now leaves auto mode
  and says why.
- **It ignored the payload `cwd`**, reading flags and `prd.json` relative to the
  shell that spawned the hook rather than the project Claude is working in.

Rewritten with every path guaranteed to reach `approve`, and covered by
`tooling/test-stop-auto-check.js` — 28 assertions across blocking, the idle
one-shot, the exit signal, stale flags, deferred-only sprints, malformed input,
and payload-cwd handling.

### Added — `autodev-init`

Generates `.claude/project-rules.md` by **measuring** the codebase — component
style, data-fetching library, semantic tokens versus raw colors, where auth is
enforced, where external data is validated — instead of shipping a default. Every
rule it writes cites a count; anything genuinely split is recorded as
`Undecided` and explicitly must not be flagged in review. Splits worth a decision
are put to the user with the counts in the options.

`review`, `audit`, and `standards` now defer to that file wherever it disagrees
with the shipped defaults. This inverts the plugin's model: it stops being a
knowledge dump that ages as models improve, and becomes a capture mechanism for
what a project actually decided.

### Added — validator guard for shell glob quoting

`--include=*.tsx` unquoted in a skill's shell snippet is expanded by zsh before
grep sees it, and errors when nothing matches locally — so a measurement command
silently returns 0 instead of failing loudly. This bit `autodev-init` during
testing: every count came back zero against a fixture that plainly had matches.
`validate.js` now rejects unquoted globs in `--include`, `--exclude`, and
`--exclude-dir` across every shipped doc.

### Removed — superseded by Claude Code itself

The tool was written when models needed reminding that `<div onClick>` should be a `<button>`. That is no longer where the value is, and restating it costs context on every session.

- **`smart-explore`** (skill + 565-line script + suite) — the built-in Explore agent does structural code exploration better, and reads real excerpts rather than a signature outline.
- **`telemetry`** (skill + hook + suite) — Claude Code has native OTEL support, and this wrote a JSONL line into every project on every tool call.
- **`update`** — its entire content was two slash commands; they live in the README now.
- The generic bulk of **`a11y`**, **`seo`**, **`perf`**, and **`standards`**. What remains is the part a general-purpose model cannot know: this project's Core Web Vitals and bundle budgets, its design-token rules, its query-key shape, its report formats, and its anti-pattern list. `standards` matters most here — it auto-loads on every code file, so its length was a per-session context tax.

### Changed — `review`, `security`, and `fix` delegate

Each now runs the matching built-in command first and adds only the project-specific delta:

| Skill | Delegates to | Adds |
|---|---|---|
| `review` | `/code-review` | prd.json story alignment, design tokens, UI-state completeness, whether verification actually ran |
| `security` | `/security-review` | secrets in Supabase migrations, RLS policy quality (not just the enabled flag), cloud key hygiene |
| `fix` | `/debug` | how this project reproduces a bug, and what counts as verified |

`security` also stops "auto-fixing" a leaked credential by deleting the line — the value is already in git history, so it reports and tells the user to rotate.

Net: 7,075 → 5,847 skill lines, 3,131 → 2,450 lines of runtime code, 44 → 41 skills.

### Changed — skills
- **`triggers:` → `when_to_use:`** across all 39 migrated skills. `triggers` was never a Claude Code frontmatter field.
- **`config/rules/*.md` became five auto-loading skills** (`rule-security`, `rule-design-system`, `rule-file-organization`, `rule-windows`, `rule-verification`). `rules/` is not a plugin component type, so those files would never have loaded; as skills with `paths` globs they apply automatically.
- **`update` skill** now hands over `/plugin marketplace update` instead of pulling a git repo and re-running a sync script.

### Changed — repo layout
- `tooling/` holds `validate.js`, the test suites, and `bump.js`, and ships to no one.
- `validate.js` rewritten for the plugin layout: version sync, marketplace/plugin manifests, skill frontmatter (including the unreachable-skill and unquoted-YAML traps), hook wiring, and `${CLAUDE_PLUGIN_ROOT}` path resolution.
- `bump.sh` → `tooling/bump.js`: one writer for `VERSION`, `package.json`, `marketplace.json`, and all three `plugin.json` files, replacing nine sed targets across two platform branches.
- CI runs on Linux, Windows, and macOS, and syntax-checks every hook.

## [7.6] - 2026-08-12

### Added — CI
- **`scripts/test-all.js`** — new zero-dependency `npm test` runner. Discovers every `scripts/test-*.js` suite, runs each in its own child process, then runs `validate.js` as a final consistency gate; prints a `SUITE pass/fail` summary and exits non-zero if any suite or validate fails. Wired as the `test` script in `package.json`.
- **`.github/workflows/ci.yml`** — new GitHub Actions workflow. Runs `npm test` on `ubuntu-latest` with Node 22 (where `node:sqlite` is available so the DB-backed suites run, not skip) on every push and pull request. Least-privilege `contents: read` permissions.

### Added — semantic search fallback (roadmap §3.1, "lighter weight, no daemon" path)
- **`scripts/semantic-search.js`** — new pure-JS, zero-dependency, offline, deterministic ranker. This is **lexical-semantic** (TF-IDF token cosine similarity + conservative stemming + a small dev-domain synonym expansion), **not** neural embeddings — no ChromaDB, no external API, no network. Exports `{ tokenize, stem, expandQuery, rank }`.
- **`scripts/memory-db.js`** — two new API functions. `searchSemantic(query, projectPath, limit)` ranks recent project observations (last 500) via the ranker. `searchSmart(query, projectPath, limit)` runs FTS5 first and, only when it returns fewer than 3 results, merges in semantic results (dedup by id, FTS first). The ranker is required lazily inside a try/catch so a load failure degrades gracefully like FTS does.
- **CLI** — new `semantic` command; the existing `search` command now calls `searchSmart` (output formatting unchanged). `skills/mem-search/SKILL.md` documents the auto-fallback and adds a `mem why` trigger (synced to `skills/manifest.json`).

### Added — knowledge-agent (roadmap §3.2, "domain brains" — dependency-free path)
- **`skills/knowledge-agent/SKILL.md`** — new user-invocable skill. Distills the accumulated memory for a code **area** (a path prefix / directory / fragment such as `src/auth`) into a focused Markdown brief: observations touching that area are grouped into decisions, bug fixes, gotchas & discoveries, and changes & features, then deduped by title. Triggers: `knowledge`, `what do we know about`, `brief me on`, `domain knowledge`. Registered in `skills/manifest.json` and `skills/commands.md`.
- **`scripts/memory-db.js`** — new `knowledge(projectPath, area, limit)` API plus a `renderKnowledgeBrief(result, area)` renderer, and a `knowledge <area>` CLI command (`node scripts/memory-db.js knowledge "$(pwd)" "src/auth"`). This **queries the existing memory store** — no new database, no parallel knowledge files, no external API — and is bounded to the recent-500-observation window like semantic search. An area with nothing recorded renders "no accumulated knowledge yet" rather than erroring; a missing DB returns null and the CLI degrades gracefully.
- **Auto-injection of area briefs** (roadmap's "auto-injected when Claude touches auth files") now ships in the existing `hooks/post-tool-typecheck.js` PostToolUse (Write|Edit) hook — no new hook file and no change to the settings files. On the **first** edit of an area in a session, the hook derives the area from the edited file's directory (first 1-2 path segments, e.g. `src/auth`), calls `knowledge()`, and, when `total > 0`, prints a compact `[Memory] Domain knowledge for <area> (<n> notes):` header plus the top ~3 items (decisions → gotchas → bugfixes → changes, each truncated to ~100 chars) to stderr. It is **throttled to once per (session, area)** via a git-ignored `.claude/knowledge-surfaced` state file that is checked first, so at most one brief is computed per distinct area per session; the injection runs in its own try/catch after capture and can never disturb typecheck or capture.
- Area matching is **path-boundary aware** (`src/auth` matches `src/auth/login.js` but not `src/authentication/…`, and `auth` matches a whole path segment / whole word but not `author`), and dedup is **type-aware** — the key is `(type, title)` so a decision and a bugfix sharing a title are no longer collapsed into one.

### Tested
- **`scripts/test-knowledge.js`** — new suite. DB-backed cases (skipped cleanly on Node without `node:sqlite`): a brief renders grouped observations for a matching area; path filtering restricts to the area (an observation in a different area does **not** appear); an empty area yields a graceful "no accumulated knowledge yet" brief instead of crashing.
- **`scripts/test-knowledge-injection.js`** — new suite. Drives `hooks/post-tool-typecheck.js` as a subprocess against a temp `HOME` + temp project (skipped cleanly without `node:sqlite`): seeding observations for `src/auth` and editing a `src/auth/*` file emits the `[Memory] Domain knowledge for src/auth` line on stderr; a second edit in the same area/session does **not** re-emit (throttle); editing a file in an area with no knowledge emits nothing and does not crash.

### Added — smart-explore (roadmap §3.3, "structural code exploration" — dependency-free path)
- **`scripts/smart-explore.js`** — new pure-JS, zero-dependency, offline structural code outliner. Emits a **compact structural outline** (imports/requires, top-level function signatures with params + line numbers, arrow-function consts, class names + their methods, `interface`/`type` names, `export`/`module.exports` names, notable top-level consts) instead of full file contents — ~95% smaller than raw source on this repo. This is **honest heuristic/regex line-based extraction, NOT a real AST**: robust for JS/TS/JSX/TSX, decent for Python (indentation-based top-level detection), and a generic keyword scan for other languages that honestly reports `[no structure detected]` rather than fabricating symbols. It never throws on malformed input, and guards against binary (NUL-byte) and huge (>1MB) files. A true **Tree-sitter AST** (24+ languages, higher fidelity) remains an optional future upgrade. Exports `{ extractSymbols, summarizeFile, summarizeDir }`.
- **CLI** — `node scripts/smart-explore.js <path> [--json]`: a file prints its outline; a directory (walked recursively, skipping `node_modules`/`.git`/`dist`/`build`/`.next`/`coverage`/dotdirs, bounded to ~500 files) prints a per-file outline plus a final `Outline: X chars vs Y source chars (~Z% smaller)` line. `--json` prints the structured object.
- **`skills/smart-explore/SKILL.md`** — new user-invocable skill (triggers `smart explore`, `explore code`, `outline`, `map the codebase`, `code outline`) that shells to the CLI and documents the heuristic's limitations (multi-line signatures, dynamic exports, unusual syntax). Registered in `skills/manifest.json` (now 39 active skills) and `skills/commands.md`.

### Tested
- **`scripts/test-smart-explore.js`** — new suite (37 cases, no DB). Asserts specific symbol names/params for JS (function/arrow/class+methods/exports), TS (interface/type/typed function/class methods), and Python (top-level `def`/`class`/`import`, with a nested def **not** mislabeled top-level); a realistic multi-function file's outline is a meaningful fraction of source size; and robustness — unknown extension → generic, no-structure → `unstructured`, empty string → no crash, malformed input never throws, and a NUL-byte file is marked binary.

### Security — privacy hardening
- **`scripts/memory-db.js`** — `saveObservation` now redacts every user-controlled field before persisting: `raw_data` and `source_files` are run through `stripPrivate` after `JSON.stringify`, and the dedup `content_hash` is computed over the already-redacted `title`/`concept` so no hash of secret content is stored. Together with the previously redacted `title`, `concept`, and session summary fields, this closes every path by which `<private>…</private>` content could reach the DB. (`source_files` and the `content_hash` were the two fields not covered by the initial `raw_data`-only fix; both are now redacted.)

### Tested
- **`scripts/test-semantic-search.js`** — new suite. Pure-ranker tests (always run, no DB): conceptual ranking, stemming, synonym bridging, empty-input handling. DB tests (skipped cleanly on older Node without `node:sqlite`): `<private>` redaction across title/concept/raw_data, and `searchSmart` surfacing a paraphrased match that exact FTS would miss.

### Fixed — smart-explore extraction & auto-injection hardening
- **`scripts/smart-explore.js`** — an adversarial review found real extraction bugs, now fixed (regex-scoped): Python `async def` (top-level **and** methods) is captured; TS/JS generic functions `foo<T>(x)` (and the `const f = <T>(x) =>` arrow form) are no longer dropped; `export default function X`/`class Y` no longer emit a phantom export literally named `"function"`/`"class"` while the real symbol is still captured; `#private()` methods and TS `enum` declarations are captured; TS constructor-parameter modifiers (`public`/`private`/`protected`/`readonly`) are stripped so a param reads `http` not `private http`; and `savedPct` is clamped at 0 so tiny inputs never print a negative "% smaller". Comments/strings are still not parsed as symbols and the binary/huge/malformed guards are unchanged. New regression cases added to `scripts/test-smart-explore.js` (now 53 cases).
- **`hooks/post-tool-typecheck.js`** — the knowledge auto-injection throttle file (`.claude/knowledge-surfaced`) is now rewritten to keep only the **current session's** markers before appending, so it stays bounded to the session's areas instead of growing unbounded across sessions (matching its documented "session-specific" intent). A **transient** DB failure (`knowledge()` returns `null`) is no longer recorded as surfaced, so the next edit retries; a real empty result (`total === 0`) is still recorded to avoid recompute. Monorepo over-broadening at the 2-segment area granularity is now documented in code and in `skills/knowledge-agent/SKILL.md`. A capture-active injection case was added to `scripts/test-knowledge-injection.js`.

## [7.5] - 2026-04-22

### Added — telemetry (audit finding 3.2)
- **`hooks/telemetry.js`** — new PostToolUse hook. On every tool call, appends one JSONL line to `.claude/reports/telemetry-YYYY-MM-DD.jsonl`. Logs metadata only (tool name, input/output sizes, cwd, session, timestamp, success heuristic) — never tool input/output **contents**. Privacy-safe by design. Exit 0 always; 500ms timeout cap.
- **`skills/telemetry/`** — read-side skill. Commands: `telemetry`, `usage stats`, `tool stats`, `token stats`. Reports top tools by event count + total bytes, per-day activity, week view. Runs on Haiku.
- **Optional OTLP export** — set `CLAUDE_OTEL_ENDPOINT` env var to also POST each event to an OTLP JSON endpoint (Honeycomb, local collector, Jaeger). Fire-and-forget, 500ms HTTP timeout, won't slow sessions if endpoint is down.
- **Opt-out** — set `CLAUDE_TELEMETRY_DISABLED=1` or remove the hook from settings.
- **`scripts/test-telemetry-hook.js`** — 15-case suite: field coverage, privacy (no secret leakage), error detection, opt-out, malformed stdin resilience, unreachable-endpoint resilience, speed (<500ms). 15/15 pass. Local run: 39ms end-to-end.

### Registered
- Added a second `PostToolUse` entry with matcher `.*` in both `settings.json` and `settings-unix.json` so telemetry fires on every tool call (existing `Write|Edit` typecheck entry unchanged).

### Context
Closes audit finding 3.2 ("No OTEL / telemetry — industry standard in 2026"). The design choice: local JSONL by default so there's zero-config visibility on day one, with OTLP forwarding available to anyone who wants to wire a collector later. Honeycomb and Jaeger both accept OTLP JSON directly; no vendor lock-in.

## [7.4] - 2026-04-22

### Changed — Progressive disclosure on three more skills
Continuing v7.3's Anthropic-idiomatic split pattern. Three more heavy skills now load long reference sections on demand instead of inlining everything.

- **`audit/SKILL.md`** — 398 → 280 lines (~4765 → 3675 tokens, 23% reduction).
  - New `references/known-safe-patterns.md` — false-positive list (shadcn nesting, React 19 server actions, Supabase RLS, etc.) that every audit agent prompt needs
  - New `references/persist-findings.md` — the 8-step prd.json persistence flow (read, dedupe, batch, add, session tasks, report, score tracking, npm audit)
  - Dropped the one remaining `MUST` in the body

- **`setup-project/SKILL.md`** — 417 → 217 lines (~2948 → 1806 tokens, 39% reduction — biggest win).
  - New `references/monorepo-scaffold.md` — full directory layout + pnpm-workspace.yaml + root package.json + shared-package template
  - New `references/tooling-config.md` — TypeScript strict flags, Biome config, shadcn init, .gitattributes, .gitignore, .npmrc ready-to-paste templates
  - New `references/version-defaults.md` — the April 2026 pinned version table

- **`doppler/SKILL.md`** — 255 → 218 lines (~2353 → 2074 tokens, 12% reduction).
  - New `references/extract-to-hub.md` — shared-key and Supabase extraction command sequences with safety rules (the migration steps are rare but dense)

### Not done
- Consolidation of `clean` / `status` / `archive-prd` — `clean` (68 lines) and `status` (42) are already lean; `archive-prd` (141) has a clear user-facing responsibility called from auto. Consolidation would break muscle memory without meaningful token savings.
- OTEL telemetry exporter — needs a design decision on destination (local collector vs Honeycomb free tier vs Jaeger). Deferred.

### Aggregate impact
Running `auto` with `audit` and `setup-project` triggered (common combo) saves ~2,500 tokens per session vs v7.2. Over a typical multi-session day, meaningful.

## [7.3] - 2026-04-22

### Added
- **`scripts/test-pre-tool-filter.js`** — 33-case test suite for the PreToolUse hook. Caught a real bug on first run: `rm -rf ~/` (home-dir wipe) was not being blocked. Now blocked.
- **Auto-lint loop in `post-tool-typecheck.js`** (Aider-style) — after typecheck, runs the project's linter (Biome > ESLint, via package.json `lint` script or `biome check .` / `eslint .` fallback). Lint failures get printed to stderr (first 30 lines, truncation notice) so Claude can self-fix in the next turn. Skipped silently if no linter is configured.

### Changed
- **`auto/SKILL.md`** — split into `references/generation-constraints.md` + `references/verify-tags.md` (Anthropic-idiomatic progressive disclosure). Main body dropped from 590 lines / ~7k tokens to 501 lines / ~6k tokens. Also dropped all 12 `MUST` / `NEVER` ALL-CAPS directives — rewritten as reasoned prose explaining the failure mode each rule prevents. Follows Anthropic's [skill-creator guidance](https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md): "yellow flag — if possible, reframe and explain the reasoning."
- **Haiku tier for mechanical skills** — `status`, `archive-prd`, `clean`, `update`, `env-vars` moved from Opus to Haiku. ~12× cheaper per token on operations that don't require reasoning.

### Fixed
- **`hooks/session-start.js`** — added `process.exit(0)` at end so the hook can't exit non-zero if an unhandled error slips past the try/catch. Every other hook had this; session-start was the one gap.
- **`hooks/pre-tool-filter.js`** — `rm -rf ~` and `rm -rf ~/` are now blocked. Tests caught the gap on first run.

### Removed
- **Deprecated skill dirs deleted:** `skills/verify/`, `skills/checkpoint/`, `skills/browser-auth/`. Manifest entries in `deprecated` retained so rename history stays discoverable.

### Context
Post-audit pass (see `.claude/reports/AUDIT-2026-04-22.md`). Findings were cross-referenced against Anthropic's official Agent Skills spec ([agentskills.io](https://agentskills.io)) and 10 popular 2026 Claude Code frameworks.

## [7.2] - 2026-04-22

### Added
- **`doppler` skill** — Hub/spoke secret management via Doppler. Handles install detection (`winget install doppler.doppler` on Windows, brew on macOS, curl on Linux), login guidance (`doppler login`), per-project linking via `doppler.yaml`, command wrapping (`doppler run -- npm run dev`), and shared-key extraction to hub projects with cross-project `${ref://hub.config.KEY}` references. Fits the Developer plan's 10-project cap by consolidating supabase accounts into branch configs. Rotate once in a hub, all spokes pick up the new value.
- **`memory-backup` skill** — Private GitHub repo mirroring `~/.claude/projects/*/memory/`. One-command setup creates `<your-username>/claude-memory` (private), on-demand `memory backup now`, Windows Task Scheduler recipe for daily auto-commits, one-command `memory restore` after Windows reinstall. Explicitly excludes `sessions/`, `tasks/`, and other ephemeral state.

### Changed
- **`env-vars` skill** — Doppler is now the recommended pattern. Skill defers to the `doppler` skill when `doppler.yaml` is present, otherwise falls back to `.env.local` flow. Added "Migrate to Doppler" option.
- **`auto` Context Loading** — Step 6 added: detect `doppler.yaml` and prepend `doppler run --` to dev/build/test commands automatically. Installs CLI if missing, guides login if not authenticated.
- **`setup-project` onboarding** — Gap check now suggests Doppler migration when `.env.local` has 3+ vars and no `doppler.yaml` exists yet.

### Notes
- Doppler Developer plan is free; cross-project secret references work on it (confirmed 2026-04-22)
- Project cap is 10 on free tier — skill enforces this check before creating new projects
- `doppler login` is a browser OAuth flow; Claude cannot run it autonomously — always guide user

## [7.1] - 2026-04-09

### Added
- **Collision-safe install** — `scripts/sync.js` enumerates shipped items and refuses to overwrite user-owned files/dirs with the same name unless they're byte-identical. Use `--force` to back up collisions to `.user-backup-<timestamp>/` and install on top.
- **Install sidecar** — `~/.claude/.auto-dev-installed.json` records exactly what this install put on disk, enabling symmetric uninstall. Legacy installs without a sidecar are auto-detected via `skills/manifest.json`.
- **Surgical uninstall** — `scripts/uninstall.js` + `uninstall.sh` / `uninstall.ps1` remove only items the install created. User skills, hooks, agents, and user-modified rules are preserved. Strips auto-dev hook entries from `settings.json` without touching other entries. Supports `--dry-run`.
- **Image auto-scan hook** — `hooks/user-prompt-image-scan.js` (UserPromptSubmit). When you attach an image, Claude surfaces every distinct issue it sees, not just what you asked about. Tail-reads transcript JSONL (~35 ms flat regardless of size). Auto mode logs findings to `.claude/reports/image-scan-*.md` instead of acting. Skip with `[focus]` marker in your prompt.
- **`auto-exit` flag** — Writing `.claude/auto-exit` unconditionally releases the Stop hook on the next cycle. Gives the auto skill a clean exit path without fighting the idle detector.

### Fixed
- **Auto-active flag path divergence** — Stop hook was reading `$HOME/.claude/auto-active` while the auto skill and writers used `<project>/.claude/auto-active`. All three flags (`auto-active`, `auto-exit`, `auto-idle-triggered`) are now project-relative under `process.cwd()/.claude/`.
- **Install was silently destructive** — Previous install wiped `~/.claude/skills/` and `~/.claude/hooks/` on every run, destroying any user-added content. Fixed at the root: install now tracks what it owns and leaves everything else alone.
- **README uninstall instructions** — Old `rm -rf ~/.claude/skills ~/.claude/hooks` would have blown away unrelated user work. Replaced with the scripted uninstall flow.
- **README staleness** — Removed obsolete `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` reference (replaced by `teammateMode: "auto"` in v6.9).

### Removed
- **Symlink install mode** — Fundamentally incompatible with user-owned skills (users couldn't add their own). `--copy` / `-Copy` flags kept as silent no-ops for back-compat.

## [7.0] - 2026-04-05

### Added
- **Generation constraints in auto** — Security, a11y, design anti-slop rules applied at code-generation time, not just post-hoc audit
- **Self-critique step** — 8-question checklist auto runs after writing code, before typecheck
- **Hardening check** — 12-pattern per-task diff scan (fail-open auth, unsafe casts, fire-and-forget fetch, missing labels, stock UI, dark mode, chart colors)
- **Per-story verify tags** — `"verify": ["visual", "a11y", "design", "security", "auth", "test", "api"]` in prd.json stories for targeted checks
- **Design token compliance check** — Auto verifies UI output uses project tokens, not stock shadcn defaults
- **Test generation table** — Auto writes tests for API routes, auth, hooks, data mutations, RLS policies
- **Risk-shaped testing** — Test effort matches risk (100% auth/billing, 70% hooks, optional for static pages)
- **Coverage thresholds** — 70% lines, 60% branches, 100% auth/billing paths
- **Deferred task distinction** — `passes: "needs-setup"` + `blockedReason` separates infrastructure blockers from skipped tasks
- **Security checks 6-11** — SSRF prevention, fail-open auth, HTTP headers, open redirect, rate limiting, npm audit
- **Score tracking** — Audit logs scores to sprint-history.md with delta from previous audit
- **Migration safety** — Deploy checks for destructive SQL operations, nullable defaults rule
- **Simplify suggestion** — Auto recommends simplify after 5+ task sprints

### Changed
- **audiq MCP removed from all skills** — Replaced with agent-browser (preferred) and Playwright (fallback) across ship, commit, design, brainstorm
- **Ship: blocking quality gates** — npm audit critical/high now blocks deploy alongside typecheck/build/tests
- **Ship: expanded security checklist** — 11 items including fail-closed auth, SSRF, middleware coverage, HTTP headers, rate limiting
- **Review: tests run in default mode** — Not just deep mode; also adds npm audit, breaking change detection, hardening scan
- **Audit: reduced noise** — A11y agent skips transition-all (perf not a11y), type agent skips console.error and test files
- **Audit: expanded security agent** — RLS policy logic, fail-open auth, SSRF, middleware gaps, unsafe casts, fire-and-forget fetch
- **Fix: regression tests mandatory** — For auth/billing/RLS paths after fix; escalation after 3 failures
- **Commit: story ID in messages** — `feat(S13-001): description` format; tests added to safety checklist
- **Standards: anti-patterns reorganized** — Split into accessibility, design system, security/data safety categories
- **Standards: fail-closed patterns** — Auth deny-by-default, fetch error handling, Zod validation for external data
- **Supabase: RLS runtime verification** — REST API test after migrations to verify policies actually restrict access
- **Supabase: migration rollback pattern** — Nullable defaults, separate drop migrations
- **Design: quality gate expanded** — Dark mode, a11y focus rings, reduced motion, form UX checks
- **Workflow rules: cross-cutting verification** — 6 patterns applied to all task types regardless of category
- **Auto: exactOptionalPropertyTypes** — Generates `foo?: string | undefined` on first pass in strict projects

## [6.9.1] - 2026-04-05

### Fixed
- **Auto skill: use Write tool for auto-active flag** — Bash echo to `.claude/auto-active` triggered sensitive file permission prompt every time. Now uses Write tool which is already in the allowlist.

## [6.9] - 2026-04-05

### Added
- **scripts/sync.js** — Single source of truth for syncing repo files to ~/.claude. Handles symlink/copy, settings merge, rules, agents, deprecated cleanup, and validation in one cross-platform Node.js script.

### Changed
- **install.sh / install.ps1** — Sync logic delegated to sync.js, removing ~90 lines of duplicated copy/symlink code
- **scripts/update.sh** — Reduced from 114 lines to 12, delegates to sync.js
- **Embedded update-dev functions** — Both bash and PowerShell versions now call sync.js instead of manual copy blocks
- **Brainstorm dedup threshold** — Fixed drift: standardized to 25-char match (was 20 in brainstorm, 25 in audit)
- **Settings: removed CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS** — Redundant since teammateMode: "auto" is set

### Removed
- **5 dead files** — templates/progress.txt, templates/settings.local.json, templates/env.local.template, templates/task-patterns.json, skills/prd-schema.json
- **Dead chmod in install.sh** — Was targeting *.sh hooks but all hooks are .js

## [6.8] - 2026-04-04

### Added
- **setup-project: greenfield mode** — Full scaffolding from description to working build. Monorepo support (pnpm workspaces), package manager detection, Biome over ESLint, shadcn v4, TS strict defaults, .gitattributes, version table with risk notes
- **setup-project: onboard mode** — Gap detection (.gitattributes missing, TS strictness, missing .env.example)
- **Audit size gate** — Scales agent count by codebase size: 1 agent (<50 files), 3 agents (50-200), full 7-swarm (200+)

### Changed
- **Typecheck hook detects package manager** — Reads lockfile (pnpm-lock.yaml/yarn.lock/bun.lockb) instead of hardcoding `npm run typecheck`
- **Commit: solo projects stay on main** — Checks contributor count + remote before forcing feature branches. Solo devs commit to main.
- **Auto: /compact threshold raised** — "Do NOT suggest unless >70%" (was "after 10+ tasks"). 1M context makes premature compaction wasteful.
- **setup-project triggers narrowed** — `"setup"` → `"setup project"` to avoid false matches on "set up the database"

### Fixed
- **bash -c filter narrowed** — Only blocks at command position or after chain operators, not inside quoted arguments (e.g., `docker exec` wrapping)

## [6.7.3] - 2026-03-31

### Changed
- **Windows: Supabase CLI rule** — `supabase db query --linked` blocked (triggers firewall, times out). Use REST API with curl instead.

## [6.7.2] - 2026-03-30

### Changed
- **Auto: removed unused sections** — Worktree parallel execution (never used), decisions.md logging (nobody reads it), mistakes.md reference
- **Auto: tool-aware verification** — Audiq/agent-browser instructions now check if MCP is connected before suggesting visual scans. Falls back gracefully to WebFetch or skipping with a note.

## [6.7.1] - 2026-03-30

### Fixed
- **npx regex false positive** — Anchored pattern to command position (like `node -e` fix from v6.6.3). No longer triggers inside quoted strings like `git commit -m "...npx..."`
- **config/rules/ out of sync** — Updated repo config templates (security, design-system, file-organization, workflow) so `update dev` preserves v6.7.0 rule changes instead of overwriting them
- **config/CLAUDE.md template** — Added `@rules/workflow.md` to includes

## [6.7.0] - 2026-03-30

### Added
- **Auto integration test gate** — API/edge function tasks require real request verification (curl + response shape check) before marking done
- **Auto sprint transitions** — Automatically archives completed stories, carries forward deferred, bumps sprint number, logs to `.claude/sprint-history.md`
- **Auto deploy phase** — Detects changed `supabase/functions/` files after commit and auto-deploys edge functions
- **Sweeping change verification** — Self-review step 4b: grep for old patterns after bulk find-and-replace to confirm full elimination
- **`rules/workflow.md`** — New global rule documenting audit/brainstorm scope split and verification requirements by task type

### Changed
- **Audit = bugs/fixes** — Absorbs quality scans (console.log, empty catch blocks) from brainstorm. Type Safety agent expanded to include code quality.
- **Brainstorm = features/architecture** — Removed quality scans. Now runs 3 agents (dead code, complexity, unused deps) instead of 5. Competitor research is optional.
- **Agent tool call cap** — All scan agents capped at ~80 tool calls to prevent rate limits
- **Pre-flight simplified** — Replaced `node -e` one-liners with simpler checks that don't trigger security filter on Windows
- **Size-gate** — Removed Plan Mode suggestion (dead path). Large tasks get inline 3-sentence plan instead.
- **Commands.md** — Reorganized into Primary / On-Demand / Specialized tiers
- **Manifest descriptions** — Synced audit and brainstorm descriptions to reflect scope boundary
- **Design system** — Added gradient/themed surface exception for hardcoded colors
- **Security rules** — Added edge function testing and bulk change verification
- **npx allowlist** — Added `tsx`, `shadcn`, `shadcn-ui`, `create-next-app`, `prisma`
- **File organization** — Replaced unused `decisions.md`/`mistakes.md` with `sprint-history.md`

## [6.6.4] - 2026-03-22

### Fixed
- **npx allowlist expanded** — Added `npm-check-updates`, `axe-core-cli`, `@next/bundle-analyzer`, `lighthouse`, `netlify`, `remotion` to pre-tool filter. These were referenced in skills but would be blocked at runtime.

## [6.6.3] - 2026-03-22

### Fixed
- **pre-tool-filter: node -e false positive** — pattern now only matches at command start, not inside grep/echo arguments. Fixes the filter blocking searches for "node -e" strings.
- **Contradictions resolved across skills:**
  - commit: "never git add -A" softened to "prefer targeted adds" (batch mode with exclusions is acceptable)
  - core: "don't read full prd.json" updated for 1M context (fine for <50 stories)
  - review: "go beyond acceptance criteria" → "flag opportunities but don't implement during review"

## [6.6.2] - 2026-03-22

### Added
- **`brainstorm quick`** — Diff-based scan that only checks files changed since last brainstorm (~10s vs ~3min). Skips full agent scan for recently-cleaned codebases.
- **Size-gating for stories** — Tasks touching 5+ files or needing UI design flagged as `size: "large"` with Plan Mode suggestion instead of auto-executing
- **Progress output** — Auto mode now outputs `[3/8] ✓ S6-003 | Next: S6-004` between tasks for visibility
- **Resource validation** — Self-review step 3 validates external URLs (images, fonts, API endpoints) with curl before committing
- **Worktree cleanup** — Auto pre-flight now runs `git worktree prune` to clean orphaned worktrees from previous sessions

## [6.6.1] - 2026-03-21

### Security
- **pre-tool-filter: outer catch now fail-closed** — exit 2 instead of exit 0 on unexpected errors
- **pre-tool-filter: block `node -e`/`node --eval`/`node -p`** — closes the `Bash(node *)` bypass vector
- **pre-tool-filter: block `npx` except allowlisted tools** (tsc, supabase, vercel, next, vite, vitest, jest, playwright, eslint, prettier)
- **pre-tool-filter: tightened `bash -c` regex** — `\s*` instead of `\s+` catches `bash -c"cmd"` without space
- **pre-tool-filter: tightened `eval` regex** — `[\s"']` catches `eval"cmd"`, avoids false positives on `evaluate`
- **pre-tool-filter: block `cp`/`mv` targeting `.claude/hooks/` and `.claude/settings`**
- **session-start: expanded PROTECTED_VARS** — added LD_PRELOAD, LD_LIBRARY_PATH, DYLD_INSERT_LIBRARIES, BASH_ENV, ENV, PROMPT_COMMAND, CDPATH, NODE_EXTRA_CA_CERTS, GH_TOKEN, VERCEL_TOKEN, SUPABASE_ACCESS_TOKEN

### Fixed
- **pr-review: stale `browser-auth` reference** → changed to `agent-browser`
- **update skill: ALL-CAPS "NOT" and "SINGLE"** → lowercased per tone moderation
- **commands.md: version and migrate entry** — bump.sh handles version; migrate row was missing

## [6.6] - 2026-03-20

### Added
- **Migrate skill** — Dependency updates, major version upgrades, and breaking change resolution. Safety tiers (patch→minor→major), one-at-a-time major updates with changelog checks, security audit integration.
- **PreCompact promoted to .js file** — `hooks/pre-compact.js` with error reporting, replacing inline `node -e` one-liner

### Changed
- **Merged browser-auth into agent-browser** — Auth token injection, security rules, and test patterns now in one skill. browser-auth is deprecated. Saves 229 lines from 4 requires chains (auto, test, audit, ship).
- **Requires chains updated** — auto, test, audit now require `agent-browser` directly instead of `browser-auth`

## [6.5.2] - 2026-03-20

### Security
- **pre-tool-filter: fail-closed on parse error** — was exit 0 (allow), now exit 2 (block). Malformed input can no longer bypass security checks.
- **pre-tool-filter: block `bash -c`, `sh -c`, `eval`** — prevents shell escape wrappers that bypass regex patterns
- **session-start: expanded PROTECTED_VARS** — now blocks NODE_ENV, CI, HTTP_PROXY, HTTPS_PROXY, NODE_TLS_REJECT_UNAUTHORIZED, ANTHROPIC_API_KEY, GITHUB_TOKEN, GITHUB_PAT from .env.local override
- **bump.sh: env vars instead of shell interpolation** — version strings passed via `process.env` instead of string interpolation in `node -e`

### Fixed
- **post-tool-typecheck: 10-second debounce** — skips typecheck if last run was <10s ago, preventing dozens of redundant 30s runs during rapid edits
- **session-start: strip trailing \r from .env.local values** — CRLF files on Windows no longer leave carriage returns in env values
- **clean skill: added .typecheck-stamp** to cleanup targets

## [6.5.1] - 2026-03-20

### Fixed
- **allowed-tools mismatches** — 5 skills (auto, brainstorm, ship, commit, design) referenced audiq MCP tools they couldn't call. Added the specific tools each skill needs.
- **auto: added Agent + SendMessage** to allowed-tools — parallel worktree execution was dead code
- **auto: removed ghost `simplify` references** — replaced with `refactor` (actual skill)
- **auto: consolidated duplicate audiq verification blocks** — single reference instead of repeated code
- **auto: fixed `date -I` (GNU-only)** — replaced with portable `date +%Y-%m-%dT%H:%M:%S`
- **auto: quoted glob in find command** — prevents shell expansion of `*/node_modules/*`
- **iterate: trimmed 12 unused audiq tools** from allowed-tools — sub-skills handle audiq calls
- **audit: removed unused TaskUpdate, TaskList** from allowed-tools
- **ALL-CAPS cleanup** — lowercased NOT, BOLD, UNFORGETTABLE across auto, ship, design skills
- **Stale skill counts** — README and commands.md now say "35 skills (33 active + 2 deprecated)"

## [6.5] - 2026-03-20

### Added
- **Smart pre-flight** — Auto `npm install` when package.json is newer than node_modules, detect test runner (vitest/jest/playwright) instead of hardcoding `npm test`, detect monorepo structure, auto-create feature branch if on main
- **Error pattern recognition** — Tracks recurring errors across tasks; after 3+ occurrences, saves fix recipe to auto-memory for instant resolution. Includes common pattern→fix table.
- **Post-commit quick scan** — After every commit, runs build check + console error scan (~5s) to catch regressions immediately
- **PR description from prd.json** — Auto-generates PR body from completed stories with titles, resolutions, and test plan
- **Auto feature branch** — Commit skill auto-creates feature branch when on main/master instead of committing directly
- **Screenshot baseline** — First scan saves as `baseline-YYYY-MM-DD.json` (never overwritten); all future `scan compare` diffs against it
- **CLAUDE.md from real data** — setup-project reads actual package.json scripts, detects dev port, maps src/ structure, finds env vars — no guessing
- **Expanded project knowledge saving** — Auto skill saves environment quirks, build gotchas, test setup, deploy requirements, and error patterns to auto-memory

## [6.4.1] - 2026-03-20

### Added
- **README Tips & Tricks** — Comprehensive guide covering /btw side questions, parallel work patterns, convergence loop, visual verification, agent teams, context management, design anti-slop, and quick fix workflow
- Updated commands table with scan/qa, iterate, design skills
- Fixed stale "30 skills" references to "33 skills"

## [6.4] - 2026-03-19

### Added
- **Iterate skill** — Convergence loop that chains brainstorm→apply→auto in one command. Runs until codebase is clean (typically 3-4 rounds). Supports focus modes (`iterate auth`, `iterate design`) and configurable round limits. Safety check: stops if a round finds more issues than previous.
- Triggers: `iterate`, `deep work`, `converge`

## [6.3.2] - 2026-03-19

### Changed
- **Brainstorm product thinking** — Feature ideation now requires product identity analysis, competitor research with differentiation focus, and rejects generic SaaS playbook suggestions
- **Auto visual enforcement** — UI tasks cannot be marked complete without visual verification (audiq screenshots). Added explicit step 7 in execution flow and hard gate at step 5.
- **Auto archive check** — Pre-flight now checks prd.json size and auto-archives when >50KB
- **Core archive trigger** — Archive runs automatically (no prompt) when starting new sprint with completed previous sprint

## [6.3.1] - 2026-03-19

### Fixed
- **Audit skill** — Removed /compact prompt gate (unnecessary with 1M context)
- **validate.js** — Fixed version check failing for X.Y.Z semver (was only handling X.Y)

## [6.3] - 2026-03-18

### Added
- **Scan skill** — Live site QA via audiq MCP (17 tools): visual bugs, console errors, a11y, perf, SEO, design quality analysis, baseline comparison, fix plan generation
- **Brainstorm Phase 1 Scan 5** — Live QA scan runs in parallel with code scans; surfaces visual, design, and a11y issues alongside code issues
- **Auto visual verification** — UI/UX tasks verified with audiq screenshots (desktop + mobile) + console error check before marking complete
- **Design AI slop checklist** — 9-point detection checklist (safe font, purple gradient, card grid, etc.) with audiq visual analysis integration
- **Design reference sites** — linear.app, vercel.com, stripe.com, raycast.com, notion.so, cal.com as quality benchmarks

### Changed
- **Auto IDLE detection** — Added "dev server + UI changes" and "scan score <70" as signals to trigger QA scan and fix stories
- **Ship post-deploy** — Now uses audiq MCP for verification (preferred over agent-browser)
- **Deploy skill** — Added Read, Grep, Glob to allowed-tools
- **Token management** — Relaxed for 1M context; removed aggressive /compact suggestions

### Fixed
- **Hook paths** — `%USERPROFILE%` replaced with `$HOME` (Claude Code 2.1.69 runs hooks via Git Bash)
- **Stop hook schema** — `ALLOW`/`REJECT` replaced with `approve`/`block` (new CC schema)
- **Stop hook infinite loop** — Added idle marker to prevent re-blocking after IDLE detection runs
- **Pre-tool filter** — Block `rm --recursive --force` (reversed flag order) and `git restore --staged .`
- **Settings sync** — Both config files now identical (unified on `$HOME`); validate.js does deep equality
- **bump.sh** — X.Y.Z input no longer creates invalid semver X.Y.Z.0
- **Install scripts** — Removed misleading "auto-pull on session start" claim
- **session-start.js** — Fixed quote stripping (matching pairs only), hoisted PROTECTED_VARS outside loop, fixed section numbering
- **brainstorm** — Stronger deduplication against prd.json AND native Tasks
- **browser-auth** — Fixed agent-browser `--task` syntax, added Windows fallback note
- **sprint** — Fixed stale "quality skill" reference
- **seo/supabase** — Resolved "schema" trigger overlap
- **Parallel agents** — Added file ownership rules, worktree commit requirement, overhead guidance (<3 files skip worktree)
- **Auto retry** — Auto-fix trivial errors (missing import, type mismatch) before counting as retry
- **Supabase/design** — Use `${CLAUDE_SKILL_DIR}` for portable reference paths

## [6.2] - 2026-02-09

### Added
- **Stripe skill** — Stripe integration patterns (API keys, webhooks, checkout, subscriptions) based on stripe/ai (MIT)
- **SEO skill** — SEO audit and structured data patterns (meta tags, Open Graph, JSON-LD schema) merged from marketingskills repo (MIT)

### Changed
- **Setup-project rewritten** — smart stack detection from package.json dependencies, project type classification, automatic skill recommendations, environment scaffolding based on detected services

## [6.1] - 2026-02-08

### Fixed
- **disable-model-invocation blocks Skill tool** — removed flag from all 11 user-invocable skills; kept only on passive/deprecated (core, standards, checkpoint, verify)
- **Supabase deploy uses wrong token** — deploy skill now sources project `.env` first; 401 flagged as wrong token, not retried

### Changed
- **Brainstorm rewritten** — architecture-level scans (dead code, unused deps, splittability, client-vs-server fetch) replace linter-level checks (TODOs, any types). Adds competitor web search, user journey walkthrough, validation-before-claiming. "Codebase is clean" is a valid outcome.

## [6.0] - 2026-02-08

### Changed
- **Merged quality + code-quality into standards** — single passive reference skill, not in system prompt listing
- **Merged review + verify into review** — depth levels: `review`, `review quick`, `review deep`
- **Brainstorm reports first** — presents findings table, user decides whether to create stories (`brainstorm apply`)
- **Tone moderation** — replaced ALL-CAPS aggressive language with natural prose (44 instances across 13 files) for Opus 4.6 compatibility
- **"Just do it" mode** — < 5 tasks skip sprint/story overhead entirely
- **Archive threshold** — auto-suggests at 4+ sprints, keeps last 3 active

### Removed
- **Checkpoint skill deprecated** — Claude's built-in memory and `/compact` handle persistence now
- **quality, code-quality directories deleted** — merged into standards
- **verify reduced to redirect** — points to `review deep`

### Improved
- **System prompt listing reduced** — ~25 visible skills down to ~17 via `disable-model-invocation: true` on niche skills
- **Token savings** — ~200 tokens/turn fewer in system prompt, cleaner context

## [5.5] - 2026-02-08

### Fixed
- **prd.json dual-shape support** — all 7 dynamic injections across 5 skills now handle both flat (`p.stories`) and nested (`p.sprints[].stories`) shapes
- **Force-push short flag blocked** — `git push -f` now caught alongside `--force` in settings and pre-tool-filter

### Changed
- **Browser verification upgraded** — auto mode now checks console errors and network requests alongside visual snapshots (mirrors real DevTools workflow)
- **Update skill reminder** — reminds user to restart session for CLAUDE.md changes to take effect

## [5.4] - 2026-02-06

### Added
- **Custom agents** — 4 read-only Opus agents in `agents/` directory
  - `code-reviewer` — Reviews changes, learns project patterns (project memory)
  - `security-scanner` — Vulnerability scanning with cross-project learning (user memory)
  - `architect` — Feature planning, dependency mapping, architecture decisions (project memory)
  - `researcher` — Deep codebase/web research, bug investigation (project memory)
  - All use `permissionMode: plan` (read-only enforcement, no Write/Edit)
  - Synced via install scripts and `update dev` (copy mode, preserves user agents)

### Security
- **Shell injection prevention** — bump.sh validates version format, update.sh passes paths via `process.env` instead of string interpolation
- **Expanded deny rules** — `rm -r`, `git stash drop/clear`, `git branch -D` blocked in settings and pre-tool-filter
- **Env var protection** — session-start blocks overriding `PATH`, `HOME`, `NODE_OPTIONS` from .env.local
- **Fallback validation** — update.sh validates JSON before fallback copy

### Changed
- **All agents now use Opus** — 27 skills on Opus, 5 simple commands on Haiku (update, status, clean, archive, env)
- **Audit compact detection** — skips `/compact` suggestion if user already compacted this session
- **Pre-tool-filter refactored** — patterns moved to module-level constants (compiled once, not per call)
- **Error logging** — all empty catch blocks now log parse errors to stderr

### Fixed
- **README badge** — was stuck on 5.0, now auto-bumped
- **README skill count** — 34 → 32 (actual)
- **README Quick Start** — added PowerShell instructions, example session
- **`git branch -D` pattern** — case-sensitive to not block safe `git branch -d`
- **validate.js** — safe regex match, escaped special chars in trigger matching
- **.gitignore** — added `settings.backup.json`, `.claude/pre-compact-state.json`

## [5.3] - 2026-02-06

### Added
- **Agent Teams** enabled via `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` env var in settings
- **Settings merge** — `update dev` deep-merges permissions (user-added allow/deny rules preserved)
- **Settings backup** — `settings.backup.json` created before every merge
- **Post-install validation** — checks manifest, hooks, settings, commands after sync
- **`.gitattributes`** — CRLF normalization, no more warnings on commit

### Changed
- **Removed prompt-type Stop hook** — only command-type `stop-auto-check.js` remains (saves tokens every session)
- **Audit skill** — launches immediately, tells user to type `/compact` themselves (not invoke as skill)
- **Removed fake token estimates** from audit skill

## [5.2] - 2026-02-06

### Changed
- **Update logic moved to `scripts/update.sh`** — deterministic execution, no model improvisation
- **Deprecated skills list** in manifest.json — stale cleanup only removes known deprecated skills, never user-created ones
- **`${HOME:-$USERPROFILE}` fallback** in update script for Windows compatibility

### Fixed
- **update dev exit code 1** — three root causes fixed:
  - Git Bash `$HOME` paths (`/c/Users/...`) passed to Node.js — fixed with `cygpath -m`
  - `[ "$REPO" = "/tmp/..." ] && rm` returns exit 1 when test is false — removed from SKILL.md
  - Haiku combining bash steps caused variable loss — single Bash call + external script

## [5.1] - 2026-02-06

### Security
- **Remove auto-pull from session-start hook** — updates now manual via `update dev` only
- **Write/Edit protection** for `~/.claude/hooks/` and `settings.json` in pre-tool-filter.js
- **Settings backup** — `update dev` backs up settings.json before overwrite

### Changed
- **Node.js hooks** — all 4 hooks converted from .sh/.ps1 pairs to unified .js files
- **Skill consolidation** (34 -> 32): `react-patterns` into `code-quality`, `preserve-ui` into `design`
- **Preserve-ui extracted** to `design/references/preserve-ui.md` (loaded on demand, saves ~400 tokens)
- **Manifest cleaned** — removed 20 empty `context: []` arrays
- **CLAUDE.md deduplicated** — `~/CLAUDE.md` slimmed from 49 to 6 lines
- **Windows settings** use `%USERPROFILE%` instead of `$HOME` for hook paths

### Fixed
- **Git Bash path translation** in session-start.js (`/c/Users/...` -> `C:/Users/...`)
- **Bash `!` escaping** in update skill stale cleanup (`=== false` instead of `!`)
- **validate.js** updated for .js hooks and CRLF normalization
- **All frontmatter complete** — 0 WARN (was 2)

## [5.0] - 2026-02-05

### Breaking Changes
- **Skill consolidation** (40 -> 34): 6 skills merged into parent skills
  - `supabase-postgres` + `supabase-schema` merged into `supabase`
  - `browser-test` + `auth-token-injection` merged into new `browser-auth`
  - `security-patterns` merged into `security`
  - `self-review` merged into `review`
  - `ci-cd` merged into `deploy`
- **Requires chains updated**: All downstream skills (auto, ship, audit, test, review, pr-review) reference new consolidated names
- **Deleted directories**: supabase-postgres/, supabase-schema/, browser-test/, auth-token-injection/, security-patterns/, self-review/, ci-cd/

### Added
- **Dynamic context injection** (`!`command`` syntax) on 5 skills
  - `auto` - Pre-injects git status and prd.json sprint stats
  - `status` - Pre-injects sprint data (project, done/pending/deferred counts)
  - `commit` - Pre-injects working tree status, diff stats, recent log
  - `audit` - Pre-injects existing task list from prd.json
  - `brainstorm` - Pre-injects existing task list from prd.json
  - Estimated savings: 18-24 tool calls, 23-37K tokens per auto session
- **`argument-hint` frontmatter** on 6 user-facing skills
  - `commit` -> `[type] [message]`
  - `fix` -> `[error or file]`
  - `security` -> `[scope: full|quick|file]`
  - `refactor` -> `[target file or pattern]`
  - `brainstorm` -> `[focus area]`
  - `sprint` -> `[new|advance|close]`
- **Skill-scoped Stop hook** in `auto/SKILL.md` frontmatter (forward-looking: blocked by Claude Code bug #19225)
- **PreCompact hook** in all 3 settings files - preserves prd.json to `.claude/pre-compact-state.json` before context compaction
- **Permission deny rules** in all 3 settings files - blocks `rm -rf /`, `rm -rf ~`, `git push --force origin main/master`, `git reset --hard`
- **New skill**: `browser-auth` (merged browser-test + auth-token-injection)

### Changed
- **Supabase triggers expanded**: now includes `postgres`, `rls` (absorbed from merged skills)
- **Deploy triggers expanded**: now includes `ci`, `deploy` (absorbed from ci-cd)
- **Security priority**: changed to 0 (auto-loaded with review, audit, ship)
- **Sprint skill**: now user-invocable with argument-hint
- **Manifest description**: updated to reflect 34 skills
- All version files bumped to 5.0

Total skills: 34 | Version: 5.0

## [4.9.4] - 2026-02-05

### Fixed
- **CRITICAL: Stop hooks disabled** - Installed settings.json had empty Stop array; auto-mode protection was non-functional
- **CRITICAL: Unwired hooks** - PreToolUse (security filter) and PostToolUse (typecheck) now wired in all settings files
- **Orphaned build/ skill** - Deleted dead directory (not in manifest, unreachable)
- **6 invalid skill names** - Uppercase/spaces fixed to lowercase-hyphens per Anthropic spec (agent-browser, archive-prd, env-vars, fix, ship)
- **Settings divergence** - Installed, repo, and unix configs now aligned (ExecutionPolicy, WindowStyle, hook wiring)
- **README missing commands** - Added sprint and verify to command table (18 commands)
- **Install script fallbacks** - Updated from 4.9.0 to 4.9.4

### Added
- **disable-model-invocation** on 8 side-effect skills (auto, commit, ship, deploy, clean, setup-project, update, archive-prd)
- **PreToolUse hook** - Blocks dangerous commands (rm -rf, DROP TABLE, git push --force) and skips large file reads
- **PostToolUse hook** - Auto-runs typecheck after TS/JS edits
- **.gitignore** - Added node_modules/, .env*, dist/, build/, .next/

### Changed
- **Manifest descriptions** improved with "use when..." context for 7 skills (sprint, fix, self-review, auth-token-injection, clean, verify, security)
- **Skill count** 40 → 39 (build removed)

Total skills: 39 | Version: 4.9.4

## [4.9.3] - 2026-02-05

### Added
- **Commit Skill** - Standardized git commit, push, and PR workflow
  - Conventional commits format (feat|fix|refactor|chore|docs|test|perf)
  - Safety checks: no .env, no console.log, no hardcoded secrets
  - Batch commit pattern for auto mode (every 3 tasks)
  - Full PR flow with gh CLI
  - Triggers: "commit", "push", "pr", "commit-push-pr"
- **Perf Skill** - Web performance audit patterns
  - Core Web Vitals targets (LCP, INP, CLS, FCP, TTFB)
  - Bundle size rules and common fixes (images, code splitting, React.memo, fonts)
  - Supabase query optimization
  - Audit report format
  - Triggers: "perf", "performance", "lighthouse", "bundle size", "core web vitals"
- **A11y Skill** - Accessibility audit (WCAG 2.1 AA)
  - Keyboard navigation, focus management, color contrast
  - Images/media, forms, ARIA, semantic HTML patterns
  - Bad vs good code examples for each pattern
  - Audit report format with scoring
  - Triggers: "a11y", "accessibility", "wcag", "screen reader"
- **Refactor Skill** - Code refactoring patterns
  - Split large file, extract component, extract hook
  - Replace prop drilling, consolidate duplicates
  - Safety checklist (typecheck before/after each step)
  - Triggers: "refactor", "extract", "split", "restructure"

### Changed
- **Requires Chains Updated** - New skills integrated into critical workflows
  - `auto` now requires: commit (for batch commits)
  - `ship` now requires: commit (for clean commits before deploy)
  - `audit` now requires: perf, a11y (comprehensive quality audit)
- **Auto Skill Fixed** - No longer auto-creates new sprints when all tasks done
  - Explicit STOP rule added to IDLE Detection
  - Suggests `brainstorm` or `sprint` for next work

### Fixed
- **Duplicate "pr" trigger** - removed from commit, kept in pr-review
- **Missing YAML frontmatter** - added to auth-token-injection and design skills
- **Trigger mismatches** - synced pr-review and setup-project with manifest
- **Orphaned hooks** - removed unused auto-continue.ps1/.sh
- **Dead build skill** - removed from manifest (directory kept as reference)
- **Missing jq checks** - added to stop-auto-check.sh, pre-tool-filter.sh, post-tool-typecheck.sh
- **Auto skill language** - dialed back aggressive caps/bold for Opus 4.5+ compatibility

**Total skills:** 40 | **Version:** 4.9.3

---

## [4.9.2] - 2026-02-05

### Added
- **Update Skill** - Say "update dev" to sync latest changes
  - Pulls from GitHub
  - Mirrors skills/ and hooks/ to ~/.claude
  - Removes stale files (robocopy /MIR on Windows, rsync --delete on Mac/Linux)
  - Reports version and changes
  - Triggers: "update dev", "update auto-dev", "update skills", "sync skills"

### Changed
- Session-start hook now has 5s timeout (no hang offline)
- Copy mode auto-detects and re-syncs on updates

**Total skills:** 37 | **Version:** 4.9.2

---

## [4.9.0] - 2026-02-05

### Added
- **Zero-Maintenance Updates** - Symlink-based installation
  - Skills/hooks symlinked to repo (changes auto-sync)
  - `update-dev` command added to shell profile
  - `repo-path.txt` stores clone location for portability
  - `--copy` flag for systems where symlinks fail
- **Plan Mode Integration** - brainstorm and audit now suggest plan mode for complex work
  - `brainstorm` suggests plan mode for features spanning 3+ files
  - `audit` suggests plan mode when 5+ critical/high issues found
- **Enhanced Triggers** - More natural language activation
  - `fix` now responds to: "broken", "error"
  - `env-vars` now responds to: "environment", "credentials", "secrets", "api key"
  - `agent-browser` now responds to: "browser", "web test", "ui test"

### Changed
- **Install Scripts Rewritten** - Now use symlinks by default
  - `install.ps1` / `install.sh` create symlinks instead of copying
  - Automatic fallback to copy if symlinks fail (Windows without admin/dev mode)
  - Adds `update-dev` function to PowerShell profile / bashrc / zshrc
- **Complete Synergy Chains** - All critical workflows now fully connected
  - `auto` requires: code-quality, quality, react-patterns, verify, browser-test, security-patterns
  - `ship` requires: review, security-patterns, test
  - `audit` requires: quality, code-quality, design, security-patterns, browser-test
- **Built-in Command Conflicts Resolved**
  - `status` skill trigger changed to "progress" (status is Claude Code built-in)
  - `deploy` marked internal-only (use `ship` for user-facing deploys)
- **Enhanced Clean Skill** - Age-based cleanup
  - Screenshots: all deleted on clean
  - Backups: delete older than 7 days
  - Handoffs: delete older than 7 days
  - Archives: prompt before deleting (30+ days)

### Fixed
- **prd.json Schema** - Corrected skills referencing stories as array (now object)
- **Deprecated MCP Reference** - Removed from settings.local.json template

**Total skills:** 36 | **Requires chains:** 14 | **Version:** 4.9.0

---

## [4.8.0] - 2026-02-05

### Added
- **Security Skill** - Pre-deploy security audit (user-invocable)
  - Secrets scan, env file check, RLS validation, XSS detection
  - Trigger: `security`
  - Auto-runs before ship

### Fixed
- **Version sync** - All version files now 4.8.0 (VERSION, package.json, manifest)
- **status skill** - Now uses TaskList + prd.json (removed project-meta.json reference)
- **prd.json template** - Fixed to match schema (projectName, stories as object)
- **ship skill** - Added security check step before deploy
- **Auto requires** - Added verify to chain (ensures completion quality)
- **Deduplication** - audit/brainstorm now check existing tasks before creating

### Changed
- **Quality skills consolidated** - Clear boundaries, no overlap
  - `quality` = Core principles (judgment, UI states)
  - `code-quality` = Production patterns (learned rules)
- **deploy skill** - Now internal only (use `ship` for deploys)
- **Single-word commands** - All triggers simplified

### Removed
- Unused templates (ab-test, context, learnings, project-meta)
- Plugin files (marketplace not approved yet)
- Redundant QUICKSTART files
- **Stale scripts** - setup-keys.ps1, setup-keys.sh, scripts/, bin/install.js
- **MCP template** - config/mcp.template.json (not using MCPs)

### Changed (Install Scripts)
- **Simplified install.ps1/sh** - From ~200 lines to ~80 lines
- **Removed credential setup** - No longer saves API keys during init
- **README simplified** - From 772 lines to 120 lines (accurate, concise)

**Total skills:** 39 | **Requires chains:** 14

---

## [4.6.3] - 2026-02-05

### Added
- **CI/CD Skill** - GitHub Actions workflows and CI/CD patterns
  - Standard CI workflow template
  - Vercel deploy workflow
  - Supabase Edge Functions deploy
  - Matrix builds for multi-version testing
  - Triggers: `ci`, `github actions`, `workflow`, `pipeline`
- **Monitoring Skill** - Observability patterns for production
  - Structured JSON logging
  - Error boundaries with logging
  - Vercel Analytics integration
  - API route monitoring
  - Health check endpoint
  - Triggers: `monitoring`, `logging`, `observability`, `analytics`
- **New requires chain**: `deploy` → `ci-cd`

### Changed
- **Directory structure normalized** - All skills now use `skill-name/SKILL.md` format
  - Migrated 12 flat files to directory structure
  - Updated manifest.json with new paths
- **supabase-schema split** - Was 361 lines, now modular:
  - `SKILL.md` - Main reference (~80 lines)
  - `rules/rls-patterns.md` - RLS policy examples
  - `rules/security-patterns.md` - Security hardening
  - `rules/multi-account.md` - Multi-account CLI setup
- **Total skills**: 39 (was 37)
- **Total requires chains**: 12 (was 11)

---

## [4.6.2] - 2026-02-05

### Added
- **Supabase Postgres Skill** - Official Postgres best practices from Supabase
  - Query performance (missing indexes, composite indexes)
  - Connection management (pooling, limits)
  - Security & RLS (basics, performance optimization)
  - Schema design (foreign key indexes, data types)
  - N+1 query prevention
  - 8 detailed reference files included
  - Source: [supabase/agent-skills](https://github.com/supabase/agent-skills)
- **CONTRIBUTING.md** - Skill authoring guide
  - Directory structure conventions
  - SKILL.md format specification
  - Manifest entry guidelines
  - Best practices and checklist
- **New requires chain**: `supabase` → `supabase-postgres`
- **Total skills**: 37 (was 36)
- **Total requires chains**: 11 (was 10)

---

## [4.6.1] - 2026-02-05

### Added
- **Remotion Skill** - Best practices for video creation in React
  - Compositions, animations, sequencing, timing
  - Subtitles and captions
  - Media embedding (videos, images, audio)
  - 5 detailed rule files included
  - Source: [remotion-dev/skills](https://github.com/remotion-dev/skills)
- **Total skills**: 36 (was 35)

### Changed
- Updated muzic.ai, reelr, cloud-connect-build to v4.6
- Removed stale skills folder from cloud-connect-build

---

## [4.6.0] - 2026-02-05

### Added
- **Security Patterns Skill** - Vulnerability detection patterns from Anthropic's security-guidance
  - Command injection (GitHub Actions, child_process, os.system)
  - Code injection (eval, new Function, pickle)
  - XSS patterns (dangerouslySetInnerHTML, document.write, innerHTML)
  - Auto-loaded with review, audit, ship, pr-review
- **PR Review Skill** - Comprehensive PR review using specialized agents
  - Triggers: `pr-review`, `review-pr`, `code-review`
  - CLAUDE.md compliance checking
  - Bug hunting with validation
  - Security scanning
  - Requires: security-patterns, code-quality

### Changed
- **Renamed** `frontend-design` → `design` (simpler, clearer)
  - Triggers: `design`, `ui`, `landing page`, `marketing page`
  - Creates distinctive UI, avoids generic AI aesthetics
- **Total skills**: 35 (was 33)
- **Total requires chains**: 10 (optimized from 6 in v4.4)
- Updated all skills referencing `frontend-design` to use `design`

### Requires Chain Updates
```
review     → quality + code-quality + security-patterns (NEW)
pr-review  → security-patterns + code-quality (NEW skill)
audit      → quality + code-quality + design + security-patterns (design renamed)
ship       → review + security-patterns (security added)
brainstorm → quality + design (design renamed)
```

---

## [4.5.0] - 2026-02-05

### Added
- **Skill Synergy Chains** - Critical missing connections now in place
  - `test` → requires `browser-test` → requires `agent-browser`
  - `ship` → requires `review` (pre-deploy quality check)
  - `verify` → requires `quality` (standards enforcement)
- **Improved Descriptions** - Third-person, specific, with trigger words per API best practices
- **Trigger Deduplication** - Removed conflicting triggers between skills
  - `setup-project` triggers: `init`, `new project`, `scaffold` (removed `setup`)
  - `test` triggers: `test`, `e2e`, `browser` (removed duplicate `verify`)
  - `ship` triggers: `ship` only (removed duplicate `deploy`)

### Changed
- Total `requires` entries: 10 (was 6)
- Quality skill description now specific about what it enforces
- Workflow skill description clarifies it's for reference
- Browser-test now chains to agent-browser automatically
- Version: 4.5.0

### Optimized (from API best practices review)
- **Progressive Disclosure**: Skills load only when needed via requires chains
- **Token Efficiency**: Metadata always loaded (~100 tokens), SKILL.md on-demand
- **Cross-references**: ONE level deep maximum (e.g., test→browser-test→agent-browser)
- **Trigger Specificity**: Each trigger maps to exactly one skill

---

## [4.4.0] - 2026-02-05

### Added
- **Frontend Design Skill** - Anthropic's official skill for high-quality UI design
  - Avoids "AI slop" (purple gradients, Inter/Roboto, generic layouts)
  - Guides toward intentional design choices (typography, color, motion, composition)
  - Pro tips: generate 5 variants, iterate on favorites
  - Triggers: `design`, `frontend`, `ui`, `landing page`, `marketing page`
  - Source: [anthropics/claude-code](https://github.com/anthropics/claude-code/blob/main/plugins/frontend-design/skills/frontend-design/SKILL.md)
- **Skill Synergy System** - Skills now cross-reference each other
  - `audit` → references `quality`, `code-quality`, `frontend-design`, `preserve-ui`
  - `review` → references `quality`, `code-quality`, `self-review`
  - `brainstorm` → references `quality`, `frontend-design`, `preserve-ui`
  - `auto` → requires `code-quality`, `quality`, `react-patterns`
  - Design validation step in brainstorm for UI features

### Changed
- Total skills: 33
- Manifest now has 6 `requires` entries (was 1)
- Skills include "Quality Framework Reference" sections
- Design system principles flow into audit/review checks

---

## [4.3.0] - 2026-02-04

### Added
- **32 skills now registered** - Consolidated all skills from installed versions
  - agent-browser (browser automation CLI reference)
  - archive-prd (archive completed stories)
  - auth-token-injection (auth patterns for testing)
  - build (build commands and error handling)
  - build-reference (build documentation)
  - env-vars (environment variable patterns)
  - help (list available commands)
  - supabase-schema (schema reference)
- **6 hooks added** - Full hook system for all platforms
  - auto-continue.ps1/.sh - Auto-continues if tasks remain
  - post-tool-typecheck.ps1/.sh - Runs typecheck after TS/JS edits
  - pre-tool-filter.ps1/.sh - Blocks dangerous commands
- **Brainstorm Phase 2** - Feature ideation after cleanup proposals
- **Skills vs Plugins architecture** - Documentation clarifying the two systems

### Changed
- Repository is now single source of truth for all skills and hooks
- Installer synced to v4.3
- prd.json removed from repo (project-specific file)

### Fixed
- 8 missing skills now registered in manifest.json

---

## [4.0.0] - 2026-02-03

### Breaking Changes
- Archived v3.9 (19 commands, 14 skills, 8 hooks → archive/v3.9/)
- New skill structure using SKILL.md in directories
- Native TaskCreate/TaskUpdate replaces prd.json for active work

### Added
- **Native Tasks Integration** - Uses Claude Code's built-in task system
  - TaskCreate/TaskUpdate/TaskList/TaskGet with metadata
  - blocks/blockedBy dependencies built-in
  - Session-scoped persistence - no file I/O during work
- **Hybrid Task System** - Two-layer architecture
  - prd.json = Long-term memory (sprint history, verification notes)
  - Native Tasks = Short-term memory (current session work)
  - 92% token reduction (~35K → ~2.6K per session start)
- **Resolution Learning** - Documents HOW issues were fixed
  - `resolution` field in prd.json schema
  - Pattern format: `[CATEGORY]: [SPECIFIC FIX]`
  - Auto-inject warnings on similar errors
- **Parallel Swarm Audit** - 6 specialized agents run simultaneously
  - Security (secrets, XSS, CORS, injection)
  - Performance (memo, effects, re-renders, N+1)
  - Accessibility (WCAG, keyboard, contrast, aria)
  - Type Safety (any, ts-ignore, type conflicts)
  - UX/UI (loading states, empty states, error handling)
  - Test Coverage (critical paths, untested hooks)
  - Produces severity-rated report with scores
- **Proactive Brainstorm** - YOU propose, user doesn't ask
  - Parallel scans for TODOs, console.logs, hardcoded colors
  - Presents concrete improvement scenarios with impact/effort
  - Never asks "what do you want?" - proposes based on findings

### Changed
- **skills/audit/SKILL.md** - Parallel swarm architecture
- **skills/brainstorm/SKILL.md** - Proactive proposals
- **skills/core/SKILL.md** - Hybrid task system documentation
- **Auto mode** - No more Ralph Loop dependency

### Philosophy
- Context is expensive - minimize prd.json reads
- Learn from mistakes - document resolutions
- Parallel execution - 6 agents faster than 1 comprehensive scan
- Use native tools when available (TaskCreate over prd.json)

---

## [3.9.0] - 2025-01-25

### Added
- **Auto Mode v2** - Self-bootstrapping autonomous development
  - Detects Ralph Loop for true non-stop execution
  - Bootstrap from project context if no prd.json exists
  - Auto-verify UX tasks with browser checks
  - Outputs `<promise>` tag for Ralph completion
- **Brainstorm auto mode** - Generates tasks without asking when called programmatically
- **Ralph Loop integration** - Suggests `/ralph-loop` if not already running

### Changed
- **auto.md** - Complete rewrite with entry point flow diagram
- **brainstorm.md** - Added auto mode vs interactive mode distinction
- Never use `AskUserQuestion` in auto mode - make decisions autonomously

### Philosophy
- "Walk away" development - start it and come back to finished work
- Bootstrap intelligently from CLAUDE.md, README.md, package.json context

---

## [3.8.0] - 2025-01-25

### Added
- **Verification requirement** - Tasks need actual testing, not just build passing
  - `verified: "browser"|"test"|"e2e"` = truly complete
  - `verified: null|"build"` = code complete but unverified
- **Verification matrix** - Different task types require different verification
  - UX: Browser test required
  - Feature: Browser OR unit test
  - Bugfix: Reproduce and verify fix
  - AI: Test with real/mock data
- **Status shows verification** - Verified vs unverified counts

### Changed
- **auto.md** - Verification step required before marking complete
- **core.md** - Schema includes `verified` field
- **status.md** - Shows verification quality metric

### Philosophy
- Build passing is NOT done
- Unverified code is technical debt
- Story quality matters more than velocity

---

## [3.7.0] - 2025-01-25

### Added
- **code-quality.md** - Learned patterns from production mistakes
  - 5 type safety rules (single source of truth, complete Records, Supabase typing)
  - 2 React patterns (no nested interactives, hooks at top level)
  - Error handling patterns (auth errors, storage quota)
  - Query key factory pattern
  - Mistake logging format with categories

### Changed
- **core.md** - Enhanced prd.json schema
  - Added `type` as required field
  - Task scoping rules (split if >5 files, >8 criteria)
  - Field validation rules with examples
  - ID format: `TYPE-NAME##`
- **auto.md** - Added learned code quality rules section
  - Type safety checklist from recurring mistakes
  - Enhanced decision logging format with rationale/trade-offs
- **manifest.json** - Added `requires` field for skill dependencies

### Context Optimization
- code-quality.md auto-loads with auto/review commands
- Prevents recurring mistake patterns before they happen

---

## [3.6.0] - 2025-01-25

### Changed
- **94% context reduction** - Slimmed build.md from 548 to 61 lines
- **Granular skill loading** - Each command loads only its specific file
- **Archived build-reference.md** - 1074 lines of redundant content removed
- **New core.md** - Minimal 43-line prd.json schema reference

### Context Savings
- "status" command: ~3K → ~300 tokens
- "auto" command: ~3K → ~1K tokens
- Estimated 60-70% reduction in initial context per command

---

## [3.5.0] - 2025-01-25

### Added
- **Sprint mode** - Time/milestone-based development cycles
  - `sprint 3h` - Run for 3 hours
  - `sprint "all P1 done"` - Run until milestone
  - Cycles through: brainstorm → auto → review → polish → security → docs
- **Session lock** - Prevents parallel session conflicts via `.claude-lock`
- **Mistake tracking** - `/mistakes` command to view error patterns
- **Smart retry** - Auto-retry failed tasks with different approach (max 2)
- **Task templates** - Pre-built patterns: auth, crud, api, component, hook, supabase
  - `template auth` - Adds 6 authentication tasks
  - `template crud users` - Adds 5 CRUD tasks
- **Batch commits** - Commit every 3 tasks instead of per-task
- **Preflight check** - Validates git, build, types before auto mode
- **Handoff export** - `/handoff` generates session summary for continuity
- **Context audit** - Analyze and optimize context window usage

### Changed
- **Auto mode hardened** - Explicitly forbidden from using AskUserQuestion
- Decisions logged to `.claude/decisions.md` instead of asking user
- Ralph Loop integration for true non-stop operation

---

## [2.4.3] - 2026-01-22

### Fixed
- **Cross-platform archive** - Use Read/Write tools instead of shell copy commands
- Prevents `copy` vs `cp` command errors on Windows
- Fixed emoji encoding in install.ps1 (replaced with ASCII)

---

## [2.4.2] - 2026-01-22

### Added
- **Skill index injection** - SessionStart hook now outputs command→file mapping
- manifest.json now actively used for skill discovery at session start
- Claude can now instantly look up which skill file to read for any command

---

## [2.4.1] - 2026-01-22

### Fixed
- **QUICKSTART.md**: Fixed Windows path syntax in troubleshooting section
- **install.sh**: Added plugin installation for Mac/Linux users (was missing)
- **auto-continue hook**: Changed from blocking to informing behavior
  - Now respects user's "stop" command instead of forcing continuation
  - Shows remaining tasks as info message, not blocker

---

## [2.4.0] - 2026-01-22

### Added
- **Local plugin** for slash commands (`/auto`, `/status`, `/brainstorm`, etc.)
  - Auto-registered during install
  - Works alongside natural language commands
  - 8 commands: auto, status, brainstorm, continue, archive, clean, stop, reset
- **Archive system** for large prd.json files:
  - `archive` command moves completed stories to `prd-archive-YYYY-MM.json`
  - Keeps only active/QA stories in main prd.json
  - Adds `archived` section with summary for context
  - Reduces token usage by 60%+ on large projects
- **Clean command** to remove Claude Code artifacts:
  - Deletes `.claude/screenshots/*.png`
  - Removes `prd-backup-*.json` older than 7 days
  - Cleans `.playwright-mcp/` folder
- **Screenshot convention**: Save to `.claude/screenshots/` (auto-gitignored)
- **archive-prd.md** skill with detailed archival documentation

### Changed
- Updated `build.md` with archive and clean commands
- Updated `test.md` with screenshot folder convention
- Updated README with inline changelog
- Install script now auto-registers plugin in Claude Code

---

## [2.3.0] - 2026-01-22

### Added
- **Hooks system** for token optimization and automation:
  - `auto-continue.ps1/.sh` - Stop hook that auto-continues if tasks remain in prd.json
  - `session-start.ps1/.sh` - Injects task progress context at session start
  - `pre-tool-filter.ps1/.sh` - Blocks dangerous commands, skips large/generated files
  - `post-tool-typecheck.ps1/.sh` - Runs typecheck only for TS/JS files
- `config/settings.json` - Pre-configured hooks for Windows
- `config/settings-unix.json` - Pre-configured hooks for Mac/Linux
- Hooks documentation in README

### Changed
- Install scripts now copy hooks and settings.json
- Token savings of 30-60% through context injection and filtering

---

## [2.2.0] - 2025-01-22

### Added
- `agent-browser.md` skill - Browser automation CLI (5-6x more token-efficient than Playwright MCP)
- Browser testing section in README

### Changed
- `test.md` now uses agent-browser CLI instead of Playwright MCP
- Simplified README - focus on "brainstorm" and "auto" commands
- Simplified `config/CLAUDE.md` and `config/QUICKSTART.md` templates
- Updated install scripts to remove scripts directory references

### Removed
- `scripts/start-server.ps1` - No longer needed (use background bash instead)
- `scripts/start-server.sh` - No longer needed
- `scripts/` directory - Empty after removing start-server scripts

---

## [2.1.0] - 2025-01-15

### Added
- Heartbeat monitoring (3-min intervals for faster work stealing)
- Dependency tracking (`dependsOn` field in tasks)
- Pattern storm detection (detects same error across 3+ tasks)
- Rollback command (`rollback S42` to undo task changes)
- Enhanced status dashboard with emojis and ANSI colors
- ASCII dependency tree (`deps` / `tree` command)

### Changed
- Stale work detection reduced from 30min to 10min
- Task schema updated with `heartbeat`, `dependsOn`, `blockedBy` fields

---

## [2.0.0] - 2025-01-10

### Added
- Multi-agent coordination with claim system
- `claimedAt` field for task locking
- Offset algorithm for parallel agent starts
- `stop` command to release claims before closing
- `reset` command to clear all claims after crash

### Changed
- Complete rewrite of build.md for autonomous operation
- Simplified task schema

---

## [1.0.0] - 2024-12-01

### Added
- Initial release
- `prd.json` task management
- `progress.txt` learnings log
- Basic skills: build, ship, test, fix, setup-project
- Supabase MCP integration
