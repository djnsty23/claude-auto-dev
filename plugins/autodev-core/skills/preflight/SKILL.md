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
one: `scripts/preflight.js`, run before every deploy and in CI, failing the
build on the bug families this project has actually shipped.

Prose rules do not move the number. Two of the repos this framework was measured
against carry 526- and 593-line `CLAUDE.md` files and have the **worst**
fix-per-feature ratios. Gates that fail a build are what changes outcomes.

## `preflight init`

1. **Find out what to gate.** Run `/learn-from-fixes` first. Gate the top two or
   three classes for *this* repo, not a generic list. If the user insists on
   starting without that analysis, gate only `syntax` and `gates-ran` and say
   plainly that the rest is guesswork until there is history to read.

2. **Copy the template** to `scripts/preflight.js`:

   ```bash
   cp "${CLAUDE_PLUGIN_ROOT}/templates/preflight.js" scripts/preflight.js
   ```

3. **Wire it so it cannot be forgotten** — the template fails if you do not:

   ```json
   { "scripts": { "preflight": "node scripts/preflight.js" } }
   ```

   Add it to CI, and to the deploy ritual ahead of any build step.

4. **Run it.** It should fail the first time, on `gates-ran`, until wiring is
   done. That failure is the template proving itself.

## `preflight add <class>`

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
| Cross-surface consistency | Assert the surfaces showing one value import the same function |
| Cache / key scoping | Assert every cache key includes the account/tenant dimension |
| Copy / i18n drift | Hash the source string per key; fail when the source changed and a locale's hash did not |
| Lifecycle | Assert each `addEventListener` / `setInterval` / `requestAnimationFrame` has a teardown in the same module |
| Config targeting | Assert the env var or project id resolves to the environment the build targets |

**Then prove it.** Reintroduce the original defect, run preflight, and watch the
gate go red. A gate never seen to fail is not known to work — say explicitly in
your report that you did this, or that you could not.

## `preflight verify`

Audit the gate file itself:

- Does every gate still run? A gate whose target file was renamed reports
  "skipped", and in the template that is a hard failure — confirm none are.
- Is every `KNOWN_RED` entry still red, and still tied to an open work item?
- Is preflight still referenced by CI and by a package script?

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
