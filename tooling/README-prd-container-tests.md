# prd.json container + archive keep-list — tests

Three test files for `tooling/`, written 2026-08-29 by a session that did not
write the fix they cover. Two of them are new coverage axes; one is a
regression test for a bug that is now fixed.

All three run from `tooling/` with no arguments and no environment:

```bash
node tooling/test-prd-container-class.js
node tooling/test-archive-keeplist-prose.js
node tooling/test-nested-sprints.js
```

Against `main` at v8.141.0 they are **20/0**, **10/0**, **5/0**.

Each takes an env var to point at a different tree — `AUTODEV_PLUGINS` for the
first and third, `AUTODEV_ROOT` for the second — so you can run them against an
installed marketplace or a candidate build without editing anything. That is how
each was verified red-then-green.

---

## What each one is for

### `test-prd-container-class.js` — the container, across all readers

`prd.json` has two documented story containers (`auto/SKILL.md:127-129`):

```
Flat:   { stories: { "S1-001": {...} }, sprint: "sprint-1" }
Nested: { sprints: [{ id: "sprint-1", stories: { "S1-001": {...} } }] }
```

Five call sites read it. Before #85, four of them handled only the flat shape,
so a nested file made them see **zero stories** — the Stop hook then ended `auto`
on a full sprint, and `session-start` injected "0 done, 0 pending, 0 FAILED".

**The invariant is deliberately not "all five report the same number."** The
sites answer different questions — `isActionable` vs `isOutstanding` vs
per-state counts — so a shared expected value would encode this file's
re-derivation of each site's predicate, and a test that re-derives its subject
agrees with the derivation rather than with reality. Instead each site is its own
oracle:

```
for every site:  observable(nested) === observable(flat)
```

The predicate cancels; only the container is under test. This file never asserts
what any site *should* count and so cannot be wrong about it.

It also asserts the **multi-sprint** case: a nested file must read the same as
the flat file holding the union of its sprints. That is what pins
flatten-all-sprints over last-sprint-only, which the one-line contract in
`auto/SKILL.md` does not settle. It is not decoration — an implementation using
`sprints.at(-1)` reports `actionable: 0` on a file with pending work in an
earlier sprint, and the Stop hook approves the stop. Same silent approval as the
original bug, narrower trigger.

All five sites are **driven**, none are grepped. A static check on the container
expression would be the defect this file hunts. `drift-audit` is
config-dir-agnostic, so a sandboxed `HOME`/`CLAUDE_CONFIG_DIR` makes it discover
one fixture repo, and a single run exposes both its call sites separately.
`memory-session-end` (a different plugin) runs real and unmodified with only its
two collaborators stubbed.

### `test-archive-keeplist-prose.js` — the archive KEEP enumeration

Archiving is **prose an agent follows**, not a script. `isArchivable()` is well
covered by `test-prd-states.js` and `test-archive-prd.js` — mutating it to
re-archive `needs-setup` is killed by both. But step 2 of the skill carries its
own enumeration beside the helper's name, and *that* is what the agent acts on:

```
- KEEP: everything else — null, false, "deferred", "needs-setup",
        a MISSING passes key, any unrecognised value, and type="qa"
```

Deleting the two words `"needs-setup",` leaves `isArchivable()` still named, the
banned two-bucket prose still absent, and PROVE still before CREATE — all three
existing doc pins pass, and `test-prd-states`, `test-archive-prd` and
`test-skill-prd-commands` all stay green. One word, reads as tidying, and it
restores the exact condition of the incident that silently deleted stories
waiting on the operator.

The property is **derived**, not hardcoded:

```
for every state the helper will not archive, the prose names it
```

from `prd-states.VALID` and `isArchivable()`, plus the two non-VALID
non-archivable classes (missing key, unrecognised value). Hardcoding the state
list would leave state N+1 exactly as exposed as `needs-setup` was as the fifth,
which is the mistake that generated this whole family.

**Known limit, stated rather than implied:** this proves the prose *names* every
state. It does not prove an agent *buckets* correctly. While the procedure is
prose, no gate closes that — `test-archive-prd`'s own header says so. The real
fix is an archive script the prose calls; that is a design decision, not a
fixture.

### `test-nested-sprints.js` — regression test for the original bug

The narrow, behavioural reproduction: against a nested file the Stop hook
announced "Sprint complete" and, one turn later, returned `{"decision":"approve"}`
and deleted `.claude/auto-active`, ending auto mode with four stories still
actionable. Red before #85, green after. Keep it alongside the class test — it
asserts the damage, the class test asserts the property.

---

## Two guards, in every file. Treat a failed guard as a failure.

Both fired on the author's own instruments before they found anything real.

**NON-VACUITY** — the baseline run must find real work, or `nothing === nothing`
reports as agreement. A missing KEEP clause fails loudly instead of passing every
"is this named" check by default.

**LIVENESS** — each probe runs against a second, different baseline and must
return something *different*. A probe whose regex never matches is a constant,
and a constant agrees with itself in every variant. Two probes were dead on first
run: one regex missed the richer fixture because the status line only appends
", N blocked on setup" when such a story exists, and one drift fixture edited only
the last sprint so its observable never changed.

A dead or vacuous probe is reported `UNTESTED` and **counted as a failure**,
never as a pass.

---

## What is NOT here, and who has it

- **The archive destination path** and the recovery instruction — a separate
  concern (`.claude/archives/` is gitignored and an archive file was lost that
  way). These tests are indifferent to where the archive is written; they assert
  step 2's enumeration, not step 4's path. The two cannot collide.
- **The fix for the container bug** — shipped as #85 in v8.141.0. Written by a
  different session, deliberately: a test written by the session that wrote the
  fix, from the same reading, agrees with the fix rather than with reality.

## One thing worth knowing about how these were verified

The author's own reference fix for the container bug used `sprints.at(-1)` and
was **wrong** — it reproduced the original silent approval with a narrower
trigger. The shipped fix flattens all sprints and is right. The author found this
by building the separating case rather than by defending the patch.

Separately, the first multi-sprint run reported `drift-audit.js:280` as FAILING
on correct code. That was the harness: its fixture generator edited only
`sprints[last].stories`, so earlier-sprint stories never changed across the
scanned history and resolved to a null age. **The same wrong assumption was in
both the patch and the test that was supposed to catch it.** A probe can carry
the very defect it hunts, which is why the liveness guard exists and why a green
from an unguarded probe is a claim about the probe.
