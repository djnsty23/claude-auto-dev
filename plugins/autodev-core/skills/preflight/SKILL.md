---
name: preflight
description: Scaffold and grow a project's executable gate file — the checks that run before every deploy and fail the build on the bug families this project actually ships.
when_to_use: "Invoked when the user says \"preflight\", \"add a gate\", \"set up preflight\", \"gate this\", or after /learn-from-fixes identifies a class worth enforcing mechanically."
allowed-tools: Bash, Read, Write, Edit, Grep, Glob
model: opus
user-invocable: true
argument-hint: "[init | add <class> | verify]"
---

# Preflight

A checklist a human runs sometimes is not a gate. This builds the executable
one: `scripts/preflight.js`, wired into the project’s actual local completion/
release gate and existing CI when used, failing on relevant bug families.

A rule’s presence does not prove it changes outcomes. Measure whether the
actual gate rejects a reproduced defect while preserving a known-good control.

## `preflight init`

1. **Find out what to gate.** Run `/learn-from-fixes` first. Gate the top two or
   three classes for *this* repo, not a generic list. If the user insists on
   starting without that analysis, start with applicable template checks and
   known acceptance risks. Record missing history; a new repo can still have
   concrete requirements worth testing.

   The template defaults are `syntax` (JavaScript parse checks), `gates-ran`
   (wiring hints) and `workflow-valid` (a narrow workflow shape check). They
   need project-specific applicability and behavioral controls. A
   workflow file GitHub refuses fails in **0 seconds, with no jobs and no log**,
   so nothing readable tells you it happened. Measured in one repo on
   2026-08-20 — a duplicate top-level `concurrency:` key left a workflow dead
   for three days while marking every open PR `UNSTABLE`, past sixty other
   gates. The template’s line scan targets that class; it is not a full workflow
   validator. Some parser configurations accept duplicate keys, so verify that
   the chosen validator rejects the actual malformed workflow.

2. **Copy the template** to `scripts/preflight.js`:

   ```bash
   cp "${CLAUDE_PLUGIN_ROOT}/templates/preflight.js" scripts/preflight.js
   ```

3. **Wire it into the command that actually guards completion:**

   ```json
   { "scripts": { "preflight": "node scripts/preflight.js" } }
   ```

   Add it to the actual local completion/release command and existing CI if
   applicable. Inspect what the copied template requires before claiming it is
   wired; a package-script name alone does not show a consumer runs it.

4. **Run it and its consumer.** Inspect failures and warnings. The template’s
   `gates-ran` checks a script substring and can pass on `echo preflight`; absent
   package/CI configuration can produce only a warning. Prove propagation by
   making an actual check fail in an isolated fixture and running the real
   completion/release command. Do not infer enforcement from this template alone.

## `preflight add <class>` — first, prove the gate does not already exist

**Before writing anything**, in this order:

1. **Is it already gated?** List the gate ids in the existing file and read the
   tests the build already runs. A duplicate gate reports the same finding under
   two names and doubles the noise.
2. **Was it already rejected?** Search the gate file for a recorded decision not
   to build it. Mature gate files carry these, and they usually contain a reason
   better than the one you arrived with.
3. **Measure the population before writing the check.** Count what the gate would
   fire on today, then **read every finding**. If they are false positives, the
   gate is wrong — not the codebase. A gate that cries wolf is one people learn
   to skip, and the skipping generalises to the gates that were right.

A measurement of zero is a fine result: the gate becomes a regression guard.
A measurement of sixty requires triage: it can reflect real debt, false
positives or both. The count alone does not decide which.

### When the population is large: ratchet, don't flood

A measurement in the hundreds does not mean "write a gate that fails 400 times".
After triage confirms real debt, a **ratchet** can prevent new violations
without declaring the existing ones fixed: record today’s verified violations
as a baseline, fail on **new** ones,
and let the baseline shrink. Do not baseline an unresolved critical release
risk merely to ship; keep its acceptance criterion and remediation visible.

Measured example: `@typescript-eslint/no-floating-promises` on one repo returned
**417 findings across 183 files**. As `error` it breaks the build immediately; as
`warn` it gates nothing and is ignored within a week. As a ratchet it stops the
418th on the day it is written.

The shape:

1. Enable the rule and dump today's violations to a checked-in baseline file.
2. The gate fails when a violation appears that is not in the baseline.
3. The gate **also fails when a baseline entry no longer violates** — the same
   stale-excuse rule as `KNOWN_RED`. Otherwise the baseline never shrinks.
4. Never regenerate the baseline to make a build pass. Regenerating is how a
   ratchet silently becomes a rubber stamp.

Prefer an existing, battle-tested rule over a hand-written check every time. A
config line plus a baseline beats a custom detector you will have to debug — and
this project's own history is four hand-written detectors that were wrong on
first contact with a real repo.

### Record the gates you decide NOT to build

When you conclude a gate should not exist, write that into the gate file as a
comment block in the same format as a real gate, ending with why. Something like:

```js
/* [thing] NOT BUILT, ON PURPOSE — <what already covers it>.
   Written down here because "we should gate <thing>" is a thought that recurs,
   and the next person to have it should find the answer instead of building the
   duplicate.
   <the specific reason a naive version would be WRONG — e.g. four controls are
   deliberately under the floor, measured in a real browser, so a static px gate
   fires on all four.>
   WHAT IS STILL NOT COVERED, so nobody assumes it is: <the honest gap>. */
```

This convention is worth more than most gates. A rejected-gate record answers a
recurring question permanently, and it is the only thing that stops each new
contributor — human or agent — from rebuilding the same wrong check.

## Gate shapes

One gate per bug family. Name the gate after **the family it prevents**, not the
mechanism — a future reader needs to know why it exists.

Write the comment above each gate as the incident: what shipped, what it cost,
what the gate now prevents. That comment is the reason nobody deletes the gate
in six months.

Shapes that work, by class:

| Class | Gate shape |
|---|---|
| Reachability / dead path | Parse the dispatch site; assert every handler is registered at the depth that actually runs |
| Duplicated derivation | Assert only one module computes the value; every other reference imports it |
| Cross-surface consistency | Exercise the relevant surfaces on the same inputs; shared imports are a structural guard, not proof of equal output |
| Cache / key scoping | Test account-scoped data across account changes; exempt intentionally global caches with evidence |
| Copy / i18n drift | Hash the source string per key; fail when the source changed and a locale's hash did not |
| Lifecycle | Exercise creation/disposal and verify no unintended live handlers/timers remain; document intentionally process-long resources |
| Config targeting | Assert the env var or project id resolves to the environment the build targets |
| **Gate satisfied by a comment** | Strip comments with a real lexer before the gate's own regex runs — see below |

## The gate that a comment satisfies

The nastiest failure a gate file has, because the gate reports PASS forever and
the thing it guards is gone.

Two real instances in one repo, same week:

- An owner-only exemption stripped `//` comments before testing for an owner
  check. A **block** comment describing a check that had been *deleted three
  months earlier* kept granting the exemption.
- An image-consent gate ran `/consentV/` against raw source. Three of the files
  it checked mention `consentV` in explanatory prose. Delete the real guard,
  leave the comment twelve lines above it, and the gate stayed green over
  Art. 9 special-category health data.

Both were proven by injection — remove the guard, confirm the gate still passes —
which is the only way to know a gate is not decoration.

**Do not ship this as a scanning gate.** Measured on those two files: a detector
for "regex tested against raw file contents" found **54 hits, of which 2 were
bugs.** Most raw-source tests are correct — a check looking for `readFileSync`
calls, or matching a version label, genuinely wants the literal text. A gate at
that precision is one people learn to skip.

For named security-critical checks, run the actual gate on controlled copies
of its production input. Remove the executable guard while leaving line and
block comments naming it; require failure for the intended reason. Preserve a
valid control (including valid string-literal forms) and require it to pass.
A regex checking whether the gate body mentions `decomment` or `codeOnly` is
not evidence it uses a lexer: a comment can satisfy that regex too.

Use a real lexer, not two regexes. `src.replace(/\/\*[^]*?\*\//g,'').replace(/\/\/.*$/gm,'')`
is not a scanner: a `//` inside a string (every URL) eats the rest of the line,
and a `/*` inside a string or line comment opens a block that runs to the next
close marker. Measured on one repo, that idiom deleted **128,599 characters of
live code** across 5 files — whole functions — from the views assertions ran
against. Those assertions did not fail; they looked at a hole and passed.

**Pick the right variant.** A comments-only strip keeps string literals; a
strip that also blanks literal *contents* is stronger but blinds any gate whose
pattern matches inside a string. One of the two gates above needed each:

```
sample                          comments-only   +literals
real gate, identifier form           true         true
real gate, string-literal form       true         FALSE   <- blinded
only a line comment                  false        false
only a block comment                 false        false
```

**Then prove it.** Reintroduce the original defect, run preflight, and watch the
gate go red. A gate never seen to fail is not known to work — say explicitly in
your report that you did this, or that you could not.

## `preflight verify`

Audit the gate file itself:

- Does every gate still run? A gate whose target file was renamed reports
  "skipped", and in the template that is a hard failure — confirm none are.
- Is every `KNOWN_RED` entry still red, and still tied to an open work item?
- Does the actual completion/release command execute preflight and preserve
  its failure? Check existing CI wiring too when applicable. Run a controlled
  failure through that consumer; matching a script name is not enough.

## The four laws

These are not style preferences. Each cost a production repo a shipped bug.

**1. A gate that could not run is not a pass.** Gates sit in try/catch so one
broken gate cannot take out the run — but routing that catch to a warning lets a
gate switch *itself* off while the run still exits 0. That shipped: renaming one
file turned a parity gate into "check skipped" and preflight printed PASS. In
this template a skip is a **hard** failure.

**2. Snapshot before you regenerate.** If a gate compares a generated artifact
against its source, read the artifact from disk *before* any step regenerates
it — otherwise it compares the generator against its own output and is green
forever. That shipped two consecutive stale releases.

**3. A known-red excuse that now passes is a failure.** Track deliberate
failures in `KNOWN_RED`, keyed by bare gate id, each naming an open work item —
and fail the run when a tracked gate starts passing. A stale excuse is how a
real failure gets waved through.

**4. A gate never seen to fail is not known to work.** Prove every new gate by
reintroducing the defect.

## What not to do

- Do not add six gates at once. An unwanted gate gets disabled, and a disabled
  gate teaches the team that gates are noise.
- Do not gate what a typecheck already catches. Gate what survives it.
- Do not let preflight become slow enough to skip. Keep it offline and parallel;
  anything touching the network belongs behind an explicit flag.
- Do not silence a red gate by loosening it. Track it in `KNOWN_RED` with the
  work item, or fix it.
