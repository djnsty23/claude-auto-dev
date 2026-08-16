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
