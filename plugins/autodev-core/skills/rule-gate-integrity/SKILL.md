---
name: rule-gate-integrity
description: "Ways a gate or test proves nothing while looking decisive: grading a copy of itself, passing on emptiness, a canary firing for the wrong reason, a summary read as a verdict, a probe pointed at the wrong invocation. Load before writing a gate, a mutation harness, or any check guarding generated output."
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

These failure modes were hit independently by two sessions on the same day,
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

A zero finding can be valid; zero execution cannot prove coverage. Establish
expected population from independent inputs and distinguish an intentionally
empty workload from missing, unreadable or wrongly filtered input. Do not invent
work merely to satisfy a positive floor.

## 3. A canary must fire, and fire for the RIGHT reason

Confirm all three properties of every deliberate breakage:

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

Check fixture context as well as contents. A directory intended to be outside
Git can inherit an ancestor repository when temporary files are placed beneath
the checkout. Verify `git rev-parse --show-toplevel` in both the positive Git
fixture and the intended non-Git fixture; require failure in the latter. Use
an OS temporary root outside the source checkout when ancestor discovery is
part of the behavior. Moving fixtures can otherwise make a correct test fail
for a different reason while leaving its purported assertion untested.

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

Also assert complete output through the transport the caller uses. An immediate
`process.exit()` can discard pending writes while returning 0. Node documents
asynchronous stdout/stderr pipes on POSIX, including Linux and macOS; a passing
file redirect or another platform does not prove a pipe drained. Prefer
`process.exitCode` and natural completion, and compare a substantial known
payload byte-for-byte through a pipe and a file control. A callback for one
write does not establish that unrelated pending work finished.

`[measured 2026-09-09]` Node 24.19.0 on macOS, 1,048,576 expected bytes:
immediate exit delivered 65,536 pipe bytes; natural completion and a write
callback each delivered all 1,048,576. All three variants exited 0 and all file
controls were complete. See the [platform contract](https://nodejs.org/api/process.html#a-note-on-process-io);
Linux and Windows were not executed in this control.

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

Load [references/corpus-precision.md](references/corpus-precision.md) before wiring a new gate or detector: a passing selftest is not precision, so triage its first corpus run by hand, and prove every suppressor fires on one input.

## 8. A probe is bound to the command form it was measured on

Load [references/probe-command-form.md](references/probe-command-form.md) when a probe reads a command's exit code or output: pin the invocation and the probe on the same line, and re-measure when either moves.

## 9. Sample the input before you build the reader

Section 7 asks whether a gate's hits are worth reading. This one is upstream of
it: does the shape you plan to key on occur in the real input **at all**? A gate
built against a shape that is not there does not fire wrongly. It never fires,
reports a confident zero for every subject forever, and reads exactly like an
all-clear.

A spec said to join session heartbeats to the OPEN ITEMS in each project's
`QUEUE.md`, keyed on markdown checkboxes. Measured across every real `QUEUE.md`
on the machine before a line of the join was written:

```
4 files, 1,488 lines total
unchecked "- [ ]"   0
checked   "- [x]"   0
"PREMISE:" lines    0
control: a planted checkbox and a planted PREMISE: line   1 and 1
```

They are prose. Nobody had written a checkbox into one, ever. The specified join
would have shipped a gate that reports zero open items for every session, and
the number would have been *correct* in the sense that the query returned it.

The control is the half that makes this reportable rather than a shrug. Without
planting a checkbox and confirming the same grep finds it, "zero" is a claim
about the probe. With it, zero is a fact about the corpus, and the finding stops
being "my grep found nothing" and becomes "the data does not have this shape".

**So the spec was wrong, and that is the deliverable.** The instrument was keyed
on staleness instead, and its header says which question it answers rather than
carrying the original name over a different measurement. Reporting "this cannot
be built as specified, here is the measurement" is a result. Building it anyway
produces an instrument that is inert and looks healthy, which is worse than
having none.

Two habits fall out, both cheap:

- **Before writing a reader, run its extraction over the real corpus and print
  what it found, with a known-positive control beside it.** One command, before
  any design is committed to.
- **When the extraction returns nothing, do not soften the key until something
  matches.** That converts a finding about the data into a gate with invented
  semantics. Ask instead what the input actually contains and whether a
  different question is the useful one.

This is the same discipline as pre-selling a product before building it: the
cheapest possible test of whether the thing you are about to spend days on has
a subject. The failure it prevents is not a wrong answer, it is weeks of work
sitting behind an assumption nobody sampled.

## 10. A floor is a property of one item. "Complete" is a property of a set.

> Every assertion passed. The page was in the route list. It had two dedicated
> tests. The defect was between two siblings, which is neither an item nor a page.

`[measured 2026-09-03]` A pricing page shipped a grid declaring 5 items in
`coinPacks.ts` against 4 columns in a Tailwind class in `Pricing.tsx`, so the
last row held one stranded cell at every breakpoint. Its layout suite at the
time asserted only a per-element floor (every control at least 44px) and a
page-level absence (no horizontal scroll). Both passed, correctly. `/pricing`
was in the route list and carried two dedicated tests, so coverage was never
the gap.

**That suite has since grown a relational check, and its header carries the
sub-trap that catches the second attempt: measure the thing that is DRAWN, not
the grid cell.** A list item wrapping a button stretches to the row height while
the button inside it does not, so comparing a grid's direct children reports
equal heights and sees nothing. Descend to the lone element child, and compare
only elements that are actually painted, or a grid of bare text spans with
differing line counts fires on every page.

I re-derived that gate without reading the file first and got exactly that
distinction wrong, comparing `children` rects directly. The existing version
also guards against its own blindness, refusing to report a pass when it scanned
zero grids. Read the suite before writing the check, not after.

**Sort your assertions by how many items you must look at to decide them.**

| shape | decidable from | examples |
|---|---|---|
| floor, ceiling, format | ONE item | `>= 44px`, has a condition clause, declares `allowed-tools` |
| absence | the whole page, but as one fact | no horizontal scroll, no console error |
| **relational** | **two or more items, compared** | equal, aligned, unique, distinct, the last row is full, no two of these collide |

A suite built entirely from the first two rows cannot fail on anything in the
third, no matter how complete its coverage. That is not a gap in the corpus, it
is a gap in the assertion's shape, and adding routes never closes it.

**Historical instance in this repo.** `check-skill-triggers.js` scores every
description alone: `!r.hasCondition`, `r.len > 320`, `!r.hasWhenToUse`. Every
predicate reads one row and there is no pairwise comparison in the file. So
that checker alone cannot detect two skills matching the same situation. The
current `check-skill-collisions.js` adds pairwise candidate detection; read its
actual results and triage reasons. Lexical overlap is a review signal, not proof
of semantic ambiguity, and a lexical pass is not an observed dispatch outcome.

Two reasons this shape survives review, both of which apply above:

- **The fact spans files.** Item count in one module, column count in a class
  string in another; a skill's description here, its neighbour's over there.
  Section 9 covers a reader built on too little input. This is a reader whose
  unit of observation is smaller than its subject, so it reports absence
  confidently, which is the trap `verification-traps.md` names for a
  line-oriented probe over wrapped prose.
- **The coupling is not typed.** `sm:grid-cols-4` is a string, not a number the
  compiler can compare against `COIN_PACKS.length`. Adding the fifth pack was a
  data-only diff with no type error and no failing test. Where you can, make the
  relation a shared constant so a typecheck decides it and no gate is needed.

**Writing one:** name the property, then name the set it ranges over, then print
that set's size beside the verdict. A relational check that reports only a count
is worse than a per-item one, because the reader cannot tell WHICH pair failed.
Print the pair.

And expect the first run to find things outside the case that prompted it. A
ragged last row is correct for a blog list and wrong for a pack selector. Triage
by hand rather than tuning until quiet, and where an instance is legitimate mark
it at the source with an attribute rather than in an allowlist keyed on a
selector that will drift.

## 11. A control must not share a mechanism with its subject

Load [references/controls-and-selftests.md](references/controls-and-selftests.md) when writing a completeness control: a control that asks the subject's own mechanism inherits its blind spot, so use a different mechanism and measure the positive half.

## 12. Asserting that a control EXISTS is not running it

Load [references/controls-and-selftests.md](references/controls-and-selftests.md) when a gate ships a selftest: name the command that executes it, because a test that greps the source for the selftest detects deletion and is blind to breakage.

## 13. Bind evidence to the candidate and transition

Capture the prior deployed artifact before changing the target. A baseline read
after promotion can equal the candidate and erase the entire verification set.
Freeze baseline and candidate identities, derive expected members independently,
and require fresh evidence when either identity or the acceptance contract changes.
A ledger rewrite must not transfer old checkmarks to a new candidate; deleting
an expected row cannot turn missing verification into completion. Exercise those
transitions with controls, not just an unchanged happy-path ledger.

## 14. Redact BEFORE you transform, and search for the TRANSFORMED value

Load [references/redaction-before-transform.md](references/redaction-before-transform.md) when a gate, collector or detector handles secrets: scrub values where they enter the record, search every transformed form, and confirm a clean result by a positive marker.

## Before shipping a gate

- [ ] It runs the real implementation, not a reconstruction.
- [ ] The shape it keys on was confirmed to EXIST in the real input, with a control.
- [ ] Its first corpus run was triaged by hand, and the precision written down.
- [ ] It fails on missing expected input/coverage; a legitimate empty workload is
      explicitly distinguished from a broken or unexecuted scan.
- [ ] Each deliberate breakage was confirmed to fire, and for the right reason.
- [ ] Every negative assertion was confirmed to reach the code it denies.
- [ ] Every suppressor was watched firing on one input, not scored by how often it fired.
- [ ] No count was reported without reading its members.
- [ ] The exit code depends on every finding the gate prints.
- [ ] Running it leaves the tree, and the fixtures, unchanged.
- [ ] Its probe was measured against the exact invocation the gate runs.
- [ ] Every relational property it claims is decided by comparing items, not by passing each one.
- [ ] Its control uses a DIFFERENT mechanism from the subject, not the subject itself.
- [ ] Every selftest it ships is executed by a named command, not merely present in the source.

- [ ] Every value it redacts is scrubbed BEFORE any transform that rewrites it.
- [ ] Its canary carries every shape the transforms can alter, and was watched firing.
- [ ] A "clean" verdict was confirmed by a POSITIVE marker, not by the absence of a match.
