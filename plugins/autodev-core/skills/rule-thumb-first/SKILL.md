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
a lower-screen region that varies with device, grip, handedness and ability.
Treat the percentages below as one design hypothesis, not accessibility limits.

- **Upper region — often the READ plane.** Favor state and orientation here on
  one-handed touch flows, while preserving established navigation and accessible
  keyboard, assistive-technology and alternative-input operation.
- **Lower region — often the ACT plane.** Test primary-action reach with the
  actual layout, handedness, safe areas and on-screen keyboard. Do not relocate
  every control or assume an off-center primary action works for everyone.
- **The band between — TENSION.** Where something lives just before it becomes
  actionable; scrolling brings it into the arc.

**Let the interface fall toward the thumb.** Sheets, menus and confirmations rise
from the bottom edge, originating from the control that summoned them. Placement must fit the actual device and interaction; do not turn one grip's
reach heuristic into a blanket ban on established controls.

Prefer undo for reversible actions. Confirm consequential actions when the
user needs to understand or authorize their effect; keep the choice reachable
and preserve focus.

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

Preserve the product's established theme and user/system preference. For a
dark design chosen by the brief, develop it intentionally rather than inverting light. True black grounds with elevation
as slightly lifted neutral surfaces. One saturated accent against near-black is
what gives a product a face recognisable in a screenshot.

**Size is hierarchy.** If colour is needed to establish hierarchy, the sizes are
wrong. One type family, wide weight range, and **tabular numerals anywhere
numeric** — otherwise digits shift horizontally as they change, and that flicker
reads as cheap even to people who cannot name why.

### The second axis: ambient state

The accent answers *what can I press*. There is a second, orthogonal thing colour
can carry, and it is easy to miss because it never touches a control:
**what state is the person in.**

A consumer health app in this codebase's orbit does it properly. Its `<body>`
carries a mood set at runtime, and the mood moves **hue and tempo together**:

| mood | ambient hue | aurora period |
|---|---|---|
| `recovery` | cool — deep blue, indigo, teal | **34s** |
| `push` | warm — amber, red, yellow | **11s** |

Nothing interactive changes. The accent stays exactly where it was. What changes
is the *room* — slow and cool when the body needs to back off, fast and warm when
it is time to work. Do not rely on hue or animation to communicate this state: retain an accessible
text equivalent and respect reduced-motion settings.

Two rules make this work rather than becoming decoration:

- **The two axes must not collide.** Ambient hue lives in the background and on
  nothing that can be pressed. If ambient warm and the accent are the same
  family, the accent stops being findable in the mood that matters most.
- **Validate the state cue.** Hue/tempo associations are design hypotheses, not
  universal semantics. Motion can be reduced or disabled without losing state.

Use this only where the app genuinely has a state worth broadcasting. Most
products do not, and inventing one is exactly the unearned signal §4 is about.

## 4. The rule that generalises past screens

**Unearned signal destroys real signal.**

This is why the accent colour may not decorate a label. It is also why a routine
typecheck should avoid unnecessary output while retaining a usable verdict, why a hook that has nothing to say must emit zero
bytes, and why a confirmation dialog for a reversible action is a cost with no
benefit. Each is the same mistake: spending the user's attention without buying
anything with it.

Apply the three questions to non-visual work too. For CLI and agent output, "where
is the hand" becomes *what will the reader do next*, and everything printed that
does not serve that is noise competing with the line that does.

## Checklist before calling an interface done

- [ ] Frequent touch actions are reachable in the tested grip/device; keyboard
      and assistive-technology paths remain usable.
- [ ] Nothing destructive sits where a thumb rests by default.
- [ ] The accent colour appears **only** on actionable things.
- [ ] Hierarchy survives being screenshotted in greyscale.
- [ ] Numerals are tabular.
- [ ] Every interactive icon has an accessible name; visible labels are used
      where the symbol or action could be unclear.
- [ ] The primary action is reachable without shifting grip.
- [ ] Nothing is printed, shown, or animated that the reader did not need.
- [ ] Ambient state has a non-color, non-motion equivalent and remains clear
      with reduced motion and the user's chosen theme.
