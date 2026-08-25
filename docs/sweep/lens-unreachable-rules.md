# Lens: unreachable `rule-*` skill frontmatter

Scope: the 9 `rule-*` skills in `plugins/autodev-core/skills/` that the survey
measured as `user-invocable: false` AND carrying no `paths:` glob. One verdict
and one concrete fix per skill.

**Verdict: 9 of 9 UNREACHABLE. 6 have an honest glob. 3 do not.**

---

## The mechanism, stated before it is used

A skill reaches a session by one of three routes here:

- **(a) the skill listing**, matched on `description` / `when_to_use`. Measured
  broken for autodev-core: all ~56 skills arrive as bare names, descriptions
  elided by usage rank.
- **(b) a `paths:` glob**, which auto-loads the skill when the session **reads a
  matching file**. This repo's `CLAUDE.md:51` states the mechanism in those
  terms.
- **(c) a cross-reference from a skill that is already loaded** — a
  user-invocable skill naming `rule-x` in its body pulls it in. Real, but it
  inherits the reachability of the referrer.

Everything below turns on (b) firing on a **read**, not on a write and not on an
intent. That is why a rule governing a *speech act* — ending a turn, stating a
cause, claiming done — often has no honest glob: there is no file to hook.

## Three facts that reframe this from "9 gaps" to "a documented contract that was never true"

**1. The repo's own doctrine says all of them already have globs.**
`docs/rules.md:7` — *"Each is a `rule-*` skill with `user-invocable: false` and a
`paths:` glob. Claude Code loads one when the work matches its glob... anything
that proposes a cause pulls `rule-diagnosis`, marking a task done pulls
`rule-verification`."* Both named examples are in the unreachable nine. The two
sentences are false as written.

`CHANGELOG.md:2715` — *"`config/rules/*.md` became five auto-loading skills
(`rule-security`, `rule-design-system`, `rule-file-organization`, `rule-windows`,
`rule-verification`)... as skills with `paths` globs they apply automatically."*
Three of those five have no glob.

**2. They never had one — this is not a regression.** `[measured]`

```bash
git log --oneline -S"paths:" -- plugins/autodev-core/skills/rule-file-organization/SKILL.md   # (empty)
git log --oneline -S"paths:" -- plugins/autodev-core/skills/rule-windows/SKILL.md             # (empty)
git log --oneline -S"paths:" -- plugins/autodev-core/skills/rule-verification/SKILL.md        # (empty)
```

No commit ever added or removed a `paths:` key in any of the three. The CHANGELOG
described a delivery mechanism that was never wired. This is the "reassuring
label on a skip" family: absent coverage recorded as reported coverage, closing
the question for every reader since.

**3. `validate.js` already half-knows.** `tooling/validate.js:212-226` carries the
comment and its own measurement: *"`[measured 2026-08-24]` 12 skills claimed
'Always-on'; 3 declared a paths glob; 9 had no trigger of any kind. Among the 9
were rule-gate-integrity, rule-diagnosis and rule-verification — the three that
describe this exact failure. Across 212 transcripts, rule-\* skills were
explicitly invoked 3 times in total."* The gate that followed only forbids the
*phrase* "Always-on" without a glob. It does not require a glob. Every one of the
nine passes `npm run validate` today by having reworded its `when_to_use`.

**Adding `paths:` to any of these is validate-safe** — no existing check
conflicts, and only the "Always-on" wording rule interacts with the gate at all.

---

## Per-skill verdicts

### 1. `rule-ab-testing` — UNREACHABLE · partial glob available

- Reachable by (a)? No — bare name in the listing.
- Reachable by (b)? No glob.
- Reachable by (c)? **No.** Referenced only by `rule-diagnosis`, which is itself
  unreachable. Dead chain.

**Governs three things**: writing a detector, recommending a change, claiming
something is cheap/fast/better. Only the first has a file signature.

**Honest glob (covers roughly the detector third of its scope):**

```yaml
paths:
  - "**/check-*.js"
  - "**/find-*.js"
  - "**/preflight*.js"
```

Justified from the skill's own body, which cites `scripts/find-orphan-checks.js`
and `/preflight add` as the artifacts it governs, and from the population here:
9 `check-*.js` and 5 `find-*.js` tracked in this repo. A session writing a new
detector reads the existing ones first — that read is the moment.

**What this does not fix:** the "measure before you recommend" and "report the
baseline" halves have no artifact and stay unreachable. If those matter more than
the detector half, this skill is a **merge candidate into `rule-diagnosis`** —
its rules 3, 5 and 9 already restate it, and rule 9 defers to `rule-diagnosis` by
name.

---

### 2. `rule-diagnosis` — UNREACHABLE · **NO HONEST GLOB EXISTS**

- (a) No. (b) No glob. (c) Referenced only by `rule-ab-testing`, itself
  unreachable. Dead chain.

Diagnosis applies to a stack trace, a log, a config, a test output, a screenshot,
a git range — any file and no file. **Any glob wide enough to catch it is not a
trigger, it is an always-on injection wearing a trigger's name**, and it would
fire on thousands of reads that have nothing to do with proposing a cause.
Inventing `"**/*.js"` here is exactly the dishonesty this sweep exists to find.

**Fix, in preference order:**

1. **Mechanism (c), done properly.** Add a one-line reference to `rule-diagnosis`
   in the body of the user-invocable skills whose entire job is diagnosis:
   `fix`, `heal`, `audit`, `review`. That is the only route that fires at the
   right moment. Cost: four one-line edits.
2. **`user-invocable: true`**, so it can at least be typed as `/rule-diagnosis`.
   This does nothing for auto-load, but it converts a dead listing slot into a
   reachable one — and per the elision mechanism, an invoked skill keeps its
   description, which partially restores route (a) for it.

Do **not** patch this one with a glob.

---

### 3. `rule-file-organization` — UNREACHABLE · honest glob available

- (a) No. (b) No glob. (c) Not referenced by any skill.

Note before anyone proposes cutting it: this is a portable duplicate of the
operator's `~/.claude/rules/file-organization.md`, which is `@`-imported and
therefore always resident **on this host only**. The plugin copy is the one that
ships. At 1.7 KB it is the smallest of the nine, so a slightly wide glob is
affordable.

**Honest glob:**

```yaml
paths:
  - "**/prd.json"
  - "**/.claude/**/*.md"
  - "**/.claude/**/*.json"
```

`prd.json` because `prd-archive-*.json` and `prd-backup-*.json` are its
derivatives and the rule's headline is *"only `prd.json` and source code belong
in project root"*. `.claude/**` because the rule's entire output map lives there
and those files are genuinely read: `audit` reads
`.claude/agent-memory/audit-patterns.md`, `sprint`/`status` read
`.claude/sprint-history.md`, and a handoff or report is read before the next one
is written.

**Weakness to state:** the rule wants to fire before a **write**, and `paths:`
fires on a **read**. The globs above catch the common case and miss the
first-ever write into a clean tree.

---

### 4. `rule-gate-integrity` — UNREACHABLE · **strongest honest glob of the nine**

- (a) No. (b) No glob. (c) **Partial** — referenced by `phase` and
  `writing-for-agents`, both user-invocable. Live, but conditional on those being
  invoked.

**Honest glob:**

```yaml
paths:
  - "**/check-*.js"
  - "**/find-*.js"
  - "**/test-*.js"
  - "**/preflight*.js"
```

The tightest fit in the set. All four of the skill's failure modes are properties
of gate source, and a session writing or repairing a gate reads the gate.
Population here: 46 `test-*.js`, 9 `check-*.js`, 5 `find-*.js`.

**Optional widening, with its cost named:** adding `"**/*.test.*"` and
`"**/*.spec.*"` is defensible — the skill's own `when_to_use` says "gate, test,
detector or harness" — but it puts 5.2 KB on every ordinary unit-test read in
every consumer repo, which is far more often than the governed work occurs. Ship
without them.

---

### 5. `rule-local-first` — UNREACHABLE · honest glob available, one tempting glob rejected

- (a) No. (b) No glob. (c) **Partial** — referenced by `phase`.

Largest of the nine at 18 KB, so glob precision matters more here than anywhere
else.

**Honest glob:**

```yaml
paths:
  - "**/.claude/launch.json"
  - "**/PUBLISH-QUEUE.md"
  - "**/.github/workflows/*.yml"
  - "**/.github/workflows/*.yaml"
```

Each is a file the skill is itself about. `launch.json` is the mechanism it
mandates for the local run. `PUBLISH-QUEUE.md` is a file this skill defines,
including its location — nothing else in the repo mentions it. A workflow read is
precisely the moment "GitHub Actions is not the gate" applies. Neither
`launch.json` nor `.mcp.json` is tracked in *this* repo, which is correct and
irrelevant: the glob is evaluated against the consumer's project, where both are
standard.

**Rejected glob, and why — this is a finding, not an omission.**
`"**/package.json"` looks compelling: the skill explicitly instructs *"read the
`gate` script out of `package.json` at the commit you are on; never quote it from
here."* But `package.json` is read for dependency checks, version bumps and a
dozen unrelated reasons, and this skill is the largest of the nine. Highest read
frequency against highest token cost is the worst pairing available. Rejected on
cost, not on principle.

---

### 6. `rule-options-protocol` — UNREACHABLE · **NO HONEST GLOB EXISTS**

- (a) No. (b) No glob. (c) Not referenced by any skill. Fully isolated.

This governs how to **end a turn**. Ending a turn reads no file, touches no
artifact, and has no filesystem signature of any kind. There is no glob, honest
or otherwise. At 10.5 KB it is also the second-largest of the nine, making it the
most expensive dead listing slot in the set.

**Fix, pick one:**

1. **`user-invocable: true`.** Cheapest honest change. Makes it typeable, and an
   invoked skill keeps its listing description — the only lever that touches
   route (a) at all.
2. **Cut it from the plugin.** Defensible: it is a verbatim portable copy of
   `~/.claude/rules/options-protocol.md`, which is `@`-imported and already
   always-on for this operator, so the plugin copy delivers to nobody while
   costing a listing slot. **Confirm before cutting** that no consumer relies on
   the plugin as their only copy. That is Andy's decision, not a sweep decision.

I checked for a third route and it does not exist: `hooks/session-start.js`
contains no skill or rule injection (`grep -n "skill\|rule-\|SKILL"` returns
nothing), so there is no always-delivered surface to fold this into without
building one — and building one is a new mechanism, which this sweep excludes.

---

### 7. `rule-ramifications` — UNREACHABLE · honest glob available, narrowed on cost

- (a) No. (b) No glob. (c) Referenced by `rule-verification`, itself unreachable.
  Dead chain.

Seven of its eight failure classes are component-shaped: async ordering, flow
states, mount ownership, cache keys, cleanup of listeners/intervals/rAF,
units/locales, and reachability of handlers.

**Honest glob:**

```yaml
paths:
  - "**/*.tsx"
  - "**/*.jsx"
  - "**/*.vue"
  - "**/*.svelte"
```

**Deliberately excludes bare `"**/*.ts"` and `"**/*.js"`.** `rule-security` and
`standards` already claim those four extensions; adding a 5.8 KB skill on top
means every TypeScript read in every consumer repo pulls three rule skills. The
component extensions are where the classes actually live and are read far less
often. If class 8 (wrong environment/project/key) is judged to need `.ts`
coverage, that is a separate decision with a stated token bill, not a free
widening.

---

### 8. `rule-verification` — UNREACHABLE · honest glob available, and it is exact

- (a) No. (b) No glob. (c) **Partial** — referenced by `phase`, `review`, and
  `rule-ab-testing`. The first two are live.

**Honest glob:**

```yaml
paths:
  - "**/prd.json"
```

The most precise fit in the whole set. The skill's core section is *"Closing a
task: the claim must be checkable, and it must be true"* — it governs what
writing `passes: true` means. A session reads `prd.json` immediately before
closing a story. The artifact and the rule share a subject.

It also makes `docs/rules.md:8` true for the first time: *"marking a task done
pulls `rule-verification`."*

**Cost:** `core` already claims `**/prd.json`, so a prd.json read would pull two
skills (`core` plus 6.2 KB). Justified — closing stories is the highest-stakes
thing this framework does unattended, and `stop-auto-check.js` blocks the turn on
the exact field this skill governs.

---

### 9. `rule-windows` — UNREACHABLE · honest glob available, with one limitation the mechanism cannot express

- (a) No. (b) No glob. (c) Not referenced by any skill.

**Honest glob:**

```yaml
paths:
  - "**/.mcp.json"
  - "**/*.ps1"
  - "**/.claude/launch.json"
```

`.mcp.json` is the highest-value entry: the skill's first rule is *"ALWAYS use
`cmd /c` wrapper"* for MCP server config, and editing that config means reading
that file. `*.ps1` is Windows-correlated by construction. `launch.json` covers
the dev-server section.

**The limitation, stated rather than papered over:** `paths:` has no OS
predicate, so `.mcp.json` fires this 6.5 KB skill on macOS and Linux too, where
the skill's own description says *"Load only when working on Windows."* The
mechanism cannot express the condition the skill needs. Two honest options:

- Ship the full glob and accept the cross-platform cost. The body is
  self-labelling and a non-Windows reader skips it.
- Ship `"**/*.ps1"` only, which costs nothing off Windows, and accept that the
  MCP `cmd /c` rule — arguably the highest-value line in the file — stays
  unreachable.

Ship the full glob. A skill that occasionally loads where it does not apply beats
a rule that never loads where it does.

---

## Summary

| Skill | Verdict | Fix | Route |
|---|---|---|---|
| rule-ab-testing | UNREACHABLE | glob: `check-*`, `find-*`, `preflight*` (partial scope) | (b) |
| rule-diagnosis | UNREACHABLE | **no honest glob** — cross-ref from `fix`/`heal`/`audit`/`review`, plus `user-invocable: true` | (c) |
| rule-file-organization | UNREACHABLE | glob: `prd.json`, `.claude/**` | (b) |
| rule-gate-integrity | UNREACHABLE | glob: `check-*`, `find-*`, `test-*`, `preflight*` | (b) |
| rule-local-first | UNREACHABLE | glob: `launch.json`, `PUBLISH-QUEUE.md`, workflows. **Reject `package.json`** | (b) |
| rule-options-protocol | UNREACHABLE | **no honest glob** — `user-invocable: true`, or cut (Andy's call) | (a)/cut |
| rule-ramifications | UNREACHABLE | glob: `*.tsx`, `*.jsx`, `*.vue`, `*.svelte`. **Exclude `*.ts`/`*.js`** | (b) |
| rule-verification | UNREACHABLE | glob: `prd.json` | (b) |
| rule-windows | UNREACHABLE | glob: `.mcp.json`, `*.ps1`, `launch.json` — no OS predicate available | (b) |

**Six honest globs. Two skills with no honest glob at all** — `rule-diagnosis`
and `rule-options-protocol`, both governing speech acts rather than artifacts.
That is a structural mismatch with a read-triggered mechanism, not something a
cleverer glob solves. `rule-ab-testing` is a third partial case: its glob covers
the detector third of its scope and leaves the rest unreachable, which makes it
the strongest merge candidate in the set.

## Two follow-ups this lens surfaced but does not own

- **`docs/rules.md` and `CHANGELOG.md:2715` assert delivery that was never
  wired.** Correct them in the same change as the globs, or the next reader stops
  asking the question again. `docs/rules.md` also says "twelve" rule skills;
  there are thirteen on disk.
- **`validate.js` forbids the phrase, not the defect.** It fails a skill whose
  `when_to_use` says "Always-on" without a glob; all nine pass today by wording.
  The gate that would have caught this is: `user-invocable: false` AND no
  `paths:` AND not referenced by any user-invocable SKILL.md, then FAIL. That
  belongs to whoever owns the gate lens, not here.
