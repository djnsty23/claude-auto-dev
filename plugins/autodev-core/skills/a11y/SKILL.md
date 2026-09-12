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
npx --no-install axe "$TARGET_URL" --exit
```

Resolve the project’s installed `@axe-core/cli` and its browser driver first;
use an existing axe integration if that is what the project provides. Record
the command, version, target build, routes/states, exit status and report.
Missing tooling or a failed page load is an unexecuted check. A clean automated
scan covers only its rules and scanned states; manual checks still apply.

## 2. Manual checks

Use an available browser driver with its actual tool schema. Confirm these in
the affected public and authenticated flows, including relevant error states:

1. **Keyboard only.** Tab through the whole flow. Every interactive element is
   reachable, in a sensible order, with a visible focus indicator. Modal dialogs trap
   focus and restore it on close; nonmodal dialogs must not trap the user.
2. **Status changes are accessible.** Verify relevant loading, error and success
   notifications through suitable status semantics or focus management. Do not
   claim an announcement was heard from a DOM inspection alone; if no screen
   reader was exercised, record that manual coverage gap.
3. Labels on every input; errors tied to their field.
4. Contrast at 4.5:1 for body text, 3:1 for large text and UI boundaries.
5. Meaningful landmarks and a heading hierarchy that describes the content.
6. Images: meaningful ones have alt text, decorative ones have `alt=""`.

`rule-design-system` and `standards` list the anti-patterns to flag on sight
(`user-scalable=no`, `outline-none` with no visible focus replacement). Check
reduced-motion behavior and effective hit areas; distinguish project touch-size
targets from the WCAG criterion actually violated.

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

Coverage: [named routes, roles, states, automated/manual checks and gaps]
Critical: 0 | High: 1 | Medium: 2 | Low: 1
```

Each finding gets `file:line`, the WCAG criterion, and the fix. Say which checks
were automated and which you performed manually — a reader cannot tell
otherwise. A severity or rating requires a stated rationale, not a raw violation count.

## Proving the run

**Observable:** the scanner executed across the named routes/states, findings
were triaged against the applicable standard, and manual outcomes are recorded.
`--exit` fails on any selected rule violation, not only serious/critical ones.

```bash
npx --no-install axe "$TARGET_URL" --exit   # non-zero on any selected rule violation
```

A clean report is only meaningful next to the population it covers. "No issues
found" over one route reads identically to "no issues found" over twelve, and
identically again to a scanner that failed to load the page — so the report says
how many routes were scanned and names them. If the scan could not run, say that
instead; it is not a pass.
