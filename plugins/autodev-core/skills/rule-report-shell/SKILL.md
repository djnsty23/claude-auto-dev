---
name: rule-report-shell
description: "The house shell for any HTML report, audit, or findings page an agent publishes: summary-first cards that expand on click with staggered detail, themed scrollbars, and a token system that survives both themes. Load before writing or editing an HTML page a person will read."
when_to_use: "Before writing or editing an HTML report, audit, findings page, or any artifact a human will read rather than a machine."
user-invocable: false
allowed-tools: Read, Grep, Glob
paths:
  - "**/*.html"
---

# The report shell

Copy `references/report-shell.html` and replace the content. Do not rebuild the
CSS from memory — four of the rules below were found by measuring a live page,
and each one looks correct in source right up until it is rendered.

## Why this exists

`[measured 2026-08-25]` A report built without it scored **5/10** on review, and
the two complaints were the two things this file fixes: *"text is too stacked,
not clean enough"* and *"scroll is another color"*.

## The four things that are not obvious

**Scrollbars do not inherit your theme.** A dark page with an unstyled `overflow`
container gets the operating system's light scrollbar — a white rail down a
near-black code well. Nothing in the page hints at it, and no repo checked had
any scrollbar styling at all. Set `scrollbar-color` and `scrollbar-width` *and*
the `::-webkit-scrollbar` block; browsers split across the two.

**The `0fr` → `1fr` grid disclosure does not work inside a flex card.** This is
the widely-published technique and it fails here for a reason that only shows up
in the rendered box:

| child `overflow` | expand | collapse |
|---|---|---|
| `hidden` | **0px** — broken | works |
| `visible` | 500.422px — works | **stuck open** — broken |

`overflow:hidden` is what the collapse needs, and it zeroes the child's automatic
minimum, so `minmax(auto, 1fr)` resolves to zero on the way open. You get one
direction or the other, never both. `minmax(0,1fr)` does not rescue it.

Use `max-height` with the value read from `scrollHeight` **at click time**. Never
a constant: a guessed cap silently truncates the longest card, which is always
the card worth reading. Re-measure on `resize`, because reflowed text is taller.

**Rhythm is a ratio, not a value.** Space *between* sections is 3× the space
*within* them (68px against ~18px). Uniform spacing is what reads as "stacked" —
every element the same distance from its neighbour gives the eye nothing to
group on.

**Summary first, detail earned.** Every card shows one or two lines. Detail lives
behind the disclosure and arrives as bullets that fade in one at a time, ~70ms
apart. The stagger is the whole delight; keep it under six bullets or the last
one arrives after the reader has moved on.

## Interaction

**The whole card is the hit area.** One click handler on `.card`; the button
inside it is the visible affordance, not the only target. Two handlers is how
`data-open` and `max-height` drift out of sync.

Three guards, all needed:

```js
if (e.target.closest('.btn, .well, a')) return;      // never hijack a control
if (window.getSelection().toString()) return;         // they are reading, not toggling
```

Without the second, selecting a sentence collapses the card under the cursor.

## What not to change

The token block defines the **complete** palette on bare `:root` (dark, since
this shell commits to dark) and re-declares it in *both* directions — under
`prefers-color-scheme: light` guarded by `:not([data-theme="dark"])`, and under
`[data-theme="light"]`. A colour declared only inside a media block never applies
in the default un-stamped state, which renders one theme's text on the other
theme's ground.

`body` sets an explicit background from a token. A transparent body borrows the
host's ground and the page inverts.

## Verify it, do not assume it

Assert `innerWidth`/`innerHeight` in the same call that measures anything. A
zero-height viewport reports a working disclosure as broken and an open card as
collapsed — both readings were produced while building this, and the zero-viewport
one looked like a pass.
