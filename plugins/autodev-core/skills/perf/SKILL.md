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

Load the project’s performance budgets first. The values below are reference
thresholds and example bundle budgets, not decisions already made for every
project. Use measured user impact and the project’s acceptance criteria to
choose targets; do not introduce release blockers from defaults alone.

## 1. Measure

```bash
npm run build  # example: use the actual project build command; retain its exit status
npx --no-install lighthouse "$TARGET_URL" --output=json --output-path=.claude/reports/lighthouse.json
```

Create the report directory, identify the app/build behind `TARGET_URL`, and
use a production build for representative bundle/load measurements. Record raw
output and exit status; preserve diagnostics. Measure before changing anything.
A failed build or missing metric is not a passing measurement.

Separate lab from field data: a Lighthouse navigation run does not measure INP;
TBT is a proxy, not an INP value. Measure interactions with suitable tooling or
report field INP from an identified data source and time window.
[Web Vitals measurement](https://web.dev/articles/vitals).

## 2. Budgets

| Metric | Good | Needs work | Poor |
|--------|------|------------|------|
| LCP | ≤ 2.5s | > 2.5–4s | > 4s |
| INP | ≤ 200ms | > 200–500ms | > 500ms |
| CLS | ≤ 0.1 | > 0.1–0.25 | > 0.25 |
| FCP | < 1.8s | 1.8–3s | > 3s |
| TTFB | < 800ms | 800–1800ms | > 1800ms |

| Bundle | Target | If over |
|--------|--------|---------|
| Total JS | < 200KB gzipped | Code split, lazy load |
| Single chunk | < 50KB | Dynamic import |
| Image | < 100KB | WebP, compress, lazy load |
| Font | < 50KB | Subset, `font-display: swap` |

## 3. Fix in this order

Prioritize the measured bottleneck. These are candidates, not a fixed ranking;
finish when the agreed targets and affected functional checks pass:

1. **Request waterfalls** — parallelise, hoist fetches, preload what blocks LCP.
2. **Payload** — inspect images, fonts and JS; optimize the resource that
   measurements show is delaying the flow.
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

Lighthouse score: [only if measured; include run conditions]
Unmeasured metrics / remaining functional checks: [list]
```

Report measured numbers, not estimates. If a metric could not be measured, write
"not measured" rather than filling it in.

## Proving the run

**Observable:** the same metric, on the same route, measured before and after,
with both numbers reported.

A perf change without a before number is not an improvement, it is a hope. Report
the pair (`LCP 3.4s → 1.9s`, `bundle 412kb → 380kb`) and the conditions —
which revision, route, user state, cold or warm, viewport, device/network settings
and tool version. Repeat noisy measurements and report the sample count and
spread before claiming a gain. A comparison across different
conditions is worse than no comparison; it is a wrong number that reads as
authoritative. If only one side could be measured, say which and why.
