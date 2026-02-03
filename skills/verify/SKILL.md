---
name: verify
description: Run quality checks and mark tasks complete
allowed-tools: Bash, Read, Grep, Glob, TaskUpdate, TaskList
model: sonnet
---

# Verify

Run thorough quality checks on completed work. Do NOT rush this.

## Process

1. **Find task** - Use $ARGUMENTS as task ID, or find current in_progress task via TaskList

2. **Run ALL checks** (do not skip any):
   - `npm run typecheck` - MUST pass with zero errors
   - `npm run build` - MUST pass
   - `npm run test` - if available, MUST pass
   - `npm run lint` - if available, note warnings
   - Grep changed files for `as any`, `@ts-ignore`, `console.log`
   - Verify no hardcoded secrets in changed files

3. **Review the work:**
   - Read the files that were changed (from git diff)
   - Check: Does the implementation match the acceptance criteria in the task description?
   - Check: Are all acceptance criteria met?
   - Check: Is error handling present where needed?
   - Check: Are loading/empty/error states handled (if UI)?

4. **Determine result:**

   **PASS** - All checks pass AND acceptance criteria met:
   ```
   TaskUpdate({
     taskId: "[id]",
     status: "completed",
     metadata: { passes: true, verified: "[build|test]" }
   })
   ```

   **FAIL** - Any check fails:
   ```
   Report exactly what failed and why.
   Keep task as in_progress.
   Do NOT mark as completed.
   ```

5. **Report:**
   ```
   Verify: [SID] - [subject]
   ═══════════════════════════
   Typecheck: ✓/✗
   Build: ✓/✗
   Tests: ✓/✗ ([N] passed, [N] failed)
   Lint: ✓/✗
   Code review: ✓/✗

   Result: PASS/FAIL
   [If fail: specific errors]

   Next: [SID] - [subject]
   ```

## Rules
- NEVER mark a task as completed if any check fails
- NEVER skip the code review step
- If tests don't exist for the feature, note it as a gap (don't fail, but flag)
- Build + typecheck are non-negotiable - both must pass
