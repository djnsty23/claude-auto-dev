# Reading a Claude Design handoff bundle

`[measured 2026-09-04]` against one real exported bundle, not from docs. The
structure below is what was in that zip. Re-check yours rather than assuming the
export format is frozen.

## What is in the zip

| Path | What it is | Port it? |
|---|---|---|
| `*.dc.html` | one artboard per file, the design itself | read, never copy |
| `support.js` | the canvas runtime, tens of KB, one copy per bundle | never |
| `docs/index.html`, `docs/styles.css` | a built standalone preview | never, it is output |
| `docs/manifest.json`, `docs/icon.svg` | a real web manifest and icon | yes, these are assets |
| `baseline/current-app.html` | a snapshot of the app as it was before | read, for the diff |
| `uploads/*.png` | the reference images pasted into the design conversation | keep, and label them |
| `CLAUDE.md` | instructions the designer left for the receiving session | read FIRST |
| other `*.md` | design system, handoff spec, session briefs | read, this is the mechanism half |

The single biggest mistake is reading the artboards and skipping the markdown.
The `.dc.html` files are surface. The authored `.md` files are where the decisions
live, and they are the only part of the bundle that speaks about mechanism at all.

**Reading order:** `CLAUDE.md`, then the design-system document, then the handoff
spec, then the artboards last, as illustration of what the prose already said.

## The artboard format

```html
<!DOCTYPE html>
<html><head><script src="./support.js"></script></head>
<body>
<x-dc>
<helmet>
  <link rel="stylesheet" href="...fonts...">
  <style>body{...}</style>
</helmet>
<div style="width:430px;height:900px;margin:0 auto;...">
```

`<x-dc>` wraps the document and `<helmet>` hoists what would be head content.
Below that it is plain divs and inline SVG.

## Three traps when porting one

**Every style is inline, so a verbatim port is a token violation on every
element.** There are no classes and no custom properties in an artboard. Copying
the markup reproduces raw hex values throughout, which is exactly what
`rule-design-system` forbids. Map colours to semantic tokens as you port, not
afterwards.

**A fixed-width artboard is not a breakpoint.** The root div carries an explicit
pixel width and height. That is one device, chosen for the canvas. The file is
silent about every other width, and silence is not a decision: do not infer that
the designer wanted the desktop layout to be the mobile one scaled up. Ask, or
design the other widths and show them.

**Check the typeface before adopting it.** The face arrives via a font link in
`<helmet>`, and canvas defaults land on the same small set of faces that make
generated work recognisable. Cross-check against the AI Slop Detection Checklist
in the parent skill before it becomes the product's font.

## The bundle names the revision it was synced against

A `github.md` in the bundle records source association and a repo revision range
for the last sync. Read it before porting. A bundle exported weeks ago describes
a tree that has since moved, and the artboards will disagree with the code for
reasons that are nobody's mistake.

## Verification

A port is done when the rendered result has been measured, not when it resembles
the artboard. Run the rendered-layout gate across several widths:

```bash
node plugins/autodev-core/scripts/rendered-layout-gate.js --how
```

The artboard cannot tell you whether text overflows at 360 or an element occludes
another at 768, because it was never rendered at either.
