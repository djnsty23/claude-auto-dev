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
!`node -e "try{const p=require('./prd.json');const sp=p.sprints?p.sprints[p.sprints.length-1]:p;Object.entries(sp.stories||p.stories||{}).forEach(([k,v])=>console.log(k,v.passes===true?'done':v.passes==='deferred'?'deferred':'pending',v.title))}catch(e){}"`

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

If you find a bug or violation during brainstorm, note it but don't create a story — suggest running `audit` instead.

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
# 1. Get files changed since last brainstorm
git diff --name-only HEAD~5 -- '*.ts' '*.tsx' '*.css'

# 2. For each changed file, look for architecture opportunities:
#    - Large new files that could be split
#    - Duplicated patterns across new files
#    - New components that could be generalized
```

Quick mode takes ~10 seconds. Use after a recent full brainstorm when the codebase hasn't changed much.

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

Launch 3 scans simultaneously using Task tool with `run_in_background: true`.

Replace `[PROJECT_PATH]` below with the actual working directory path.

**Important:** Cap each agent at ~80 tool calls. Scope to specific directories, not entire src/.

```typescript
// Scan 1: Dead code — unused exports, unreferenced components, orphan routes
Task({ subagent_type: "Explore", run_in_background: true,
  prompt: `Find dead code in [PROJECT_PATH]/src. Limit to 80 tool calls max.
  1. Components in src/components/ not imported anywhere else
  2. Exported functions/constants not imported by any other file
  3. Route segments (page.tsx) that import deleted/missing components
  Cross-reference: for each export, grep for its name across src/. Report only confirmed unused.` })

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
  1. Read package.json dependencies. For each dependency, grep src/ to check if it's actually imported. Report unused deps.
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

If `.claude/auto-active` exists (running in auto mode), skip the presentation and create stories directly in prd.json. Auto mode's IDLE detection depends on story creation to continue the loop.

### brainstorm apply

When user says `brainstorm apply`:
1. Read prd.json (or create with `sprint: "S1"` if none exists)
2. Deduplicate against existing stories (match first 25 chars of title)
3. **Push back on padding.** Before creating, review the finding list:
   - If 3+ findings are 1-line changes in the same area, batch into one story
   - If the full list has fewer than 2 findings that are genuinely non-trivial (require reasoning, multi-file changes, or design decisions), tell the user: "This looks like a 1-story sprint, not 5 — recommend skipping the sprint and just doing the fix directly." Then wait for confirmation before creating.
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

```typescript
const existing = await TaskList();

function isDuplicate(newTitle: string): boolean {
  return existing.some(task =>
    task.subject.toLowerCase().includes(newTitle.toLowerCase().slice(0, 25)) ||
    newTitle.toLowerCase().includes(task.subject.toLowerCase().slice(0, 25))
  );
}

if (!isDuplicate("Add keyboard shortcuts")) {
  TaskCreate({ subject: "Add keyboard shortcuts (Cmd+K)", ... });
}
```

Report skipped duplicates: "Skipped 2 ideas (already in task list)"

## Design System Awareness

Before proposing UI features:
- Check existing component structure (extend vs. replace)
- Ensure proposals use design tokens, not hardcoded colors
- Reference `design` skill for aesthetic consistency

## Rules

- **Features and architecture, not bugs** — if you find a bug, note it and suggest `audit`, don't create a story
- Analyze and propose — do not ask "what do you want?"
- Quality over quantity — 2 real findings beat 6 padded ones
- Validate before claiming — grep to confirm, don't assume
- Deduplicate against existing prd.json stories AND native Tasks before creating
- Check open tasks overlap: if a finding matches an existing pending story (first 25 chars of title), skip it
- "Codebase is clean, nothing to propose" is a valid outcome
- Cap each scan agent at ~80 tool calls to avoid rate limits
