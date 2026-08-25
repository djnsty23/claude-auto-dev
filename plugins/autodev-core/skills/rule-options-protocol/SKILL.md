---
name: rule-options-protocol
description: "How to end a turn: a clickable AskUserQuestion panel of vetted, complementary options with a recommendation in every block."
when_to_use: "Before ending a turn that asks the user for direction."
user-invocable: true
allowed-tools: Read, Grep, Glob
---

# Options Protocol (always applied)

End every substantive turn with a **clickable panel** — the `AskUserQuestion` tool —
carrying **four vetted paths**, each genuinely detailed, **multi-select wherever the
options are not mutually exclusive**. The tool appends "Other" automatically, so never
add an "Other" option yourself.

## Four paths, in one question

`AskUserQuestion` caps `options` at **4 per question** and `questions` at **4**.
**Offer four, in one question.** More options do not gather more direction — they
manufacture a backlog. A second question block is an exception, not a shape: add one
only for genuinely optional complements, never for leftovers that did not fit. If
there are genuinely only two paths, give two — a padded option is worse than a short
list.

Going wider costs more than a line of config. Five or six paths means two blocks, and
`options` has a **minimum of 2**, so five splits 3+2 — never 4+1, which is both
schema-invalid and a "choice" with one item. Each block then needs its own
recommendation, and under multi-select every option still has to compose.

## Every question gets a recommendation

A question block without a `(Recommended)` is a menu, not a recommendation — and a menu
pushes the ranking work back onto the reader. Mark option #1 of **every** question, with
the reason in its **first clause**. The recommendation is what you would actually do if
the user said nothing at all — not the safest option, not the cheapest, and not the one
that flatters the work you just did.

Test it: delete the label and re-read the description. If nothing marks it as first, it
was an ordering, not a recommendation.

## Selection mode decides what the options ARE

- **`multiSelect: true` → the options must be COMPLEMENTARY.** Independently valuable,
  safe to run together, ordered so that picking all of them yields one coherent sequence
  rather than competing plans. Before offering, ask: *if they pick every one, is that a
  sane work queue?* If not, the panel is wrong.
- **`multiSelect: false` → the options must be genuinely DIFFERENT solutions** to the
  same problem. Real alternatives with different tradeoffs, each fully considered on its
  own terms. Not intensities, not one plan at three speeds, and never a rushed pair
  where only the recommended option got real thought.

## Vet BEFORE you offer, not after the pick

Verification happens before the panel is written. Do the tool calls, read the files,
measure the cost — then write the options out of what you actually learned. A panel
assembled first and vetted afterwards is guesswork with a clickable interface.

**The test:** could you start any option *right now*, without another discovery step? If
one needs "let me first check whether that exists", it was not vetted — check, then
offer it, or drop it and say why. When vetting kills an option, say so in the turn.

## Evaluate every option — logically and technically

Each option must clear two separate bars, and the non-recommended ones get the same
scrutiny as the first:

- **Technically possible here.** The command, flag, file, API, or permission it needs
  actually exists on this machine and this version — checked, not assumed. An option
  whose mechanism you could not confirm is either dropped or offered with the gap named
  out loud ("I could not verify X").
- **Logically coherent beside the others.** It is a real alternative or a real
  complement, not a restatement, not a subset of another option, and not something the
  work already underway would deliver anyway. Two options that collapse into the same
  action are one option.

Run this pass over the whole set before offering it, not per-option as you write. The
duplicate-and-subset failures are only visible when you read the panel as a whole.

## Detail bar — what each option must say

`description` is where the thinking goes. Every option gets **2–3 sentences** covering,
in this order: **what concretely happens** (name the files, the command, the surface),
**what it costs** (minutes, tool calls, builds, dollars — measured where possible), and
**what breaks if it's wrong** (the actual failure mode, and whether it is reversible).

> Weak: "Refactor the auth module."
> Strong: "Split `auth/middleware.ts` (410 lines) into guard + session modules, updating
> the 7 call sites found by grep. ~15 min, no schema change. If the split is wrong the
> failure is loud at typecheck, not silent in prod — and it's one `git revert`."

Prefer a number over an adjective every time.

## Context-gated options: offer what the work is READY for

An option is not "possible" merely because the mechanism exists — it has to be the right
thing *now*. For each one, ask what must be true for it to be worth doing at this
moment, then check whether it is true. If the precondition is unmet, it belongs on a
later panel.

- **Write tests** once the behaviour is settled enough that the test won't be rewritten
  along with it.
- **Refactor** once tests exist that would catch the refactor breaking something.
- **Automated live QA** once the code is complete, the suite is green, and the polish
  pass is done. A live run mid-implementation tests a moving target and spends real
  budget to tell you nothing.
- **Deploy or ship** once QA passed on the thing being shipped, not an earlier version.
- **Write docs** once the interface has stopped moving.
- **Measure or benchmark** once there is a stable build and a baseline to compare to.

Two failures this prevents: offering the next stage while the current one is
half-finished (it reads as progress and produces rework), and offering a stage whose
precondition silently regressed. When a high-value option is one precondition away, say
so rather than offering it — "live QA once the polish pass lands" beats a live-QA option
that should not be picked yet.

## Finish what was selected — the delivery contract

**A selection is a work order, not a topic.** When the user picks N options, the next
turns execute those N, in order, until they are delivered or the user redirects.

- **Execute before exploring.** After a multi-select, the default next action is item #1
  of the selection — not a new investigation, not a better idea, not a deeper analysis
  of whatever produced the panel. If an item genuinely needs discovery first, do that
  discovery *as* the item and say so.
- **Report against the list, every turn.** Name what is done, what is in flight, and
  what is still queued. A turn that advances the queue silently reads as one that
  ignored it.
- **A new instruction re-orders the queue; it does not delete it.** Serve the
  interjection, then return to the remaining items and say they are still outstanding.
- **Do not offer a new panel while items are undelivered** unless the panel exists to
  re-sequence or drop them. Offering fresh work on top of an undrained queue is the
  failure mode, not a service.
- **If the queue cannot be finished this turn, say which items will not be reached and
  why** — at the point of picking, not three turns later.

## Respect the backlog

Count what the user has already selected and not yet received **before** offering more.

- If the queue is deeper than this turn's delivery, the panel's job is **sequencing or
  fewer options** — not new items on top.
- An option that cannot start until queued items finish is not a real option this turn.
  Say it is queued; do not re-offer it as if it were available.

## Shape

- **Four**, across one question. A padded option is worse than a short list.
- **#1 of every block is the recommendation**, with the reason in the first clause.
- **Distinct outcomes**, not intensities. "Do it", "do it carefully", and "do it later"
  are one option wearing three hats.
- **The tail option is decided by the queue.** Items outstanding → the last option is
  **"continue the backlog"**, naming the remaining items and their count, placed last so
  the new paths are read first and the queue is a visible fallback rather than a buried
  default. Queue empty → the last option is **"stop here"**, because banking a clean
  state is only honest when the state is clean. Never offer both — they are one slot
  answered by different facts.
- **`header` is a chip, max 12 characters.** Make it a noun, not a sentence.
- **`multiSelect: true` by default.** Use single-select only when the options genuinely
  exclude each other.

## Scale the panel to the turn — but always show one

- Real fork in the work → four.
- Small or informational turn → two or three pills covering the obvious next moves.
- Genuinely nothing follows → say so in one line and give a single pill to reopen it.
  Silence is not the alternative.

This includes conversational turns: a "how do I X?" answer ends with pills for what
follows X.

## The panel is for direction, not permission

Act without waiting when the work is reversible, in scope, and obvious — offer the panel
*and* get on with it. Stop and wait for a real answer only for money, production
deploys, shared or third-party state, bulk mutation, and destructive work.

## Always give the working link

Every artifact named in a turn gets a clickable URL **in the message where it is named**
— not "check the PR", but the PR's actual link.

- Files **inside** the working directory → markdown links relative to cwd, with `:line`
  when a line matters.
- Files **outside** it → a plain absolute path in backticks, never a markdown link. Link
  hrefs resolve against cwd, so a `../../` climb out of the project yields a dead link.
- PRs, issues, dashboards, settings → the full URL, plus any gate (auth, staging
  password, query param).

If a link cannot be produced, say why in the same breath.

## Changing this

This file is the logic — there is no hidden state. Edit it and the behaviour changes on
the next session. To change the count, edit "Four paths, in one question" and the Shape
section; those are the only two places a number lives. To turn the panel off, replace the
body with the disable instruction: call `AskUserQuestion` only when genuinely blocked on
a decision the user alone can make, and otherwise name next steps in one line of prose.
