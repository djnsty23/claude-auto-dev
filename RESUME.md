# RESUME — autodev, 2026-08-24

The machine-specific half of this handoff — which product repos hold which
unpushed branches, and the operator's outstanding decisions — lives in
`~/.claude/memory/`, because it names private projects and this repo is public.
What follows is the part that is true on any machine.

## Why a handoff exists at all

The session that produced this reached **632k average context** over its last
200 requests, against 288k over its first 200, with a 991k peak and 77% of
3,699 requests above 300k. Rule 14c models a 29–46% saving on a reset. A long
thread is also where wrong causal diagnoses cluster, and that session produced
five. Start fresh sooner than feels necessary.

## What just shipped: `b32a742`

**Nine rule skills called themselves "Always-on" with nothing to load them.**

CLAUDE.md states rule-* skills are always-on, auto-loaded by a `paths:` glob.
Measured against the tree: **12 skills claimed Always-on, 3 declared a paths
glob, 9 declared no trigger of any kind.** All nine are also
`user-invocable: false`, so nothing reaches them except the model electing to
call Skill by description.

Among the nine: `rule-gate-integrity`, `rule-diagnosis` and `rule-verification`
— the three skills that describe this exact failure. A mechanism structurally
incapable of firing, wearing a label that reads as coverage.

`validate` now fails any skill claiming Always-on without a `paths:` trigger.
Its first run reported exactly the nine predicted.

**Do not collapse this distinction:** on the machine in question the
`@`-imported `~/.claude/rules/*.md` DID load, and four documented traps recurred
anyway. The portable plugin copies mostly never load at all. Those are two
different failures. Loading is necessary and demonstrably not sufficient.

## Outstanding

**1. Surface parallel work at session start.** `hooks/session-start.js` already
runs on SessionStart. Have it print open branches and PRs —
`git ls-remote --heads origin`, `gh pr list --state all --limit 30` — so a
session about to start work sees that someone else already is.

The option as offered was a hand-maintained claims file at the repo root. That
is the weaker design: it drifts, nothing enforces it, and it would join the
skills nobody invokes. Branches and PRs are already authoritative. **This
reframing has not been put to the operator — do that before building.**

Constraints: `check:hooks` is a hard gate, so a newly wired hook needs its own
suite (model it on `tooling/test-pre-tool-filter.js`, drive it as a subprocess).
A hook with nothing to say must emit **zero bytes on stdout and stderr both**.
Network calls on SessionStart cost every session latency — budget or cache.

**2. The rule corpus is not buying prevention at its current size.** The
always-imported stack measures **175,121 characters, roughly 44k tokens, on
every request of every session**, and the traps it documents recurred in a
session that had all of it in context. Audit for rules that have never fired
versus rules that keep being violated. Measure before cutting; the item above is
what measuring first looks like.

**3. Retire the unused command vocabulary.** Unblocked now that the auto-load
question is answered. 65 skills ship. Across 212 transcripts there are **91
explicit Skill calls in total**, 42 of them `artifact-design`, which is
Anthropic's. `/auto` — the flagship command — has **zero** invocations by either
path. `/audit` has 7. That measurement is authoritative about explicit
invocation and silent about the 3 skills that can auto-load, so it does not show
rules going unread; it shows the command surface going unused. Deleting changes
what autodev advertises itself as, so it is the operator's call.

## A defect left in place, deliberately

`hooks/telemetry.js:131` builds its output path as
`path.join(process.cwd(), '.claude', 'reports')`. The shell's working directory
persists across tool calls, so the hook plants a `.claude/reports/` in every
directory a session cd's into. One landed inside `plugins/autodev-core/skills/`
and broke `validate`, which enumerated it as a skill with no SKILL.md.

`pluginDirs()` and `skillDirs()` now skip dot-directories, so the gate no longer
breaks. **The cwd-relative write itself is untouched** — it is shipped
behaviour and where a hook writes is a separate, deliberate decision.

## Conventions worth re-reading before touching this repo

- `bump.js` is the only correct way to change the version, and **re-read
  `VERSION` immediately before running it** — several sessions share this clone
  and the number moves under you. Two trees sharing a version number is a
  poisoned plugin cache.
- **Never `git commit --amend` here**, and stage explicit paths rather than
  `git add -A`. Concurrent sessions make both dangerous.
- `git commit -F <file>`, never `-m` — the shell eats backticks.
- `check-no-private-names.js` gates the tree. It caught the first draft of this
  file. When a document keeps failing it, the document is trying to be two
  documents; split it rather than redacting.
