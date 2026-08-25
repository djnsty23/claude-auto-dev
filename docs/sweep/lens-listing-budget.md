# Lens: dead weight, glob scope, and the elision mechanism

**Tree:** `<repo root>`, branch `chore/skill-layer-a1`, HEAD `1f1d7cd`, `VERSION`
8.115.0. Naming the tree because `plugins/` differs from the installed cache:
HEAD~1 (`7435ca0`) cut six skills that the installed 8.115.0 still ships, and this
tree adds `phase`, which the installed build lacks. Every listing observation
below is therefore about the **installed** build; every frontmatter observation is
about **this tree**.

**Population scanned:** 58 `SKILL.md` on disk (autodev-core 50, autodev-memory 4,
autodev-stack 4). 13 are `rule-*`; 45 are not. 6 skills carry a `paths:` glob —
four `rule-*` (`rule-agent-concurrency`, `rule-design-system`, `rule-security`,
`rule-thumb-first`) and two not (`core`, `standards`).

Prior art read first, not re-derived: `docs/sweep/survey.md` and
`docs/SKILL-LAYER-PLAN.md`. This lens adds glob-scope measurement, the
dead/unreferenced pass, and three new measurements on the elision mechanism. It
also **contradicts one prescription in the plan** — see D2 — and flags one
premise of this sweep as unverified — see E3.

Consumer repos are anonymised as Project A (vanilla JS + SQL, no TypeScript),
Project B and Project C (both React + TypeScript + SQL), Project D. This file
ships in a public repo.

---

## Part 1 — Glob scope of the six globbed skills

Populations measured with `find <repo> -name <pat> -not -path '*/node_modules/*'`
across five real trees. Reading the numbers is the point: a glob is only a
reachability mechanism if files matching it exist where the skill is meant to fire.

| pattern | this repo | Project A | Project B | Project C |
|---|---|---|---|---|
| `*.workflow.js` | **1** | **0** | **0** | **0** |
| `*.tsx` | 0 | 0 | 491 | 461 |
| `*.ts` | 0 | 0 | 1220 | 910 |
| `*.css` | 0 | 36 | 24 | 5 |
| `*.sql` | 0 | 68 | 70 | 144 |
| `prd.json` | 1 | 16 | 3 | — |
| `tailwind.config.*` | 0 | 0 | 0 | 0 |

Project D was also checked for `*.workflow.js`: 0.

### G1 — `rule-agent-concurrency` · UNREACHABLE in every consumer project

Glob: `**/*.workflow.js`. Population: **one** file in this repo
(`plugins/autodev-core/scripts/heal-sweep.workflow.js`), **zero** in all four
product repos checked.

The skill governs a *session action* — how many agents to spawn, at which model
and effort, before a fan-out. Nothing about that action requires reading a file,
so no file read predicts it. The glob added in `1f1d7cd` fires only inside this
marketplace repo, and only for a session that happens to open the single
`.workflow.js` file. A session running `audit` or `heal` in Project B — the exact
moment the rule exists for — will never load it.

Verdict: the fix is nominal. It closed the shape (`user-invocable:false` + no
glob) without closing the defect.

**No honest glob exists.** Three fixes, in order of durability:

1. **Body cross-reference from the skills that actually fan out.** This is the
   only mechanism here that does not depend on the listing or on a file read.
   `audit/SKILL.md` already names `rule-agent-concurrency`; `heal`, `auto`,
   `iterate`, `auto-brain` and `brain` all dispatch agents and do not. Adding the
   line to those five is five edits and needs no new skill.
2. **Set `user-invocable: true`** so it is at least typeable. Costs nothing; the
   skill is background knowledge, but background knowledge nobody can reach is
   worse than a `/` entry nobody types.
3. Keep `**/*.workflow.js`. It is honest inside this repo and costs nothing.

### G2 — `rule-design-system` and `rule-thumb-first` fire on the same trigger

| skill | glob |
|---|---|
| `rule-design-system` (44 lines) | `**/*.tsx`, `**/*.jsx`, `**/*.css`, `**/tailwind.config.*` |
| `rule-thumb-first` (144 lines) | `**/*.tsx`, `**/*.jsx`, `**/*.vue`, `**/*.svelte`, `**/*.css`, `**/tailwind.config.*` |

`rule-design-system`'s glob set is a strict **subset** of `rule-thumb-first`'s.
In every React or CSS-bearing repo both load on the identical file read. Two
listing entries, one trigger, one subject (visual work).

Both are REACHABLE. The finding is dead weight, not unreachability:
**merge `rule-design-system` (44 lines) into `rule-thumb-first`** and delete the
directory. One listing slot recovered, zero behaviour lost — thumb-first is the
superset on both axes.

### G3 — `rule-security` and `standards` fire on the same trigger

| skill | `user-invocable` | glob |
|---|---|---|
| `rule-security` (21 lines) | false | `**/*.ts`, `**/*.tsx`, `**/*.js`, `**/*.jsx`, `**/*.sql`, `**/*.env*` |
| `standards` (113 lines) | false | `**/*.ts`, `**/*.tsx`, `**/*.js`, `**/*.jsx` |

`standards`' glob set is a strict subset again. Both REACHABLE, both fire on
every TypeScript read. Same remedy: fold `rule-security`'s 21 lines into
`standards` (or the reverse — the direction does not matter, the count does) and
recover a slot.

`standards` is also the one non-`rule-*` skill wearing rule clothes:
`user-invocable: false`, glob-triggered, no command semantics. If the merge lands,
naming the survivor `rule-security` keeps the `rule-*` convention intact.

### G4 — `core` · REACHABLE, well calibrated, no change

Glob `prd.json` + `**/prd.json`. The skill *is* the `prd.json` schema, and
`prd.json` exists in the target repos (16 in Project A, 3 in Project B). The
trigger is the file the skill documents — the only glob in the set where that is
exactly true. The apparent redundancy of listing both the bare and recursive
pattern is defensive against implementations where `**/` does not match at root;
leave it.

### G5 — Calibration note, not a defect

`rule-security` globs `**/*.ts` and `**/*.js`: 1,220 `.ts` files in Project B.
Opening one test file loads 21 lines of credential-handling rules. That is
context cost in sessions where the rule is irrelevant, not an unreachability
defect, and it is the price of the mechanism working. Recorded so it is not
re-found as a bug.

---

## Part 2 — Dead or unreferenced non-rule skills

Reference census: for each skill, the count of files outside its own directory
that name it (excluding `.git`, `node_modules`, and `docs/sweep/`).

### D1 — The plan's step A1 is half-executed

`docs/SKILL-LAYER-PLAN.md` §A1 specifies ten changes: six cuts and four converts.
`7435ca0` landed the **six cuts** (`clean`, `deploy`, `env-vars`, `fix`,
`monitoring`, `pr-review`). The **four converts** did not land.
`grilling`, `show-your-work`, `wizard` and `writing-for-agents` are unchanged.

Consequence for the falsification test A1 was designed to be: it now measures a
6-slot reduction, not 10. If the leading indicator comes back negative, that is a
weaker result than the plan assumes.

### D2 — Do NOT apply the plan's prescription to those four. It would make three of them unreachable.

The plan says: *"Set `user-invocable: false` plus a `paths:` glob, exactly as the
13 `rule-*` skills already do."* That is the wrong move for three of the four, and
this lens exists to say so.

**Current state, measured:** all four omit the `user-invocable` key entirely.
Anthropic's documented default is `true` (docs: *"Set to `false` to hide from the
`/` menu… Default: `true`"*). So today they are **REACHABLE by the typed path**
and unreachable by model matching, like every other bare-name entry.

Setting `user-invocable: false` without an honest glob converts them from
reachable-if-typed to **UNREACHABLE** — precisely the `rule-agent-concurrency`
shape this sweep exists to remove. And no honest glob exists for three of them:

| skill | what it governs | honest glob? |
|---|---|---|
| `grilling` | attacking the premise of a plan before building | **No.** A plan is a conversation, not a file type. |
| `show-your-work` | opening a decision trail at the start of unattended work | **No.** The trigger is a moment, not a read. |
| `wizard` | a tool error that names a human decision (pick a browser, enter a credential) | **No.** The trigger is an *error string*, and no glob sees stderr. |
| `writing-for-agents` | writing a `SKILL.md`, `CLAUDE.md`, `AGENTS.md`, or a subagent brief | **Yes.** Those are files a session genuinely opens. |

**Recommended instead:**

- `writing-for-agents` → `user-invocable: false` **plus**
  `paths: ["**/SKILL.md", "**/CLAUDE.md", "**/AGENTS.md"]`. Honest and it fires:
  this repo alone holds 58 `SKILL.md` and a `CLAUDE.md`, and every consumer repo
  has a `CLAUDE.md`. This is the one convert that should proceed as planned.
- `grilling`, `show-your-work`, `wizard` → set `user-invocable: true`
  **explicitly**. Two reasons beyond the reachability one: the current behaviour
  rests on an undocumented default, and this repo's own validator does not require
  the field, so nothing here would notice if the default changed upstream. If the
  listing budget still needs slots after the merges in G2 and G3, these three are
  the next honest cut candidates — but cut them, do not silently strand them.

`wizard` is the strongest keep of the three: its body records a session that
retried the same browser error from 10:14 to 12:24 without asking. That is a
measured, expensive failure and the skill is the antidote. Do not bury it behind
a glob that cannot fire.

### D3 — Genuinely thin reference counts

| skill | referenced by |
|---|---|
| `memory-backup` | `CHANGELOG.md` only |
| `writing-for-agents` | `CHANGELOG.md`, `docs/SKILL-LAYER-PLAN.md` |
| `memory-maintenance` | `CHANGELOG.md`, `README.md`, one RFC |

Not dead code — all three are `user-invocable: true` (or default) and typeable —
but nothing in the skill layer routes to them. A body cross-reference from a
sibling is cheaper than any listing fix and is the mechanism G1 recommends.

### D4 — No dead pointers, and the reference-file discipline holds

Every `${CLAUDE_PLUGIN_ROOT}/…` path named in a non-rule `SKILL.md` resolves to a
file that exists: **0 dead pointers across 45 non-rule skills.** Six skills carry
a `references/` directory (`audit`, `auto`, `design`, `setup-project`, `doppler`,
`supabase`), which is the load-on-demand pattern the plan recommends for merges.
Nothing to fix here — recorded because "is any of this dead" was the question, and
the answer for this axis is a clean no with a named population.

---

## Part 3 — The elision mechanism itself

Three measurements, none of which appear in `survey.md` or `SKILL-LAYER-PLAN.md`.

### E1 — F2 reproduces in a fresh session

Read directly out of this agent's own skill listing: **55** `autodev-core`
entries, of which exactly **3** carry any description — `brain`,
`rule-diagnosis`, `rule-thumb-first` — and **52** arrive as bare names.

Identical to the plan's F2. Same installed build, different session, so this is
corroboration of stability rather than an independent source. Stated as such.

Note one disagreement with `survey.md`, which reported `rule-agent-concurrency` as
carrying a description in its session. It does not in this one. If both readings
are accurate the surviving set moves between sessions, which is what a
usage-ranked drop would do for a skill invoked minutes earlier by the commit that
fixed it. Flagged as an observation, not a finding — the alternative explanation
is a misread, and one report each is not enough to separate them.

### E2 — A `paths:` glob does NOT protect a listing entry

This is the measurement that matters most for the rest of the sweep, because
every proposed fix so far has been "add a glob".

Of the **6** globbed skills in the installed build, **1** kept its description
(`rule-thumb-first`). `rule-agent-concurrency`, `rule-design-system`,
`rule-security`, `core` and `standards` were all bare names **despite carrying
globs**. Meanwhile `rule-diagnosis`, which has **no** glob, kept its full
description.

Glob status and listing survival are uncorrelated. A glob is a *separate channel*
with its own precondition — a matching file must be read — not an exemption from
elision. Any recommendation that treats "add a glob" as restoring discoverability
is wrong on this evidence.

### E3 — The docs describe `paths` as a RESTRICTION, not a trigger. This sweep's premise (b) is unverified.

Verbatim from the Anthropic skill-frontmatter reference:

> `paths` … Glob patterns that **limit** when this skill is activated. … When set,
> Claude loads the skill automatically **only when** working with files matching
> the patterns.

Two readings are open:

- **R1 (this sweep's premise):** a glob is an *additional* auto-load trigger.
- **R2 (the doc's literal wording):** a glob *narrows* the existing
  model-invocation channel to sessions touching matching files.

Under R2, `1f1d7cd` made `rule-agent-concurrency` **less** reachable, not more —
from "the model may load it whenever it judges relevant" to "only in a session
touching a `*.workflow.js` file", of which consumer repos have zero (G1).

I could not discriminate R1 from R2 from here: doing so needs a live session that
reads a matching file and reports whether the skill body arrived, and this is a
non-interactive run. **CANNOT-TELL, and it decides real work** — six skills plus
today's fix rest on it. Resolve it with one interactive probe before any further
glob is added as a remedy.

Under either reading the conclusion for G1 is the same: the rule does not reach a
session fanning out agents in a product repo.

### E4 — The repo's own unreachability gate is structurally incapable of firing

`tooling/validate.js:230`:

```js
if (String(fm['user-invocable']) === 'false' && String(fm['disable-model-invocation']) === 'true') {
```

`disable-model-invocation` occurs **0 times** across the entire `plugins/` tree
(`grep -rn "disable-model-invocation" plugins/ | wc -l` → `0`). The conjunction
can never be true, so this check has never fired and cannot. `validate` passed on
a tree carrying **9** skills in the real defect shape.

The adjacent check at `validate.js:225` gates a narrower case — `when_to_use`
saying "Always-on" with no glob — and only 3 skills still make that claim
(`rule-design-system`, `rule-security`, `rule-thumb-first`), all of which do carry
globs, so it is green too.

**Fix:** change line 230's second clause to `!hasPathTrigger` (the variable is
already computed four lines above for the Always-on check), so the condition
becomes `user-invocable:false && no paths glob` — the shape that actually strands
a skill. Then mutation-test it: strip the glob from `rule-thumb-first`, confirm
**that** check fires by name, revert. A gate added for this defect class and never
made to fail is the same defect one layer up, and this repo ships
`rule-gate-integrity` about exactly that.

Expected first run against this tree: 9 findings (`rule-ab-testing`,
`rule-diagnosis`, `rule-file-organization`, `rule-gate-integrity`,
`rule-local-first`, `rule-options-protocol`, `rule-ramifications`,
`rule-verification`, `rule-windows`). Triage them; do not tune until quiet.

### E5 — Trimming descriptions is not a lever, confirmed from a second direction

The per-skill cap is documented: combined `description` + `when_to_use` is
truncated at **1,536 characters** in the skill listing. Measured across all 58
skills in this tree, the longest combined field is **559 characters** (`spec`),
then `auto-brain` 557, `grilling` 523, `phase` 510, `wizard` 509. Nothing is
within 2.7× of the cap.

So per-skill truncation is not happening at all, and the elision observed is
whole-entry dropping. This reaches the plan's F3 conclusion by a different route:
F3 argued from *which* entries survived, this argues from the cap never being
approached. Two independent arguments, same answer — shortening text cannot help.

---

## Verdicts

| item | verdict | mechanism |
|---|---|---|
| `rule-agent-concurrency` | **UNREACHABLE** in any consumer project | glob matches 0 files outside this repo; description elided |
| `rule-design-system` | REACHABLE | glob (`.tsx/.jsx/.css`) fires abundantly — but duplicate of thumb-first |
| `rule-security` | REACHABLE | glob (`.ts/.js/.sql`) fires abundantly — but duplicate trigger with `standards` |
| `rule-thumb-first` | REACHABLE | glob fires; also the 1 of 6 globbed skills whose description survived |
| `core` | REACHABLE | glob is the file the skill documents; present in target repos |
| `standards` | REACHABLE | glob fires; subset of `rule-security`'s |
| `grilling` | REACHABLE only if typed | `user-invocable` defaults true; description elided; no honest glob |
| `show-your-work` | REACHABLE only if typed | same |
| `wizard` | REACHABLE only if typed | same; trigger is an error string, which no glob sees |
| `writing-for-agents` | REACHABLE only if typed | same, but an honest glob exists |
| 41 other non-rule skills | REACHABLE only if typed | `user-invocable: true`, description elided |
| dead script pointers | none | 0 of 45 non-rule skills |
| `validate.js:230` gate | **VACUOUS** | conjunct occurs 0 times in the tree |

Counting strictly — unreachable by both mechanisms, in the environment the skill
is meant to serve — this lens found **1** (`rule-agent-concurrency`, G1) plus
**1 vacuous gate** (E4), and it blocks **3** more from being created (D2).

## Recommended actions, all removals or frontmatter fixes

1. **Fix `validate.js:230`** to `user-invocable:false && !hasPathTrigger`, then
   mutation-test it. Highest leverage: it is the thing that would have caught all
   nine, and it prevents the next one.
2. **Merge `rule-design-system` → `rule-thumb-first`** (subset glob, same
   subject). Deletes one directory, one listing slot.
3. **Merge `rule-security` ↔ `standards`** (subset glob, both `user-invocable:
   false`). Deletes one directory, one listing slot.
4. **`rule-agent-concurrency`**: `user-invocable: true`, keep the glob, and add
   the body cross-reference to `heal`, `auto`, `iterate`, `auto-brain`, `brain`
   (`audit` already has it).
5. **`writing-for-agents`**: `user-invocable: false` +
   `paths: ["**/SKILL.md", "**/CLAUDE.md", "**/AGENTS.md"]`. The one plan convert
   that is honest.
6. **`grilling`, `show-your-work`, `wizard`**: set `user-invocable: true`
   explicitly. Do **not** apply the plan's glob conversion. Cut candidates later
   if slots are still short.
7. **Before adding any further glob as a fix**, run one interactive probe to
   settle E3 — read a matching file, check whether the skill body arrived.
