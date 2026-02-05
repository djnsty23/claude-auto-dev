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

**Philosophy:** User doesn't know what to focus on. YOU scan, analyze, propose, and create stories - without asking.

## Existing Tasks
!`node -e "try{const p=require('./prd.json');Object.entries(p.stories||{}).forEach(([k,v])=>console.log(k,v.passes===true?'done':v.passes==='deferred'?'deferred':'pending',v.title))}catch{}" 2>/dev/null`

## Usage

| Command | Behavior |
|---------|----------|
| `brainstorm` | Full: quality scan + feature ideas |
| `brainstorm auth` | Targeted: ideas for auth specifically |
| `brainstorm features` | Skip quality scan, only feature ideas |

## Phase 1: Quality Scan (Parallel)

Launch 4 scans simultaneously using Task tool with `run_in_background: true`:

```typescript
Task({ subagent_type: "Explore", model: "haiku", run_in_background: true,
  prompt: "Find TODOs/FIXMEs in [PROJECT_PATH]. Report: count, file:line, content." })

Task({ subagent_type: "Explore", model: "haiku", run_in_background: true,
  prompt: "Find console.log statements in [PROJECT_PATH] (skip test files). Report: count, files." })

Task({ subagent_type: "Explore", model: "haiku", run_in_background: true,
  prompt: "Find hardcoded colors (text-white, bg-black, #hex, rgb) in [PROJECT_PATH]. Report: count, files." })

Task({ subagent_type: "Explore", model: "haiku", run_in_background: true,
  prompt: "Find large files (>300 lines) and 'any' type usage in [PROJECT_PATH]. Report: file, lines, issues." })
```

## Phase 2: Feature Ideation (Autonomous)

After scans complete, read project context:
- `CLAUDE.md` - goals, roadmap, known issues
- `README.md` - what the app does
- `package.json` - name, description, dependencies

Then analyze and propose 3-8 features:
- **Missing features** - what similar apps have that this doesn't
- **UX improvements** - based on component structure found
- **Integration opportunities** - based on installed packages
- **Performance wins** - based on patterns observed

**Be specific:** "Add Cmd+K search modal" not "Improve UX"

## Phase 3: Present Everything

```
Brainstorm Complete
═══════════════════
Scanned 247 files in 45 seconds.

Quality Issues
┌──────────────────┬───────┬──────────────────┐
│ Category         │ Count │ Status           │
├──────────────────┼───────┼──────────────────┤
│ TODOs/FIXMEs     │ 0     │ ✅ Clean         │
│ console.log      │ 12    │ ⚠️ In 4 files    │
│ Hardcoded colors │ 6     │ ⚠️ In shadcn/ui  │
│ Large files      │ 3     │ ⚠️ >500 lines    │
└──────────────────┴───────┴──────────────────┘

Feature Ideas
┌───┬─────────────────────────────────┬────────┐
│ # │ Idea                            │ Effort │
├───┼─────────────────────────────────┼────────┤
│ 1 │ Add keyboard shortcuts (Cmd+K) │ Medium │
│ 2 │ Offline mode (PWA ready)        │ High   │
│ 3 │ Export to PDF                   │ Low    │
└───┴─────────────────────────────────┴────────┘

Create stories?
- "quality" → cleanup tasks only
- "features" → feature tasks only
- "all" → everything
```

## Targeted Mode

When user says `brainstorm X`:
- Skip quality scan entirely
- Read files related to X topic
- Propose 3-5 specific ideas for X
- Immediately create stories

## Rules

- **Never ask "what do you want?"** - analyze and propose
- **Don't over-generate** - 3-8 feature ideas max
- **Be specific** - concrete features, not vague improvements
- **Note effort** - Low/Medium/High for each
- **Skip shadcn/ui colors** - note them but don't prioritize (library defaults)
- **Auto-create for top recommendation** - then offer more
- **Deduplicate** - check existing tasks before creating (see below)

## Deduplication (REQUIRED)

Before creating any story, check for existing tasks:

```typescript
const existing = await TaskList();

// Skip if similar task exists
function isDuplicate(newTitle: string): boolean {
  return existing.some(task =>
    task.subject.toLowerCase().includes(newTitle.toLowerCase().slice(0, 20)) ||
    newTitle.toLowerCase().includes(task.subject.toLowerCase().slice(0, 20))
  );
}

// Only create if truly new
if (!isDuplicate("Add keyboard shortcuts")) {
  TaskCreate({ subject: "Add keyboard shortcuts (Cmd+K)", ... });
}
```

**Report skipped duplicates:** "Skipped 2 ideas (already in task list)"

## Token Cost

- 4 parallel Haiku scans: ~20K tokens
- Context reads: ~5K tokens
- Time: 30-60 seconds
- Much cheaper than reading entire codebase

## Design System Awareness

Before proposing UI features, check design constraints:

| Skill | What to Check |
|-------|---------------|
| `design` | Aesthetic direction, typography, color palette, UI structure preservation |
| `quality` | Design token usage, semantic colors |
| `code-quality` | Performance implications of new features (React/Next.js patterns) |

**When proposing UI features:**
- Check existing component structure first (`design` - Preserve UI Structure section)
- Ensure proposals use design tokens, not hardcoded colors
- Reference `design` for aesthetic consistency
- Note if feature requires new design patterns

**Example validation:**
```
Feature: "Add dark mode toggle"
├─ design: Extend existing ThemeProvider? ✓
├─ design: Uses CSS variables? ✓
├─ quality: All states handled? (system/light/dark) ✓
└─ Ready to create story
```

## Phase 2B: Design Validation (Optional)

For UI-heavy features, add validation step:
1. Check `design` principles (no AI slop)
2. Check `design` Preserve UI section (extend vs. replace)
3. Check existing tokens/variables
4. Propose feature with design context included

## Plan Mode (For Complex Features)

When brainstorm identifies features that span multiple areas, suggest plan mode:

**Triggers for plan mode suggestion:**
- Feature touches 3+ files
- Architectural decisions required
- Multiple valid implementation approaches
- Database schema changes involved

**Suggestion format:**
```
This feature spans [N] areas: [list areas].

Would you like me to enter plan mode to design a detailed implementation approach before creating stories?

Say "plan" to explore options, or "create" to proceed with stories.
```

**In plan mode:**
1. Explore codebase for existing patterns
2. Design implementation approach
3. Identify trade-offs
4. Present plan for approval
5. Then create stories from approved plan
