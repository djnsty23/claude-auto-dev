---
name: rule-diagnosis
description: "A wrong fix costs one cycle; a wrong diagnosis costs every cycle until someone questions the premise. Reproduce before explaining, suspect the frame before inventing a mechanism, and attribute a failure before repairing it. Load before proposing any cause, fix, or explanation."
when_to_use: "Before stating why something is happening — any cause, fix, or explanation, including one that looks obvious."
user-invocable: true
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

## 4. Ask which artifact ANSWERS the question, before reading one that is near it

Every artifact is authoritative about one layer and silent about the others, and
the dangerous ones are silent while sounding current. **A migration, a code
comment, a PR body and a memory file all record what was true WHEN THEY WERE
WRITTEN.** They do not update when the world moves, and nothing marks the moment
they stop being true.

For "is this built, and how does it work today", the authoritative sources are the
repo's own agent-facing instructions — `AGENTS.md`, `CLAUDE.md`, `README` — plus
the config that activates the thing and the git log. Read those first. They are
maintained precisely because they are read first.

| the question | what answers it | what merely mentions it |
|---|---|---|
| is this capability live? | `AGENTS.md` / `CLAUDE.md`, the env var that switches it, the deploy | a migration header, a TODO, a memory file |
| which backend does it use? | the config the running code reads | a credentials map, which is authoritative about credentials and silent about consumers |
| did this land? | `git log`, `gh pr view` | a commit body saying "fixes", a doc saying "planned" |

**The incident.** `[measured 2026-08-27]` A session read the header of a migration
dated six weeks earlier, which described a data-in-git problem in the present
tense **as of that date**, and concluded the problem was present now. It wrote a
brief, a repo document and a memory file all asserting a stalled migration, then
handed an agent a backfill to run.

The cutover had completed five weeks before. `AGENTS.md` line 123 said so in plain
text and named the correct project; `CLAUDE.md`, `ROUTINES.md` and `.gitignore`
agreed. None was read. The brief also named the wrong database, taken from a
memory file rather than from the repo.

Running it would have overwritten **46 live documents** and reset every
optimistic-concurrency token, one from version **15085 to 1**.

**Two tells, both cheap.** The session counted 39 old-path call sites and read
coexistence as *stalling* — but the module's own header explained why both paths
remain, and that sentence had been quoted into the write-up without being
connected. And every input it used was secondary: a migration, a comment, its own
notes. **If no primary source is in your evidence list, you have not checked yet.**

**This is the worse direction of a stale claim.** A stale "already fixed" surfaces
the moment somebody looks. A stale "not done yet" sends someone to redo finished
work, and work not attempted emits no failure, no diff and no signal — so it can
stand indefinitely, and here it very nearly destroyed the thing it meant to
protect.

### Same rule for WHO said it: cite the message, never recall it

**Availability is not reading, and having a source in context is not having read
it.** The failure above used a migration header while the answer sat in
`AGENTS.md`. The same day, a peer writing a critique of that session
misattributed two of its errors to a different session — with the message it was
describing *in its own context window* — inside a paragraph headed "if you are
writing a self-assessment off recall, that is the first thing to re-check".

It conceded in one turn and left the rule, which is better than the apology:

> A peer critique that names WHO did something must cite the message it is
> reading, not recall it. Nothing about having the source available makes you
> read it.

**And peer identity is not self-evident from a message.** That fleet had two
sessions both presenting as a coordinator. Neither could attribute an error to
the other without checking, and the peer could not attribute one to the session
it was grading. Every party assumed identity was obvious: the session about its
own history, the peer about that session's.

So before writing "you said X" or "that was you": open the message. Before
accepting "you said X" about yourself: open it too. A critique whose opening
claim is unverified is worth less than one whose is, and the author is usually
the last to notice which kind they wrote.

## 5. Attribute before you repair

When something goes red after a change, establish *whose* change before fixing or
reverting. The instinct to fix immediately destroys the evidence.

A byte-budget gate failed after a rebase. A worktree at `HEAD~1` settled it in
one command: green there, red one commit later, with upstream sitting at 4.94%
against a 5% tolerance and the new commit adding the 0.09% that crossed it. The
drift belonged to everyone; the red branch belonged to me. Both facts mattered,
and neither was guessable.

**Bisect one step before theorising.** `HEAD~1` in a worktree, or the same
command in the state before the change, is usually enough.

## 6. Say what would change your mind

Write the disconfirming observation down *before* you go looking. A diagnosis
with no stated falsifier is a belief.

This is also the cheapest way to catch a frame error: "if this were true, X would
also be true" surfaces the unexamined assumption faster than more evidence for
the thing you already think.

## 7. A gate is what you add when diagnosis failed

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
- [ ] For any claim about WHO said or did something, I opened the message rather
      than recalling it.
- [ ] At least one PRIMARY source is in my evidence: the agent-facing docs,
      the activating config, or the git log. Not only a comment or a memory file.
- [ ] If something went red after a change, I attributed it before fixing it.
- [ ] Where I could not measure, I said so and said which way I am guessing.
- [ ] If I am proposing a new gate, I said why diagnosis alone will not hold.
