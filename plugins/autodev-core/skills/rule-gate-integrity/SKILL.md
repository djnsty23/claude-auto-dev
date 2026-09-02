---
name: rule-gate-integrity
description: "Ways a gate, test, or generator check proves nothing while looking decisive: grading a copy of itself, passing on emptiness, a canary firing for the wrong reason, a summary line read as a verdict, and a mutation whose red comes from a different assertion than the one being validated. Load before writing a gate, a mutation harness, or any check that guards generated output."
when_to_use: "Before writing a gate, test, detector or harness — again when one reports green, and again when a mutation makes one go red."
user-invocable: false
allowed-tools: Read, Grep, Glob, Bash
paths:
  - "**/check-*.js"
  - "**/find-*.js"
  - "**/test-*.js"
  - "**/preflight*.js"
---

# A gate that cannot fail is not a gate

These four failure modes were hit independently by two sessions on the same day,
working on unrelated problems — a mutation harness for a token generator, and a
test-vacuity sweep across a plugin marketplace. Both arrived here the hard way.
Each one produces a **green result that means nothing**, and each is invisible
from the summary line.

## 1. Run the real thing. Never grade a copy.

A check that rebuilds what it is checking grades its own reconstruction. It
passes happily while the shipped artefact emits something else.

- A token gate must **run the real generator in `--check`** and read its exit
  code, not assemble the CSS it expects and diff that.
- A retry-policy test must **import the real function**. One in a production repo
  reimplemented `withTransientRetry` inline; the copy was faithful when compared,
  which is the most dangerous state for a copy to be in — it looks like evidence.

If speed is the reason for the copy, make the *slow part* injectable instead. A
2s/8s/32s backoff became an optional parameter that production never passes; the
real function then runs in milliseconds under test.

The same trap has a timing form: a gate that regenerates an artefact and *then*
reads it compares the generator against its own output and is green forever. One
production repo shipped a stale manifest twice that way, with preflight passing
both times. Snapshot what was **on disk** — what a commit would actually have
shipped — before any regeneration runs.

## 2. Assert a population floor

**No output never differs from no output.** A drift check that compares generated
against committed passes forever once the generator silently emits nothing.

Every check over a collection needs a floor asserted separately from the
comparison:

- a generator: *at least N tokens, N shells, N themes*
- a parity check across two sets: *both sets non-empty, and the same keys*
- a scan: *at least one file was actually scanned*

The same shape appears in test tooling: a suite whose subject is stubbed to
nothing still exits 0, so "the suite passes" proves nothing about the stub.

The sharpest statement of it comes from a production preflight that had already
learned it, and it is worth keeping in these words:

> **A verdict emitted before the work.**

Its success line used to print before a single file was opened, so it said the
same thing whether the directory held 200 files or did not exist at all. The fix
was to move the line to the end and give it the count it actually read — *"so an
empty scan is visible instead of reassuring."* That repo now carries an explicit
`read 0 files, so nothing was checked` branch. Copy the shape.

## 3. A canary must fire, and fire for the RIGHT reason

Confirm two things about every deliberate breakage:

1. **It fired at all.** A mutation that matches nothing proves nothing. If a
   canary reports an assertion vacuous, suspect the *mutation* first — one that
   fell back to a different data source could never have matched.
2. **It fired for the reason you think.** A harness that removed a JSON entry
   without its preceding comma broke the file, so every test threw — which looked
   exactly like the gates correctly firing. An anchor that matches a substring in
   two places does the same.
3. **It has DIFFERENT PROVENANCE from the check it validates.** A canary derived
   from the same source as the check shrinks when the check shrinks, so weakening
   the gate weakens its guard in the same motion and nothing goes red.

The check is cheap: run **one** case by hand and read the actual assertion text.

### Same-source canaries — two instances, one morning

A colour gate iterated a `FAMILIES` array and built its known-positive by
interpolating each family, while the regex under test was *also* built from
`FAMILIES`. Narrowing the array back to its original two exited 0 with a clean
tick: the gate could be silently reduced to nothing while reporting green. Found
only because the author applied this rule to their own fix rather than to the code
under test.

Independently, a copy guard's "every declared term is detected" controls looped
over the guard's own exported vocabulary. The whole suite passed with the
second-most-common production term deleted from the guard — 4 of 17 terms were
pinned by independent fixtures; the other 13 were guarded only by a loop that
shrank with them.

Both were verified as vacuous by deletion, not by reading. **The question to ask
of any canary: what single edit makes both the check and this canary weaker at
once?** If one exists, the canary is decorative. Pin it to a hardcoded literal, an
expected array, or a fixture written by hand — something that cannot move when the
subject moves.

A mutant you wrote to match the detector's own pattern has the same defect in a
different place: it verifies the assertion *wiring*, not the detector's coverage.
The cases it cannot represent are exactly the ones a reviewer will find.

### A RED SUITE IS NOT PROOF THAT YOUR ASSERTION WORKS

Point 2 above covers a mutation that breaks the subject incidentally, so
everything throws. This is the neighbouring case and it is harder to see, because
nothing is broken and the red is entirely legitimate: **the suite fails on a
DIFFERENT assertion than the one you were validating, and you read the exit code
instead of the line.**

`[measured 2026-09-01]` A new feature collapsed anonymous rows out of a report,
and its safety property was that a row which can be acted on is never collapsed.
Two filters implement that: one selects the rows to hide, one selects the rows to
keep. The mutation emptied the FIRST filter, the suite went red, and that looked
like confirmation. It was not. The failure was the count assertion noticing 5
where it expected 4. **The safety assertion passed**, because the filter that
actually protects those rows had not been touched. Mutating the second filter
instead failed the safety assertion and its control together, which is the real
check.

Both runs exit 1. Only one of them tests anything.

So the rule is one word longer than the familiar one, and the word carries all of
it: **assert that THAT assertion went red**, not that the suite did. Concretely,
run the suite under mutation and diff the set of failing assertion NAMES against
the set you predicted. If a name you did not predict is in there, you have
learned something either way: either your mutation is hitting the wrong code, or
an assertion you did not know about is doing the work you credited to yours.

The trap is structural rather than careless. A property worth protecting usually
has several assertions around it, and the loudest one is rarely the one that
encodes the property. Anything with a separate include-path and exclude-path has
this shape: a filter pair, an allowlist beside a denylist, a fast path beside a
fallback. Mutating either turns the suite red; only one of them tests the
invariant you care about.

Cheapest tell that you are about to make this mistake: you can state which
FUNCTION your mutation changed but not which ASSERTION should catch it. Predict
the assertion by name before running, then check.

## 4. Never read a summary line as a verdict

> `4 tests failed` and `4 gates fired` look identical from the summary line.

Counts are not findings. Before reporting one, open it:

- a "never called" count mixed dead code with CLI entry points, platform-gated
  code, and untested-but-live branches — **11 reported, 1 actually dead.**
  Chasing it to zero would have deleted five working commands.
- a survivor count from a mutation tool overstated the debt several times over,
  because the tool takes one suite and the subject had six.
- an orphan count was ~90% false positives from one regex artefact.

And the negative form, which is worse because nothing looks wrong: **an assertion
that something is NOT reported passes when the fixture never reached the code at
all.** Two fixtures did this in one file — repos that were never discovered, and
a state the function returns early on. Both looked like passing tests.

## 5. Exit on what you print

> A gate whose exit code ignores its own findings is not a gate. It is a report
> with a green light stapled to it.

A design checker computed `strikes = invented + pillar + laws`, printed every
one, and then exited on **blind leaks alone**. A spec with a dozen strikes
printed a dozen `✗` lines and returned 0, so every chain that ran it read a
pass. Separately, three violations the same file *declared* as grammar errors
were counted into no total at all — the comment above one said absence "is now a
violation rather than a silent pass", and it was still a silent pass with extra
prose.

Both survived because every assertion called the checker **in-process and read
the returned object**. No in-process test can see an exit code. If the CLI is
how the gate is consumed, a canary has to **spawn it** and assert the status.

The same trap catches the fix: a later instrument printed "answers that once
existed are gone" and returned 0. Writing the warning is not the gate.

## 6. A gate must not rewrite what it grades

Exit codes are structurally blind to this, because the offender exits 0.

A sweep spawned every script with no arguments to see if it self-tested. One of
them read bare invocation as "delete both benchmark directories and rebuild them
empty". It exited 0, the sweep scored it green, and the standing preflight
destroyed the benchmark on every run — losing four of five recorded answers
before anyone noticed. This repo has its own version: a killed mutation sweep
left a mutant in the tree, `git add -A` swept it into a commit, and it was
**pushed to a public repo** as `if (true)`.

Two things follow. **Declare how a script wants to be driven** rather than
assuming bare is safe — undeclared can still mean bare, but the premise is
written down and a script that cannot be run bare can say so. And **snapshot the
state a gate may read but not modify, then compare after**; `tooling/test-all.js`
does this as `tree-inert`, and it is the only check in the run that can see a
suite rewriting the tree.

Two cautions, both measured. The comparison must be *before vs after*, not
"is it clean" — a tree is legitimately dirty during work. And the check passes
on emptiness: rebuilding an already-empty directory is idempotent, so it proves
nothing until there is something to destroy. Verify it by reintroducing the
defect with real state present.

## 7. Measure precision on the real corpus before wiring anything

A gate earns its wiring with a triaged first run, never with a passing
selftest. The selftest proves the check CAN fire. Only the corpus says
whether what it catches is worth reading.

**A worked negative, kept because the result is the useful part.** A
reviewer found a real defect no suite here could see: a document that
denied a thing in one paragraph and measured it in another, where each
sentence was individually plausible and only their conjunction was false.
A detector for that shape was written, and it passed a careful selftest
8 of 8, including the real defect planted verbatim and the fixed text
staying quiet.

Then it met the corpus: **204 hits over 123 files, and 12 of the first 12
triaged by hand were false.** Every one paired unrelated paragraphs -- "no
releases" in one changelog entry against "releases" in a different entry
forty paragraphs later. The check matched a shared noun; the question was
whether two statements are about the same subject, and a string comparison
cannot answer it.

Three things that generalise past this one check:

- **A selftest measures the author's imagination.** Both the positive and
  the negatives were cases considered while writing it. The corpus
  supplies the cases that were not.
- **Fix your own bugs before condemning the class.** The first sweep
  flagged `the`, `from`, `its`: the capture took the token after the
  negation, which is often a determiner. That was 24 hits of author error
  masquerading as evidence about the problem. Removing them moved 228 to
  204 and changed no conclusion, but the conclusion was only trustworthy
  after.
- **A detector at zero precision is worse than none**, and the reason is
  the same one that makes a reassuring skip worse than silence: a check
  people mute stops catching the real thing later. Ship the negative
  result instead. "This class needs a semantic comparison, here is the
  measurement that says so" is a finding.

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
JSON file that is `JSON.parse` throwing on the markers, which also proves the
records you cared about survived rather than only that a conflict existed.

## Before shipping a gate

- [ ] It runs the real implementation, not a reconstruction.
- [ ] Its first corpus run was triaged by hand, and the precision written down.
- [ ] It fails when the population is empty, not just when it differs.
- [ ] Each deliberate breakage was confirmed to fire, and for the right reason.
- [ ] Every negative assertion was confirmed to reach the code it denies.
- [ ] No count was reported without reading its members.
- [ ] The exit code depends on every finding the gate prints.
- [ ] Running it leaves the tree, and the fixtures, unchanged.
- [ ] Its probe was measured against the exact invocation the gate runs.
