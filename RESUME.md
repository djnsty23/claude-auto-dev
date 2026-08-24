# RESUME — autodev, 2026-08-24

The machine-specific half of this handoff — which product repos hold which
branches, and the operator's decisions — lives in `~/.claude/memory/`, because
it names private projects and this repo is public.

## Why a handoff exists at all

The session that produced this reached **632k average context** over its last
200 requests, against 288k over its first 200, with a 991k peak and 77% of
3,699 requests above 300k. Rule 14c models a 29–46% saving on a reset. A long
thread is also where wrong causal diagnoses cluster, and that session produced
five. Start fresh sooner than feels necessary.

## Shipped on `fix/always-on-without-a-trigger` (pushed)

**`b32a742` — nine rule skills called themselves "Always-on" with nothing to
load them.** CLAUDE.md states rule-* skills are always-on, auto-loaded by a
`paths:` glob. Measured: **12 claimed Always-on, 3 declared a paths glob, 9
declared no trigger of any kind.** All nine are also `user-invocable: false`, so
nothing reaches them except the model electing to call Skill by description.

Among the nine: `rule-gate-integrity`, `rule-diagnosis` and `rule-verification`
— the three that describe this exact failure. `validate` now fails the claim
without the trigger; its first run reported exactly the nine predicted.

**Do not collapse this distinction:** on the machine in question the
`@`-imported `~/.claude/rules/*.md` DID load, and four documented traps recurred
anyway. The portable plugin copies mostly never load at all. Loading is
necessary and demonstrably not sufficient.

**`57ce7c6` — SessionStart now says when someone else is already in this repo.**
One line, only when there is something to say: other worktrees by branch name,
and origin branches not merged into main. Local refs only, because this runs on
every session start and `ls-remote`/`gh` are network calls — so the output says
"as of the last fetch" and names the authoritative commands rather than implying
freshness it does not have.

The negative case is the point: a solitary clone gets nothing, and that silence
is asserted. Mutation-tested — never-emit killed 5 assertions, always-emit
killed the silence assertion, revert byte-identical.

**`eb56f2c`** — this file, split so the public half can be public.

## Outstanding

**1. The rule corpus is not buying prevention at its current size.** The
always-imported stack measures **175,121 characters, roughly 44k tokens, on
every request of every session**, and the traps it documents recurred in a
session that had all of it in context. Audit for rules that have never fired
versus rules that keep being violated. Measure before cutting — `b32a742` is
what measuring first looks like, and it changed the answer.

**2. Retire the unused command vocabulary.** Unblocked now that the auto-load
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

`pluginDirs()` and `skillDirs()` now skip dot-directories, so the gate survives
it. **The cwd-relative write itself is untouched** — it is shipped behaviour and
where a hook writes is a separate, deliberate decision.

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
