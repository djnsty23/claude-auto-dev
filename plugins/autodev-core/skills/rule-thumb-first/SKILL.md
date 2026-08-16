---
name: rule-thumb-first
description: "Interface design starts from where the hand is and what each element MEANS, not from a palette. Reach zones, progressive density, and the rule that unearned signal destroys real signal. Load before designing a screen, choosing a theme, or adding colour, motion, or output."
when_to_use: "Always-on background rules for any interface work — mobile, web, or terminal output. Not user-invocable."
user-invocable: false
allowed-tools: Read, Grep, Glob
paths:
  - "**/*.tsx"
  - "**/*.jsx"
  - "**/*.vue"
  - "**/*.svelte"
  - "**/*.css"
  - "**/tailwind.config.*"
---

# Thumb-first, meaning-first

A theme is not a palette. **It is a claim about where the user's hand is and what
their eye does first.** Colour is downstream of that. Pick colours first and you
get something that looks designed; pick geometry and meaning first and you get
something that *feels* designed — which is the part people never articulate and
always notice.

Three questions, in this order, for anything built:

1. **Where is the hand?** What can this person reach, in the posture they are
   actually in?
2. **What does the eye do first?** What is this screen for?
3. **What does this mean?** Every colour, motion, and word — or cut it.

## 1. The screen is two machines

On a 6.1–6.9" phone held one-handed, the thumb sweeps a comfortable arc across
roughly the **bottom 45%**, biased to the dominant side. Above that the user can
see but not act.

- **Top ~30% — the READ plane.** State, identity, numbers, "where am I". Never a
  control. An unreachable *title* is fine. An unreachable *button* is a bug.
- **Bottom ~45% — the ACT plane.** Every verb. The primary action sits at the far
  edge of the arc where the thumb rests, not centred.
- **The band between — TENSION.** Where something lives just before it becomes
  actionable; scrolling brings it into the arc.

**Let the interface fall toward the thumb.** Sheets, menus and confirmations rise
from the bottom edge, originating from the control that summoned them. Nothing
important appears top-centre — that is the one place a thumb cannot answer.

A confirmation dialog placed in the read plane is wrong twice: it demands an
action where no action is possible, and it demands one at all (see §4).

## 2. Progressive density, never a "pro mode"

"Biggest cohort" and "power user" are usually resolved badly — dumbed down, or
turned into a cockpit. Both assume expertise wants *more controls*. It does not.
**Expertise wants predictability.** A technical user has built a mental model and
is checking whether the product respects it.

Same surface for everyone; it says more as the user earns it. A beginner sees the
number. Months in, the same tile carries the trend, the rolling average and the
band — because now those mean something. Nobody flipped a switch.

What actually earns technical respect:

- **Determinism** — the same gesture does the same thing everywhere, always.
- **Visible state** — never make someone guess whether it saved.
- **Reversibility** — undo beats confirm.
- **No mystery meat** — an icon without a label is a quiz.

## 3. Colour must mean something

**If a colour carries no meaning, it is not used.**

- **One accent hue**, meaning *actionable, now*. The moment it appears on a
  non-interactive element it stops being a signal.
- **A semantic ramp** for success / caution / danger, used sparingly enough that
  danger still reads as danger.
- **Everything else neutral**, separated by elevation and spacing, not by tint.

Dark-first, and not as an inversion of light. True black grounds with elevation
as slightly lifted neutral surfaces. One saturated accent against near-black is
what gives a product a face recognisable in a screenshot.

**Size is hierarchy.** If colour is needed to establish hierarchy, the sizes are
wrong. One type family, wide weight range, and **tabular numerals anywhere
numeric** — otherwise digits shift horizontally as they change, and that flicker
reads as cheap even to people who cannot name why.

## 4. The rule that generalises past screens

**Unearned signal destroys real signal.**

This is why the accent colour may not decorate a label. It is also why a passing
typecheck must print *nothing*, why a hook that has nothing to say must emit zero
bytes, and why a confirmation dialog for a reversible action is a cost with no
benefit. Each is the same mistake: spending the user's attention without buying
anything with it.

Apply the three questions to non-visual work too. For CLI and agent output, "where
is the hand" becomes *what will the reader do next*, and everything printed that
does not serve that is noise competing with the line that does.

## Checklist before calling an interface done

- [ ] Every control a user must press is inside the bottom 45%.
- [ ] Nothing destructive sits where a thumb rests by default.
- [ ] The accent colour appears **only** on actionable things.
- [ ] Hierarchy survives being screenshotted in greyscale.
- [ ] Numerals are tabular.
- [ ] Every icon has a label, or is a universally-known glyph.
- [ ] The primary action is reachable without shifting grip.
- [ ] Nothing is printed, shown, or animated that the reader did not need.
