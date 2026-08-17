---
name: perf
description: Web performance audit against this project's Core Web Vitals and bundle budgets, with a fixed report format.
when_to_use: "Invoked when the user says \"perf\", \"performance\", \"core web vitals\", \"lighthouse\", \"bundle size\", or reports the app feeling slow."
allowed-tools: Bash, Read, Grep, Glob
model: opus
user-invocable: true
argument-hint: "[url or page path]"
---

# Performance Audit

The budgets below are the project's decisions. The optimisation techniques are
not restated here — you know them.

## 1. Measure

```bash
npx next build 2>&1 | tail -30              # bundle sizes
npx lighthouse http://localhost:3000 --output=json --quiet
```

Measure before changing anything. A perf change with no before/after number is a
guess.

## 2. Budgets

| Metric | Good | Needs work | Poor |
|--------|------|------------|------|
| LCP | < 2.5s | 2.5–4s | > 4s |
| INP | < 200ms | 200–500ms | > 500ms |
| CLS | < 0.1 | 0.1–0.25 | > 0.25 |
| FCP | < 1.8s | 1.8–3s | > 3s |
| TTFB | < 800ms | 800–1800ms | > 1800ms |

| Bundle | Target | If over |
|--------|--------|---------|
| Total JS | < 200KB gzipped | Code split, lazy load |
| Single chunk | < 50KB | Dynamic import |
| Image | < 100KB | WebP, compress, lazy load |
| Font | < 50KB | Subset, `font-display: swap` |

## 3. Fix in this order

Highest yield first, and stop when you are inside budget:

1. **Request waterfalls** — parallelise, hoist fetches, preload what blocks LCP.
2. **Payload** — images, then fonts, then JS. An unoptimised hero image usually
   outweighs every code change you could make.
3. **Bundle** — split routes, dynamic-import anything below the fold.
4. **Server** — cache, stream, move work off the request path.
5. **Re-render optimisation last.** It is the most invasive and the least often
   the actual cause.

## 4. Report

```
Performance Audit
─────────────────
LCP: 1.8s ✅
INP: 150ms ✅
CLS: 0.05 ✅
FCP: 1.2s ✅

Bundle: 180KB gzipped ✅
Largest chunk: audio-player.js (45KB) ✅

Issues Found:
1. [HIGH] Unoptimized hero image (2.1MB PNG) → Convert to WebP
2. [MEDIUM] No code splitting on /studio page → Dynamic import
3. [LOW] Unused lodash import → Replace with native

Score: 85/100
```

Report measured numbers, not estimates. If a metric could not be measured, write
"not measured" rather than filling it in.

## Proving the run

**Observable:** the same metric, on the same route, measured before and after,
with both numbers reported.

A perf change without a before number is not an improvement, it is a hope. Report
the pair (`LCP 3.4s → 1.9s`, `bundle 412kb → 380kb`) and the conditions —
which route, cold or warm, which viewport — because a comparison across different
conditions is worse than no comparison; it is a wrong number that reads as
authoritative. If only one side could be measured, say which and why.
