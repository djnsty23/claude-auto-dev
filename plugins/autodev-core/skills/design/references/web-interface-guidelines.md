# Web Interface Guidelines

Curated from [Vercel's Web Interface Guidelines](https://github.com/vercel-labs/web-interface-guidelines). Apply to all frontend work.

## Accessibility

- Icon-only buttons need `aria-label`
- Form controls need `<label>` or `aria-label`
- Interactive elements need keyboard handlers (`onKeyDown`/`onKeyUp`)
- `<button>` for actions, `<a>`/`<Link>` for navigation (never `<div onClick>`)
- Images need `alt` (or `alt=""` if decorative)
- Decorative icons need `aria-hidden="true"`
- Async updates (toasts, validation) need `aria-live="polite"`
- Use semantic HTML before ARIA
- Headings hierarchical `<h1>`-`<h6>`; include skip link for main content

## Focus States

- Interactive elements need visible focus: `focus-visible:ring-*` or equivalent
- Never `outline-none` without focus replacement
- Use `:focus-visible` over `:focus` (avoid focus ring on click)
- Group focus with `:focus-within` for compound controls

## Forms

- Inputs need `autocomplete` and meaningful `name`
- Use correct `type` (`email`, `tel`, `url`, `number`) and `inputmode`
- Never block paste (`onPaste` + `preventDefault`)
- Labels clickable (`htmlFor` or wrapping control)
- Disable spellcheck on emails, codes, usernames
- Submit button stays enabled until request starts; spinner during request
- Errors inline next to fields; focus first error on submit
- Placeholders end with `...` and show example pattern
- Warn before navigation with unsaved changes (`beforeunload` or router guard)

## Animation

- Honor `prefers-reduced-motion` (reduced variant or disable)
- Animate `transform`/`opacity` only (compositor-friendly)
- Never `transition: all` - list properties explicitly
- Set correct `transform-origin`
- Animations interruptible - respond to user input mid-animation

## Typography

- `...` not `...` (use ellipsis character)
- Non-breaking spaces: `10&nbsp;MB`, `Cmd&nbsp;K`
- Loading states end with `...`: "Loading...", "Saving..."
- `font-variant-numeric: tabular-nums` for number columns
- Use `text-wrap: balance` or `text-pretty` on headings (prevents widows)

## Content Handling

- Text containers handle long content: `truncate`, `line-clamp-*`, or `break-words`
- Flex children need `min-w-0` to allow text truncation
- Handle empty states - never render broken UI for empty data
- Anticipate short, average, and very long user-generated inputs

## Images

- `<img>` needs explicit `width` and `height` (prevents CLS)
- Below-fold images: `loading="lazy"`
- Above-fold critical images: `priority` or `fetchpriority="high"`

## Performance

- Large lists (50+ items): virtualize (`virtua`, `content-visibility: auto`)
- No layout reads in render (`getBoundingClientRect`, `offsetHeight`)
- Batch DOM reads/writes; avoid interleaving
- Prefer uncontrolled inputs; controlled inputs must be cheap per keystroke
- `<link rel="preconnect">` for CDN/asset domains
- Critical fonts: `<link rel="preload" as="font">` with `font-display: swap`

## Navigation & URL State

- URL reflects state - filters, tabs, pagination in query params
- Links use `<a>`/`<Link>` (supports Cmd/Ctrl+click, middle-click)
- Deep-link all stateful UI (if uses `useState`, consider URL sync)
- Destructive actions need confirmation or undo - never immediate

## Touch & Mobile

- `touch-action: manipulation` (prevents double-tap zoom delay)
- Set `-webkit-tap-highlight-color` intentionally
- `overscroll-behavior: contain` in modals/drawers/sheets
- During drag: disable text selection, `inert` on dragged elements
- `autoFocus` sparingly - desktop only, single primary input; avoid on mobile

## Safe Areas & Layout

- Full-bleed layouts need `env(safe-area-inset-*)` for notches
- Avoid unwanted scrollbars: `overflow-x-hidden` on containers
- Flex/grid over JS measurement for layout

## Dark Mode & Theming

- `color-scheme: dark` on `<html>` for dark themes (fixes scrollbar, inputs)
- `<meta name="theme-color">` matches page background
- Native `<select>`: explicit `background-color` and `color` (Windows dark mode)

## Hydration Safety

- Inputs with `value` need `onChange` (or use `defaultValue` for uncontrolled)
- Date/time rendering: guard against hydration mismatch
- `suppressHydrationWarning` only where truly needed

## Interactive States

- Buttons/links need `hover:` state (visual feedback)
- Interactive states increase contrast: hover/active/focus more prominent than rest

## Copy & Content

- Active voice: "Install the CLI" not "The CLI will be installed"
- Title Case for headings/buttons
- Numerals for counts: "8 deployments" not "eight"
- Specific button labels: "Save API Key" not "Continue"
- Error messages include fix/next step, not just problem

## Anti-Patterns (Always Flag)

- `user-scalable=no` or `maximum-scale=1` disabling zoom
- `onPaste` with `preventDefault`
- `transition: all`
- `outline-none` without focus-visible replacement
- Inline `onClick` navigation without `<a>`
- `<div>` or `<span>` with click handlers (should be `<button>`)
- Images without dimensions
- Large arrays `.map()` without virtualization
- Form inputs without labels
- Icon buttons without `aria-label`
- Hardcoded date/number formats (use `Intl.*`)
- `autoFocus` without clear justification

Source: [vercel-labs/web-interface-guidelines](https://github.com/vercel-labs/web-interface-guidelines)
