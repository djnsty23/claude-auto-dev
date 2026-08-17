---
name: a11y
description: Accessibility audit against WCAG 2.1 AA — run the automated scan, then the manual checks tooling cannot make, and report in this project's format.
when_to_use: "Invoked when the user says \"a11y\", \"accessibility\", \"wcag\", \"screen reader\", or asks whether a UI is accessible."
allowed-tools: Bash, Read, Grep, Glob
model: opus
user-invocable: true
argument-hint: "[url or component path]"
---

# Accessibility Audit

You know WCAG 2.1 AA. This skill is the procedure and the report format, not a
tutorial on it.

## 1. Automated scan

```bash
npx axe-core-cli http://localhost:3000
```

**Automated tooling catches roughly 30% of real issues.** Treat a clean axe run
as the starting point, never as a pass.

## 2. Manual checks

Drive the page with the `browser` skill and confirm, in this order — the first
two are where this codebase actually fails:

1. **Keyboard only.** Tab through the whole flow. Every interactive element is
   reachable, in a sensible order, with a visible focus indicator. Dialogs trap
   focus and restore it on close.
2. **State changes are announced.** Loading, error, and success states reach a
   live region — a spinner that only appears visually is invisible to a screen
   reader.
3. Labels on every input; errors tied to their field.
4. Contrast at 4.5:1 for body text, 3:1 for large text and UI boundaries.
5. Landmarks and one `h1`, with no skipped heading levels.
6. Images: meaningful ones have alt text, decorative ones have `alt=""`.

`rule-design-system` and `standards` list the anti-patterns to flag on sight
(`user-scalable=no`, `outline-none` with no `focus-visible`, `transition: all`).

## 3. Report

```
Accessibility Audit (WCAG 2.1 AA)
──────────────────────────────────
Keyboard Navigation:  ✅ All interactive elements reachable
Focus Management:     ⚠️ Dialog doesn't trap focus
Color Contrast:       ✅ All text meets 4.5:1
Images:               ⚠️ 3 images missing alt text
Forms:                ✅ All inputs labeled
ARIA:                 ✅ Live regions for loading states
Semantic HTML:        ⚠️ Missing landmark roles

Score: 78/100
Critical: 0 | High: 1 | Medium: 2 | Low: 1
```

Each finding gets `file:line`, the WCAG criterion, and the fix. Say which checks
were automated and which you performed manually — a reader cannot tell
otherwise, and it changes how much the score is worth.

## Proving the run

**Observable:** zero serious/critical axe violations across the routes scanned,
and the number of routes is stated.

```bash
npx axe-core-cli <url> --exit   # non-zero exit on any violation
```

A clean report is only meaningful next to the population it covers. "No issues
found" over one route reads identically to "no issues found" over twelve, and
identically again to a scanner that failed to load the page — so the report says
how many routes were scanned and names them. If the scan could not run, say that
instead; it is not a pass.
