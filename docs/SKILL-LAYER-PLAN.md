# Skill layer: diagnosis and plan

Status: **proposal awaiting approval.** No `SKILL.md` was modified to produce this.
Measured 2026-08-25 against repo HEAD `7631846` (v8.115.0), by an agent whose own
skill listing is cited as primary evidence.

---

## 1. Which diagnosis the evidence supports

**The trigger mechanism is broken. Not count, not wording.** Skill count is the
input that broke it, so cutting is the repair — but cutting is a lever on the
mechanism, not an independent fix, and that distinction decides the order of work
below.

### F1 — The probe reproduces, so the silence is real

`artifact-design` 8, `gtm-kb` 1, across **75** transcripts newer than 2026-08-24.
Thirty-eight invocable skills fired zero times. The probe returns non-zero hits,
so it can see invocations.

### F2 — 52 of 55 autodev-core entries reach the model as a bare name

Read directly out of this session's own skill listing, which is the surface the
model actually matches against. Exactly three carry any description: `brain`,
`rule-diagnosis`, `rule-thumb-first`. Of those, only `brain` is user-invocable.

This is first-hand, not inferred from a config file. The text on disk is
irrelevant to matching if it never reaches the listing.

### F3 — The elision is usage-ranked, not length-ranked

This is the measurement that decides between "too weak" and "broken mechanism",
and it kills the intuitive explanation:

| skill | description + when_to_use | survived in listing? |
|---|---|---|
| `brain` | **381 chars** | yes |
| `preflight` | 334 | no |
| `scan` | 279 | no |
| `review` | 246 | no |
| `audit` | 178 | no |
| `test` | 141 | no |
| `auto` | **132** | no |
| `ship` | **130** | no |

The **longest** entry survived and the two **shortest** were dropped. Trimming
descriptions to fit therefore cannot help; it would have saved `ship` and `auto`
first, and they are the ones that died. The ordering matches Anthropic's
documented behaviour — descriptions are dropped starting with the least-invoked
skill — which makes this a self-reinforcing ratchet: zero invocations to dropped
description to unmatchable to zero invocations.

### F4 — Every skill that fired had a surviving description; none without one did

3 of 3 invoked skills in the window (`artifact-design`, `gtm-kb`, `brain` via
slash command) render with full text. 0 of the 39 bare-name skills fired. The
correlation is total across the observed population. It is not proof of
causation on its own, but combined with F3 it leaves no competing mechanism.

### F5 — The user-typed path is dead too, which rules out "they just typed the command instead"

Across the same 75 transcripts, exactly **one** autodev slash command was typed:
`/autodev-core:brain`. Neither route is being used. So the silence is not users
bypassing an unmatched listing by naming skills explicitly.

### F6 — Trigger text on disk is mostly fine, with a specific and important exception

29 of 40 invocable skills carry multi-phrase `when_to_use`; none is missing.
Refreshing them wholesale would be work aimed at a field the model never sees.

The exception matters because it lands on the load-bearing four. Eight skills
have a single-phrase `when_to_use` that only echoes their own name — a tautology
that adds nothing a bare name does not already carry: `audit`, `auto`, `clean`,
`fleet`, `ship`, `sprint`, `status`, and effectively `brainstorm` (two phrases,
both self-referential).

### F7 — "live" routes nowhere at all

Of Andy's four load-bearing words, **`live` matches no skill name and appears in
zero `when_to_use` fields.** The only place the word occurs is `scan`'s
`description` — *"Live site QA in a real browser"* — which is precisely the field
the budget drops first.

So for one of the four, the single piece of routing text that exists is in the
elided field. That is the whole failure in one line.

### What the evidence does NOT support

- **"Too many skills"** as a *direct* cause. Nothing rejects a skill for being
  the 41st. Count matters only because it is the input to the budget ranking.
- **"Too weak to trigger"** as the primary cause. Wording cannot be the binding
  constraint on text that is not delivered. It becomes a real second-order
  problem the moment the budget is fixed — see F6 and F7.

### Honest ambiguity

The evidence cleanly separates mechanism from wording. It does **not** let me
predict *how much* cutting is enough. autodev-core is ~55 entries in a listing
that also carries ~54 personal skills, ~160 entries from business plugins that
are not in local `enabledPlugins`, plus vercel, slack, firebase and the
harness built-ins. **Proposal, not finding:** autodev may be a minority of the
pressure, and cutting it alone may not free enough budget. Step A1 below is
designed to falsify that cheaply before the expensive work starts.

---

## 2. The concrete list

40 invocable skills to **16**. Composition: 6 cut, 14 merged, 4 converted to
always-on rules, 16 kept.

### CUT — 6 skills, 23,434 bytes

Each duplicates a harness built-in its own body already defers to, or a sibling
skill that supersedes it.

| skill | bytes | why |
|---|---|---|
| `fix` | 3,412 | body defers to the harness `/debug`; `when_to_use` claims "fix", "debug" |
| `pr-review` | 2,897 | its own `when_to_use` lists `"code-review"`, the name of a harness built-in |
| `monitoring` | 4,407 | overlaps `deploy` and `telemetry`; no unique mechanism |
| `deploy` | 4,651 | step 3 of `ship` *is* deploy |
| `env-vars` | 4,167 | body defers to `autodev-stack:doppler` |
| `clean` | 2,698 | single-phrase tautology trigger; `sessions` covers it |

### MERGE — 14 skills folded into 5 parents

Each becomes an argument on its parent rather than a listing entry.

| merge these | into | grounding |
|---|---|---|
| `a11y`, `perf`, `seo`, `security`, `review` | **`audit`** | `audit` already runs parallel agents whose Agent 2 is a performance audit and Agent 3 an accessibility audit. `review` defers to `/code-review` in its first line. Becomes `audit [full\|a11y\|perf\|seo\|security\|diff]`. |
| `archive-prd`, `sprint`, `status`, `iterate` | **`auto`** | all four are `prd.json` lifecycle; `iterate` is literally brainstorm + apply + auto in a loop |
| `auto-brain`, `fleet`, `sessions`, `telemetry` | **`brain`** | `auto-brain` opens by saying "Read brain first"; `fleet` and `sessions` are fleet-state reads |
| `autodev-init` | **`setup-project`** | both scaffold a project's conventions |

Merging is 25,426 + 15,341 bytes of parent already; the parents are the two
largest files in the tree and `auto` at **518 lines** already breaks the 500-line
best-practice limit. **Merge bodies into `references/` beside each parent, not
into `SKILL.md`** — reference files load on demand and cost no listing budget.

### CONVERT to always-on rule — 4 skills

These have `when_to_use` fields with **zero** invocation phrases. They describe a
*moment* ("Before work starts on anything whose FRAME could be wrong", "At the
START of long or unattended work"), not a word a user types. They are rules
wearing a skill's clothes, and they can never be matched from a listing.

`grilling`, `show-your-work`, `wizard`, `writing-for-agents`

Set `user-invocable: false` plus a `paths:` glob, exactly as the 13 `rule-*`
skills already do. **Nothing is deleted** — the content keeps working, and it
stops competing for budget.

### KEEP invocable — 16

`audit`, `auto`, `brain`, `brainstorm`, `commit`, `design`, `heal`,
`learn-from-fixes`, `migrate`, `preflight`, `refactor`, `scan`, `setup-project`,
`ship`, `spec`, `test`

### The four that must work, and what each needs beyond the cut

| word | skill | required change |
|---|---|---|
| audit | `audit` | replace the tautology `"Invoked when the user says \"audit\""` with real phrases |
| brainstorm | `brainstorm` | same; two self-referential phrases today |
| live | **`scan`** | **F7 — add "live", "live qa", "check it live", "is it live" to `when_to_use`.** Today the word exists only in the elided description |
| test | `test` | two phrases (`"test"`, `"e2e"`); widen to cover "does it work", "run the tests" |

Do these edits **after** step A1 confirms descriptions render again. Editing
undelivered text first is the mistake this whole document is about.

---

## 3. First change, and how to know in a month

### A1 — First change: remove the 10 zero-risk entries

The 6 cuts plus the 4 converts. **Not** the 14 merges.

Chosen because it is the subset with no invocation history to lose — every one of
the ten has fired zero times in 75 transcripts — and because it is reversible in
one `git revert`. It removes ~18% of autodev-core's listing entries without
touching any skill Andy named.

It is also the falsification test. Per the ambiguity noted above, if freeing ten
slots does not bring `audit`, `brainstorm`, `scan` and `test` back into the
listing with descriptions, the budget pressure is dominated by the ~160 business
plugin entries and the ~54 personal skills, and the remaining 30 changes to
autodev would be wasted effort aimed at the wrong tree.

**Deliberately not first:** the settings knobs. The research names
`skillListingBudgetFraction` and `SLASH_COMMAND_TOOL_CHAR_BUDGET`; neither is
present in `~/.claude/settings.json` today and **I did not verify either is
honoured by this build.** Marked a proposal, not a finding. It would be the
cheapest fix of all if real, so it is worth one `/doctor` run before A1 — but a
plan should not rest on an unverified setting name.

### A2 — Bigger lever, outside this repo, needs Andy's call

~160 listing entries come from business plugins — small-business (~35),
anthropic-skills (~18), data (10), and a dozen more — that are **not** in local
`enabledPlugins` and **not** in the local plugin cache. They appear to be
account-level, so they are not removable from `settings.json`. If A1 fails, this
is where the budget actually went, and no amount of autodev pruning reaches it.

Separately: **39 versions of autodev-core sit in the plugin cache** (8.65.0
through 8.115.0, 1,953 `SKILL.md` files). That is disk bloat rather than listing
pressure — the listing only reflects the active version — but it is worth one
`rm` while in the area.

### The measurement — one command, it already exists

```bash
find ~/.claude/projects -name '*.jsonl' -newermt '<cut-date>' -print0 \
  | xargs -0 grep -ohE '"skill":"[a-z0-9:_-]+"' | sort | uniq -c | sort -rn
```

Run it a month after A1 with `-newermt` set to the cut date.

**Success:** any of `audit`, `brainstorm`, `scan`, `test` appears with a non-zero
count. One invocation breaks the ratchet, because an invoked skill keeps its
description and stops being the first thing dropped.

**Failure:** the output is still only `artifact-design` and `gtm-kb`. Then the
diagnosis in section 1 is wrong or A2 is the real constraint — and the correct
response is to stop cutting, not to cut harder.

**Leading indicator, available immediately rather than in a month:** open a fresh
session after A1 and read the skill listing. If `audit` and `test` render with
descriptions, the mechanism is fixed and invocations will follow. If they are
still bare names, A1 failed and the month-long wait is unnecessary.

**Guard against a false negative.** The probe counts the `Skill` tool only. A
skill reached by slash command shows up as `"content":"/autodev-core:audit"`
instead. Check both paths before concluding zero — the baseline for that second
path is 1 in 75 transcripts.

---

## What is deliberately not proposed

**No new skills.** A 41st skill in a library where 38 never fire is the failure
repeating. Every change above is a removal, a fold, or an edit to a `when_to_use`
field that already exists.
