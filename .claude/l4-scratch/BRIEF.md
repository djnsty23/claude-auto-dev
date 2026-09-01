# L4 bootstrap audit brief (round 1, tests-first)

Tree: commit f44f321, worktree `.claude/worktrees/vigorous-maxwell-7ac5dc`.

## Subject

`.claude/l4-scratch/tooling/check-population-reporting.js` — a copy of a real
gate from this repo. Beside it sits `.claude/l4-scratch/tooling/fixture-absence.js`.
The copy resolves its scan ROOT from `__dirname/..`, so it scans ONLY
`.claude/l4-scratch/tooling/` (itself plus the fixture). Read the file's header
comment first: it documents the script's own known limits, and those are NOT
findings for this round.

## The question

Does this script, as a GATE, ever report a failure in its OUTPUT while its EXIT
CODE says otherwise? A gate whose prose says "fail" and whose exit code says 0
is a false verdict: a CI step reads only the exit code. Find every such path.
Anything else you notice (style, radius limits already documented, missing
features) goes under a separate heading "Out of scope" with one line each and
no test.

## Rules

1. Every finding is prefixed exactly `Measured: <command> printed <x>` with the
   real command you ran and the real output. A finding you did not reproduce is
   labelled `HYPOTHESIS:` instead and carries no test.
2. Write findings INCREMENTALLY to `.claude/l4-scratch/findings.md`: append one
   finding per block as you confirm it, never compose one answer at the end.
   Give findings stable ids F1, F2, ...
3. For each Measured finding, write an acceptance test
   `.claude/l4-scratch/test-<short-name>.js` (plain node, `assert`, exit 1 on
   failure, exit 0 on pass) that FAILS on the current subject FOR THE STATED
   REASON. The test must be self-contained: build its own temp tree with
   `fs.mkdtempSync`, copy the subject into `<tmp>/tooling/` beside a fixture the
   test writes, run it with `child_process.spawnSync(process.execPath, ...)`,
   assert on `status` (the exit code). Run the test and paste the command and
   its output into the finding block; it must show the failure.
4. Do NOT modify the subject. Do NOT write outside `.claude/l4-scratch/`. Do NOT
   run npm scripts and do not run anything under the repo's real `tooling/`
   other than reading it.
5. Closing message under 1200 characters: each finding id with one clause, the
   test file names, then the exact line `AUDIT: COMPLETE`.
