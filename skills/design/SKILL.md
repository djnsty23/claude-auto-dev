---
name: design
description: Creates distinctive UI with preserved structure. Avoids generic AI aesthetics. Use when designing or refining user interfaces.
triggers:
  - design
  - ui
model: opus
user-invocable: true
---

# Frontend Design

Create distinctive, production-grade frontend interfaces that avoid generic "AI slop" aesthetics.

## When to Use

- Building web components, pages, or applications
- Creating marketing/landing pages
- UI that needs to look professionally designed
- Any frontend where visual quality matters

## Design Thinking

Before coding, commit to a **BOLD aesthetic direction**:

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
3. **Differentiation**: What makes this UNFORGETTABLE?

**CRITICAL**: Choose a clear direction and execute with precision. Bold maximalism and refined minimalism both work - the key is **intentionality, not intensity**.

## Implementation

Create working code (React/Vue/HTML) that is:
- Production-grade and functional
- Visually striking and memorable
- Cohesive with clear aesthetic point-of-view
- Meticulously refined in every detail
- **Responsive across mobile (375px), tablet (768px), and desktop**

## Responsive Design (MANDATORY)

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

## NEVER Do This

**Generic AI aesthetics to avoid:**
- Inter, Roboto, Arial, system fonts
- Purple/blue gradients on white backgrounds
- Predictable layouts and component patterns
- Cookie-cutter designs lacking character
- Space Grotesk (overused)
- Same design across generations — vary themes, fonts, aesthetics

No design should be the same. Interpret creatively and make unexpected choices that feel genuinely designed for the context.

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
| `references/web-interface-guidelines.md` | Forms, focus states, animation, a11y, dark mode, touch, i18n |

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
| `quality` | Ensure new designs use semantic tokens, handle all states |
| `audit` | Design issues flagged here inform UI/UX audit agent |
| `brainstorm` | Feature proposals validated against design system |

**Before creating new components:**
1. Check the Preserve UI Structure section below - can we extend existing?
2. Check design tokens - use CSS variables
3. Check `quality` - handle loading/empty/error states

---

Remember: Claude is capable of extraordinary creative work. Don't hold back - show what can be created when thinking outside the box and committing fully to a distinctive vision.

---

## Preserve UI Structure

When modifying ANY UI component, follow this protocol to avoid breaking existing layouts.

### Before Touching UI (MANDATORY)

#### 1. Context Loading
```
MUST READ before any UI change:
1. The TARGET component file (entire file)
2. The PARENT component that renders it
3. 2-3 SIBLING components in same directory
4. The layout/page that contains the component
```

#### 2. Pattern Identification
Before writing, identify and document:
- [ ] Grid system used (CSS Grid, Flexbox, custom)
- [ ] Spacing pattern (gap-4, space-y-6, etc.)
- [ ] Component structure (Card > CardHeader > CardTitle)
- [ ] Responsive breakpoints (sm:, md:, lg:)
- [ ] Animation patterns (if any)

#### 3. Design Token Check
```bash
# Run mentally before adding styles:
grep -r "className=" src/components/ui/ | head -20
# What tokens do existing components use?
```

### Rules for UI Changes

#### Extend, Don't Replace
```tsx
// BAD: Replacing existing structure
<div className="flex gap-4">  // Your new layout
  {children}
</div>

// GOOD: Adding within existing structure
<ExistingLayout>
  <NewFeature />  // Fits the pattern
</ExistingLayout>
```

#### Match Siblings
If adding a new card to a grid of cards:
1. Read an existing card component
2. Match its: padding, border-radius, shadow, spacing
3. Use the SAME component (don't create a new one)

#### Preserve Hierarchy
```
Page Layout
  └── Section Container
      └── Grid/Flex Container
          └── Card Components
              └── Content

DO NOT flatten this. Add at the appropriate level.
```

#### Use Existing Components
Before creating anything new:
```bash
# Check what exists:
ls src/components/ui/
ls src/components/

# Use existing:
import { Card, CardHeader, CardContent } from "@/components/ui/card"
```

### Forbidden Actions

#### Never Do
- Create new layout when parent already has one
- Use different spacing than sibling components
- Add new color tokens without checking theme
- Ignore existing responsive breakpoints
- Create a "similar but different" component
- Add inline styles when Tailwind classes exist

#### Red Flags
If you're about to:
- Add a `<div>` just for styling → Check if parent handles it
- Create `MyCustomCard` → Use existing `Card` component
- Write `style={{}}` → Use Tailwind classes
- Add `grid-cols-3` → Check what siblings use

### Responsive Considerations

#### Check Existing Breakpoints
```tsx
// Find the pattern in existing components:
className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3"

// Match it exactly, don't invent new breakpoints
```

#### Mobile-First
- Base styles for mobile
- Add complexity at larger breakpoints
- Test your mental model: "What happens at 320px?"

### Before Submitting UI Changes

#### Visual Verification Checklist
- [ ] Does it look like it belongs? (Not obviously "new")
- [ ] Same spacing as neighbors?
- [ ] Same border/shadow treatment?
- [ ] Responsive at all breakpoints?
- [ ] Loading state matches other loading states?
- [ ] Empty state matches other empty states?
- [ ] Error state matches other error states?

#### Integration Check
- [ ] Parent component still renders correctly?
- [ ] Sibling components unaffected?
- [ ] No layout shifts or jumps?
- [ ] Animations consistent with existing?

### Common Mistakes

#### The "Fresh Start" Trap
```tsx
// You see messy code and think "I'll rewrite this properly"
// DON'T. The "messy" code probably handles edge cases you don't see.
// Extend it. Don't replace it.
```

#### The "Better Way" Trap
```tsx
// You know a "better" way to do the layout
// DON'T change it unless asked. Consistency > Perfection.
// The codebase should look like ONE person wrote it.
```

#### The Orphan Component
```tsx
// You create a component that doesn't match anything else
// It works, but it looks out of place
// DELETE IT. Use existing components or extend them.
```

### Preserve UI Summary

1. **Read before write** - Know the context
2. **Match, don't invent** - Use existing patterns
3. **Extend, don't replace** - Add to what's there
4. **Check siblings** - Your component should look like family
5. **Test visually** - Does it belong?
