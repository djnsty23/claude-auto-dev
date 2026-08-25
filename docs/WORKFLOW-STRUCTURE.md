# Workflow structure and peer protocol

The canonical shape for a substantive task on this fleet, and the protocol for
talking to other sessions while it runs.

Everything numbered below is checkable. Where a rule is a choice rather than a
measurement, it says so and is marked **proposal**.

Evidence: [`docs/evidence-workflow-runs.md`](evidence-workflow-runs.md)
(52 workflow runs, 280 agents, 895 transcripts) and
[`docs/evidence-peer-traffic.md`](evidence-peer-traffic.md) (456 sends, 348
deliveries). Both `[measured 2026-08-25]` on one machine.

Revised 2026-08-25 against three adversarial lenses (cost, correctness,
adoption). What survived is folded in below; what was rejected is recorded in
[Part 6](#part-6-objections-rejected-and-why) so the next session does not
re-raise it.

---

## Part 0: the card

**Read this part. The rest is why.**

### D0 — should this be a workflow at all?

Run the work **inline on the main thread** unless BOTH hold:

- the task needs more than roughly **40 main-thread turns**, and
- it **splits into file sets that do not overlap**, so two readers never need the
  same file.

One fails → inline. Both hold → the shape below.

This test is first because the doc had no branch for *not* running a workflow,
and a six-agent workflow is not free: each agent's first request pays a **cold
cache write at 1.25x input**, so six agents buy six cold caches before any of
them reads anything. `[measured]` A wall lands on whatever is in flight; the
cheapest run is the one that never started. **Proposal:** 40 turns is chosen,
not measured — it is where six cold caches stop being the larger term.

### The shape, once D0 passes

```text
S0 brief     main thread   write the brief to a file, run the two dup checks
S1 survey    1 agent   serial     sonnet   -> path + lenses + 5 bullets  600 chars
S2 coverage  2-3 agts  parallel   opus     -> path + count + top 3       800 chars each
S3 synthesis 1 agent   serial *   opus     -> path + sections            600 chars
S4 attack    1 agent   serial     opus     -> path + count + top 3       800 chars
S5 revise    1 agent   serial     opus     -> delta only                 400 chars
S6 gate      main thread   npm test (or the repo's gate), read the file
                                       * the only read-time data dependency
```

### The numbers

| rule | number |
|---|---|
| concurrent agents | **3-4 normal, 5-6 for a deep sweep** |
| agents per workflow | 6 |
| schema string field | 2,048 chars, silent truncation, 5 retries |
| total returned to the main thread | ≤4,000 chars |
| attack rounds | exactly 1 |
| main-thread dispatches per task | 1 |
| reset the session at | ~300k context |

Concurrency matches `plugins/autodev-core/skills/rule-agent-concurrency/SKILL.md`,
which ships and is always-on. An earlier draft of this doc said "cap 2, ceiling
3" and would have forked from it. See [F2](#f2-width-is-blast-radius-not-a-loss-rate).

### The five things that cost the most

1. **Naming a file path in the return and pasting the file anyway.** 88 of the
   129 returns that named a path (**68%**) also exceeded 10,000 characters.
2. **Naming a path you never wrote.** Only 49 agents ever called `Write`/`Edit`,
   so **at least 39 of those 88** cited a file that does not exist. Downstream
   stages then open nothing.
3. **A serial stage restating the artifact instead of a delta.** Peak 113,915
   chars re-emitting one document 15 times.
4. **Six main-thread dispatches instead of one workflow.** Each re-reads 405k.
5. **A long session.** The second half costs 1.44x the first for the same turns.

### Before starting anything

```bash
git ls-remote --heads origin | grep -i '<topic>'
gh pr list --state all --limit 30
```

### Where this document must live to be read

`docs/` never ships (CLAUDE.md: everything outside `plugins/` is repo machinery)
and this file has **zero inbound references** — `grep -rl WORKFLOW-STRUCTURE`
across every `.md`, `.js` and `.json` in the repo returns nothing but itself. As
a file in `docs/`, nothing makes any session read it. [Part 7](#part-7-delivery)
is the fix and is the highest-value change here.

---

## Part 1: the standard shape

Six agents, one main-thread dispatch, five phases. Default once D0 passes;
Part 2 says when to leave it.

| step | what it does | shape | agents | model | returns to the main thread |
|---|---|---|---|---|---|
| **S0 Brief** | Main thread writes the task brief to a file in the repo and runs the two duplicate-work checks | main thread, no agent | 0 | n/a | n/a |
| **S1 Survey** | Reads the repo against the brief. Produces an inventory: files, prior art, open PRs, and the two or three lenses S2 will use | serial, first | 1 | `sonnet` | path + lens list + 5 bullets + one unknown, **≤600 chars** |
| **S2 Coverage** | One agent per lens named by S1. Each reads a disjoint file set and writes its own findings file | parallel, 2-3 | 2-3 | `opus` | path + finding count + top 3 one-liners, **≤800 chars each** |
| **S3 Synthesis** | Reads the S2 **files** from disk and writes the deliverable | serial, dependency after S2 | 1 | `opus` | path + section list + one open question, **≤600 chars** |
| **S4 Attack** | Reads the deliverable file, tries to refute it, writes numbered findings to a review file. Exactly one round | serial | 1 | `opus` | path + finding count + top 3, **≤800 chars** |
| **S5 Revise** | Applies the review. Returns a **delta**, never the document | serial | 1 | `opus` | changed section names + what changed + findings rejected and why, **≤400 chars** |
| **S6 Gate** | Main thread runs `npm test` (or the repo's gate) and reads the deliverable file | main thread, no agent | 0 | n/a | n/a |

Total returned to the main thread: **≤4,000 characters, about 1,000 tokens.** The
measured median return today is 12,933 characters per agent, so six ordinary
agents put roughly 77,600 characters (about 19,400 tokens) into a thread that then
re-reads them on every subsequent turn. The worst single run measured put 658,588
characters, about 165,000 tokens, into one main thread from 30 agents.

### Why each shape is what it is

**S1 is serial and first because nothing downstream can be briefed without it.**
A coverage wave commissioned before anyone has read the repo is N agents guessing
at the same lens. Measured: parallel agents given the same brief produce answers
with mean pairwise similarity 0.008, which sounds like healthy diversity and in
practice means they answered different questions, only one of which was asked.

**S2 is the only parallel stage.** Coverage parallelises because the lenses are
independent: no lens needs another lens's output, so holding them apart would buy
nothing and cost the fast one its idle time. Coherence does not parallelise.
Designing, deciding, and writing one document are S3 through S5, and they are
serial for that reason.

<a name="f2-width-is-blast-radius-not-a-loss-rate"></a>
**Width is blast radius, not a loss rate — and this doc previously got that
backwards.** Two facts have to be held apart:

- **Given a wall lands, width is exactly how much dies.** `wf_8419f91d`: 6
  parallel agents, 6 `<synthetic>` rows, 6 lost. A serial chain would have lost
  one and journaled the rest. This is true and is the reason to narrow when a
  wall is *plausible*.
- **Width does not predict whether a wall lands.** The same evidence file refutes
  that: mixed runs at maxConc 7 and 10 lost **7%**, and `wf_1b4aecc9` ran **30
  agents at concurrency 16 and journaled 30 of 30** — the evidence file's own
  words, "width did not break it". Meanwhile `single` runs, one agent at
  concurrency 1, lost **67%** (2 of 3). If width drove loss, that column is
  impossible.

The 48% headline for parallel is real but confounded: 3 of the 4 quota-wall runs
happened to be parallel, over 12 runs and 54 agents. Quota timing drives loss;
width only sizes it. So the prescription is **not** a blanket cap of 2 — it is:
narrow when a wall is plausible (D6), and make loss survivable (D9, C8).

**S3 is the one read-time data dependency.** Its prompt is writable at S0 — it is
a static glob, `${OUT}/lens-*.md`. What it cannot do is *run* before the S2 files
exist on disk. That distinction matters: an earlier draft tested barriers by
asking "can I write the next prompt now?", which S3's static glob passes, so the
test deleted the one dependency the doc calls legitimate. See
[D1](#d1-hold-a-stage-back).

**S3 reads files, not returns.** The S2 agents each wrote a file; S3 is told the
glob and opens the files itself. This is why the S2 return budget can be 800
characters without losing anything.

**S4 runs exactly once.** Loop-until-dry does not converge: an adversary told to
output DRY if the work is sound finds findings anyway, because that is what it was
asked to do. Two workflows ran to their agent cap with zero dry passes. One
bounded round, then a human reads the delta.

**S5 returns a delta because serial chains are where duplication actually lives.**
Measured: parallel pairs have mean pairwise similarity 0.008 and max 0.060. Serial
pairs mean 0.072 with peaks of 0.710, 0.672 and 0.546, and all 19 pairs above 0.25
sit in three serial refine chains. One chain returned 113,915 characters
re-emitting the same document 15 times.

**This repo's own `heal-sweep.workflow.js` breaks three of these rules and is
still live.** `[measured 2026-08-25]` at
`plugins/autodev-core/scripts/heal-sweep.workflow.js`: line 240 inlines
`JSON.stringify(found.findings, null, 1).slice(0, 90000)` into a stage that could
have been handed a path, lines 293 and 296 do the same at 60,000 each, and **none
of its three `agent()` calls carries a `model:` pin** — `grep -n "model:"` on that
file returns nothing. It is the only `.workflow.js` in the repo and it fails the
gate proposed in [Part 7](#part-7-delivery). That is not a coincidence: it is the
reason the gate is worth writing.

### Construction rules for the brief

These apply to every agent prompt in the shape.

1. **Name the file the agent must write, in the prompt, as a repo-relative path.**
   Agents that called Write or Edit returned a median 5,217 characters. Agents that
   wrote nothing returned 13,389, which is 2.6x more. Only 56 of 280 agents (20%)
   wrote anything, and the write-less 79% produced 86% of every character returned.
2. **Say "do not paste the file's contents into your return" in the prompt.** 88
   returns named a file *and* exceeded 10,000 characters. That is **68% of the 129
   returns that named a path** (it is 37% of all 238 results — an earlier draft
   printed the 37% against the wrong denominator). Worse: only 49 agents ever
   called `Write`/`Edit`, so **at least 39 of those 88 named a path that was never
   created**. The evidence file's own sentence, "88 returns wrote a file and pasted
   the content back anyway", overstates this — most of them did not write one. Ask
   for the path *and* verify it exists at S6.
3. **Never depend on a skill firing by keyword match.** 259 active skills compete
   for a listing budget of about 2,000 characters, roughly 8 characters each, and
   when the listing overflows Claude Code drops descriptions starting with the
   least-invoked skills. 39 of 42 `autodev-core` skills reach the model as a bare
   `plugin:name` with no description, so their trigger text never arrives.
   `[measured 2026-08-25, in this session's own skill listing]`
   `autodev-core:rule-agent-concurrency` arrived as a bare name with no
   description, while `rule-diagnosis` and `rule-thumb-first` arrived with theirs
   intact — and `rule-thumb-first` is one of the five skills carrying a `paths:`
   glob. A step either names the skill explicitly in its prompt or carries its own
   instructions inline. Do not add a keyword-triggered skill to fix anything.
4. **Every `agent()` call carries an explicit `model`.** Agents inherit the session
   model when unpinned, and 186 of 280 agent meta files declare no model. One
   measured inheritance ran a plan at 1.8M tokens on the 2x tier against 679k for
   equivalent work.
5. **Keep every schema string field short.** The cap is **2,048 characters**, it
   truncates silently mid-token, and the retry loop then burns five full
   generations rewriting the same too-long prose into the same wall. Measured: of
   280 agents, exactly 2 carry `__unparsedToolInput`, and one of them is five
   attempts at exactly 2,048 characters each, every one severed mid-word. That run
   is one of seven runs that journaled zero results.
6. **Declare every field the script reads back.** A structured return only carries
   what the schema declares. Reading `survey.lenses` when the schema has no
   `lenses` throws at the first stage boundary, after S1 has already been paid
   for. The skeleton below carried exactly this bug until 2026-08-25.

### The skeleton

The runner is harness-provided: a `.workflow.js` file exports `meta`, receives
`args`, and calls injected `agent()`, `pipeline()` and `log()` at top level with
`await`. Width comes from how many items you hand `pipeline`, so the item list is
the concurrency control.

```js
export const meta = {
  name: 'task-name',
  description: 'one line',
  whenToUse: 'one line',
  phases: [
    { title: 'Survey',    detail: 'inventory the surface and name the lenses' },
    { title: 'Coverage',  detail: 'one agent per lens, disjoint file sets' },
    { title: 'Synthesis', detail: 'read the lens files, write the deliverable' },
    { title: 'Attack',    detail: 'one bounded round of refutation' },
    { title: 'Revise',    detail: 'apply the review, return a delta' },
  ],
}

// Every string field truncates SILENTLY at 2048 chars, then retries 5 times.
const PTR = {
  type: 'object',
  properties: {
    file:    { type: 'string', description: 'Repo-relative path you wrote. Path only.' },
    summary: { type: 'string', description: 'At most 5 bullets, 600 chars total. NOT the file contents.' },
    unknown: { type: 'string', description: 'The one thing you could not determine, or "none".' },
  },
  required: ['file', 'summary', 'unknown'],
}

// S1 needs its own schema: the script reads survey.lenses, so `lenses` must be
// DECLARED. PTR alone throws at the pipeline() below. Two lenses cost about 150
// chars, so this does not strain the 600-char summary budget - the budget is on
// `summary`, and `lenses` is a separate field.
const SURVEY = {
  type: 'object',
  properties: {
    ...PTR.properties,
    lenses: {
      type: 'array',
      description: 'Two or three independent lenses. Disjoint file sets.',
      items: {
        type: 'object',
        properties: {
          name:  { type: 'string', description: 'Short lens name, e.g. "cost".' },
          slug:  { type: 'string', description: 'Filename-safe, e.g. "cost".' },
          files: { type: 'string', description: 'Glob or path list. Must not overlap another lens.' },
        },
        required: ['name', 'slug', 'files'],
      },
    },
  },
  required: [...PTR.required, 'lenses'],
}

const BRIEF = args.brief   // repo-relative, written by the main thread before dispatch
const OUT   = args.out     // directory the agents write into

const survey = await agent(
`Read ${BRIEF}. Inventory what exists: the files in scope, prior art, and any open
branch or PR touching them. Then name TWO independent lenses the next stage
should use. A lens is independent if its file set does not overlap another's.

Write the inventory to ${OUT}/survey.md. Return the path, the lenses, and at most
five bullets. Do NOT paste the inventory into your return.`,
  { label: 'survey', phase: 'Survey', model: 'sonnet', schema: SURVEY })

// Fail loudly rather than at a property access three lines down.
const lenses = Array.isArray(survey.lenses) ? survey.lenses.slice(0, 3) : []
if (lenses.length < 2) throw new Error(`survey returned ${lenses.length} lenses; need 2-3`)

// Coverage: item count IS the concurrency. 2-3 here; see D3 before widening.
const found = await pipeline(
  lenses,
  (lens) => agent(
`Read ${BRIEF} and ${OUT}/survey.md. Your lens: ${lens.name}. Your files: ${lens.files}.
Do not read outside that set; another agent has it.

Write your findings to ${OUT}/lens-${lens.slug}.md, numbered F1, F2, ...
Return the path, the finding count, and the top three as one line each.`,
    { label: `lens:${lens.slug}`, phase: 'Coverage', model: 'opus', schema: PTR })
)

const draft = await agent(
`Read ${BRIEF} and every file in ${OUT}/lens-*.md. Open them yourself; they are on
disk. Write the deliverable to ${OUT}/deliverable.md.

Return the path, the section names, and the one question you could not settle.`,
  { label: 'synthesis', phase: 'Synthesis', model: 'opus', schema: PTR })

const review = await agent(
`Read ${OUT}/deliverable.md and try to REFUTE it. Default to refuted when unsure:
a false finding produces a change to working code, which is worse than nothing.

Write numbered findings to ${OUT}/review.md. ONE round. Do not ask for another.
Return the path, the count, and the top three.`,
  { label: 'attack', phase: 'Attack', model: 'opus', schema: PTR })

await agent(
`Read ${OUT}/deliverable.md and ${OUT}/review.md. Apply what survives. Edit the
deliverable in place.

Return ONLY a delta: which sections changed, what changed in each, and which
findings you rejected with the reason. Never restate the document.`,
  { label: 'revise', phase: 'Revise', model: 'opus', schema: PTR })
```

**Proposal, not a finding:** the return budgets (600/800/600/800/400) are chosen,
not measured. They come from wanting the six-agent total under about 1,000 tokens.
Nothing measured says 800 is better than 500 or 1,200.

**Proposal:** the claim that this shape costs one main-thread turn rather than six
is an inference, and the comparison has to be stated precisely or it misleads in
both directions. It compares **six agents dispatched one-per-main-thread-turn**
against **the same six agents inside one workflow**. The agent-internal cost is
identical on both sides and cancels; what differs is main-thread turns, so the
saving is roughly five re-reads of 405k. It is **not** a comparison against doing
the work inline with no agents — that is D0, and it runs the other way.

**Population caveat on the 155k figure.** 155k is the mean subagent request across
one quota window, a fleet average that includes sonnet scouts and long-running
agents. An opus agent in this shape reads a brief, a survey and one or two lens
files, which is plausibly well under 155k — so the true per-agent cost here is
unmeasured and probably lower. Do not quote 155k as this shape's number.

---

## Part 2: when to deviate

Each condition is a yes/no test or a command. If the test does not pass, keep the
default. **D0 in [Part 0](#d0--should-this-be-a-workflow-at-all) comes first: it
is the only test that can send you out of the shape entirely.**

<a name="d1-hold-a-stage-back"></a>
**D1: hold a stage back.** Correct only when stage N has a **read-time data
dependency** on stage N-1: its prompt may be writable now, but running it before
the N-1 artifacts exist reads an empty or partial set. The test is *what does this
agent open, and does it exist yet?* — not *can I type the prompt yet?* S3 passes:
its glob `${OUT}/lens-*.md` is writable at S0 and matches nothing until S2 lands.
An earlier draft used the prompt-writability test, which S3's static glob passes,
so the test deleted the one dependency this doc calls legitimate.

**D2: run a second attack round.** Only when both hold: a human read S5's delta,
and that delta changed a decision rather than wording. Never arm an automatic
loop. Measured: two loop-until-dry workflows ran to their agent cap with zero dry
passes, because a model asked to find findings finds findings.

**D3: add a third coverage agent.** Only when S1 named at least three lenses
*and* each maps to a file set disjoint from the others. Run
`git ls-files <set-a> <set-b> <set-c>` and confirm no overlap. Ceiling: 3-4
concurrent normally, 5-6 for a deep sweep, 6 agents per workflow — matching the
shipped `rule-agent-concurrency`. Overlapping lenses are the real cost of width,
not the agent count: two agents on the same file produce two answers to one
question.

**D4: skip S1 Survey.** Only when the brief already names the exact files to
change and both of these return nothing relevant:

```bash
git ls-remote --heads origin | grep -i '<topic>'
gh pr list --state all --limit 30
```

Those two commands are never skippable, survey or no survey. Two sessions in this
repo independently gated the same defect class an hour apart and one PR deleted
the other's work.

**D5: skip S4 Attack.** Only when the deliverable has a mechanical gate that can
fail, that gate is wired, and it is green. `npm test` here runs every
`tooling/test-*.js` then `validate`. If no such gate exists for the artifact, S4
is mandatory, because prose review is then the only verification there is.

**D6: narrow the parallel wave, or go fully serial.** Trigger: any agent in this
session has already returned a `<synthetic>` session-limit row, or the session has
been running long enough that a wall is plausible. This is the *conditional* form
of the width rule — width sizes the loss when a wall lands, so narrow when one is
likely, and do not pay wall-clock for it when one is not.

**D7: split the run into two dispatches.** When the deliverable needs a decision
from a human between stages. Kill a workflow only **between** phases: the journal
records a result on agent completion only, so a mid-phase kill loses every agent in
that phase. Measured: three agents killed mid-phase left 48 to 51 rows of real work
each and final text of 51 to 138 characters. Nothing recoverable.

**D8: a step names a skill.** If any prompt in the workflow mentions a skill by
name, either invoke it explicitly or inline its instructions. Test:
`grep -o 'plugin:[a-z-]*' <workflow>.js` and check every hit is an explicit
invocation, not a hope.

**D9: recover before re-running.** A failed expensive run is usually not an empty
one. Two checks, both seconds:

```bash
grep -l '"model":"<synthetic>"' <transcripts-root>/*/*.jsonl   # hit a quota wall, not a bug
grep -l "__unparsedToolInput" <transcripts-root>/*/*.jsonl     # finished work stuck in a rejected payload
```

At exactly 2,048 characters the work is there and readable; short payloads are
genuine schema errors. Honest caveat: the rejected-payload case was true for
**2 of 280** agents. It is worth doing only because re-running is expensive, not
because it is common. The `<synthetic>` check is the more useful of the two — it
tells you the run was interrupted rather than broken, so a resume is the right
move and a rewrite is not.

**Never deviate on these three.** No loop-until-dry. No single `parallel()`
holding the whole fan-out. No stage that reads an artifact set before it exists.

---

## Part 3: the cheapness rules

The dominant term is cache read at 77% of weighted cost, and a main-thread request
re-reads 405,000 tokens to emit 1,063, a ratio of 381 to 1. Everything below
follows from that.

**C1: one dispatch per task, not N turns.** Count the `Agent` calls the main
thread makes. Target 1 **once D0 has said a workflow is warranted at all.** Six
sequential dispatches from the main thread are six 405k re-reads; the same six
agents inside one workflow are one. This is a comparison between two ways of
running the same six agents — it is not an argument for spawning agents, which is
D0's question and answers the other way for small work.

**C2: the return budget is a hard number, not a preference.** Default 800
characters per agent, 400 for a delta stage. The absolute ceiling is **2,048
characters per schema string field**, above which the field truncates silently
mid-token and the retry loop spends five full generations reproducing the same
overflow. The cap is per field, not per payload: 65,399-character returns exist,
so the cap will not save you from a bloated return spread over several fields.

**C3: write the file, return the pointer — and the pointer must be real.** What an
agent writes to a file costs the main thread nothing. What it returns is re-read on
every subsequent main-thread turn for the rest of the session. Concretely, an
agent returns:

- the repo-relative path it wrote
- a count (findings, sections, files changed)
- at most five one-line items
- the one thing it could not determine

and never: the document, a diff, a code block longer than three lines, a list of
every file it read, or a restatement of its own brief. Measured justification:
writers returned 5,217 characters median against non-writers' 13,389, and the 79%
of agents that wrote nothing produced 86% of all returned characters. **S6 checks
the paths exist**, because at least 39 of the 88 oversized path-naming returns
cited a file no agent ever created.

**C4: a serial stage passes a delta, not the artifact.** A stage receiving the
previous stage's work restates nothing. It returns changed sections, what changed,
and what it rejected. Measured: serial refine chains peak at 0.710 pairwise
similarity and one returned 113,915 characters re-emitting one document 15 times.
The same applies to what you put *into* the next prompt: hand it a path, not
90,000 characters of JSON — which `heal-sweep.workflow.js:240` still does.

**C5: session length is the bill.** The second half of a session costs 1.44x the
first half for the identical turn count, and the only variable is accumulated
context. At roughly 300k of context with the task not nearly done: finish the
current step, write the brief file and the state file, and start fresh. Modelled
saving is 29% at a 300k reset and 46% at 200k, both upper bounds since a reset pays
to rebuild working state.

**C6: do not reach for a cheaper tier as the saving.** A subagent request carries
155k of context against the main thread's 405k, which is 2.6x cheaper per request
before any tier is chosen — with the population caveat above: 155k is a fleet
average, not this shape's measured number. Tier is roughly the 2% term. Pin models
explicitly on every call for **behaviour**, never for savings, and never rely on
inheritance: 186 of 280 agent meta files declared no model, and one inherited pin
cost 5x.

**C7: a cold cache is a real cost, and it is per agent.** Each agent's first
request writes its context to cache at **1.25x input** before any read discount
applies. Six agents is six cold writes. This is the term that makes a workflow the
wrong shape for small work, and it is the arithmetic behind D0. It does not argue
against C1, where the six agents run either way.

**C8: stop between phases.** A mid-phase kill loses every agent in the phase,
because the journal records on completion only. When a wall lands rather than a
kill, D9's `<synthetic>` grep tells you to resume rather than rewrite.

**C9: measure the return, not the intention.** After a run, the checkable number
is the sum of the returned payloads. If six agents returned more than about 5,000
characters between them, the shape leaked, and the leak is almost always an agent
that pasted a file it had already written.

---

## Part 4: peer management

**This part is a summary. The operative copy is `~/.claude/rules/fleet-brief.md`,
which is `@`-imported into every session on this machine and therefore wins any
disagreement.** Keeping a second full copy here guarantees a fork: the resident
one is read on every turn, this one is read never. What follows is the short form
plus the numbers measured on 2026-08-25 that the resident file did not yet carry;
those numbers belong in `fleet-brief.md` and should be moved there rather than
maintained in two places. See [Part 7](#part-7-delivery).

Two independent peer sessions, neither shown the other's answer, reached the same
split when asked what a coordinating session was worth. One of them: *"Keep the
probing, drop the briefing."*

- **BROADCAST — do this.** Assert measured facts about code, git and platform
  metadata, freely and unprompted. Such a fact needs no visibility into anyone's
  branch and survives being wrong about who is doing what.
- **VERIFY — do this.** Run the gate, mutation-test the finding, read the live
  surface, find the drift.
- **COORDINATE — do not.** No next-step lists for a peer, no sequencing of another
  session's work, no assertion about state you cannot read.

| category | example | allowed |
|---|---|---|
| code, git, platform metadata | "`origin/main` is at `7435ca0`" | assert |
| a portable measured fact | "a rendered-geometry gate reports different numbers on a different OS" | assert |
| a peer's tree, branch, queue, decisions or intent | "S4-AUD-94 is open" | **ask**: "Is S4-AUD-94 actually open?" |
| an instruction from the principal | any | never relay |

### The measured numbers to fold into `fleet-brief.md`

These are the parts of Part 4 that are new. `[measured 2026-08-25]`, 456 sends and
348 deliveries on one machine.

**P3 — join sessions on cwd plus branch, never on id.** The identifier spaces do
not join: of 52 target ids addressed in measured traffic, exactly **1** was also a
transcript filename. A probe joining on id returned NOT FOUND for two live
sessions.

**P5 — send-to-delivery latency over 293 pairs: p50 1.8 seconds, p90 47.8
minutes, max 10.1 hours**, with 22 over an hour. Messages queue behind an
in-flight turn, so silence proves nothing for an hour. One message per peer per
topic; do not send a second until the first is answered or an hour has passed.

**P7 — the transport wraps whatever you send in 724 characters of framing**, so a
one-word message arrives at 1 character of content to 118 of envelope. And **20%
of traffic (70 of 348 deliveries) arrives as a raw queued command with the
preamble and safety footer absent**, so a peer may receive your words with no
framing at all. Write for that case. Of 456 sends, exactly 2 were six words or
fewer (`audit`, `brainstorm`) and **both were refused as ambiguous**.

**P8 — 278 of 278 delivered messages got a reply, median 19 seconds**, so nothing
is ignored; but **82 replies (29%) corrected the sender**. **Proposal, not a
finding:** correction rate peaked at 42% in the 500 to 1,500 character band,
against a median dispatch of 2,189 characters. The reading that a mid-length
dispatch looks specific while being under-specified is plausible and unproven.

**P4 — liveness is four states, not a boolean.** `isRunning` reported false for
two sessions writing to disk at that moment. Use the transcript file's mtime, and
read the send result, which is already four-state in the tool's own output:

| send result text | what it means |
|---|---|
| "queued... if that session stays healthy" | delivered on their next turn boundary |
| "sent" | delivered |
| "not acknowledged yet, may be waiting for approval there" | almost certainly panel-blocked |
| not found / archived | wrong id, or the session is gone |

**P6 — a panel deadlocks the mailbox.** A session stopped on `AskUserQuestion`
never finishes its turn, so every message queued to it waits behind that panel.
`brain-panels.js` denies `AskUserQuestion` per-repo for exactly this. A peer whose
transcript mtime is frozen with a pending question is panel-blocked, not dead.

The rest — P1 attribution, P2 read-the-state-first, P9 announce idle, P10 do not
poll, P11 re-read before sending, P12 the never-list — is already in
`fleet-brief.md` in full and is deliberately not restated here.

---

## Part 5: what this replaces

Nothing yet. That is the problem [Part 7](#part-7-delivery) exists to fix.

---

## Part 6: objections rejected, and why

Three adversarial lenses ran against the 2026-08-25 draft. Most of what they
raised is folded in above. These were rejected, and are recorded so the next
session does not re-raise them.

**Rejected: "the cost lens kills C1 — six dispatches vs one workflow is
unpriced."** C1 compares six agents dispatched one-per-main-thread-turn against
the same six agents inside one workflow. The agent-internal cost — every agent
request, every cold cache write, every tool call — is identical on both sides and
cancels. What differs is main-thread turns. The lens priced a *different*
comparison, workflow against inline-with-no-agents, and concluded C1 was wrong;
that comparison is real and important, so it is now **D0**, but it does not touch
C1. The draft also already carried this as an explicit **proposal**, which the
objection did not acknowledge.

**Rejected: "cap concurrency at 2, ceiling 3."** This was the draft's own rule and
the correctness lens was right to kill it — but the replacement is not a different
number, it is a different claim. Width sizes loss when a wall lands; it does not
predict whether one lands. `single` runs at concurrency 1 lost 67% and a 16-wide
run kept 30 of 30. The caps now match the shipped `rule-agent-concurrency`
(3-4 normal, 5-6 deep), because a doc that forks from an always-on skill loses.

**Rejected: "adding `lenses[]` to S1's schema collides with the 600-char
budget."** It does not. The budget is on the `summary` field; `lenses` is a
separate field. Two lenses at `{name, slug, files}` measure about 150 characters.
The schema bug itself was real and is fixed.

**Rejected: "create a new `rule-workflow-shape` skill."** The mechanism is right —
a `paths:` glob is the only delivery this repo has proven fires — but a new skill
would be the *third* document about agent concurrency, beside this one and the
shipped `rule-agent-concurrency`. Part 7 folds into the existing skill instead.
Also noted honestly: a glob on `**/*.workflow.js` cannot fire before the workflow
file exists, so it delivers Parts 1 and 3 (authoring) and **cannot** deliver D0
(the decision made before any file is touched).

**Rejected: "≥32 of the 88 never called Write."** Directionally right, arithmetic
low. 88 oversized path-naming returns against 49 agents that ever wrote anything
gives **at least 39**, and that is the floor only if every writer is inside the 88.

---

## Part 7: delivery

The adoption objection is the one that mattered, and it is confirmed:
`grep -rl "WORKFLOW-STRUCTURE"` across every `.md`, `.js` and `.json` in this repo
returns **only this file**. `docs/` never ships. As it stands, nothing causes any
session to read any of the above.

Three moves, in value order.

**1. Fold Parts 1 and 3 into `plugins/autodev-core/skills/rule-agent-concurrency/SKILL.md`
and give it a `paths:` glob.** That skill already exists, is `user-invocable:
false`, already declares `when_to_use: "Before spawning subagents, running a
workflow, or fanning work out across agents"` — and currently **contradicts** this
doc on concurrency, which is a live fork today. It has no `paths:` glob, and
`[measured 2026-08-25]` in this session's own skill listing it arrived as a bare
`autodev-core:rule-agent-concurrency` with **no description**, while
`rule-diagnosis` and `rule-thumb-first` arrived with theirs — and `rule-thumb-first`
is one of the five skills that carry a `paths:` glob. Its trigger text is not
reaching the model. Adding:

```yaml
paths:
  - "**/*.workflow.js"
```

matches the mechanism used by `rule-security`, `rule-design-system`,
`rule-thumb-first`, `core` and `standards`. Honest limit: this fires when a
workflow file is opened, which covers authoring and not the D0 decision. D0 belongs
in the always-on rule stack, not behind a glob.

**2. Add `tooling/check-workflow-shape.js` to `npm test`.** Every rule in Part 1 is
mechanically checkable, and nothing checks any of them. Four assertions over
`**/*.workflow.js`:

- every `agent()` call carries an explicit `model:`
- no `pipeline()`/`parallel()` item list wider than the concurrency ceiling
- no schema field `description` over 2,048 characters
- no `JSON.stringify(...).slice(...)` inside an agent prompt

`[measured 2026-08-25]` its first run fires on **four real violations in the one
`.workflow.js` this repo has**: three `agent()` calls with no `model:` pin, and
`JSON.stringify(...).slice()` at lines 240, 293 and 296 (90,000 / 60,000 / 60,000
characters). Per `rule-gate-integrity`, that first run is the measurement — triage
every hit rather than tuning until it is quiet. Scope caveat: `tooling/` does not
ship, so this gates this repo's workflows only.

**3. Move Part 4's new numbers into `~/.claude/rules/fleet-brief.md` and delete the
duplicate.** That file is `@`-imported into every session here, so it is read on
every turn and this one is read never. Two copies means the resident one wins and
this one rots. Only P3, P5, P7 and P8's numbers are new; the rest is already there.
Note the split rule from CLAUDE.md when moving: anything naming a specific repo,
port or machine goes to `~/.claude/rules/`; the portable form ships.

**What this document remains** after all three: the evidence trail and the
reasoning, linked from the skill, read when someone asks *why* — not the thing a
session relies on having read.
