---
name: design
description: Creates distinctive UI with preserved structure. Avoids generic AI aesthetics. Use when designing or refining user interfaces.
when_to_use: "Invoked when the user says \"design\", \"ui\"."
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, mcp__Claude_Browser__*
model: opus
user-invocable: true
---

# Frontend Design

Use the browser driver actually exposed by the current host and its documented
schema. Resolve it before promising live verification; historical tool names
and opening a browser window do not establish agent control.

Create distinctive, production-grade frontend interfaces that avoid generic "AI slop" aesthetics.

## When to Use

- Building web components, pages, or applications
- Creating marketing/landing pages
- UI that needs to look professionally designed
- Any frontend where visual quality matters

## Design Thinking

Read the requested scope and existing design system first. For new visual
exploration, choose a clear direction grounded in the user's task; routine
feature work preserves established tokens, structure and interaction patterns:

1. **Purpose**: What problem does this solve? Who uses it?
2. **Tone**: Choose an appropriate direction; possible references include:
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

Adapt layouts to the actual content, task and supported breakpoints. The table
is a set of possible patterns, not a mandate to replace existing navigation:

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
- Preserve established type tokens when extending a product.
- For a new visual direction, choose legible type that supports hierarchy and
  loading/performance constraints; system fonts are valid when they serve it.
- Pair a display font with body type only when the content benefits.

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

**A background you SOURCE or GENERATE fails differently from one you draw in
CSS.** Photographic and generated heroes carry their own legibility, crop,
weight and reduced-motion problems, and the hierarchy decision behind them is
that the hero shows no product UI at all. Load
`${CLAUDE_SKILL_DIR}/references/background-craft.md` before building one.

## AI Slop Detection Checklist

Use these signals as prompts to inspect fit with the actual task, not a score
or restart gate. Three shared patterns do not prove poor design. Preserve
accessible, consistent components unless observed evidence supports a change:

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

Consistency across an existing product is valuable. Make intentional choices
for the context; novelty alone is not a requirement or acceptance criterion.

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

### Browser verification

Use the available driver's actual navigation, viewport, DOM, screenshot and
interaction methods. Test the verified local URL at the project's supported
mobile/desktop sizes, with fresh navigation/reload where device behavior depends
on initial load. Inspect the resulting screenshots and operate the affected
flow, including loading, empty, error and permission states where applicable.
An opened Playwright window without an agent-controllable driver is not an
autonomous test.

Measure contrast against the rendered composite background. An opaque card does
not prove its text has sufficient contrast, and a static tool does not always
assume white. Inspect both elements on cards and those over images/transparent
surfaces; keep the measurement method and unsupported cases explicit.

Check for trimmed text, unintended overlap, scroll behavior, consistent spacing,
focus/keyboard operation, supported themes and reduced motion. Visual appeal is
not evidence that a control performs the intended action.

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

## Claude Design: the canvas surface

Everything above assumes you are writing the code. Claude Design is the other
surface: a canvas product where the design exists before any repo does, and which
hands off to Claude Code when it is ready. Reach for it for wireframes, decks and
marketing collateral. Stay in code for anything already living in a component tree.

`[measured 2026-09-03]` from Anthropic's own docs, linked at the end of this
section. Plan tiers and release status move, so re-read the source before quoting
either rather than trusting this paragraph.

- **Beta on Pro, Max, Team and Enterprise**, and **default OFF for Enterprise**, so
  an Enterprise seat is not evidence of access. Web at `claude.ai/design`, or the
  Claude Desktop sidebar. Powered by Claude Opus 4.7.
- **Chat on the left, canvas on the right.**

### Four input channels, and they are not interchangeable

| Channel | What the docs say it is for | In practice |
|---|---|---|
| Chat | "structural changes, new sections, or anything that requires explanation" | section order, layout, colour direction, tone |
| Inline comment | click the element, "request a targeted change" | one button, one card, one headline |
| Direct edit | drag, resize and align elements on the canvas | nudging position, quick visual shifts |
| Custom sliders | built by Claude for that design | sweeping one dimension without re-prompting |

**Macro before micro.** This ordering is reasoning rather than documented: an inline
comment is anchored to a rendered element, so any chat prompt that reflows the page
destroys the node every earlier comment was attached to. Settle structure and visual
direction in chat first, then spend comments on detail. The other order means
redoing the detail work after every structural change.

### Checkpoint before exploring

Ask Claude to save the current version before requesting a different approach, so
earlier iterations stay referenceable. Then ask for alternatives of ONE section
rather than the whole page, and compare them side by side. This is the same move as
shipping an options artifact: two or three genuine variants, real content rather
than lorem, one marked recommendation, and a decision made by looking rather than
by guessing.

### Handoff and export

`.zip`, PDF, PPTX, Canva, standalone HTML, and a handoff bundle to Claude Code
(local agent or web). Partner targets: Adobe, Base44, Gamma, Lovable, Miro, Replit,
Vercel and Wix. Sharing is organisation-scoped, with view, comment and edit levels.

**A handoff bundle is a proposal about surface, not a spec for mechanism.** It is
authoritative about palette, type, layout and the shape of a row. It is silent on
navigation, state and what a control does. A session that reads a mockup as a flow
mandate ships a different product wearing the right silhouette. Where the bundle
conflicts with logic already built and vetted, the logic wins and the conflict gets
written down rather than silently resolved.

### Known limitations, from the docs

Comments do not always persist, large codebases lag, chat errors can require a new
tab, multi-person editing is unreliable, it is web and desktop only, and imported
design-system quality tracks the quality of the source you pointed it at. When a
comment fails to register, put the same instruction into chat rather than fighting
the canvas.

Sources: [Anthropic Labs announcement](https://www.anthropic.com/news/claude-design-anthropic-labs) and
[Get started with Claude Design](https://support.claude.com/en/articles/14604416-get-started-with-claude-design).

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
| `${CLAUDE_SKILL_DIR}/references/background-craft.md` | A hero or section led by a photographic or generated background: sourcing, reframing, video loops, legibility over an image |
| `${CLAUDE_SKILL_DIR}/references/claude-design-handoff.md` | Porting a Claude Design handoff bundle into a component tree |

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

**Observable:** inspect screenshots of the actual changed surface at supported
viewports and verify its affected user behavior, resulting state and reload.
Bind the evidence to the tested version/environment. A screenshot is necessary
for a visible change, but it cannot prove that its controls work.

A diff cannot show a modal hanging off the edge of a phone, a token that resolves
to the same colour as its background, or an animation that lands wrong. Capture
the real rendered page — 390px and 414px for mobile, since one width is not
"mobile" — and say which viewports were checked. If the tooling to screenshot is
unavailable, say that; "it looks right in the diff" is not a verification and has
shipped broken layouts before.
