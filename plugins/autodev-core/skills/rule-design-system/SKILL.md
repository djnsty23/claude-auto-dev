---
name: rule-design-system
description: "Design-token rules: semantic tokens over inline colors, where tokens are defined, and the one case hardcoded colors are allowed. Load before writing or editing component styles."
when_to_use: "Always-on background rules for styling work. Not user-invocable."
user-invocable: false
allowed-tools: Read, Grep, Glob
paths:
  - "**/*.tsx"
  - "**/*.jsx"
  - "**/*.css"
  - "**/tailwind.config.*"
---

## Never Do
- Inline colors: `text-white`, `bg-black`, `text-gray-500`
- Hardcoded values in components
- Custom one-off styles

**Exception:** Hardcoded colors (`text-white`, `bg-black`) are valid on dynamic gradient backgrounds or explicitly themed surfaces where the background is not a standard theme token.

## Always Do
- Define in tailwind.config.ts or index.css first
- Use semantic tokens: `text-foreground`, `bg-background`, `text-muted-foreground`
- Create component variants for reuse

## Magic UI is the motion layer, and it obeys the tokens above

`[measured 2026-09-03]` `magicuidesign/magicui`: MIT, a shadcn registry named `magicui`
carrying 247 items typed `registry:ui`. It installs the way the rest of the components do,
the code lands in the tree, so it is OURS to gate rather than a dependency to trust.

**Everything on this page still applies to it.** A pasted effect arrives carrying literal
colors, because a registry cannot know your tokens. Convert them to semantic tokens on the
way in, in the same commit, or the first Magic UI component becomes the exception that
retires the whole rule. The gradient carve-out above is the only licence, and an animated
surface is exactly where somebody will claim it without checking whether an opaque surface
sits underneath.

**Use it for MOTION and signature moments, never for ordinary controls.** Buttons, inputs,
dialogs, menus stay shadcn. Two sources on the same control is how a screen stops reading as
one product.

**Six effects on one screen is the same slop in better clothes.** Distinctiveness is a
signature, singular, not a density. If a screen has more than one thing asking to be looked
at, it has none.

**And read what an effect costs before shipping it.** Most animate `transform` and `opacity`,
which is correct. Some animate layout properties or run an infinite loop on a repaint
property, which is a phone-heat defect wherever it lands. Check the pasted source rather than
the demo: the demo runs on a desktop with one instance on screen.

## Token Structure (index.css)
```css
:root {
  --background: 0 0% 100%;
  --foreground: 222.2 84% 4.9%;
  --primary: 222.2 47.4% 11.2%;
  --primary-foreground: 210 40% 98%;
  /* ... */
}
```

## Tailwind Config
```ts
colors: {
  background: "hsl(var(--background))",
  foreground: "hsl(var(--foreground))",
  primary: { DEFAULT: "hsl(var(--primary))", foreground: "hsl(var(--primary-foreground))" }
}
```
