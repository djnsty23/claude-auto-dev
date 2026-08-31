---
name: phase
description: Name the phase of app-building you are in and get the two or three sentences that matter for it, plus the skills that already exist for that phase. Use at the start of a phase, or when work has drifted and it is unclear which phase it is in.
when_to_use: "Invoked when the user says a phase keyword (spec, design, build, verify, ship, audit) or asks \"what phase are we in\", \"how should we start this\", or starts a new stretch of app-building work."
allowed-tools: Bash, Read, Grep, Glob
model: opus
user-invocable: true
argument-hint: "[spec | design | build | verify | ship | audit]"
---

# Phase

One keyword, two or three sentences, and the skills that already exist for it.

## Why this exists

`[measured 2026-08-25]` Across **558 transcripts over seven days**, **4 of this
plugin's 45 user-invocable skills fired at all.** The other 41 fired zero times.

The split matters more than the total. Of those four, exactly **one** was reached
by the model choosing it (`rule-diagnosis`, once). The other three were reached
only because a person typed a slash command: `brain` 17 times, `audit` 11,
`auto-brain` 3. A few skills are reachable by hand; the model-initiated channel
is effectively dead. Those are different problems with different fixes.

An earlier version of this paragraph said "exactly one of 37 invocable skills".
That read only the Skill-tool channel and missed slash commands entirely, which
is the same defect this file is about: a measurement that answers a neighbouring
question and gets reported as the whole picture.

They are not bad skills. They are unreachable ones: a skill nobody remembers to
invoke is indistinguishable from a skill that does not exist, and the same
sessions spent that week re-deriving things those skills already encode.

The fix is not more skills. It is a **cheap entry point**: a word you can say
without deciding anything, which then names what matters now.

## The phases

Each is: the two or three sentences that actually change the work, then the
skills that already exist for it. Read the sentences; invoke the skills only if
the work warrants it.

---

### `spec`: before anything is built

**Name the constraint, the deadline, what already exists, and the success
criterion before proposing anything.** State the verifiable success criterion
*before* writing code, because a criterion invented afterwards is a description
of what you happened to build. And research anything that depends on external
behaviour (API caps, SDK versions, endpoints) rather than reasoning from
internal consistency, which is not correctness.

Existing: `spec`, `brainstorm`, `framework-radar`, `wizard`, `setup-project`

---

### `design`: before any UI change

**Publish options before implementing, and ground every variant in the code
first**. Reading it once surfaced an already-built, never-wired component that
turned a build task into a wiring task. Carry the surface's own invariants into
every option; an option that silently breaks a rule the codebase already encodes
is not a real option. Mockups are authoritative about **surface**, meaning palette,
type, layout and motion, and **silent about mechanism**: navigation,
information architecture, state.

Existing: `design`, `/design` (the canvas), `artifact-design`, `a11y`,
`rule-design-system`, `rule-thumb-first`

---

### `build`: while writing it

**Touch only what was asked; clean up what your change orphans and mention the
rest rather than fixing it.** A bug is a family. On finding one, grep the value,
the inverse, and the adjacent concept before calling it fixed. Fix the EVENT
rather than the path in front of you, and scope the test to the event too,
because a test bounded by your diff is a test that agrees with you.

Existing: `auto`, `refactor`, `migrate`, `iterate`, `heal`

---

### `verify`: before claiming it works

**Answer three questions of every probe: which build did it read, which surface,
and which user state.** If any answer is "I assumed", the probe has not run yet.
Ask them of a FAILURE too. A red gets acted on without scrutiny, and a change
made to working code is worse than the nothing a false green produces. Validate
every "none found" against a known positive, and print the population beside the
count.

Existing: `test`, `preflight`, `review`, `grilling`, `show-your-work`,
`rule-verification`, `rule-gate-integrity`

---

### `ship`: releasing it

**Run the gate locally and read its exit status from the process, never through
a pipe**. A pipeline reports its last stage, so red reads as green. Re-read the
version immediately before bumping rather than when you started; in a shared
clone it moves under you. Verify the deploy on the live surface with a
known-negative control, because a green "already up to date" describes a version
number rather than the code behind it.

Existing: `ship`, `commit`, `preflight`, `rule-local-first`

---

### `audit`: looking for what is wrong

**A green gate is a claim, not evidence, so mutation-test it.** A gate can be
structurally incapable of firing, and that is invisible in the source because
you read filters one at a time while the emptiness lives in their intersection.
Every detector must demonstrate a hit on a known positive before its zero is
believed, and it must print what it scanned: a report showing only a verdict is
indistinguishable from a finder that returned nothing.

Existing: `audit`, `scan`, `security`, `heal`, `perf`, `seo`,
`learn-from-fixes`

---

## How to use it

Say the keyword. That is the whole interface. The point is that it costs
nothing to reach for, because the measured failure was not bad judgement about
which skill to use, it was never reaching for one at all.

If the phase is unclear, that is itself the finding: work that cannot be placed
in a phase is usually work that skipped `spec`.

## Keep this honest

The sentences above are the ones that have actually changed an outcome on this
machine, not a summary of good practice. When a phase's advice stops earning its
place, cut it. A phase carrying six sentences is one nobody reads, and this
file becomes another skill that never fires.

**Re-measure rather than trusting this.** Invocation is countable, and there is
a script for it that reads both channels, separates auto-loaded `rule-*` hits
from chosen ones, prints the population it scanned, and refuses to report a zero
total as a finding:

```bash
node plugins/autodev-core/scripts/analyze-skill-invocations.js --days 30
```

**Do not hand-roll a grep for this.** The obvious one-liner greps `"skill":"..."`
and that is the Skill-tool channel only. A person typing `/autodev-core:brain` is
recorded as a `<command-name>` block instead, so the naive count reports zero for
a skill invoked seventeen times. That is exactly how the first version of the
paragraph above came out tenfold too low.

If this skill is not in that output a month from now, it failed the same way the
other 41 did, and the answer is not to write a 46th.
