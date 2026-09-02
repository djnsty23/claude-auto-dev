---
name: isolate
description: "Start work in a fresh git worktree branched from the remote default branch, so parallel agents never share a tree. Use before the first edit of any feature, fix or task, and whenever a repo has more than one session working in it."
when_to_use: "Invoked when the user says \"isolate\", and automatically as step 1 of the spine, before any edit."
allowed-tools: Bash, Read, Grep, Glob
model: opus
user-invocable: true
argument-hint: "[slug]"
---

# Isolate

One tree per task. The failure this prevents has no error message: two agents in
one working copy overwrite each other's edits, and git reports nothing, because
from git's side the second write is just the current state of the file.

## Before creating anything, check nobody is already on it

```bash
git ls-remote --heads origin
gh pr list --state all --limit 30
```

Two commands, seconds each. A branch that already exists under the name you were
about to create is the cheapest possible warning that someone is on the same
problem. Read that branch before renaming around it, and if the work is
duplicated keep the better implementation rather than yours.

## Create the tree

```bash
git fetch origin
git worktree add .claude/worktrees/<slug> -b <slug> origin/main
```

Branch from the **remote** default branch, not from local `main`, which may be
behind or may carry another session's uncommitted work.

`.claude/worktrees/` is the convention because it is gitignored, so the trees
never appear as untracked files in the parent clone.

## A fresh worktree is not a working checkout

`git worktree add` copies the tracked tree and nothing else. Two things are
missing and both fail in ways that look like a bug in your change:

- **Gitignored env files.** Copy `.env.local` and siblings from the main clone.
  Without them a dev server starts with zero env injected, the app never mounts,
  and every browser check fails against a blank page.
- **`node_modules`.** A worktree cut from an older base, or reusing the parent's
  install, surfaces import errors for dependencies added since. Run the install.

Check both before concluding anything about the code:

```bash
ls -a .claude/worktrees/<slug> | grep -c '^\.env' || echo "0 env files — copy them"
```

## Never touch a tree you did not create

Do not `git checkout` in a clone another session is using. Run `git status`
first: a dirty tree you did not dirty means someone is in there, and a checkout
carries their uncommitted work onto your branch without warning them.

The same applies to another agent's worktree, its branch, and its uncommitted
work. If you need what is on it, read it; do not switch into it.

## When to skip this

One checkout, one session, one-line change. The threshold is whether anyone else
could be in the tree while you work, not how large the change is.

If you skip it, say so. A step skipped and named is a decision; a step skipped
silently is indistinguishable from one forgotten.

## Finish by removing it

```bash
git worktree remove .claude/worktrees/<slug>
git worktree list
```

Only after the branch is merged or the work is abandoned. A stale worktree holds
a branch checked out, so the next session that tries to use that branch gets a
refusal it has no context for.
