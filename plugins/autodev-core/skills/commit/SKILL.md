---
name: commit
description: Standardized git commit, push, and PR creation workflow.
when_to_use: "Invoked when the user says \"commit\", \"push\", \"commit-push-pr\"."
allowed-tools: Bash, Read, Glob, mcp__Claude_Browser__*
model: opus
user-invocable: true
argument-hint: "[type] [message]"
---

# Commit Workflow

For UI verification, use the browser driver actually available in the current
host and its exposed schema. Resolve that capability before promising a live
check; another host's historical tool names are not an available API.

## Working Tree
!`git status --short`
!`git diff --stat HEAD`
!`git log --oneline -5`

## Quick Commit

```bash
# 1. Check what changed
git status --short
git diff --stat

# 2. Stage only the reviewed paths owned by this task
git add src/components/new-feature.tsx src/lib/utils.ts

# 3. Commit with conventional format
git commit -F "$commit_message_file"
```

Prepare `commit_message_file` with the exact conventional message before
running the commit. A file preserves literal backticks and newlines. Inspect
`git diff --cached` before committing so another session's staged work is not
absorbed into this task.

## Evidence goes IN the commit

If the change fixes a defect or moves a visible surface, the `prove` skill's
before/after pair belongs in this commit, not beside it. Two reasons, and the
second is the one that bites:

- A reviewer reading the commit later has no other route to it.
- `.claude/evidence/` is tracked, so evidence left uncommitted dirties the tree
  and any gate refusing a dirty tree then refuses to run at all.

Name the paths in the body and state the delta in one line. A difference you
cannot state in a sentence is one you have not checked.

## Conventional Commits (Required)

```
<type>: <short description>

[optional body]
```

| Type | When |
|------|------|
| `feat` | New feature |
| `fix` | Bug fix |
| `refactor` | Code restructure, no behavior change |
| `chore` | Dependencies, config, tooling |
| `docs` | Documentation only |
| `test` | Add or update tests |
| `perf` | Performance improvement |

**Rules:**
- Subject line < 70 chars
- Imperative mood: "add" not "added"
- No period at end
- Body explains WHY, not WHAT
- Include story ID when available: `feat(S13-001): add playlist UI`

## Commit and publish within the current authorization

Commit the reviewed task paths locally. Then follow the user's existing grant:
a request to push or open a PR is authorization for that requested step and does
not expire merely because it was given earlier. A commit-only request does not
imply publication. If publication is not covered, prepare the concrete branch,
validation and PR body before asking once for that missing authority.

A push or merge that deploys production also follows `ship` eligibility and
verification requirements before that action. Keep unapproved publication
queued while continuing independent authorized work.

### When a git hook refuses the commit or the push

A failing commit/push hook remains a failed check. Identify the actual hook,
command, project root and failure before diagnosing it. To compare with the base,
use an isolated temporary worktree at the verified base SHA, run the same command
with the same required environment, and retain both exit codes and diagnostics.
Verify that scratch worktree contains only this probe's files before removing it.
Do not switch refs or force-clean another worker's checkout.

Compare the FAIL lines, not the exit codes: two reds with different lines are
two different findings.

| base | branch | verdict |
|---|---|---|
| green | red | the red is this change's; fix it, no bypass |
| red | red, same lines | inherited failure; record it and resolve the gate or an explicitly authorized exception |
| red | red, more lines | both; fix the extra lines, then the rest is trunk's |

A matching base failure attributes the defect; it does not make the candidate
verified or authorize bypass. Preserve any existing explicit exception covering
this gate/action. If none exists, resolve the gate or present the concrete
evidence for an exception. For an authorized bypass, name the skipped gate, its
exact failure and the base reproduction in the commit or PR body. Historical
base-red bypasses show why attribution must be recorded; they do not supply
authority for the current action.

### Branch Strategy

Read the current branch, worktree list and task ownership before changing refs.
One git author can represent many concurrent agents, so contributor count does
not prove the checkout is private. Use the project's branch/worktree convention
and an isolated worktree when another session may be using the checkout. Never
switch branches underneath another worker or take over its staged files.

## Post-Commit Verification

Run the repository's actual required checks on the exact committed candidate.
Preserve exit codes and full diagnostic output; piping a build to `tail` can
return success while the build failed. Use a known dev-server URL from the
running project's configuration for UI verification, and drive the affected
flow rather than interpreting a responding port as acceptance.

If a check fails, attribute it against the base, fix owned failures, and make a
new forward commit. Re-run affected checks and required final gates. A long
check is not optional merely because a quick-check time budget elapsed.

## Full PR Flow (commit-push-pr)

1. Verify the assigned branch/worktree, base and changed paths. Commit only this
   task's reviewed code, tests and durable evidence.
2. Run the required checks against the candidate commit and current base. Re-run
   integration checks after a rebase or changed base.
3. Push/open the PR when covered by the current request or standing grant.
   Apply `ship` first if that action deploys production.
4. Read back the PR's actual title, head/base and contents before reporting it.

### PR Description

Describe only the changes in this PR, using its actual diff and the affected
story IDs from the shared `workPlan` population. A list of every completed PRD
story falsely credits unrelated work and misses nested stories. Lead with the
observable before/after behavior, then exact validation results and unresolved
limits. A prospective checklist is not evidence that tests ran.

Write the body to a file and pass it with `gh pr create --body-file`; keep the
literal newlines and avoid shell interpolation of commit/PR text.

## Safety Checks

**Before committing:**
- [ ] Run the applicable checks at the stage required by this repository. If its
      gate requires a clean committed candidate, commit reviewed owned paths
      first and run that gate before publication; do not create a circular
      requirement that the same gate pass before the commit can exist.
- [ ] Required tests executed a nonempty applicable population; an absent suite
      is reported, not converted to green with a no-tests-success flag
- [ ] No `.env` files staged — unstage if found
- [ ] Logging is intentional and contains no secrets; preserve required CLI output
- [ ] No hardcoded secrets — remove if found

**Before pushing:**
- [ ] Branch is correct (not pushing to main accidentally)
- [ ] Branch is up-to-date with remote: `git fetch && git status`
- [ ] Commit messages are clean

Resolve findings in owned files, record forward commits and run the required
checks at the repository's defined stage before publishing.

## Version Sync Check (claude-auto-dev repo only)

When committing here, run the existing version validation against the actual
manifests. Search matches in historical notes are not release metadata and must
not be bulk-rewritten merely because they name an earlier version.

In a repo that ships Claude Code plugins, the version lives in `VERSION`,
`package.json`, `.claude-plugin/marketplace.json`, and every
`plugins/*/.claude-plugin/plugin.json`. Do not edit them by hand — run the
repo's bumper (`node tooling/bump.js <x.y.z>` in this project) so they cannot
drift, then update the README badge.

The current version is: !`cat VERSION 2>/dev/null`

## Batch Commit (During Auto Mode)

Commit completed, independently recoverable units at useful milestones. Stage
explicit owned paths after reviewing the diff and index; a secret-extension
exclusion does not make a blanket add safe from unrelated files or another
session's changes. Write the exact conventional message to a file and use
`git commit -F`.

Do not defer all progress recording to session end: a crash can arrive first.

## Correcting a commit

Use a forward corrective commit. Local/unpushed does not prove exclusive
ownership, so an amend or reset is not routine cleanup in a shared checkout.
History rewriting requires an explicit request covering the exact owned ref
and evidence that another worker's work will not be displaced. Preserve a
recovery ref and use the repository's procedure for that exceptional operation.
