---
name: core
description: The prd.json schema and task system used by every autodev workflow. Load before reading or writing prd.json, creating stories, or interpreting a task's passes field.
when_to_use: "Background knowledge, loaded automatically whenever the session touches prd.json. Not user-invocable."
allowed-tools: Bash, Read, Write, Edit, Grep, Glob
model: opus
user-invocable: false
paths:
  - prd.json
  - "**/prd.json"
---

# Hybrid Task System

## Sprint Summary

Read the full story population through `workPlan(prd)` from this plugin's
`scripts/prd-states.js`; resolve the plugin directory from the loaded skill's
location. The same planner drives Auto and its Stop hook. Resolve the actual
loaded autodev-core directory into the `AUTODEV_CORE_ROOT` environment variable;
never guess it from the target project's working directory. Run this from the
verified target project root, where prd.json lives:

```bash
node -e "const fs=require('fs'),path=require('path');if(!process.env.AUTODEV_CORE_ROOT)throw new Error('AUTODEV_CORE_ROOT is required');const {workPlan}=require(path.join(process.env.AUTODEV_CORE_ROOT,'scripts','prd-states.js'));const plan=workPlan(JSON.parse(fs.readFileSync('prd.json','utf8')));console.log(JSON.stringify({summary:plan.summary,ready:plan.ready.map(([id])=>id),blocked:plan.blocked,invalid:plan.invalid,complete:plan.complete},null,2))"
```

Report `plan.summary` across every sprint, plus `plan.ready`, `plan.blocked` and
`plan.invalid`. Keep archived totals separate from the active population. A
missing file, parse error, invalid story and empty population are distinct
outcomes; name the actual one. `plan.complete` is false for empty or unresolved
work. A current-sprint view may be shown separately, labelled with its scope.
Use targeted reading for story details, but never a header or newest sprint as
a substitute for the population used to choose work or declare completion.

## When to Sprint

- **5+ related tasks** — create a sprint in prd.json
- **< 5 tasks or single fixes** — work directly, no sprint or stories needed
- **Design/creative work** — iterate freely, skip planning overhead
- **Quick fixes** — just fix, verify, done

Sprints are for tracking, not for ceremony. If the work is small, skip the overhead.

## One layer, on purpose

prd.json is the task system. It is git-tracked, so sprint state survives
`/clear`, compaction, a crash, and a week away — none of which the session-local
task list survives.

Use a native task tool only when the running host actually exposes it. Native
tasks can display in-flight work, but prd.json remains the durable authority.
Record the story, owner, branch/base, current action and return artifact before
dispatch; update the outcome as it changes rather than waiting for session end.

## prd.json Story Schema

```json
{
  "id": "S26-001",
  "title": "Fix tooltip clipping",
  "priority": 1,
  "passes": null,
  "realness": null,
  "type": "fix",
  "category": "components",
  "notes": "",
  "resolution": ""
}
```

| Field | Values |
|-------|--------|
| `passes` | `null` (pending), `true` (done), `false` (failed), `"deferred"` (decided against), `"needs-setup"` (blocked on a human — an API key, a vendor, a console) |
| `realness` | 0-100 (optional, see below). `null` = not rated yet |
| `type` | fix, feature, refactor, qa, perf |
| `priority` | 0=critical, 1=high, 2=medium, 3=low |
| `resolution` | HOW it was fixed (learning) |

### Realness Scale (0-100)

`realness` is an optional reviewer judgment about maturity. It does not establish
completion, production readiness or authorization. Set `passes: true` only when
the story's observable acceptance criteria have passed at its intended boundary;
record the tested commit, environment, commands/results and artifact paths in
its verification record. Pending deployment remains explicit when the story
promised a live outcome.

| Score | Meaning |
|-------|---------|
| 20 | Stubbed — UI exists, no backend |
| 40 | Wired — frontend and backend connected, happy path works in dev |
| 60 | Functional — handles the obvious edge cases, one real end-to-end test |
| 80 | Production-ready — error handling, empty/loading/error states, observability |
| 100 | Battle-tested — used by real users, edge cases caught and fixed |

Rules:
- Do not assign a default score to a bug fix; describe what was actually verified.
- Features require a manual rating — don't auto-assign 100 just because `passes: true`.
- When in doubt, pick the lower number.
- If reporting an average, include the rated population and unrated count. Keep
  acceptance failures and unresolved release work visible regardless of the score.

## Resolution Learning

When completing bug fixes, document HOW:

```
[PATTERN]: [SPECIFIC FIX]
```

Examples:
- `null-check: Added optional chaining at line 45`
- `missing-import: Added import for DateRange`
- `type-mismatch: Changed Record<string, T> to Partial<Record<K, T>>`
- `overflow: Added max-h + overflow-auto`

## Context Tips

Use the runtime's actual context budget. Keep full decisions and evidence in files
and concise artifact pointers in the conversation.

| Action | Do This |
|--------|---------|
| Check status | Read the shared work plan across all sprints |
| Start task | Grep specific story |
| Track progress | Update the story in prd.json |
| Complete work | Record verified outcomes as each unit finishes |

## Archive Trigger

When ANY of these are true, run `archive` before starting new work:
- 4+ total sprints exist in prd.json
- prd.json > 500 lines
- prd.json > 50KB
- Starting a new sprint while previous sprint's stories are all complete

Run `archive-prd` within the existing mandate. Archive only eligible completed
records to its verified tracked `prd-archives/` destination; preserve unresolved
stories and completed prerequisites still referenced by retained work. Age or
size never authorizes deleting unfinished sprints. Commit the archive and PRD
update together, then continue the already authorized work.
