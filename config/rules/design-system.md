# Design System Rules

## Never Do
- Inline colors: `text-white`, `bg-black`, `text-gray-500`
- Hardcoded values in components
- Custom one-off styles

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
