# Evidence: generating AGENTS.md from the rule-* skills (2026-09-08)

**Question.** A Codex session in this repo reads `AGENTS.md` (4,200 bytes,
hand-written) while a Claude Code session loads 16 always-on `rule-*` skills
(128,794 bytes) by path glob. Codex is used here for adversarial audits, so the
auditor never saw the conventions it audited against. What should a generator
emit per rule, and does the emitted file change what Codex answers?

**Generator.** `tooling/generate-agents-md.js`. `--measure` prints the table
below from the rules on disk; `--write` regenerates `AGENTS.md`; `--check`
(wired as `npm run check:agents-md`, the seventh step of `npm run gate` and a
CI step) regenerates to a temp path and exits 1 with a diff summary when the
committed file is stale.

## Three variants, measured over the 16 real rules

Reproduce: `node tooling/generate-agents-md.js --measure`. "Dated claim" is a
body paragraph carrying `[measured …]`, `[stated …]` or an ISO date. There
are 25 such paragraphs spanning 30 lines.

| variant | what it emits per rule | bytes | dated claims kept |
|---|---|---|---|
| A | full body | 128,384 | 25 of 25 |
| **B** (emitted) | description, `paths:`, first paragraph, dated **paragraphs** (+ the fence one introduces), `**Never`/`**Always` lines | **21,233** | **25 of 25** |
| B′ | as B, but dated **lines** instead of paragraphs (the brief's literal shape) | 14,673 | 2 of 25 |
| C | description only | 7,044 | 0 of 25 |

**The brief's shape had to be adjusted, and the measurement is why.** It asked
for "every line that starts with a measured/dated marker". Over the real rules
that keeps zero claims: no marker begins a line. Markers sit mid-sentence in
wrapped paragraphs, so the line shape keeps 30 fragments such as

> `[measured 2026-09-01]` `codex debug prompt-input` renders 44,220 bytes of

and only 2 of those fragments are whole claims. B′ is 6.5 KB cheaper than B and
buys nothing a reader can act on. B is the smallest variant that keeps every
dated claim. It lands at 21.2 KB against the brief's "about 20 KB"; the excess is
`rule-local-first`, whose 13 dated paragraphs (5.4 KB) are host-specific and
say so in the rule. `when_to_use` was dropped from B after measuring it: it
restates the description in 15 of 16 rules and cost 1,701 bytes.

Per rule, from the same run:

| rule | SKILL.md bytes | dated paragraphs | dated lines | Never/Always lines |
|---|---|---|---|---|
| rule-ab-testing | 8,450 | 0 | 0 | 0 |
| rule-agent-concurrency | 7,469 | 4 | 4 | 1 |
| rule-design-system | 2,876 | 1 | 1 | 0 |
| rule-diagnosis | 10,592 | 1 | 1 | 0 |
| rule-file-organization | 1,808 | 0 | 0 | 0 |
| rule-gate-integrity | 23,022 | 3 | 3 | 0 |
| rule-local-first | 18,047 | 13 | 17 | 0 |
| rule-options-protocol | 10,538 | 0 | 0 | 0 |
| rule-ramifications | 5,832 | 0 | 0 | 0 |
| rule-record-size | 8,634 | 0 | 0 | 0 |
| rule-report-shell | 4,152 | 1 | 1 | 0 |
| rule-security | 782 | 0 | 0 | 0 |
| rule-thumb-first | 6,857 | 0 | 0 | 0 |
| rule-verification | 8,294 | 0 | 0 | 0 |
| rule-windows | 6,576 | 2 | 3 | 1 |
| rule-workflow-spine | 4,865 | 0 | 0 | 1 |

Nine rules carry no dated claim at all, and `rule-ab-testing`, the rule the
Codex question below targets, is one of them: its evidence is a 16-row table of
reversals, none dated. For those nine, B reduces to description + first
paragraph, which for `rule-ab-testing` is the sentence that answers the
question ("measure it against what happens today and against at least one
alternative").

## Re-measured after merging main f870b15 (release 8.165.0)

The tables above were measured at base 99bb597. Between that and the merge,
`rule-agent-concurrency` gained 70 lines and `rule-gate-integrity` 33, two of
them dated. `check:agents-md` went red on the merge (first difference: the
version line), which is the drift it exists to catch. Same command, same day:

| variant | bytes | dated claims kept |
|---|---|---|
| A | 133,422 | 27 of 27 |
| **B** (emitted) | **22,231** | **27 of 27** |
| B′ | 14,827 | 2 of 27 |
| C | 7,044 | 0 of 27 |

AGENTS.md after regeneration: 27,786 bytes. The ordering and the conclusion
did not move; the numbers did, and a number in prose is only correct on the
day it is typed, so the generated file carries its own table computed at
generation time rather than quoting this one.

## The file before and after

| | bytes |
|---|---|
| AGENTS.md before, hand-written | 4,200 |
| hand-maintained section after (above the marker) | 5,128 |
| generated section after (below the marker) | 21,660 |
| AGENTS.md after | 26,788 |
| the 16 rules it was distilled from | 128,794 |

**Kept from the hand-written file**, verbatim: "What is true for you and not
written there" (cold start, the repo as the only channel, incremental writes,
recovery paths, caller timeouts, claims carry their command, the 44,220-byte
`codex debug prompt-input` measurement, sandbox width), "Working on the Codex
integration itself", and "Scope". None of it is derivable from a rule.
**Rewritten**: the intro and "Why this is a pointer and not a copy", which
argued against ever repeating guidance here. The argument was that two documents
saying the same thing means one is wrong and nothing reports which; the rewrite
keeps the failed find-replace incident and states the condition under which the
rules ARE now repeated, namely that a gate reports which one is stale.

## Gate integrity

- `--check` runs the real generator to a temp path and compares; it never
  regenerates in place and reads its own output.
- Population floor: zero rules is exit 2 with "read 0 rules", not an empty green
  file. A rule with no frontmatter or no description is exit 1 naming the file,
  and `--check` is red in that state rather than green by absence.
- Canary, run by hand: mutating the generator to the line shape (B′) turned
  exactly two of 41 assertions red, "wrapped dated paragraph survives WHOLE in
  variant B" and "committed AGENTS.md is current", which were the two predicted.
  39 stayed green.
- Private names: `tooling/check-no-private-names.js --check-text` over the
  generated text exits 0, asserted in the suite on every run. The rules are
  written for this public repo, but AGENTS.md is a new file the digest gate must
  also see.
- Bare invocation exits 2 with usage; `--help` returns immediately, so the
  entry-point gate (`check:entrypoints`) passes.

## Codex before/after — COULD NOT CHECK

The number that decides whether the generator is worth its gate is whether Codex
answers the fixed question differently with the generated file present:

> Before proposing a detector or a gate here, what must be measured first, and
> against what?

The right answer names a baseline and at least one variant (`rule-ab-testing`).
On this machine, 2026-09-08:

```
$ codex --version
zsh: command not found: codex
$ ls ~/.codex
ls: /Users/…/.codex: No such file or directory
```

The Codex CLI is not installed here, so neither the before nor the after answer
was collected. Recorded as COULD NOT CHECK rather than inferred. To close it once
Codex is available, run from the repo root, once at the parent of this PR's
merge and once at its head, and paste both answers verbatim below:

```
codex exec "Before proposing a detector or a gate here, what must be measured first, and against what?"
```

Until then the claim this PR can make is the byte-level one in the tables above:
the conventions are now in the file Codex reads, at 21.2 KB rather than 128 KB,
with a gate that fails the build when they drift. Whether Codex *uses* them is
unmeasured.
