# FINDINGS — skill reachability, one ordered work list

**Tree:** `<repo root>`, branch `chore/skill-layer-a1`, HEAD `1f1d7cd`, `VERSION` 8.115.0.
Naming the tree because two of the skills discussed here are untracked and exist in no
other checkout. `ls plugins/autodev-core/skills/ | wc -l` -> **51** dirs here; 59 `SKILL.md`
across all three plugins.

**Revised after an adversarial pass.** Seven objections were raised; five changed the work,
two were rejected. Every objection is recorded in **§A — Objections, judged** with the probe
that settled it, so the next session does not re-raise them. One objection was strengthened
rather than accepted as stated: the evidence against F1's premise is worse than the attacker
argued, and it re-ordered the list.

---

# THE WORK LIST, IN ORDER

Items 1-7 ship as **one commit** — F2 turns `npm run validate` red until the globs land.
Everything after item 7 is independent.

| # | Item | Change | Post-attack status |
|---|---|---|---|
| 1 | **F2** | `tooling/validate.js:230` — replace the dead second conjunct with `!hasPathTrigger`. One token. Mutation-test by name. | **unchanged** — the only item both sides call sound |
| 2 | **F4** | `rule-verification`: `paths: [prd.json, **/prd.json]` | **amended** — ship both patterns, not just the recursive one |
| 3 | **F9** | `rule-file-organization`: bare + recursive `prd.json`, plus `.claude/**` | **amended** — same |
| 4 | **F5** | `rule-gate-integrity`: detector + test-source globs | unchanged |
| 5 | **F6** | `rule-local-first`: workflows globs + launch.json + PUBLISH-QUEUE.md | **amended** — workflows is the load-bearing line, not PUBLISH-QUEUE |
| 6 | **F8** | `rule-ramifications`: component extensions only | unchanged |
| 7 | **F7** | `rule-windows`: **`**/*.ps1` only** | **amended** — `.mcp.json` cut, `launch.json` ceded to F6 |
| 8 | **F14** | Correct `docs/rules.md` and `CHANGELOG.md:2715` | unchanged |
| 9 | **F10** | `rule-ab-testing` partial glob (withdrawn if R1 lands) | unchanged |
| 10 | **F11** | `rule-diagnosis`: cross-refs in `heal`, `audit`, `review`, `phase` | **amended** — the `user-invocable: true` half loses its stated reason |
| 11 | **F1** | `rule-agent-concurrency`: five cross-refs, keep the glob | **demoted from #1** — its ranking rested on a premise now refuted |
| 12 | **F13** | `grilling`, `show-your-work`, `wizard`: explicit `user-invocable: true` | unchanged |
| 13 | **F12** | `writing-for-agents`: convert + glob | unchanged |
| 14 | **R2** | Merge `rule-design-system` into `rule-thumb-first` | **amended** — six files, not two |
| 15 | **R3** | **Do NOT merge.** Drop `standards`' glob, set `user-invocable: true`, keep the directory | **replaced** — the merge would break an agent dependency |
| 16 | **R4** | `rule-options-protocol`: option 1 only (`user-invocable: true`) | **amended** — a third cost found for the cut |
| 17 | **R1** | Merge `rule-ab-testing` into `rule-diagnosis` | unchanged, lowest value |
| 18 | **F3** | The D1 probe | **blocked** — needs an interactive session; not a precondition |

**Do item 1 first**, with items 2-7 in the same commit.

---

# §A — Objections, judged

Seven raised. Written down so they are not re-raised: a rejected objection with no record
is an objection that returns.

### A1 — "R3 kills `standards`, which is a declared agent dependency" — ACCEPTED, R3 replaced

Confirmed. `plugins/autodev-core/agents/code-reviewer.md:12` lists `standards` under
`skills:`, and `grep -rn "standards"` finds **12 body references** across `a11y` (1),
`audit` (6), `design` (2), `review` (1) and `autodev-init` (2). Deleting the directory
breaks the agent's declared dependency silently — an agent that cannot resolve a named
skill does not error, it runs without it.

The glob claim also checks out: `standards`' four extensions are a strict subset of
`rule-security`'s, which adds `**/*.sql` and `**/*.env*`.

**But the proposed replacement is incomplete.** Dropping the glob from a
`user-invocable: false` skill produces exactly the shape F2's repaired gate fires on. The
correct change is both halves: drop the four glob lines **and** set `user-invocable: true`.
`standards` keeps a live delivery route — 12 body refs plus the agent dependency — so route
(c) genuinely carries it where it does not carry the nine.

### A2 — "R2's `rule-design-system` is cross-referenced by four skills" — REJECTED as fatal, accepted as scope

`grep -rn "rule-design-system" plugins/` returns **four files**: `a11y/SKILL.md:41`,
`phase/SKILL.md:61`, `review/SKILL.md:77`, `standards/SKILL.md:68`. The list of names is
correct.

It does not kill R2. A merge rewrites those four lines to name `rule-thumb-first`: four
one-line edits, not a blocker. What it does kill is the earlier framing of R2 as a two-file
change. **R2 survives as a six-file change.**

### A3 — "F4/F9 ship only `**/prd.json` while the doc keeps core's bare form" — ACCEPTED

A genuine internal contradiction. This document's own clean-list keeps `core`'s duplicate
`prd.json` + `**/prd.json` as defence against implementations where `**/` does not match at
root — and then F4 and F9 prescribe the recursive form alone. If that defence is real, F4
and F9 miss the only `prd.json` that exists. If it is not real, `core` should be simplified.
Ship both patterns in both skills. It costs one line each and cannot be wrong.

### A4 — "F7's `.mcp.json` fires nowhere" — ACCEPTED, and the fix differs from the one proposed

Measured across five repos, `node_modules` excluded:

| repo | `.mcp.json` | `*.ps1` | `.claude` launch.json | `.github/workflows` |
|---|---|---|---|---|
| Project A (PWA, no TS) | 0 | 0 | 11 | 9 |
| Project B (React/TS) | 0 | 0 | 0 | 3 |
| Project C (React/TS) | 0 | 0 | 0 | 5 |
| Project D (React/TS) | 0 | 28 | 4 | 7 |
| autodev (this repo) | 0 | 2 | 1 | 1 |

`find -name '*mcp.json'` also returns 0 everywhere, so this is not a hidden-file artifact.
The line this document called "the highest-value line in the file" fires in **0 of 5** repos.
That framing is struck.

**Ship `**/*.ps1` alone**, which is the proposed conclusion reached for a different reason.
`*.ps1` covers 2 of 5. `launch.json` covers 3 of 5 and is better, but F6 already claims it,
and two skills on one read is the cost F5 and F8 spend paragraphs avoiding. Cede it to F6.

### A5 — "F6's PUBLISH-QUEUE.md is a circular trigger" — REJECTED

The circularity is real and it does not matter. `PUBLISH-QUEUE.md` exists in **2 of 5** repos
(Projects A and D, 9 copies each across worktrees), not 1 of 3. More to the point,
F6 carries four globs and the `.github/workflows` pair fires in **5 of 5**, 25 files total.
That line carries F6 on its own.

What survives is a ranking correction, not a refutation: `PUBLISH-QUEUE.md` is the weakest of
F6's four lines and should not have led the item.

### A6 — "F1/R4's 'an invoked skill keeps its description' is inferred from n=2" — ACCEPTED, and the evidence is worse than stated

This was under-argued. The premise is not weakly supported, it is **contradicted**, by this
session's own skill listing:

- Of the three autodev-core skills that **keep** a description — `brain`, `rule-diagnosis`,
  `rule-thumb-first` — **two are `user-invocable: false`.** Verified in their frontmatter.
- `grilling`, `show-your-work`, `wizard` and `writing-for-agents` **omit** `user-invocable`
  entirely, so they default to `true`, and all four arrive as bare names.

Four default-true skills elided, two invocable-false skills preserved. The correlation runs
opposite to the claim. **`user-invocable: true` does not preserve a listing description**,
and every sentence asserting it is struck from F1, F11 and R4.

Those changes survive on the other half of their justification: `user-invocable: true` is
what makes a skill typeable by the *user* as a slash command. That is a real lever and the
elision does not touch it. What does not survive is F1's claim to be "the only lever in this
sweep that touches mechanism (a)" — nothing here touches mechanism (a) — which was the entire
reason F1 ranked first. It is now item 11.

### A7 — "R4's cut breaks `tooling/check-runtime.js:135`" — ACCEPTED, additive

Confirmed verbatim at `check-runtime.js:134-135`: a content marker asserting
`skills/rule-options-protocol` exists, applied to every version at or above 8.74.0. Cutting
the skill makes that marker report missing on every installed build. A third cost of option
2, alongside the consumer-reliance question. It does not change the recommendation, which was
already option 1.

---

# §B — Two facts measured during the attack that change earlier readings

**B1 — the elision drops DESCRIPTIONS, not entries. The REMOVALS preamble is wrong.**
All 51 autodev-core skills appear in this session's listing **by name**, every `rule-*` one
included. Only the description is missing. The REMOVALS preamble below states that "the
elision is whole-entry dropping and the only lever is entry *count*". Measured here, it is
not.

That makes REMOVALS weaker still, not stronger: merging two skills recovers a listing *slot*
that was never the constrained resource. **Removals are for coherence only.** It also means
the nine are not unreachable in the strong sense. They are undiscoverable — the model can
invoke any of them by name and cannot tell what they do — which is the defect worth fixing
and is exactly what the cross-reference items (F1, F11) and F14 address.

**B2 — this session's listing is an older installed build, which caveats N3.**
The listing contains `fix`, `clean`, `deploy`, `env-vars`, `monitoring` and `pr-review`, and
`ls plugins/autodev-core/skills/` confirms **none of the six exists in this tree** (cut in
`7435ca0`). It also lacks the two untracked skills. So the listing reflects the installed
marketplace build, not this branch.

N3's reading still holds for what it measures: which descriptions survive elision, in the
build that is installed. It is **not** a reading of this branch's frontmatter and should not
be quoted as one. This is why N2 matters — a prescription written against the listing can
name a skill that no longer exists.

---

Built from `docs/sweep/survey.md`, `docs/sweep/lens-unreachable-rules.md` and
`docs/sweep/lens-listing-budget.md`. Every claim either carries a probe or is labelled a
proposal. Where the two lenses disagree, both readings are stated — see D1 and D2.

Ordered by value, not by file. **Fixes** (a glob, a pin, a flag, a gate) are separated
from **removals** (merge, cut) because they carry different risk and need different
approval. Nothing here proposes writing a new skill.

---

## Three facts measured here that neither lens has

**N1 — the population is 59, not 58, and two skills are untracked.**
`find plugins -name SKILL.md | wc -l` -> **59**. `git status --short` shows
`plugins/autodev-core/skills/phase/` and `plugins/autodev-core/skills/rule-report-shell/`
as untracked. `rule-report-shell` appears in neither lens's table. It is
`user-invocable: false` with `paths: ["**/*.html"]`, so it is **not** in the unreachable
shape — but it is a 14th `rule-*` directory, and both lenses' counts are stale by one.
`ls plugins/autodev-core/skills/ | grep -c '^rule-'` -> **14**.

**N2 — the unreachable-rules lens prescribes a cross-reference from a skill that no
longer exists.** It names `fix`, `heal`, `audit`, `review` for `rule-diagnosis`. `fix` was
cut in `7435ca0` along with `clean`, `deploy`, `env-vars`, `monitoring` and `pr-review`.
`ls plugins/autodev-core/skills/` confirms no `fix`. Re-target to `heal`, `audit`,
`review`, `phase`.

**N3 — this session is a third independent reading of the elision, and it contradicts
`survey.md`.** Read out of this agent's own skill listing: of the `autodev-core` entries,
exactly **three** carry a description — `brain`, `rule-diagnosis`, `rule-thumb-first`.
Every other one is a bare name, including `rule-agent-concurrency`, which `survey.md`
reported as carrying a description. `lens-listing-budget.md` E1 read the same three.
**Two of three sessions agree; `survey.md` is the outlier.** Treat the surviving set as
`{brain, rule-diagnosis, rule-thumb-first}` and `survey.md:130` as a probable misread.
A fourth independent reading, from the adversarial pass, returned the same three — so the
count is now three against one.

**Caveat added by B2: this listing is the INSTALLED build, not this branch.** It contains
six skills that no longer exist here. N3 measures which descriptions survive elision in the
installed marketplace build; it is not a reading of this tree's frontmatter and must not be
quoted as one.

The same reading corroborates E2 independently: `core`, `standards`, `rule-security`,
`rule-design-system` and `rule-agent-concurrency` all carry `paths:` globs and all arrive
as bare names. **A glob does not protect a listing entry.** Any fix justified as
"restores discoverability" is wrong on this evidence.

---

## D1 — The lenses disagree on what a `paths:` glob does, and it gates six items

This is the single unresolved question in the sweep.

- `lens-unreachable-rules.md` assumes **R1**: a glob is an *additional* auto-load trigger.
  Every one of its six glob prescriptions rests on this.
- `lens-listing-budget.md` E3 raises **R2**: a glob *narrows* the existing
  model-invocation channel to sessions touching matching files, and marks it CANNOT-TELL.

**I retrieved the canonical wording rather than leaving it open.** Verbatim from the
Anthropic skill-frontmatter reference (anthropic-kb chunk `id=38102`, similarity 0.767):

> `paths` | No | Glob patterns that **limit** when this skill is activated. Accepts a
> comma-separated string or a YAML list. When set, Claude loads the skill automatically
> **only when** working with files matching the patterns. **Uses the same format as
> path-specific rules.**

That last sentence is the part E3 did not have, and it cuts toward R1: path-specific
rules in Claude Code inject on a matching file read. The first two sentences are
restriction framing and cut toward R2.

**Verdict: still CANNOT-TELL, but the balance moved.** The wording is consistent with
"automatic loading happens, and is restricted to matching files", which is R1 with a
gate. It is not consistent with "a glob does nothing but narrow".

**The asymmetry that lets most work proceed anyway.** For the nine skills that are
currently unreachable — description elided, no glob — the model-invocation channel is
already dead, because the model cannot match on a description it never receives. Adding
a glob narrows a channel that delivers nothing. So under **both** readings, adding a
glob to one of the nine is non-harmful, and under R1 it is the fix.

**The one place the reading changes the answer is F1**, where a glob was added to a skill
and matches zero files in any consumer repo. Under R2 that was a regression.

Also from the same retrieval, contradicting the docs' own promise:
`user-invocable: false` is documented as *"Description always in context"* (chunk
`id=38104`). Measured, it is not. The listing budget overrides the documented contract.
Worth knowing before anyone argues from the docs that these skills are fine.

## D2 — The lenses disagree on the count of unreachable skills

`survey.md` and `lens-unreachable-rules.md` say **9**. `lens-listing-budget.md` says
**1**, counting strictly as "unreachable by both mechanisms **in the environment the
skill is meant to serve**".

Both are right about different questions. The nine are unreachable by frontmatter shape.
The one (`rule-agent-concurrency`) is unreachable *despite* having been fixed, because its
glob matches nothing where the rule applies. **Neither number should be quoted alone.**
The list below treats the nine as the population and F1 as the special case.

---

# FIXES

Frontmatter, code and flag changes. All are `git revert`-able single-file edits unless
stated. None requires approval on a deletion.

### F1 — `rule-agent-concurrency`: the glob added today matches zero files where the rule applies

- **What is unreachable:** the rule governing how many agents to spawn, at which model and
  effort — the one that measured a 5x cost overrun from inherited models.
- **Mechanism that failed:** both. Description elided (mechanism (a), confirmed in this
  session's own listing, N3). Glob is `**/*.workflow.js`, and `lens-listing-budget.md`
  Part 1 measured **1** such file in this repo and **0** in all four consumer repos
  checked. `find . -name '*.workflow.js'` here confirms the single file. Mechanism (b)
  fires only inside this marketplace repo.
- **DEMOTED to item 11 by A6.** This originally ranked first on the claim that
  `user-invocable: true` restores the listing description, making it the only lever touching
  mechanism (a). That claim is refuted — see A6. Nothing in this sweep touches mechanism (a),
  so F1 has no privileged position and drops behind the glob items, which are cheap and
  certain. What still holds: under R2 the commit that "fixed" it (`1f1d7cd`) made it strictly
  less reachable — from "the model may load it whenever relevant" to "only in a session
  touching a file type that does not exist in the target repos". A fix that closed the shape
  without closing the defect also closes the question, which is the durable point.
- **The cross-references are the whole value of this item.** Parts 1 and 2 below are close to
  free; part 3 is what changes anything.
- **Exact change**, three parts:
  1. `user-invocable: true` in `plugins/autodev-core/skills/rule-agent-concurrency/SKILL.md`
     — makes it typeable **by the user** as a slash command. It does **not** restore the
     listing description (A6), and no wording here should claim it does.
  2. Keep `paths: ["**/*.workflow.js"]`. Honest inside this repo, costs nothing outside it.
  3. Add a one-line body cross-reference from the skills that actually fan out.
     `grep -rln "rule-agent-concurrency" plugins/ --include=SKILL.md` returns only
     `audit/SKILL.md` and the skill itself. Add to `heal`, `auto`, `iterate`, `auto-brain`,
     `brain` — five one-line edits.
- **Reversible:** yes, six single-line edits, `git revert` clean.

### F2 — `tooling/validate.js:230`: the gate for this exact defect class cannot fire

- **What is unreachable:** nothing — this is the detector, not a skill. It is the item that
  would have caught all nine and prevents the next one.
- **Mechanism that failed:** the gate is structurally vacuous. Measured:

  ```js
  if (String(fm['user-invocable']) === 'false' && String(fm['disable-model-invocation']) === 'true') {
  ```

  `grep -rn "disable-model-invocation" plugins/ | wc -l` -> **0**. The second conjunct is
  never true anywhere in the tree, so the condition can never be satisfied. `validate`
  passes today on a tree carrying nine skills in the real defect shape.
- **Exact change:** replace the second clause with `!hasPathTrigger`. The variable is
  already computed four lines above at `validate.js:224` for the adjacent "Always-on"
  check, so this is a one-token edit:

  ```js
  if (String(fm['user-invocable']) === 'false' && !hasPathTrigger) {
  ```

  Then mutation-test it per this repo's own `rule-gate-integrity`: strip the glob from
  `rule-thumb-first`, confirm **that** check fires **by name**, revert. A mutation caught
  by the adjacent Always-on check proves nothing about this one.
- **Expected first run:** 9 findings — `rule-ab-testing`, `rule-diagnosis`,
  `rule-file-organization`, `rule-gate-integrity`, `rule-local-first`,
  `rule-options-protocol`, `rule-ramifications`, `rule-verification`, `rule-windows`.
  Triage every hit; do not tune until quiet. The first run is a measurement.
- **Sequencing note:** this fix turns `npm run validate` red until F4-F9 land. That is the
  forcing function, not a problem — but it means F2 and F4-F9 ship as one change or the
  tree sits red.
- **Reversible:** yes, one line.

### F3 — Settle D1 with one interactive probe before F4-F9 ship

- **What this is:** not a code change. A precondition on six items.
- **Exact procedure:** in an interactive session in a repo with a matching file, read a
  file matching an existing glob — any `*.tsx` for `rule-thumb-first`, or `prd.json` for
  `core` — then check `/context` for the skill body. Body present -> R1, glob is a trigger,
  F4-F9 are correct as written. Body absent -> R2, glob only narrows, and F4-F9 become
  no-ops that should be replaced by cross-references and `user-invocable: true`.
- **Why it is item 3 and not item 1:** F1 and F2 are correct under both readings, so they
  should not wait. F4-F9 should.
- **Cannot be run here.** This is a non-interactive session. **Proposal, not a finding.**
- **Reversible:** n/a.

### F4 — `rule-verification`: `paths: ["**/prd.json"]`

- **What is unreachable:** what counts as done per task type, and what writing
  `passes: true` means.
- **Mechanism that failed:** (a) description elided; (b) no glob. Partially alive via (c),
  referenced by `phase`, `review` and `writing-for-agents` — `grep -rln` confirms those
  three, all live and user-invocable.
- **Exact change** (amended by A3 — both patterns, not just the recursive one):

  ```yaml
  paths:
    - prd.json
    - "**/prd.json"
  ```

  The bare form is not redundant. This document's own clean-list keeps `core`'s duplicate as
  defence against implementations where `**/` does not match at root; shipping only the
  recursive form here contradicted that and would miss the only `prd.json` that exists.
- **Why it ranks highest of the glob fixes:** the most precise fit in the set. A session
  reads `prd.json` immediately before closing a story, `stop-auto-check.js` blocks the turn
  on the exact field this skill governs, and closing stories is the highest-stakes thing
  this framework does unattended. It also makes `docs/rules.md:8` true for the first time.
- **Cost, named:** `core` already claims `**/prd.json`, so a `prd.json` read pulls two
  skills — `core` plus 6,222 bytes. Justified.
- **Reversible:** yes.

### F5 — `rule-gate-integrity`: `paths` on detector and test sources

- **What is unreachable:** the four ways a gate passes while proving nothing. Note the
  recursion — F2 exists because this rule was not in context when that gate was written.
- **Mechanism that failed:** (a) elided; (b) no glob. Partial (c) via `phase` and
  `writing-for-agents`.
- **Exact change:**

  ```yaml
  paths:
    - "**/check-*.js"
    - "**/find-*.js"
    - "**/test-*.js"
    - "**/preflight*.js"
  ```

- **Deliberately excludes `**/*.test.*` and `**/*.spec.*`.** Defensible on the skill's own
  `when_to_use`, but it puts 5,199 bytes on every ordinary unit-test read in every consumer
  repo, far more often than the governed work occurs. Ship without them.
- **Reversible:** yes.

### F6 — `rule-local-first`: `paths` on the files the skill is about

- **What is unreachable:** the local gate, the batched publish cadence, the
  no-GitHub-Actions rule. Largest of the nine at 17,979 bytes, so glob precision matters
  most here.
- **Mechanism that failed:** (a) elided; (b) no glob. Partial (c) via `phase`.
- **Exact change:**

  ```yaml
  paths:
    - "**/.github/workflows/*.yml"
    - "**/.github/workflows/*.yaml"
    - "**/.claude/launch.json"
    - "**/PUBLISH-QUEUE.md"
  ```

- **Reordered by A5, and the emphasis was wrong before.** Measured across five repos: the
  workflows pair fires in **5 of 5** (25 files), `launch.json` in **3 of 5** (16 files),
  `PUBLISH-QUEUE.md` in **2 of 5** (18 files, mostly worktree copies). The workflows line
  carries this item alone. `PUBLISH-QUEUE.md` is the weakest of the four and is partly
  circular — the rule is what creates the file — but it costs one line and fires where the
  cadence is already in use, so it ships.
- **`launch.json` is claimed here, not in F7.** See A4.

- **`**/package.json` rejected, and this is a finding rather than an omission.** The skill
  itself instructs *"read the `gate` script out of `package.json` at the commit you are
  on"*, which makes it tempting. But `package.json` is read for dependency checks, version
  bumps and a dozen unrelated reasons, and this is the largest skill of the nine. Highest
  read frequency against highest token cost is the worst pairing available.
- **Reversible:** yes.

### F7 — `rule-windows`: `paths` on `*.ps1` only

- **What is unreachable:** the `cmd /c` MCP wrapper rule and the path conventions.
  Referenced by no other skill — fully isolated on route (c).
- **Exact change** (narrowed by A4, from three globs to one):

  ```yaml
  paths:
    - "**/*.ps1"
  ```

- **`.mcp.json` is cut, and the earlier justification is struck.** This item previously
  called that line "the highest-value line in the file" and argued the OS-mismatch cost was
  worth paying. Measured: **0** `.mcp.json` across all five repos, and 0 for
  `-name '*mcp.json'` too, so it is not a hidden-file artifact. A glob that fires nowhere has
  no value to weigh, and the OS-predicate paragraph was defending a cost with nothing behind
  it.
- **`launch.json` is cut here and kept in F6.** It fires in 3 of 5 repos, better coverage
  than `*.ps1`, but F6 already claims it and two skills on one read is the cost F5 and F8
  spend paragraphs avoiding. `rule-local-first` is the better owner of that file.
- **What this leaves:** `*.ps1` fires in 2 of 5 repos (28 files in one, 2 here). Honest,
  cheap, zero cost off Windows. A narrow true trigger beats a wide one that never fires.
- **Reversible:** yes.

### F8 — `rule-ramifications`: `paths` on component extensions only

- **What is unreachable:** the eight ways a change passes typecheck and is still wrong.
  Referenced only by `rule-verification`, itself unreachable — a dead chain until F4.
- **Exact change:**

  ```yaml
  paths:
    - "**/*.tsx"
    - "**/*.jsx"
    - "**/*.vue"
    - "**/*.svelte"
  ```

- **Deliberately excludes bare `**/*.ts` and `**/*.js`.** `rule-security` and `standards`
  already claim those four extensions; adding 5,762 bytes on top means every TypeScript
  read in every consumer repo pulls three rule skills. Seven of the skill's eight failure
  classes are component-shaped anyway. If class 8 is judged to need `.ts` coverage, that is
  a separate decision with a stated token bill, not a free widening.
- **Reversible:** yes.

### F9 — `rule-file-organization`: `paths` on `prd.json` and `.claude/**`

- **What is unreachable:** where generated files belong. Referenced by no other skill.
- **Exact change:**

  ```yaml
  paths:
    - prd.json
    - "**/prd.json"
    - "**/.claude/**/*.md"
    - "**/.claude/**/*.json"
  ```

- **Bare `prd.json` added by A3**, for the same reason as F4: this document's clean-list
  keeps `core`'s duplicate as defence against `**/` not matching at root, and shipping only
  the recursive form here contradicted it.

- **Weakness, stated rather than papered over:** the rule wants to fire before a *write*,
  and `paths:` fires on a *read*. These globs catch the common case and miss the first-ever
  write into a clean tree. At 1,731 bytes — the smallest of the nine — a slightly wide glob
  is affordable.
- **Reversible:** yes.

### F10 — `rule-ab-testing`: partial glob, and flag the scope it cannot reach

- **What is unreachable:** measuring a proposal against a baseline before adopting it.
- **Mechanism that failed:** (a) elided; (b) no glob; (c) **dead chain** — referenced only
  by `rule-diagnosis`, which is itself unreachable. `grep -rln "rule-diagnosis"` returns
  only `rule-ab-testing/SKILL.md` and the skill itself, confirming the loop.
- **Exact change:**

  ```yaml
  paths:
    - "**/check-*.js"
    - "**/find-*.js"
    - "**/preflight*.js"
  ```

- **What this does not fix, and it is most of the skill:** the glob covers roughly the
  detector third of its scope. "Measure before you recommend" and "report the baseline"
  have no artifact and stay unreachable. This is why R1 lists it as the strongest merge
  candidate — F10 and R1 are alternatives, not a sequence.
- **Reversible:** yes.

### F11 — `rule-diagnosis`: no honest glob exists — cross-reference and make it typeable

- **What is unreachable:** the rule that diagnosis is the load-bearing step. It is one of
  the three autodev-core skills that currently *keeps* its listing description (N3), so
  mechanism (a) works for it today — but usage-ranked elision means that is not stable.
- **Mechanism that failed:** (b) has no honest candidate. Diagnosis applies to a stack
  trace, a log, a config, a test output, a git range — any file and no file. Any glob wide
  enough is an always-on injection wearing a trigger's name. **Do not patch this one with a
  glob.**
- **Exact change**, two parts:
  1. Add a one-line body reference to `rule-diagnosis` in `heal`, `audit`, `review`,
     `phase`. **Not `fix`** — see N2; `fix` was cut in `7435ca0` and the lens's
     prescription is stale on that point. **This is the part that does the work.**
  2. `user-invocable: true`. **Amended by A6:** this makes the skill typeable by the user as
     a slash command. It does **not** convert an elided listing slot into a described one —
     `rule-diagnosis` is `user-invocable: false` today and keeps its description, which is
     the counterexample. Ship it for the user-facing lever, not for the listing.
- **Reversible:** yes, five single-line edits.

### F12 — `writing-for-agents`: the one plan convert that is honest

- **What is unreachable:** nothing today. It omits `user-invocable` entirely, and the
  documented default is `true` (anthropic-kb `id=38100`), so it is reachable if typed.
- **Why it is here:** `docs/SKILL-LAYER-PLAN.md` A1 prescribes converting it to
  `user-invocable: false` plus a glob. For this one skill that is correct and the glob is
  honest — those are files a session genuinely opens.
- **Exact change:**

  ```yaml
  user-invocable: false
  paths:
    - "**/SKILL.md"
    - "**/CLAUDE.md"
    - "**/AGENTS.md"
  ```

  Population: 59 `SKILL.md` in this repo alone, and every consumer repo has a `CLAUDE.md`.
- **Reversible:** yes.

### F13 — `grilling`, `show-your-work`, `wizard`: set `user-invocable: true` explicitly, and do NOT apply the plan's conversion

- **What is unreachable:** nothing today, and that is the point.
- **Mechanism at risk:** `docs/SKILL-LAYER-PLAN.md` A1 prescribes `user-invocable: false`
  plus a glob for all four converts. Applying it to these three would **create** three new
  instances of the exact defect this sweep exists to remove, because no honest glob exists:
  `grilling` triggers on attacking a plan's premise (a conversation), `show-your-work` on
  the start of unattended work (a moment), `wizard` on a tool error string (no glob sees
  stderr). Measured here: all three omit the `user-invocable` key entirely today.
- **Exact change:** add `user-invocable: true` explicitly to all three. Two reasons beyond
  reachability: today's behaviour rests on an undocumented default, and `validate.js` does
  not require the field, so nothing here would notice if the default changed upstream.
- **`wizard` is the strongest keep of the three.** Its body records a session that retried
  the same browser error from 10:14 to 12:24 without asking. Do not bury a measured,
  expensive antidote behind a glob that cannot fire.
- **Reversible:** yes.

### F14 — Correct the three documents that assert delivery which was never wired

- **What is wrong:** `docs/rules.md:7` states that each rule skill has `user-invocable:
  false` and a `paths:` glob, and that proposing a cause pulls `rule-diagnosis` while
  marking a task done pulls `rule-verification`. Both named examples are in the unreachable
  nine. `CHANGELOG.md:2715` claims five skills became auto-loading with `paths` globs;
  three of the five have no glob. `docs/rules.md:1` says "Twelve";
  `ls | grep -c '^rule-'` -> **14**.
- **Measured that this is not a regression:**
  `git log --oneline -S"paths:" -- <skill>/SKILL.md` returns empty for
  `rule-file-organization`, `rule-windows` and `rule-verification`. No commit ever added or
  removed a `paths:` key in any of the three. The CHANGELOG described a mechanism that was
  never built.
- **Why this ranks with the fixes rather than as tidy-up:** this is the "reassuring label on
  a skip" failure — absent coverage recorded as reported coverage. It closed the question
  for every reader since, which is why the defect survived. Correct it in the same change as
  the globs or the next reader stops asking.
- **Reversible:** yes.

---

# REMOVALS

Merges and cuts. These delete directories. Higher risk, different approval, and — stated
plainly — **lower value than every fix above.**

**Read this before approving any of them.** The listing budget is ~208 active skills;
autodev contributes 59. Merging two skills recovers two slots, about 1% of the total and
3% of autodev's footprint. **These are worth doing for coherence, not for reachability**,
and no one should expect a description to reappear because of them.

**⚠️ CORRECTED BY B1 — the sentence this preamble used to carry was wrong.** It said the
elision is "whole-entry dropping and the only lever is entry *count*". Measured in this
session's listing, all 51 autodev-core skills appear **by name**; only the description is
dropped. So the constrained resource is not the slot, and merging recovers something that
was never scarce. That makes the case for REMOVALS weaker than the preamble originally
argued, not stronger — the number to beat was never 1%.

E5's finding stands and is separate: per-skill truncation is not happening (documented cap
1,536 characters, longest combined field in the tree 559, `spec`). Truncation and elision
are different mechanisms and only the second is in play.

### R1 — Merge `rule-ab-testing` into `rule-diagnosis`

- **Why:** its rules 3, 5 and 9 already restate `rule-diagnosis`, and rule 9 defers to it by
  name. F10's glob reaches only the detector third of its scope; the rest has no artifact
  and stays unreachable under any frontmatter change. The two currently form a dead
  reference loop (F10).
- **Change:** fold the measurement rules into `rule-diagnosis/SKILL.md`, delete
  `plugins/autodev-core/skills/rule-ab-testing/` (8,372 bytes). If R1 lands, F10 is
  withdrawn.
- **Reversible:** yes via `git revert`, but the merged prose has to be re-split by hand.
  Materially harder to undo than any fix above.

### R2 — Merge `rule-design-system` into `rule-thumb-first`

- **Why:** `rule-design-system`'s glob set (`*.tsx`, `*.jsx`, `*.css`, `tailwind.config.*`)
  is a strict **subset** of `rule-thumb-first`'s, which adds `*.vue` and `*.svelte`. In
  every React or CSS-bearing repo both load on the identical file read. Two listing entries,
  one trigger, one subject. Verified against both frontmatters here.
- **Change:** fold 1,344 bytes into `rule-thumb-first/SKILL.md`, delete the directory.
  Thumb-first is the superset on both axes, so zero behaviour is lost.
- **Scope corrected by A2 — this is a six-file change, not a two-file one.** Four skills name
  `rule-design-system` in their bodies and each reference has to be re-pointed:
  `a11y/SKILL.md:41`, `phase/SKILL.md:61`, `review/SKILL.md:77`, `standards/SKILL.md:68`.
  Four one-line edits, so it does not block the merge — but a merge that deletes the
  directory and leaves the four references is worse than not merging, because a dangling
  skill name in a body reads as a live pointer and fails silently.
- **Note:** `rule-thumb-first` is one of the three skills that currently keeps its listing
  description. That is a reason to prefer it as the survivor, but per A6 it is a property of
  that skill, not something the merge confers.
- **Reversible:** yes, with the same hand-re-splitting caveat.

### R3 — ~~Merge `rule-security` and `standards`~~ → drop `standards`' glob, keep the directory

**The merge is WITHDRAWN. A1 refuted it and this is the replacement.**

- **Why the merge is wrong:** deleting `plugins/autodev-core/skills/standards/` breaks
  `plugins/autodev-core/agents/code-reviewer.md:12`, which declares `standards` in its
  `skills:` frontmatter, plus **12 body references** across `a11y`, `audit`, `design`,
  `review` and `autodev-init`. An agent that cannot resolve a declared skill does not error;
  it runs without it, and the review silently loses the conventions it was meant to apply.
  Unlike R2's four references, these cannot all be re-pointed — the agent dependency is the
  skill *itself*, not a mention of it.
- **What was right about the original finding:** the duplication is real. `standards`'
  `["**/*.ts","**/*.tsx","**/*.js","**/*.jsx"]` is a strict subset of `rule-security`'s,
  which adds `**/*.sql` and `**/*.env*`, so every TypeScript read in every consumer repo
  pulls both. Verified against both frontmatters.
- **Replacement change**, two lines in
  `plugins/autodev-core/skills/standards/SKILL.md`, no deletion:
  1. Delete the four `paths:` lines. `rule-security` already fires on every one of them.
  2. Set `user-invocable: true`. **Both halves are required** — dropping the glob from a
     `user-invocable: false` skill produces exactly the shape F2's repaired gate fires on,
     so half this change turns `validate` red.
- **What `standards` loses:** its auto-load. What it keeps: the agent dependency and 12 body
  references, which is a live route (c) — the thing the nine unreachable skills do not have.
  This is the one place in the sweep where dropping a glob is safe, and it is safe for that
  specific reason.
- **Reversible:** yes, and far more cleanly than the merge would have been. Four lines back.

### R4 — `rule-options-protocol`: `user-invocable: true`, or cut — an owner decision, not a sweep decision

- **What is unreachable:** how to end a turn. Fully isolated: no glob, no inbound reference
  from any skill, description elided. At 10,539 bytes it is the second-largest of the nine
  and the most expensive dead listing slot in the set.
- **Mechanism that failed:** all three. Ending a turn reads no file and has no filesystem
  signature, so **no glob exists, honest or otherwise**. A fourth route was checked and does
  not exist: `hooks/session-start.js` contains no skill or rule injection, so there is no
  always-delivered surface to fold it into without building one — and building one is a new
  mechanism, which this sweep excludes.
- **Two options, genuinely different:**
  1. **`user-invocable: true`** — cheapest honest change, makes it typeable **by the user**.
     Fully reversible. **Amended by A6:** the original wording added "and an invoked skill
     keeps its listing description". That is false and is struck. This option does not make
     the skill more discoverable to the model; it adds a slash command.
  2. **Cut it from the plugin** — defensible, because it is a portable copy of a rules file
     that is already always-resident for this operator via an `@`-import. The plugin copy
     delivers to nobody on this host while costing a listing slot.
- **Three costs of the cut, the third found by A7:**
  1. The argument rests entirely on *this operator's* host config. A consumer who installed
     the plugin and never wrote their own rules file has the plugin copy as their only copy.
     **Confirm no consumer relies on it before cutting.**
  2. Not reversible in practice once a release ships without it.
  3. `tooling/check-runtime.js:134-135` asserts `skills/rule-options-protocol` exists as a
     content marker for every version at or above 8.74.0. Cutting the skill makes that marker
     report missing on every installed build, so the cut is a two-file change with a runtime
     check attached — not the one-directory deletion it reads as.
- **Recommendation unchanged: take option 1 now, defer option 2.** One line, forecloses
  nothing. A6 removed one of its two reasons and A7 added a cost to the alternative, so the
  recommendation is if anything firmer than before.

---

## Explicitly clean — do not re-find these

- **Hooks.** 14 wired hook commands across two `hooks.json`; `npm run check:hooks` reports
  `14 wired · 14 driven by a suite · 0 with NO suite`. Population named so a zero is
  distinguishable from a no-op.
- **The second defect class is already fixed.** `heal-sweep.workflow.js` is the only
  `*.workflow.js` in the repo (`find` confirms), and `grep -n "model:"` shows all three
  `agent()` calls pin `model: 'opus'` at lines 222, 267 and 332, fixed in `1f1d7cd`.
  **But see F1** — the same commit's other half did not land the value it looked like it
  landed.
- **Dead pointers.** 0 of 45 non-rule skills reference a `${CLAUDE_PLUGIN_ROOT}` path that
  does not resolve.
- **`core`.** Glob `prd.json` + `**/prd.json` is the file the skill documents, and
  `prd.json` exists in the target repos. The duplicate bare/recursive pattern is defensive
  against implementations where `**/` does not match at root. Leave it.
- **`rule-security`'s wide glob is a cost, not a defect.** 1,220 `.ts` files in one consumer
  repo means opening a test file loads 782 bytes of credential rules. That is the price of
  the mechanism working. Recorded so it is not re-filed as a bug.

## Proposals, not findings

Marked because they were not verified here and should not be acted on as measured:

- **F3** — the D1 probe. Cannot run in a non-interactive session.
- **The R1/R2 resolution.** The doc wording is quoted verbatim above and is genuinely
  ambiguous. The balance moved toward R1 on the "same format as path-specific rules"
  sentence; it was not settled.
- **Any claim about consumer-repo file populations.** Those numbers come from
  `lens-listing-budget.md` Part 1 and were not re-measured here. The `*.workflow.js` count
  in *this* repo was.
- **`survey.md:130`'s reading that `rule-agent-concurrency` carried a description.**
  Contradicted by three later sessions (N3, plus the adversarial pass). Probably a misread,
  though a usage-ranked drop genuinely would move the surviving set between sessions.
- **The mechanism behind the elision.** B1 measures *that* descriptions are dropped while
  entries survive. It does not establish *why* — usage rank, alphabetical, plugin order and
  a per-plugin cap all fit the same observation. Do not build a fix on a ranking theory that
  has not been probed.
- **The consumer-repo file counts in A4 and A5 WERE re-measured here**, unlike the
  `lens-listing-budget.md` Part 1 numbers noted above. Five repos, `node_modules` excluded,
  `find` on the working trees. They are a snapshot of five checkouts on one machine, not a
  claim about consumer repos in general.
