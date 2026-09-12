---
name: brainstorm
description: Feature ideation, dead code cleanup, and product thinking. Proposes new features and architecture improvements — not bugs or violations (use audit for those).
when_to_use: "Invoked when the user says \"brainstorm\", \"generate\"."
allowed-tools: Bash, Read, Grep, Glob, Task, Write, Edit, WebSearch
model: opus
user-invocable: true
argument-hint: "[focus area]"
---

# Brainstorm

Feature ideation + architecture improvements. Not bugs — use `audit` for that.

## Existing Tasks
Read the whole `prd.json`, including earlier sprints, archived references and
explicit deferments. Resolve the loaded autodev-core root and use
`scripts/prd-states.js`'s `workPlan(prd)` for state/dependency readiness.
A missing or malformed backlog is unknown, not zero prior work.

## Scope: Brainstorm vs Audit

| Brainstorm (this skill) | Audit (separate skill) |
|--------------------------|------------------------|
| New feature ideas | Security vulnerabilities |
| Dead code cleanup | Hardcoded colors / design violations |
| Architecture improvements | console.log / any types / type safety |
| Complexity / file splitting | Missing loading/error states |
| Competitor research | Accessibility violations |
| Product differentiation | Performance issues |
| UX flow improvements | Test coverage gaps |

When a confirmed bug appears, route its evidence through `audit`. If fixing it is already within the user's requested scope, create or link the work and continue; a skill boundary does not require another invitation.

## Usage

| Command | Behavior |
|---------|----------|
| `brainstorm` | Full: 3 parallel scans + feature ideation → present findings |
| `brainstorm quick` | Diff-based: only scan files changed recently (no agents, fast) |
| `brainstorm apply` | Create prd.json stories from last scan results |
| `brainstorm [topic]` | Targeted: ideas for a specific area |

## Quick Mode (brainstorm quick)

For recently-scanned codebases, skip full agent scans:

```bash
# 1. Resolve the prior recorded scan commit into BRAINSTORM_BASE; refuse if unknown.
git diff --name-only "$BRAINSTORM_BASE" -- '*.ts' '*.tsx' '*.css'

# Include relevant untracked additions, then deduplicate the combined path list.
git ls-files --others --exclude-standard -- '*.ts' '*.tsx' '*.css'

# 2. For each changed file, look for architecture opportunities:
#    - Large new files that could be split
#    - Duplicated patterns across new files
#    - New components that could be generalized
```

Use quick mode only when a recorded prior scan identifies its commit and scope. Diff from that commit, not an arbitrary five-commit window, and name any unscanned surfaces. Measure elapsed time instead of promising ten seconds.

## Agent Memory (read before scanning)

Before running scans or proposing features, read `.claude/agent-memory/brainstorm-history.md` if it exists. This file tracks:

- **Past suggestions** — applied and rejected ideas from previous sessions. Don't re-propose rejected ideas; don't re-propose applied ideas unless the user explicitly asks.
- **Skipped patterns** — classes of suggestions the user has consistently declined (e.g., "don't suggest file splits under 300 lines").

If the file doesn't exist, create it on first brainstorm with this seed:
```markdown
# Brainstorm History (auto-maintained)

## Past Suggestions
<!-- Format: [date] title | outcome (applied:S3-002 | rejected | deferred) -->

## Skipped Patterns
<!-- Rules the user has set. Format: pattern | reason -->
```

After `brainstorm apply`, append the created stories to "Past Suggestions" with their prd.json IDs. If the user rejects a finding during presentation, record it as `rejected` so it doesn't come back.

## Phase 1: Architecture Scan (Parallel)

Read `rule-agent-concurrency` and use the current host's actual worker API, within its available slots. The Task examples below describe the briefs on hosts exposing that API; on another host use its supported equivalent, or run the scans sequentially. Verify each worker started and collect its evidence.

Replace `[PROJECT_PATH]` below with the actual working directory path.

**Important:** Cap each agent at ~80 tool calls. Scope to specific directories, not entire src/.

```typescript
// Scan 1: Dead code — unused exports, unreferenced components, orphan routes
Task({ subagent_type: "Explore", run_in_background: true,
  prompt: `Find dead code in [PROJECT_PATH]/src. Limit to 80 tool calls max.
  1. Components in src/components/ not imported anywhere else
  2. Exported functions/constants not imported by any other file
  3. Route segments (page.tsx) that import deleted/missing components
  Cross-reference exports against imports, package exports, route conventions, config, scripts, tests and dynamic consumers. A missing literal name in src/ alone is not proof of dead code.` })

// Scan 2: Complexity + splitting opportunities
Task({ subagent_type: "Explore", run_in_background: true,
  prompt: `In [PROJECT_PATH]/src. Limit to 80 tool calls max.
  1. Files over 300 lines — report file path and line count
  2. For each large file: does it have multiple exported components or clearly separable sections? Only report genuinely splittable files.
  3. Duplicated code patterns: find 2+ components with >50% structural similarity
  4. Check for client-side data fetching in page.tsx/layout.tsx that could be server-side
  Report only actionable findings, not cohesive files that should stay together.` })

// Scan 3: Unused dependencies + outdated patterns
Task({ subagent_type: "researcher", run_in_background: true,
  prompt: `In [PROJECT_PATH]. Limit to 80 tool calls max.
  1. Read package.json dependencies. Check imports plus config/plugins/scripts/CLI use, peer contracts and dynamic loading before labeling a dependency unused. State the population examined.
  2. Check for outdated patterns: class components, legacy API usage, deprecated package usage. If Context7 tools are available (mcp__plugin_context7_context7__*), use them to confirm whether patterns are actually deprecated in the current major version — don't flag based on stale training data.
  Report: unused deps list, outdated patterns found (with version context).` })
```

## Phase 2: Feature Ideation (Product Thinking)

After scans complete, read project context:
- `CLAUDE.md` — goals, roadmap, known issues
- `README.md` — what the app does
- `package.json` — name, description

### Step 1: Understand the product's identity

Answer these before proposing anything:
- **What is this product's unique angle?** (Not "what category is it" but "why would someone choose this over alternatives?")
- **Who specifically uses it?** (Developer? Marketing team? Small business owner?)
- **What's the core "aha moment"?** (The first thing that makes a user think "this is useful")

### Step 2: Research competitors (optional, skip if WebSearch is slow)

If WebSearch is available and responsive, check 1-2 competitors: "[product name] vs [competitor]" or "best [category] tools 2026"

For each competitor, note:
- What they do well (features to match)
- What they do poorly (opportunities to differentiate)

If WebSearch fails or is slow, skip this step — product thinking from step 1 + step 3 is sufficient.

### Step 3: Walk the user journey

1. Landing/onboarding — what's the first experience? Is the value prop clear in 5 seconds?
2. Core workflow — what does the user do most? Where's the friction?
3. Output/sharing — can users share results? Export? Collaborate?
4. Retention — what brings users back?

### Step 4: Propose differentiated features

Propose only features that pass ALL these filters:
- **Feasible now** — don't propose features for placeholder/coming-soon pages
- **Not already done** — verify the feature doesn't already exist before proposing
- **Specific** — "Add Cmd+K search modal" not "Improve UX"
- **Differentiated** — "This helps because competitors don't do X" not generic SaaS playbook items
- **Proportional** — don't propose 6 stories for a clean codebase. 0-3 is fine.

Avoid generic suggestions like "add analytics dashboard", "team workspaces", "notification system" unless the competitor research specifically shows these as gaps that matter for THIS product's users.

## Phase 3: Present Findings

Present a findings table. Do not auto-create stories.

Validate every finding before including it:
- Claiming "0 tests"? Check test directories, playwright config, jest config first.
- Claiming a file should be split? Check if it has multiple exported components or is actually cohesive.
- Claiming a feature is missing? Grep for it first — it might already exist.

```
Brainstorm Complete
===================
Scanned [N] files in [T] seconds.

| # | Category | Finding | Priority |
|---|----------|---------|----------|
| 1 | Feature | Competitor X has [feature] — worth adding because [reason] | High |
| 2 | Feature | [User flow] has friction at [step] — add [solution] | High |
| 3 | Architecture | 3 unused components can be removed | Medium |
| 4 | Architecture | Dashboard.tsx (450 lines) should split into 3 components | Medium |
| 5 | Architecture | Client-side fetch in page.tsx could be server prefetch | Low |
| 6 | Cleanup | 2 unused dependencies can be removed | Low |

Codebase health: [honest assessment — "clean, no urgent issues" is valid]

Say "brainstorm apply" to create stories, or pick specific items.
Bugs or violations? Run "audit" instead.
```

If the codebase is genuinely clean, say so. Do not invent work to fill a table.

### Auto Mode Exception

When the current mandate authorizes autonomous improvement, create evidence-backed, in-scope stories directly. An activation marker alone is not authority to expand scope. An empty scan is a valid outcome; do not invent stories to keep Auto running.

### brainstorm apply

When user says `brainstorm apply`:
1. Read prd.json (or create with `sprint: "S1"` if none exists)
2. Deduplicate by the actual outcome/root cause, affected surface and acceptance criteria across the full PRD; title similarity is a review lead only.
3. **Push back on padding.** Before creating, review the finding list:
   - If 3+ findings are 1-line changes in the same area, batch into one story
   - For one coherent small fix, use one story or the project's lightweight tracking convention. Existing authorization is enough; do not require confirmation merely because the list is short.
   - Never create a sprint of padding to hit a round number.
4. Create stories with ID format `S{sprint}-{number}`
5. Report: "Created X stories (batched Y trivial findings), skipped Z duplicates"

## Targeted Mode

When user says `brainstorm X`:
- Skip Phase 1 scans entirely
- Read files related to X topic
- Propose 3-5 specific ideas for X
- Present findings (do not auto-create stories)

## Deduplication

Before creating any story, check for existing tasks:

Read the persisted PRD and any available host task list as separate evidence.
Match the intended outcome, cause and acceptance, then link genuine duplicates.
Two tasks sharing a title prefix or file can still require different fixes.
Allocate a unique ID following `core`; preserve existing story containers and
dependencies. Native task widgets are optional mirrors, not the source of truth.

Report each skipped duplicate with the existing story ID and matching outcome.

## Design System Awareness

Before proposing UI features:
- Check existing component structure (extend vs. replace)
- Ensure proposals use design tokens, not hardcoded colors
- Reference `design` skill for aesthetic consistency

## Rules

- Route bug evidence through `audit`; continue fixes already authorized by the current mission
- Analyze and propose — do not ask "what do you want?"
- Quality over quantity — 2 real findings beat 6 padded ones
- Validate before claiming — grep to confirm, don't assume
- Deduplicate against the full persisted PRD; use available native task state as supplementary context
- Check actual outcome/root-cause overlap; never drop a distinct fix solely because its title or file matches
- "Codebase is clean, nothing to propose" is a valid outcome
- Cap each scan agent at ~80 tool calls to avoid rate limits
