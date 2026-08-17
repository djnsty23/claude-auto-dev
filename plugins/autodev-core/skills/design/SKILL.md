---
name: design
description: Creates distinctive UI with preserved structure. Avoids generic AI aesthetics. Use when designing or refining user interfaces.
when_to_use: "Invoked when the user says \"design\", \"ui\"."
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
model: opus
user-invocable: true
---

# Frontend Design

> **Browser access.** Use the built-in browser tools. `mcp__Claude_Browser__*`
> covers navigation, DOM reads (`read_page`), screenshots and `resize_window`;
> reach for chrome-devtools `emulate` when a mobile *device* gate has to fire,
> which `resize_window` alone does not guarantee. The `browser` skill and the
> `agent-browser` steps were dropped in 8.79.0 — do not reach for that CLI here.
> (The binary itself is still installed for kb-factory's JS-rendered crawls;
> that is a separate consumer, not a fallback for page verification.)

Create distinctive, production-grade frontend interfaces that avoid generic "AI slop" aesthetics.

## When to Use

- Building web components, pages, or applications
- Creating marketing/landing pages
- UI that needs to look professionally designed
- Any frontend where visual quality matters

## Design Thinking

Before coding, commit to a **bold aesthetic direction**:

1. **Purpose**: What problem does this solve? Who uses it?
2. **Tone**: Pick an extreme:
   - Brutally minimal
   - Maximalist chaos
   - Retro-futuristic
   - Organic/natural
   - Luxury/refined
   - Playful/toy-like
   - Editorial/magazine
   - Brutalist/raw
   - Art deco/geometric
   - Soft/pastel
   - Industrial/utilitarian
3. **Differentiation**: What makes this unforgettable?

Choose a clear direction and execute with precision. Bold maximalism and refined minimalism both work - the key is **intentionality, not intensity**.

## Implementation

Create working code (React/Vue/HTML) that is:
- Production-grade and functional
- Visually striking and memorable
- Cohesive with clear aesthetic point-of-view
- Meticulously refined in every detail
- **Responsive across mobile (375px), tablet (768px), and desktop**

## Responsive Design (required)

Every layout must adapt to mobile-first breakpoints:

| Pattern | Mobile | Tablet+ | Desktop+ |
|---------|--------|---------|----------|
| Sidebar | Hidden + hamburger | Collapsed icons | Full sidebar |
| Grid | 1 column | 2 columns | 3-4 columns |
| Navigation | Bottom tabs or drawer | Side nav | Full nav |
| Cards | Full-width stack | 2-up grid | 3-4 up grid |
| Modals | Full-screen sheet | Centered dialog | Centered dialog |
| Tables | Card view or scroll | Horizontal scroll | Full table |

```tsx
// Mobile-first: hidden sidebar with toggle
<Sheet>
  <SheetTrigger className="md:hidden"><Menu /></SheetTrigger>
  <SheetContent side="left">
    <Nav />
  </SheetContent>
</Sheet>
<aside className="hidden md:flex md:w-64 md:flex-col">
  <Nav />
</aside>
```

Test at 375px width before considering any UI complete.

## Aesthetics Guidelines

### Typography
- Choose **unique, interesting fonts** - avoid generic fonts
- Pair distinctive display font with refined body font
- Use Google Fonts or custom fonts, not system defaults

### Color & Theme
- Commit to a cohesive palette
- Use CSS variables for consistency
- **Dominant colors with sharp accents** > timid, evenly-distributed palettes

### Motion
- Use animations for micro-interactions
- CSS-only for HTML, Motion library for React
- Focus on high-impact moments: orchestrated page load with staggered reveals
- Scroll-triggering and hover states that surprise

### Spatial Composition
- Unexpected layouts
- Asymmetry, overlap, diagonal flow
- Grid-breaking elements
- Generous negative space OR controlled density

### Backgrounds & Visual Details
- Create atmosphere and depth (not just solid colors)
- Gradient meshes, noise textures, geometric patterns
- Layered transparencies, dramatic shadows
- Decorative borders, custom cursors, grain overlays

## AI Slop Detection Checklist

Before finalizing any design, check for these patterns. If 3+ are present, start over with a bolder direction:

| Signal | What It Looks Like | Fix |
|--------|-------------------|-----|
| **Safe font** | Inter, Roboto, system-ui | Pick a distinctive font from Google Fonts |
| **Purple gradient** | Purple/blue gradient on white | Choose a committed palette, not a safe default |
| **Card grid** | 3 identical cards in a row | Break the pattern — vary sizes, overlap, offset |
| **Centered everything** | All content centered, symmetric | Use asymmetry, left-align text, vary alignment |
| **No texture** | Flat solid backgrounds | Add grain, noise, mesh gradients, or patterns |
| **No motion** | Static page load | Add staggered reveals, scroll-triggered animations |
| **Stock illustration style** | Flat vector people, blob shapes | Use photography, 3D renders, or hand-drawn elements |
| **Predictable layout** | Header → hero → 3 cards → CTA → footer | Break the flow with unexpected sections |
| **Same as last time** | Reusing a previous design's patterns | Deliberately choose a different aesthetic direction |

No design should be the same. Interpret creatively and make unexpected choices that feel genuinely designed for the context.

## Design Quality Gate

Before shipping any new UI, check these against the existing design:

1. **Pattern match** — Read 2-3 existing pages/components. Does the new UI use the same spacing scale, border radius, shadow depth, and color tokens?
2. **Font consistency** — Is the new UI using the same font family and size scale as existing pages? No mixing fonts.
3. **Scroll check** — Does any text get trimmed, overlap, or overflow at 375px mobile width?
4. **Color scheme** — Are all colors from CSS variables, not hardcoded hex/rgb?
5. **External resources** — Validate image URLs, font links, icon paths are reachable before committing
6. **Dark mode** — Toggle between light and dark. All text readable? Cards have visible borders/elevation in both modes?
7. **Accessibility** — Focus-visible rings on all interactive elements. No `outline-none` without replacement. Icon-only buttons have `aria-label`.
8. **Reduced motion** — `prefers-reduced-motion` respected. No essential information conveyed only via animation.
9. **Form UX** — Correct `type` and `inputmode` on inputs. Labels on all fields. Errors inline next to fields. Don't block paste.

## Visual QA

After implementing a design, validate visually:

### Browser tools

`navigate` to the page, `computer` `screenshot` for desktop, then `resize_window`
`{preset: 'mobile'}` and screenshot again. Check 390 **and** 414 — one width is not
"mobile". For a device gate rather than a width breakpoint, use chrome-devtools
`emulate` and reload so load-time checks re-run.

**Contrast has to be measured on the rendered surface, not the stylesheet.** A static
contrast checker assumes a white background, so on a dark theme every light-on-dark
token reports as a failure. The real question is never "is this background faint" but
"is there an opaque surface underneath it" — and only the rendered tree can answer
that. Sweep the DOM and flag only elements with no opaque card ancestor.

### Playwright (fallback — more capabilities)
```bash
npx playwright open http://localhost:3000
```

Check for: trimmed text, overlapping elements, unequal font sizes, bad scroll behavior, inconsistent spacing, dark mode contrast issues.

## Reference Designs (Study Before Designing)

These represent the quality bar — match their craft, not their style:

| Site | Why It's Good |
|------|---------------|
| linear.app | Clean dark UI, subtle motion, sharp typography, keyboard-first |
| vercel.com | Minimal, high contrast, excellent CRO and hierarchy |
| stripe.com | Editorial feel, generous spacing, clear information architecture |
| raycast.com | Dark UI done right, motion with purpose, developer aesthetic |
| notion.so | Warm minimalism, playful illustrations, accessible color system |
| cal.com | Open source aesthetic, clean forms, purposeful use of color |

Study 1-2 before starting any design work. Note what makes them memorable, then apply that thinking to your own direction.

## Pro Tips

### Generate Multiple Variants
Ask for 5 different designs on /1, /2, /3, /4, /5:
- Model makes each unique from the others
- Better variety than 5 separate prompts
- Reveals model's template biases

### Iterate on Favorites
After seeing variants, tell the model:
- Which designs you liked
- What you liked about them
- Ask for 5 more iterations based on those

This is where Opus shines - it actually understands your preferences and iterates meaningfully.

## Match Complexity to Vision

- **Maximalist designs** → elaborate code, extensive animations, effects
- **Minimalist designs** → restraint, precision, spacing, typography, subtle details

Elegance comes from executing the vision well.

---

## Detailed Rules

Load specific references for engineering quality:

| Reference | When to Load |
|-----------|--------------|
| `${CLAUDE_SKILL_DIR}/references/web-interface-guidelines.md` | Forms, focus states, animation, a11y, dark mode, touch, i18n |

## Component Composition

Avoid boolean prop proliferation. Use composition:

```tsx
// Bad - boolean explosion
<Card isCompact isHighlighted hasBorder isClickable />

// Good - composition
<Card variant="compact">
  <Card.Highlight>
    <Card.Clickable>...</Card.Clickable>
  </Card.Highlight>
</Card>
```

Create explicit variant components instead of boolean modes. Use compound components with shared context for complex UI.

---

## Integration with Other Skills

| Skill | How It Integrates |
|-------|-------------------|
| `standards` | Ensure new designs use semantic tokens, handle all states |
| `audit` | Design issues flagged here inform UI/UX audit agent |
| `brainstorm` | Feature proposals validated against design system |

**Before creating new components:**
1. Check the Preserve UI Structure section below - can we extend existing?
2. Check design tokens - use CSS variables
3. Check `standards` - handle loading/empty/error states

---

Remember: Claude is capable of extraordinary creative work. Don't hold back - show what can be created when thinking outside the box and committing fully to a distinctive vision.

---

## Preserve UI Structure

When modifying existing UI: **read before write, match don't invent, extend don't replace.**

Key rules:
1. Read the target, parent, siblings, and layout before touching anything
2. Match existing grid, spacing, component patterns exactly
3. Use existing components — never create "similar but different" ones
4. Check all breakpoints match siblings

Load `${CLAUDE_SKILL_DIR}/references/preserve-ui.md` for the full protocol, checklists, and common traps.

## Proving the run

**Observable:** a screenshot of the changed surface, at the viewport it will be
used at, looked at before saying it is done.

A diff cannot show a modal hanging off the edge of a phone, a token that resolves
to the same colour as its background, or an animation that lands wrong. Capture
the real rendered page — 390px and 414px for mobile, since one width is not
"mobile" — and say which viewports were checked. If the tooling to screenshot is
unavailable, say that; "it looks right in the diff" is not a verification and has
shipped broken layouts before.
