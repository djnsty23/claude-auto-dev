'use strict';
// E2C: confirmation round for the exploratory E2 signal (always-on rule lines proposed).
// Fresh incidents, none reused from E2.
module.exports = [
  {
    id: 'env-local-blank', truth: 'C1',
    record: `Symptom: a fresh worktree of the vistek app booted to a blank page.
Changes:
  C1 copied .env.local from the main checkout into the worktree
Runs: before C1, blank 2 of 2 boots. With C1, the app rendered 3 of 3 boots. Deleting .env.local again: blank 2 of 2.`,
  },
  {
    id: 'build-oom', truth: 'NONE',
    record: `Symptom: the Vercel build ran out of memory at the "Collecting page data" step.
Changes, in one commit:
  C1 set NODE_OPTIONS=--max-old-space-size=6144 for the build
  C2 removed an unused 40 MB charting dependency
After the commit: the next build succeeded. One build so far.`,
  },
  {
    id: 'msys-path', truth: 'C1',
    record: `Symptom: a Git Bash curl to /api/leads hit C:/Program Files/Git/api/leads and returned 404.
Changes:
  C1 prefixed the command with MSYS_NO_PATHCONV=1
Runs: with C1, 3 of 3 calls returned 200. Without it, 3 of 3 returned 404 with the rewritten path in the log.`,
  },
  {
    id: 'model-pin', truth: 'NONE',
    record: `Symptom: a subagent ran on the picker default model instead of its pinned Opus.
Changes, the same hour:
  C1 added model: opus to the agent's frontmatter
  C2 restarted the desktop app
  C3 unset CLAUDE_CODE_SUBAGENT_MODEL in the shell profile
After all three: the next dispatch ran on Opus. One dispatch checked.`,
  },
  {
    id: 'isolated-lock', truth: 'C2',
    record: `Symptom: npm run gate hung at "waiting for lane" on every attempt.
Changes, tried one at a time:
  C1 deleted the worktree's .next folder: still hung, 2 of 2 attempts
  C2 (C1 kept) removed a stale waiter with full-gate-queue.js leave --pid 4412: the gate started, 3 of 3 attempts
  A planted stale waiter brought the hang back, 2 of 2.`,
  },
  {
    id: 'email-tone', truth: 'NONE',
    record: `Symptom: client report emails read as stiff and over-formal.
Changes, the same day:
  C1 added a register rule to the writing style for client emails
  C2 switched the report to a new shorter template
After both: Andy said the next draft "reads fine". One draft reviewed.`,
  },
];
