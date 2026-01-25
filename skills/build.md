---
name: Autonomous Build Loop v2.5
description: Core task loop with session management, ledger, and learning.
triggers:
  - auto
  - continue
  - status
  - brainstorm
  - generate
  - stop
  - reset
  - review
  - security
  - polish
  - handoff
  - resume
  - ledger
  - stats
  - update
  - sync
---

# Core Loop

## "status"
```
1. Read prd.json (if read fails due to token limit → suggest "archive")
2. Count: complete (passes=true) vs pending (passes=false/null)
3. Include archived count if archived section exists
4. Report: "X/Y active + Z archived. Next: [title]"
```

## "auto"
```
LOOP until no pending tasks:
  1. Find next task (passes=false/null, not skipped)
  2. Read the files listed
  3. Implement changes
  4. Run: npm run build
  5. If build fails:
     - Log error pattern to .claude/mistakes.md
     - Fix errors, retry (max 3)
  6. If build passes:
     - Run UI verification (see below)
     - If UI issues found: fix and rebuild
     - Mark passes=true
  7. Continue to next task
  8. After every 3 tasks: remind about context/handoff

UI VERIFICATION (for stories with component files):
  If story.files includes *.tsx components:
    1. Take screenshot of affected route/component
    2. Check for: clipping, overflow, spacing issues
    3. If issues found: fix before marking complete
  Skip for: API routes, hooks, utilities, types

STOP CONDITIONS:
- No more pending tasks → run "polish"
- 3 consecutive failures on same task → ask user
- User interrupts
```

## "continue"
```
Same as auto, but stop after 1 task completed.
```

## "brainstorm" / "generate"
```
1. Ask: "What do you want to build?"
2. Generate 3-10 stories based on answer
3. Show list, confirm before adding
4. Add to prd.json with passes=null
```

## "stop"
```
1. Update ledger.json with session summary
2. Append summary to progress.txt
3. Report what was done
4. Safe to close
```

## "reset"
```
1. Clear all claimedAt fields in prd.json
2. Report: "Reset complete"
```

---

# Session Management (v2.5)

## "handoff"
```
Save session context for seamless continuation in new session.

1. Generate structured summary:
   - Tasks completed this session (from prd.json changes)
   - Current task in progress
   - Key decisions made
   - Blockers/issues encountered
   - Files modified
   - Recommended next steps

2. Update ledger.json:
   {
     "sessions": [..., {
       "id": "YYYY-MM-DD-HHMM",
       "tasksCompleted": ["S1", "S2"],
       "filesModified": ["src/App.tsx"],
       "decisions": ["Switched to React Query"],
       "blockers": [],
       "nextSteps": ["Complete S3", "Fix type errors"]
     }]
   }

3. Write handoff-YYYY-MM-DD-HHMM.md with full details

4. Append summary to progress.txt

5. Output:
   "Handoff saved to handoff-[timestamp].md
   Start new session and say 'resume' to continue."
```

## "resume"
```
Continue from previous session handoff.

1. Find latest handoff-*.md file
2. Read and display summary:
   "Resuming from [date]:
   - Completed: [tasks]
   - In progress: [task]
   - Next steps: [list]"
3. Read recent mistakes from .claude/mistakes.md
4. Inject context: "Avoid these recent issues: [list]"
5. Read prd.json for current status
6. Check if status line is configured, if not: run /status line
7. Report: "Ready. Next task: [title]"
```

## "ledger" / "stats"
```
Show session analytics from ledger.json.

┌─ Session Analytics ────────────────────────┐
│ Last 7 days:                               │
│                                            │
│ Sessions: 12                               │
│ Tasks completed: 47/52 (90%)               │
│ Avg tasks/session: 3.9                     │
│ Build success rate: 94%                    │
│                                            │
│ Hot files (most modified):                 │
│   src/App.tsx (8x)                         │
│   src/hooks/useData.ts (6x)                │
│                                            │
│ Common blockers:                           │
│   - Type errors (5x)                       │
│   - Missing imports (3x)                   │
└────────────────────────────────────────────┘

Also show from .claude/mistakes.md:
"Recent mistakes to avoid: [top 3 patterns]"
```

---

# Mistake Learning (v2.5)

## Auto-Logging Build Failures

When build fails 2+ times on same error pattern:

1. Extract error pattern from build output
2. Classify error type:
   - "Object is possibly 'undefined'" → null-check
   - "Cannot find module" → missing-import
   - "Type 'X' is not assignable" → type-mismatch
   - "Expected X arguments, got Y" → arg-count

3. Append to .claude/mistakes.md:
   ```
   ## YYYY-MM-DD: [error-type]
   **Error:** [message]
   **Context:** [what was being done]
   **Fix:** [how it was resolved]
   **Files:** [affected files]
   ```

4. On session start, inject top 3 recent mistakes as warnings

## Mistake File Format

```markdown
# Mistake Log

## 2026-01-22: null-check
**Error:** Object is possibly 'undefined'
**Context:** Accessing user.profile without null check
**Fix:** Use optional chaining: user?.profile?.name
**Files:** src/hooks/useAuth.ts

## 2026-01-21: missing-import
**Error:** Cannot find module '@/lib/utils'
**Context:** Added new utility function
**Fix:** Create the file or fix import path
**Files:** src/components/Button.tsx
```

---

# Code Quality

## "review"
```
1. npm run build
2. Check for TODO/FIXME
3. npm audit (if exists)
4. Run "security" check (see below)
5. Run "ux-audit" (see below)
6. Report findings
```

## "ux-audit" (part of review)
```
Static analysis for design system violations. Run with Haiku.

1. DESIGN TOKEN VIOLATIONS (grep src/):
   Pattern: text-gray-*, text-white, text-black, bg-gray-*, bg-white, bg-black
   Fix: Use semantic tokens (text-foreground, bg-background, text-muted-foreground)

   Pattern: text-blue-*, text-red-*, text-green-* (hardcoded colors)
   Fix: Use primary, destructive, success tokens

2. INLINE STYLE VIOLATIONS:
   Pattern: style={{, style=", className={`...${
   Fix: Use Tailwind classes or CSS variables

3. PLACEHOLDER CONTENT:
   Pattern: Lorem ipsum, placeholder, TODO, FIXME, example.com, test@test
   Fix: Replace with real content or realistic mock data

4. GENERIC AI PATTERNS:
   Pattern: "Welcome to", "Get started", "Click here", "Learn more"
   Fix: Use specific, contextual copy

   Pattern: Default icons (HelpCircle, Settings, User without customization)
   Fix: Choose icons that match the action

5. ACCESSIBILITY:
   Pattern: <img without alt=, <button without aria-label (icon-only)
   Pattern: onClick on non-interactive elements (div, span)
   Fix: Add proper accessibility attributes

Report format:
  ✓ Design tokens: No violations
  ✗ Found 3 hardcoded colors in src/components/Card.tsx
    → Line 12: text-gray-500 → text-muted-foreground
    → Line 18: bg-white → bg-background
  ✗ Placeholder content in src/pages/Dashboard.tsx
    → Line 45: "Lorem ipsum" → Real description
```

## "polish" (after all tasks done)
```
Analyze codebase and let user choose direction. THREE steps:

STEP 1: Visual verification (Haiku subagent)
  1. Start dev server if not running
  2. Screenshot key routes: /, /dashboard, /login, main features
  3. AI reviews each screenshot for:
     - Clipping/overflow (text cut off, elements outside container)
     - Spacing inconsistencies (uneven margins, cramped layouts)
     - Color contrast issues (light text on light bg)
     - Empty states (missing loading, error, or empty UI)
     - Generic look (default icons, placeholder images)
  4. List specific issues with file:line references

STEP 2: Static analysis
  - Run ux-audit (design token violations)
  - TODO/FIXME comments
  - console.log statements
  - Missing error boundaries
  - any types in TypeScript

STEP 3: Direction picker (AskUserQuestion)

"All tasks complete! Found 3 code issues + 2 visual issues."

┌─ What's next? ─────────────────────────────────────┐
│                                                     │
│ ○ Fix issues & continue (Recommended)              │
│   Address found issues, keep building               │
│                                                     │
│ ○ New feature                                      │
│   Brainstorm something new                          │
│                                                     │
│ ○ Ship it                                          │
│   Deploy to production                              │
│                                                     │
│ ○ Done for now                                     │
│   Save progress and exit                            │
│                                                     │
└─────────────────────────────────────────────────────┘

ACTIONS:
- "Fix issues & continue" → Add issues to prd.json → auto
- "New feature" → brainstorm
- "Ship it" → security → ship
- "Done for now" → handoff → stop
```

## "security" (RUN BEFORE EVERY PUSH)
```
Pre-push security audit - catches issues before Lovable/deployment:

1. SUPABASE (if project has Supabase):
   - get_advisors(project_id, type: "security")
   - get_advisors(project_id, type: "performance")
   - Fix any WARN/ERROR before proceeding

2. SECRETS SCAN (grep migrations + .env):
   - Search: password, secret, api_key, token (hardcoded values)
   - Check: No secrets in migrations/*.sql
   - Check: .env is in .gitignore

3. FUNCTION AUDIT (if Supabase):
   - All functions must have: SET search_path = public
   - All functions with auth should use: SECURITY DEFINER

4. RLS CHECK:
   - list_tables → verify rls_enabled = true for ALL tables
   - No tables without RLS policies

5. TOKEN SECURITY:
   - Share tokens use: gen_random_bytes(32) or uuid
   - Tokens have: expires_at column

Report format:
  ✓ Supabase advisors: 0 issues
  ✓ No hardcoded secrets
  ✓ Functions: search_path set
  ✓ RLS: all tables protected
  ✗ ISSUE: [description] → [fix]

BLOCK PUSH if any ✗ found. Fix first.
```

---

# Maintenance

## "update" / "sync"
```
1. cd ~/Downloads/code/claude-auto-dev && git pull
2. cp skills/*.md ~/.claude/skills/
3. Report: "Updated to version X"
```

## "archive"
```
When prd.json > 2000 lines or read fails:
1. Backup prd.json → prd-backup-YYYYMMDD.json (use Read+Write, not shell copy)
2. Parse JSON, separate: completed (passes=true, type!="qa") vs active
3. Write completed to: prd-archive-YYYY-MM.json
4. Update prd.json:
   - Add "archived" section with summary
   - Keep only active/QA stories
5. Report: "Archived X stories, Y remain active"

NOTE: Use Read/Write tools for file operations, not shell commands (cross-platform).
```

## "clean"
```
Remove Claude Code artifacts to reduce clutter:
1. Delete .claude/screenshots/*.png (test screenshots)
2. Delete prd-backup-*.json older than 7 days
3. Delete handoff-*.md older than 7 days
4. Delete .playwright-mcp/ folder
5. Report: "Cleaned X files, freed Y MB"
```

## "docs" / "update docs"
```
Sync all documentation:
1. Copy local skills to claude-auto-dev repo
2. Update CHANGELOG.md with new version
3. Update README.md
4. Bump VERSION
5. Commit and push
```

---

# Files

| File | Purpose |
|------|---------|
| prd.json | Active tasks. `passes: true/false` is truth. |
| prd-archive-YYYY-MM.json | Completed stories (full detail). |
| progress.txt | Append-only log. Human readable. |
| ledger.json | Session history + analytics. Gitignored. |
| handoff-*.md | Session handoff documents. Gitignored. |
| .claude/mistakes.md | Learned error patterns. Gitignored. |
| CLAUDE.md | Project context. |

---

# Ledger Schema

```json
{
  "version": "1.0",
  "project": "project-name",
  "sessions": [
    {
      "id": "2026-01-22-1430",
      "started": "2026-01-22T14:30:00Z",
      "ended": "2026-01-22T16:45:00Z",
      "tasksCompleted": ["S45", "S46"],
      "tasksAttempted": ["S45", "S46", "S47"],
      "filesModified": ["src/App.tsx"],
      "decisions": ["Switched to React Query"],
      "blockers": ["S47 blocked by API issue"],
      "buildFailures": 2,
      "buildSuccesses": 8
    }
  ],
  "stats": {
    "totalSessions": 12,
    "totalTasksCompleted": 47,
    "totalBuildFailures": 15,
    "avgTasksPerSession": 3.9
  }
}
```

---

# prd.json Schema (Minimal)

```json
{
  "id": "S1",
  "title": "Short title",
  "description": "What to do",
  "priority": 1,
  "passes": false,
  "files": ["src/file.ts"],
  "acceptanceCriteria": ["Criterion 1", "Criterion 2"]
}
```

---

# When Stuck (Max 3 attempts)

```
Attempt 1: Try obvious fix
Attempt 2: Read error carefully, try different approach
Attempt 3: Search codebase for similar patterns

Still stuck? Log to mistakes.md, ask user. Don't loop forever.
```

---

# Quick Reference

| Say | Does |
|-----|------|
| `auto` | Work through all tasks + UI verification |
| `continue` | One task, then stop |
| `status` | Show progress |
| `brainstorm` | Create new tasks |
| `stop` | Save to ledger and exit |
| `reset` | Clear stuck state |
| `handoff` | Save session for later resume |
| `resume` | Continue from last handoff |
| `ledger` / `stats` | Show session analytics |
| `review` | Check code + security + **UX audit** |
| `security` | **PRE-PUSH** audit |
| `polish` | Visual check + static analysis + direction |
| `update` | Pull latest system |
| `archive` | Compact prd.json |
| `clean` | Remove temp files |
| `docs` | Sync documentation |

---

# Model Routing (Automatic)

Opus is best at coding. Offload non-coding tasks to Haiku (60x cheaper).

## Routing Rules

| Task | Model | Why |
|------|-------|-----|
| `brainstorm`, `auto`, `continue` | **Opus** | Coding quality matters |
| `review`, `security`, `fix` | **Opus** | Deep analysis |
| `test` (browser clicks) | **Haiku** | Simple click/verify |
| `ux-audit` (grep violations) | **Haiku** | Pattern matching |
| `polish` visual check | **Haiku** | Screenshot + review |
| `status`, `ledger`, `stats` | **Haiku** | Read + display data |
| `handoff`, `stop`, `reset` | **Haiku** | Session file ops |
| `archive`, `clean`, `update` | **Haiku** | File maintenance |

## When to Use Haiku Subagent

For any non-coding task, spawn Haiku:
```
Task tool: model="haiku", prompt="Read prd.json, count tasks..."
Task tool: model="haiku", prompt="Write handoff file..."
Task tool: model="haiku", prompt="Click @e1, verify text..."
```

## Default: Stay in Opus

All coding, reasoning, and implementation stays in main session.
Haiku handles: browser clicks, file reads, status checks, session management.

---

# Context Management Tips

- After 3+ tasks: consider `/clear` or `handoff`
- Long session? Use `handoff` to save state, start fresh
- `resume` injects recent mistakes as warnings
- `ledger` shows what's working, what's not

---

# Official Claude Code Plugins (Complementary)

Use these alongside claude-auto-dev when helpful:

| Plugin | When to Use |
|--------|-------------|
| `/feature-dev` | Complex new feature (7-phase workflow with agents) |
| `/ralph-loop` | Stuck debugging ("keep trying until it works") |
| `/commit-push-pr` | Git workflow (commit + push + create PR) |
| `/code-review` | Deep PR review with 5 parallel agents |

**Install plugins**: See https://github.com/anthropics/claude-code/tree/main/plugins
