---
name: brainstorm
description: Scans codebase, proposes improvements and features autonomously. Use when unsure what to work on next.
triggers:
  - brainstorm
  - generate
allowed-tools: Bash, Read, Grep, Glob, Task, TaskCreate, TaskUpdate, TaskList, Write, Edit
model: opus
user-invocable: true
argument-hint: "[focus area]"
---

# Brainstorm

Scan, analyze, and propose — without asking what to focus on.

## Existing Tasks
!`node -e "try{const p=require('./prd.json');const sp=p.sprints?p.sprints[p.sprints.length-1]:p;Object.entries(sp.stories||p.stories||{}).forEach(([k,v])=>console.log(k,v.passes===true?'done':v.passes==='deferred'?'deferred':'pending',v.title))}catch(e){}"`

## Usage

| Command | Behavior |
|---------|----------|
| `brainstorm` | Full: quality scan + feature ideas → present findings |
| `brainstorm apply` | Create prd.json stories from last scan results |
| `brainstorm auth` | Targeted: ideas for auth specifically |
| `brainstorm features` | Skip quality scan, only feature ideas |

## Phase 1: Quality Scan (Parallel)

Launch 4 scans simultaneously using Task tool with `run_in_background: true`:

```typescript
Task({ subagent_type: "Explore", model: "opus", run_in_background: true,
  prompt: "Find TODOs/FIXMEs in [PROJECT_PATH]. Report: count, file:line, content." })

Task({ subagent_type: "Explore", model: "opus", run_in_background: true,
  prompt: "Find console.log statements in [PROJECT_PATH] (skip test files). Report: count, files." })

Task({ subagent_type: "Explore", model: "opus", run_in_background: true,
  prompt: "Find hardcoded colors (text-white, bg-black, #hex, rgb) in [PROJECT_PATH]. Report: count, files." })

Task({ subagent_type: "Explore", model: "opus", run_in_background: true,
  prompt: "Find large files (>300 lines) and 'any' type usage in [PROJECT_PATH]. Report: file, lines, issues." })
```

## Phase 2: Feature Ideation

After scans complete, read project context:
- `CLAUDE.md` — goals, roadmap, known issues
- `README.md` — what the app does
- `package.json` — name, description, dependencies

Then analyze and propose 3-8 features:
- **Missing features** — what similar apps have that this doesn't
- **UX improvements** — based on component structure found
- **Integration opportunities** — based on installed packages
- **Performance wins** — based on patterns observed

Be specific: "Add Cmd+K search modal" not "Improve UX"

## Phase 3: Present Findings

Present a findings table. Do not auto-create stories.

```
Brainstorm Complete
===================
Scanned 247 files in 45 seconds.

| # | Category | Finding | Priority |
|---|----------|---------|----------|
| 1 | Quality  | 12 console.logs in src/ | High |
| 2 | Quality  | 3 hardcoded colors | Medium |
| 3 | Feature  | Add keyboard shortcuts (Cmd+K) | Medium |
| 4 | Feature  | Dark mode toggle | Low |
| 5 | Perf     | 2 request waterfalls in dashboard | High |

Say "brainstorm apply" to create stories, or pick specific items to work on.
```

### Auto Mode Exception

If `.claude/auto-active` exists (running in auto mode), skip the presentation and create stories directly in prd.json. Auto mode's IDLE detection depends on story creation to continue the loop.

### brainstorm apply

When user says `brainstorm apply`:
1. Read prd.json (or create with `sprint: "S1"` if none exists)
2. Deduplicate against existing stories (match first 25 chars of title)
3. Create stories with ID format `S{sprint}-{number}`
4. Priority mapping: quality issues = priority 1-2, feature ideas = priority 2-3
5. Report: "Created X stories, skipped Y duplicates"

## Targeted Mode

When user says `brainstorm X`:
- Skip quality scan entirely
- Read files related to X topic
- Propose 3-5 specific ideas for X
- Present findings (do not auto-create stories)

## Deduplication

Before creating any story, check for existing tasks:

```typescript
const existing = await TaskList();

function isDuplicate(newTitle: string): boolean {
  return existing.some(task =>
    task.subject.toLowerCase().includes(newTitle.toLowerCase().slice(0, 20)) ||
    newTitle.toLowerCase().includes(task.subject.toLowerCase().slice(0, 20))
  );
}

if (!isDuplicate("Add keyboard shortcuts")) {
  TaskCreate({ subject: "Add keyboard shortcuts (Cmd+K)", ... });
}
```

Report skipped duplicates: "Skipped 2 ideas (already in task list)"

## Token Cost

- 4 parallel scans: ~20K tokens
- Context reads: ~5K tokens
- Time: 30-60 seconds

## Design System Awareness

Before proposing UI features:
- Check existing component structure (extend vs. replace)
- Ensure proposals use design tokens, not hardcoded colors
- Reference `design` skill for aesthetic consistency

## Plan Mode (For Complex Features)

When brainstorm identifies features spanning 3+ files, multiple approaches, or DB schema changes, suggest plan mode:

```
This feature spans [N] areas: [list].
Say "plan" to explore options, or pick items to work on directly.
```

## Rules

- Analyze and propose — do not ask "what do you want?"
- 3-8 feature ideas max
- Be specific — concrete features, not vague improvements
- Skip shadcn/ui colors (library defaults, not project issues)
- Deduplicate against existing tasks before creating
