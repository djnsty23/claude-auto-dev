---
name: rule-gate-integrity
description: "Four ways a gate, test, or generator check passes while proving nothing: grading a copy of itself, passing on emptiness, a canary firing for the wrong reason, and a summary line read as a verdict. Load before writing a gate, a mutation harness, or any check that guards generated output."
when_to_use: "Before writing a gate, test, detector or harness — and again when one reports green."
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

## Before shipping a gate

- [ ] It runs the real implementation, not a reconstruction.
- [ ] It fails when the population is empty, not just when it differs.
- [ ] Each deliberate breakage was confirmed to fire, and for the right reason.
- [ ] Every negative assertion was confirmed to reach the code it denies.
- [ ] No count was reported without reading its members.
- [ ] The exit code depends on every finding the gate prints.
- [ ] Running it leaves the tree, and the fixtures, unchanged.
