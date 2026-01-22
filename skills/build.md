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
  6. If build passes: mark passes=true
  7. Continue to next task
  8. After every 3 tasks: remind about context/handoff

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
6. Report: "Ready. Next task: [title]"
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
5. Report findings
```

## "polish" (after all tasks done)
```
Analyze codebase and let user choose direction. ONE command, TWO steps:

STEP 1: Find improvements (max 4)
- TODO/FIXME comments
- console.log statements
- Missing error boundaries
- Accessibility gaps
- any types in TypeScript

STEP 2: Direction picker (AskUserQuestion)

"All tasks complete! Found 3 polish items."

┌─ What's next? ─────────────────────────────────────┐
│                                                     │
│ ○ Polish & continue (Recommended)                  │
│   Add improvements, keep building                   │
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
- "Polish & continue" → Add items to prd.json → auto
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
| `auto` | Work through all tasks |
| `continue` | One task, then stop |
| `status` | Show progress |
| `brainstorm` | Create new tasks |
| `stop` | Save to ledger and exit |
| `reset` | Clear stuck state |
| `handoff` | Save session for later resume |
| `resume` | Continue from last handoff |
| `ledger` / `stats` | Show session analytics |
| `review` | Check code quality + security |
| `security` | **PRE-PUSH** audit |
| `polish` | Find improvements + pick direction |
| `update` | Pull latest system |
| `archive` | Compact prd.json |
| `clean` | Remove temp files |
| `docs` | Sync documentation |

---

# Model Routing (Cost Optimization)

Switch models based on task complexity. Uses separate usage pools.

## Recommended Models by Task

| Task | Model | Command | Why |
|------|-------|---------|-----|
| `brainstorm`, planning | **Opus** | `/model opus` | Complex reasoning |
| `auto`, `continue` | **Sonnet** | `/model sonnet` | Balanced speed/quality |
| `test` (browser testing) | **Haiku** | `/model haiku` | Simple click/verify |
| `status`, `archive`, `clean` | **Haiku** | `/model haiku` | Trivial operations |
| `review`, `security` | **Opus** | `/model opus` | Deep analysis |
| `fix` (debugging) | **Opus** | `/model opus` | Complex problem-solving |
| `polish` | **Sonnet** | `/model sonnet` | Code scanning |

## Usage Pattern

```
# Start session with Opus for planning
/model opus
brainstorm

# Switch to Sonnet for implementation
/model sonnet
auto

# Use Haiku for simple tasks
/model haiku
status
```

## Special Mode: opusplan

For complex features, use hybrid mode:
```
/model opusplan
```
- Opus for plan/think phases
- Auto-switches to Sonnet for implementation
- Best of both: quality planning + efficient execution

## Why This Matters

- **Opus**: Most capable, uses "All models" pool
- **Sonnet**: 0% used (separate pool in many plans!)
- **Haiku**: 3x cheaper, 90% of Sonnet capability

Running 4 projects? Distribute:
- 1-2 on Opus (complex tasks)
- 1-2 on Sonnet (implementation)
- Testing/status tasks on Haiku

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
