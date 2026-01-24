---
description: A/B test different plugins, prompts, or frameworks using parallel agents
---

# A/B Test

Compare Claude Code approaches by running them in parallel and picking the best.

## Quick Start

```
ab-test "build a password generator CLI"
```

## How It Works

1. **Create test variants** as Tasks with TaskCreate
2. **Spawn parallel agents** (one per variant) using Task tool
3. **Each agent builds in isolation** (separate folders: `ab-test/variant-a/`, `ab-test/variant-b/`)
4. **Collect results** when agents complete
5. **Compare and pick winner** based on metrics
6. **Copy winner** to main project (optional)

## Process

```
ab-test "task description"
  │
  ├─→ TaskCreate: "Variant A - Full Plugin"
  │     └─→ Task(agent) → builds in ab-test/variant-a/
  │
  ├─→ TaskCreate: "Variant B - Minimal"
  │     └─→ Task(agent) → builds in ab-test/variant-b/
  │
  ├─→ TaskCreate: "Variant C - No Structure"
  │     └─→ Task(agent) → builds in ab-test/variant-c/
  │
  └─→ Wait for all → Compare → Report → Pick winner
```

## Default Variants

| Variant | Approach |
|---------|----------|
| A | Full plugin (/brainstorm + prd.json + /auto) |
| B | Built-in Tasks only (TaskCreate + TaskUpdate) |
| C | Direct build (no task tracking) |

## Parallel Execution

Use Task tool to spawn agents:

```
Task({
  description: "Build variant A",
  prompt: "In folder ab-test/variant-a/, build: ${task}. Use /brainstorm then /auto.",
  subagent_type: "builder"
})
```

Run all variants simultaneously (up to 5 parallel agents).

## Comparison Metrics

| Metric | Check |
|--------|-------|
| Build passes | `npm run build` in each folder |
| File count | `ls ab-test/variant-*/` |
| Code quality | Quick review of structure |
| Errors | Count failures during build |

## Results

After all agents complete:

```
A/B Test Results
────────────────
Task: "build a password generator CLI"

Variant A (Full Plugin):
  ✓ Build passes
  ✓ 5 files created
  ✓ Clean structure

Variant B (Tasks only):
  ✓ Build passes
  ✓ 4 files created
  ✓ Simpler approach

Variant C (Direct):
  ✗ Build failed
  ✓ 3 files created

Winner: B (Tasks only)
Reason: Same outcome, fewer steps, cleaner code
```

## Pick Winner

After comparison:
```
Copy variant B to project root? [y/n]
```

If yes, copies `ab-test/variant-b/*` to project.

## Custom Config

Create `ab-test.json` for custom variants:

```json
{
  "task": "build a CLI app",
  "variants": {
    "A": { "prompt": "Use /brainstorm then /auto" },
    "B": { "prompt": "Use TaskCreate, work through tasks" },
    "C": { "prompt": "Just build it directly" }
  }
}
```

## Cleanup

```
ab-test --clean
```

Removes `ab-test/` folder after testing.
