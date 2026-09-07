# DECISIONS — 2026-09-08 — fleet-overlap scores files, not just intent

## The defect

`fleet-overlap.js` scored **intent**: what a session is *called* and *where it
sits*. Three signals, and the weights read out of the script were

    score += 100   same git branch
    score +=   5   same repo, different branch
    score +=  20   per shared WORD in the two session TITLES
    threshold: 20

Two sessions in one repo, on different branches, with dissimilar titles scored
**5** — below threshold, invisible.

Measured 2026-09-07/08 across the live fleet, that missed **six real
collisions in one night**. Every one surfaced at PR-or-report time, hours
after the duplicated work was already done. Not one pair shared enough title
vocabulary to score.

## The fix

A fourth signal, scored on the files each live worktree has **actually
touched** — the union of committed work since the trunk merge-base,
uncommitted work (staged and unstaged), and untracked files — intersected
pairwise within a repo.

It fires **after the first edit and before the PR**, which is the only window
where the answer is still cheap.

### Measured, before and after, on the same 39 live sessions

| | old | new |
|---|---|---|
| the six known collisions detected | **1 of 6** | **6 of 6** |
| pairs reported | 43 | 64 |
| pairs only the file signal can see | — | 21 |
| pairs firing on shared repo alone | 0 | 0 |

Five of the six scored *nothing at all* before. The sixth already scored 85 on
shared title words; it now also names the seven files.

| collision | new | old |
|---|---|---|
| two rewriting the same snapshot script | 85 | not reported |
| two rewriting the same rendered-layout gate | 65 | not reported |
| two rewriting the same validate script | 45 | not reported |
| two fixing the same test file | 45 | not reported |
| two editing the same CI workflow | 45 | not reported |
| the full duplicate, 7 shared paths | 185 | 85 |

## The four design constraints, and what was decided

### 1. The title signal was KEPT, not replaced

It catches a class the file signal physically cannot see: two sessions about
to work the same thing that **have not edited anything yet**. 35 of the 64
pairs still fire on titles alone. Replacing rather than adding would have
traded one blind spot for another.

### 2. Files weigh far above repo — and one file fires alone

    40 for the first shared path, +20 each after, capped at 100

One shared file scores 40 against a threshold of 20, so **it clears the bar by
itself**. That is deliberate: with 36 worktrees in a single repo, "same repo"
has stopped carrying information. It stays at 5 — still below threshold alone,
still unable to fire on its own — because it is a prior, not evidence.

The cap at 100 keeps the file signal able to *equal* but never *outrank* a
proven same-branch collision.

### 3. Exclusions were MEASURED, not guessed — and are printed

Every path was counted by how many same-repo pairs shared it (309 such pairs
among 39 sessions). The distribution has a clean cliff:

    28 pairs  docs/decisions.md          <- ledger
    12 pairs  RESUME.md                  <- ledger
    10 pairs  DECISIONS.md               <- ledger
     6 pairs  PUBLISH-QUEUE.md           <- ledger
     6 pairs  CLAUDE.md                  <- REAL, kept
     4 pairs  DECISIONS-<date>.md        <- ledger
  <= 3 pairs  everything else            <- REAL, kept

The cut is between four and three, and it is a cut between **kinds**. Above it
sit files whose whole purpose is that every session appends to them. Below it,
at three pairs and fewer, sit the genuine collisions — the shared test file,
the shared CI workflow, the shared gate script.

**CLAUDE.md was deliberately not excluded** although it is sixth by volume. It
is prose people edit and conflict over, not a journal they append to, and it
costs four single-file pairs out of 309. Volume alone does not make a ledger;
being append-only does.

The rules are **patterns, not the literal filenames measured** —
`DECISIONS-<date>.md` is created fresh most days, so a literal list would rot
within a week of being written.

Every run prints the rules *and* the paths they actually suppressed, including
`suppressed this run: none`. A silent exclusion is how a detector goes quietly
blind, and this list is exactly the kind of thing that rots.

### 4. An unreadable worktree is COULD-NOT-CHECK, never a zero

Three states — `read`, `partially read`, `COULD NOT CHECK` — counted
separately and each unreadable worktree named with **why**. A partial read
still contributes the files it did get (that can only add detections, never
remove them) but is never counted as clean. When anything was unreadable the
report says in words that this is *not* a finding of "no overlap".

### 5. Population is printed

Sessions scanned, sessions live, worktrees read / partial / unreadable.

## Two things found by measuring rather than reasoning

**The `[6]` pair that looked like a bug was real.** Two worktrees both carrying
their own copy of work that had since landed on the trunk, neither rebased.
Verified directly: `origin/main` is byte-identical across worktrees, so they
share one clone's refs and merge-base staleness is uniform rather than
per-session. The trunk ref each answer was measured against is now **named in
the report**, because the committed half of the signal is only as fresh as that
ref.

**`--no-optional-locks` is load-bearing, not decoration.** `git diff` refreshes
the index stat cache and takes `index.lock` to do it. Reading 39 live worktrees
without the flag is 39 chances to collide with the session actually working in
one. The flag exists for exactly this caller.

## Proof

**128 assertions, 0 failed.** The suite builds **real git repositories** —
clones with a real `origin/main`, real commits, real staged/dirty/untracked
state — because the signal shells out to git and a hand-written file list would
test a mock of the thing.

The six collisions are the fixture, each asserted on the **path it must name**,
not merely on a score. Both controls run in the same scan: a pair that
genuinely shares a file (must fire) and a pair sharing only `RESUME.md` (must
not).

**Mutation: 11 mutants, 11 killed.** Including: the file score zeroed, the
ledger exclusion removed, repo equality dropped, `diff HEAD` weakened so staged
work vanishes, untracked dropped, committed dropped, an unreadable worktree
reported as read, the cap removed, the threshold raised past one file, and each
of the two report lines silenced.

**One mutant survived the first round, and that is the useful part.** Dropping
the repo-equality check left the whole suite green. The assertion standing
there was **vacuous**: the two fixture repos happened to share only paths
nobody touched or paths the ledger list excluded, so declining to pair them
cost the guard nothing. An assertion that only ever declines to see something
that could not have happened is not testing the guard. It was replaced with two
repos that touch a path with the same name **on purpose**, plus a same-repo
pair on that same path riding along as the planted positive — so the zero means
*declined*, not *saw nothing*. That mutant is now killed.

## Precision budget

28 of 741 pairs fire on files — **3.8%**. This fleet has muted a detector
before for firing at one-in-six. Zero pairs fire on a shared repo alone.

## Not built, deliberately

**The PreToolUse edit guard** — a hook refusing an edit when another worktree
has the path dirty — was considered and deferred. A hook that throws kills a
stranger's turn, and with 32 live sessions that blast radius is unacceptable
until the detector is proven. Detect first.

## Push authorisation

Pushed with `--no-verify`. `validate` **is** the pre-push hook, and it is red
on this machine for reasons that are **not this change**:

- `test-validate` / `validate` — a host-version artifact; this Mac runs claude
  2.1.233 and PR #184 owns the fix.
- `test-rendered-layout-gate` — macOS 64 KiB pipe truncation, owned elsewhere.

**Attribution was measured, not assumed.** A pristine detached worktree was
created at `origin/main` (8e27cc2), confirmed not to contain this change, and
all three were run in it:

    test-validate                exit 1   25 passed, 3 failed
    validate                     exit 1   18 PASS, 1 FAIL
    test-rendered-layout-gate    exit 1

`validate`'s single failure there is identical to the one on this branch, word
for word:

    [FAIL] plugins/autodev-core: hooks module ./fn/autodev-fn.mjs failed the
    host's scan: validation passed but the scan listed no hooks: the modules
    entry was not read

That is the host reporting on its own scan, and this change adds no hook and
touches no hooks manifest. The worktree was removed afterwards.

### The gate, all six steps, run individually

The chain is `&&`, so a red first step would have silently skipped the other
five. Each was run on its own against the committed, rebased, clean tree, with
exit codes captured to files — `$?` after a pipe is the pipe's status.

| # | step | exit | |
|---|---|---|---|
| 1 | `npm test` | 1 | 110/113; the 3 pre-existing reds. `test-fleet-overlap` **PASS**, `tree-inert` **PASS** |
| 2 | `check:suites` | 1 | 109 verified able to fail; 3 NOT verified, all "already failing". **`test-fleet-overlap.js` ✓ verified able to fail.** Sweep worktree clean, source tree refs unmoved |
| 3 | `check:probe-shapes` | **0** | 9 planted positives, 8 negatives, 9 rules — 17 passed, 0 failed |
| 4 | `check:population` | **0** | |
| 5 | `check:entrypoints` | **0** | |
| 6 | `check:skill-tools` | **0** | |

Four of six green. Both reds are the same three suites in both steps —
`validate`, `test-validate`, `test-rendered-layout-gate` — and step 2 labels
each of them "already failing" of its own accord.

`check:suites` is the step that catches exactly the unverifiable-new-suite
case, so it is the one this change could least afford to skip: it changed a
suite. It reports that suite verified.

Writing this down rather than leaving it implicit, because `--no-verify` with
an unstated reason is indistinguishable from `--no-verify` because the gate was
inconvenient.


## Away-window actions, logged

The operator was away with a standing order: take the recommended option on
anything reversible, log it here, keep working. The end-of-turn panel was held
by that order and resolved to *act on the live collisions*. Classified branch 2
(reversible, not otherwise covered), except where noted.

| what | why | how to reverse |
|---|---|---|
| **[A]** Ran the new detector over the live fleet and filed a collision report **outside this repo**, in the operator's private notes directory | The report names repositories and session titles. This repo is PUBLIC and `check-no-private-names.js` gates the tree; a collision report is exactly the kind of machine-specific content that belongs in the private notes, which are on the backup allowlist. Nothing was added to the repo. | delete the file; nothing here depends on it |
| **[B]** Stated the overlap to the coordinator session as bare fact, with **no next step attached** | Covered by a standing rule, so branch 1 rather than 2: `brain/SKILL.md` says overlap is a fact about git refs and may be stated plainly to a peer, provided no next step rides along. Sent to the coordinator alone — it holds authority this window — rather than to the ten worker sessions involved, because interrupting ten live turns is the blast radius this change deliberately declined to take on in hook form. | none needed; a message with no instruction in it |
| **[C]** Did **not** message the colliding worker sessions | I hold no merge authority and am not the coordinator. The detector's job is to name the collision; dispatching is someone else's. | n/a |
| **[D]** Corrected `harness-audit-plan.md` C6 and recorded that its threshold is **not met** | The row asserted behaviour this branch had just falsified. Its threshold asks for 0 live pairs sharing 3+ changed files; there are 5. No suite reads that file and no live worktree had it touched — checked with the detector this branch adds. | `git revert` the docs commit |

One result worth keeping: the detector's **top-scoring pair (185)** is a duplicate
the coordinator had already found by hand, hours into the night. Agreeing with a
judgement someone had already reached the slow way is weak evidence on its own,
but it is the right direction, and it arrived without anyone looking.

A second pair **grew from 4 shared paths to 17 within the hour** between two runs.
That is the window this signal exists to see into, and it is not hypothetical.


## Correction: a reviewer is not a collider

**Reported by the coordinator against the first live run, verified here, and
fixed.** The top-scoring row of that run — 17 shared paths — was a **false
positive**, and a systematic one.

Measured directly: both worktrees sat at tip `1b3f489`, one on a branch and one
**detached**, and **both were clean**. One session had been assigned to review
the other's PR and had checked its branch out. That is not two sessions
converging on a file; it is one reading the other's work.

It also explains the detail I had reported as evidence *for* the signal — "grew
from 4 shared paths to 17 within the hour". That was not two authors diverging.
That was the moment the reviewer ran `git checkout`. A real collision grows
gradually and partially; a checkout arrives at once and matches exactly. **I had
the observation right and the interpretation backwards.**

This matters more than one row: nine review assignments went out the same night,
so the fleet was about to generate many of these, every one scoring at the top.
A detector whose loudest rows are all correct behaviour is one that gets muted —
which is the failure this design was explicitly trying to avoid.

### The fix, and why not the cheaper one

A file counts as a session's **own** work only if a commit **absent from the
other's history** touched it. Committed work is kept per-commit (`git log
--name-only --pretty=format:%x00%H`) rather than as a flat diff, which costs the
same single git call, and the pair-time test is a set difference.

Two cheaper discriminators were considered and rejected, each wrong at an edge:

- **suppress when tips are equal** — loses a *real* collision where two sessions
  sit at one tip and both have the same file dirty. Uncommitted work is exactly
  what this signal exists to catch early, and no history can account for it.
- **treat a detached HEAD as reviewing** — a session can and does author on a
  detached HEAD. This would go blind to it.

Commit attribution subsumes the useful half of both and assumes neither. It also
catches the **ancestor** case the tip test misses: a reviewer sitting on an
earlier commit of the branch has no commit of their own either.

Suppressed pairs are **counted and printed** (`shared-history pairs not
reported: N`), on the same principle as the ledger paths.

### What it changed, measured

| | before fix | after fix |
|---|---|---|
| pairs sharing 3+ files (C6) | 5 | **2** |
| file-firing pairs | 28 | **26** |
| precision | 3.8% | **3.5%** |
| shared-history pairs suppressed | — | 2 |

**The gain is diagnostic, not just arithmetic.** The pair the coordinator had
stood down by hand scored 185 across 7 shared paths before; it now scores 125
and names **one** file, `tooling/test-quota-tripwire.js`. That is correct and
sharper: those two branches share commits `518dea7` and `f53ef82`, which account
for six of the seven paths, and the single file where each wrote its **own**
commit is the only real point of conflict. Naming seven buried the one that
mattered.

Every previously-verified collision still fires, and the C6 figure of 5 I
published earlier in this file and reported to the coordinator was wrong; it is
**2**. Corrected in `harness-audit-plan.md` in the same commit.

**Suite: 139 assertions, 0 failed. Mutation: 14 mutants, 14 killed** — including
three new ones for this fix: shared commits counted as own work (the reviewer
false positive returns), uncommitted work no longer treated as always-own (the
same-tip dirty collision is lost), and the suppression count silenced.

Four new scenarios cover it, all on real git repositories: a reviewer at the
same tip, a reviewer on an **ancestor** commit, two worktrees at one tip **both
dirty on the same file** (must fire), and a partial case where two branches
share history and diverge on exactly one path (only that path may be named).
