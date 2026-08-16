---
name: rule-diagnosis
description: "Diagnosis is the load-bearing step, not the fix. A wrong fix costs one cycle; a wrong diagnosis costs every cycle until someone questions the premise. Reproduce before explaining, suspect the frame before inventing a mechanism, and attribute a failure before repairing it. Load before proposing any cause, fix, or explanation."
when_to_use: "Always-on. Applies the moment you are about to say why something is happening. Not user-invocable."
user-invocable: false
allowed-tools: Read, Grep, Glob, Bash
---

# Diagnose before you fix

**A wrong fix costs one cycle. A wrong diagnosis costs every cycle until someone
questions the premise.** That asymmetry is the whole reason this is a first-class
rule and not a footnote: repeated QA rounds are almost never caused by sloppy
edits, they are caused by a confident explanation nobody re-examined.

The failure is rarely bad reasoning. It is sound reasoning on an unexamined
frame — one machine, one state, one suite, one shape — where the observation was
real and the conclusion still wrong.

## 1. Reproduce it, in the state it actually happens

An explanation that has not been reproduced is a guess wearing a lab coat.
Reproduce in the state the user is in, not the state that is convenient.

A refactor was narrowed and half-abandoned because ambient colours "computed
identically in every mood, and no CSS rule set them" — measured while signed
out, where `body.lockOpen` deliberately pins them. Nothing was broken. The
measurement was taken in the wrong state, and the diagnosis inherited that.

**Before explaining: can I make it happen on demand?** If not, say so, and say
which way you are guessing.

## 2. When two sources disagree, suspect the FRAME before inventing a mechanism

The cheap hypothesis is that you measured the wrong thing, in the wrong place, or
at the wrong time. The expensive one is that the system has an exotic mechanism
you had not heard of. **Reach for the cheap one first.**

| the observation | the mechanism invented | the real frame error |
|---|---|---|
| two plugin registries listed different marketplaces | "the config directory must be redirected" | **two different machines** |
| ambient colours identical in every mood | "the per-mood values are dead code" | measured behind a sign-in lock that pins them |
| four gate tests failed | "four gates fired correctly" | a dropped comma broke the JSON; everything threw |
| 56 mutants survived | "that is the debt" | measured against 2 of the subject's 6 suites |
| a fix existed on no branch or worktree | "it was never written" | it had shipped two minutes earlier, in a third shape |

**The tell:** you are constructing an explanation whose job is to make two
incompatible observations both fit. Stop there and ask what would have to be true
for both to be ordinary.

A contradiction is information about your frame. It is not an invitation to build
a theory that rescues it.

## 3. Read the actual failure text, never the summary

> `4 tests failed` and `4 gates fired` look identical from the summary line.

Counts, exit codes and status lines are compressions, and every compression
discards the thing that distinguishes a real failure from a broken harness. Open
one case by hand and read what it actually said.

The same applies to success. `✓ Updated 1 marketplace` was printed while nothing
was fetched — the disk was 53 commits behind both before and after. **A status
line is a claim, and the artefact is the evidence.**

## 4. Attribute before you repair

When something goes red after a change, establish *whose* change before fixing or
reverting. The instinct to fix immediately destroys the evidence.

A byte-budget gate failed after a rebase. A worktree at `HEAD~1` settled it in
one command: green there, red one commit later, with upstream sitting at 4.94%
against a 5% tolerance and the new commit adding the 0.09% that crossed it. The
drift belonged to everyone; the red branch belonged to me. Both facts mattered,
and neither was guessable.

**Bisect one step before theorising.** `HEAD~1` in a worktree, or the same
command in the state before the change, is usually enough.

## 5. Say what would change your mind

Write the disconfirming observation down *before* you go looking. A diagnosis
with no stated falsifier is a belief.

This is also the cheapest way to catch a frame error: "if this were true, X would
also be true" surfaces the unexamined assumption faster than more evidence for
the thing you already think.

## 6. A gate is what you add when diagnosis failed

Every gate has a standing cost: it runs on every push, it needs its own tests, it
can pass while proving nothing, and it competes for attention with the gates that
matter. A wall of them reads as rigour and is often the opposite — each one is a
class somebody decided not to reason about.

**Diagnose the class first. Add a gate only when it recurs, or when the cost of
missing it once is unacceptable.** The right questions, in order:

1. Was this a one-off frame error, or a class this codebase keeps producing?
2. Would a correct diagnosis have prevented it, without any new machinery?
3. If a gate is genuinely warranted, does an existing one already cover it?

One session here shipped four detectors and two floors in a day. The detectors
that earned their place found things nothing else could see — a hook nobody
tested, a CLI command that could be claimed without being announced. The floors
existed because that same session's own tooling could report a clean population
it had never read. That second kind is not rigour, it is a patch over a
diagnosis that was skipped.

**Fewer gates, better diagnosed, beats more gates.**

## Before you present a cause

- [ ] I reproduced it, in the state where it actually occurs.
- [ ] I can name the observation that would prove me wrong.
- [ ] Where sources disagreed, I questioned the frame before the mechanism.
- [ ] I read the real failure text, not a count or a status line.
- [ ] If something went red after a change, I attributed it before fixing it.
- [ ] Where I could not measure, I said so and said which way I am guessing.
- [ ] If I am proposing a new gate, I said why diagnosis alone will not hold.
