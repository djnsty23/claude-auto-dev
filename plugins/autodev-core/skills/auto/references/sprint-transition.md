# Sprint transition

What auto does once every story in a sprint is done: verify, archive, bump, then continue or ask.

## Auto Sprint Transition

When all pending tasks are done, auto handles the sprint lifecycle — but verifies the work first and surfaces a summary before bumping.

```
1. BUILD GATE — run the real deploy-target build before anything else:
   npm run build  (or pnpm/yarn/bun equivalent)
   If it fails, do NOT archive or bump. Create a prd.json story for each
   error and continue working. Sprint can only close on a clean build.

2. Log summary to .claude/sprint-history.md:
   "Sprint [N]: [done]/[total] tasks | [date] | [one-line summary of work]"

3. Apply the archive-prd skill's split and durability checks:
   - Preserve unresolved stories, passed QA records, and the full prerequisite
     chain referenced by retained work; do not delete every passed record.
   - Prove a tracked archive destination before writing, read back the archive,
     and preserve every record by id and payload across archive plus active PRD.
   - Keep dependency readiness intact and commit the archive and PRD together.
     If any check fails, preserve the PRD and stop the transition.

4. Decide whether to bump — show a one-line honesty summary first:

   Sprint [N] closed: [done]/[total] tasks.
   Average realness: [avg]%  (see realness field in core schema)
   Build: passed in [T]s
   Carried forward: [M] deferred, [K] new findings
   Bumping to Sprint [N+1]. Say "stop" to pause.

   Then proceed — no confirmation needed, but the user has a clean
   window to interrupt. This beats silent bumps AND beats blocking
   prompts that break autonomous execution.

5. If no new work exists, skip the bump and go to "Ask User" below.
```

**Honest close criteria:** A sprint doesn't close just because every story has `passes: true`. It closes when (a) build passes on deploy target, (b) the summary accurately reflects what shipped, and (c) realness scores are filled in honestly.

## Decision Matrix

| Signal | Action |
|--------|--------|
| Deferred tasks from previous sprint | Preserve the decision; reactivate only when the mandate explicitly changes |
| Audit/brainstorm created new stories | Bump sprint, continue |
| Dev server running + UI changes made | Run visual scan, fix issues found |
| TODOs/FIXMEs in changed files | Create stories, fix them |
| Build warnings | Fix directly (no story needed) |
| Clean codebase, no work | Ask user (see below) |

## Auto-Continue (Obvious Work)

When new work exists after sprint transition, continue immediately:
```
Sprint [N] complete ([done]/[total] tasks).
Archived completed stories. [M] tasks carried forward.
Continuing as Sprint [N+1].
```

Limit: 2 auto-continued sprints per session. After that, ask the user.

## Ask User (No Obvious Work or Limit Reached)

If the sprint had 5+ tasks, suggest simplify first:
```
Sprint [N] complete ([done]/[total] tasks).

Recommended: run `simplify` to catch duplicate code from this sprint.

What's next?
1. simplify - Review for duplicate code and over-abstraction
2. audit - Deep quality scan (finds bugs + violations)
3. brainstorm - Feature ideas + dead code scan
4. Done for now
```

Keep the auto flag while asking. If the user picks "Done for now", write `.claude/auto-exit` with the Write tool; the Stop hook removes this session's flag.
