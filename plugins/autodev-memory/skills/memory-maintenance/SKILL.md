---
name: memory-maintenance
description: Audit and tidy project memory — deduplicate overlapping memories, repair the MEMORY.md index, drop dead links, and refresh CLAUDE.md against what the codebase actually looks like now. Designed to run unattended on a nightly schedule.
when_to_use: "Invoked when the user says \"memory maintenance\", \"defrag memory\", \"dedup memory\", \"tidy memory\", \"clean up CLAUDE.md\", or when fired by a nightly routine."
allowed-tools: Bash, Read, Write, Edit, Grep, Glob
model: opus
user-invocable: true
argument-hint: "[project path | --all | --dry-run]"
---

# Memory Maintenance

Memory files accumulate: two memories drift into saying the same thing, the
index points at a file that was renamed, a `[[link]]` outlives its target, and
`CLAUDE.md` slowly describes a codebase that no longer exists.

This finds all of that mechanically and fixes it with judgement.

## 1. Audit — always start here

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory-audit.js"
```

Read-only. Add `--all` to include projects with no recent activity, `--json` for
machine output, `--stale-days=N` to change what counts as active (default 30).

It reports, per project: oversized index, duplicate `name:` slugs, near-duplicate
bodies, dead index links, unindexed files, dangling `[[links]]`, missing
frontmatter, and memory for projects that no longer exist on disk.

**Paths come from `CLAUDE_CONFIG_DIR` or `$HOME`.** Nothing is hardcoded, so this
works for any user on any machine.

## 2. Fix, in this order

**Never delete a memory to resolve a duplicate.** Merge, then remove the file
that is now redundant — and only when its content is fully represented in the
survivor. A deleted memory is unrecoverable and its loss is silent.

1. **Missing frontmatter** — add `name:` and `description:`. Safe, mechanical.
2. **Dead index links** — remove the row, or restore the link if the file was
   merely renamed (check git in the project first).
3. **Unindexed files** — add a one-line pointer to `MEMORY.md`.
4. **Dangling `[[links]]`** — a link to a memory that does not exist yet is not
   an error; it marks something worth writing. Leave it unless the target was
   deleted, in which case drop the link.
5. **Near-duplicates** — read both. Keep the one with more specific, more recent
   information; fold anything unique from the other into it; then delete the
   loser and update the index. If the two genuinely disagree, **keep both and
   say so in the report** — a contradiction is a signal, not a duplicate.
6. **Oversized index** — `MEMORY.md` loads into context every session, so it is
   capped at 200 lines / 25KB. Compress rows, never drop memories; if it is still
   too long, the memories themselves are too granular and should be merged.
7. **Project gone** — do not delete. Report it and let the user decide; a repo
   may be temporarily moved or on another machine.

## 3. Refresh CLAUDE.md

Use the checker rather than grepping by hand — it encodes eight precision rules
learned by running naive versions against real repos:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/claudemd-audit.js" <repo> [<repo>...]
```

It skips what only looks stale: bare filenames used in prose, filename patterns
like `qa-YYYY-MM-DD.md`, house shorthand for a path spelled in full elsewhere,
files the doc itself describes as deleted, and files annotated local-only or
gitignored. On three production repos a naive check reported 16 findings; this
reports the 1 that was real.

For each active project, check whether `CLAUDE.md` still matches reality:

- Do the paths, commands, and scripts it names still exist?
- Does it describe a stack, directory, or workflow the repo has moved off?
- Has it grown past the point of being read? Claude Code warns when it is long
  relative to the context window, and long instructions are followed less
  reliably than short ones.

Fix what is provably stale — a named file that no longer exists, a command that
is not in `package.json`. **Do not rewrite prose you cannot verify**, and do not
"improve" wording; silent edits to a user's instructions are their own failure
mode. If `.claude/project-rules.md` exists, prefer moving durable conventions
there and keeping `CLAUDE.md` short.

## 4. Report

Say, per project: what was merged, what was repaired, what was left alone and
why. If nothing needed doing, one line is the right length.

**With `--dry-run`, do step 1 and report only. Change nothing.**

## Running it nightly

This is designed for unattended execution. Schedule it with `/schedule` (or a
`CronCreate` in-session), pointing at this skill:

```
/schedule
```

Then create a routine that runs `/memory-maintenance --all` daily overnight.

Two rules for the unattended run, because nobody is watching:

- **Never delete on a contradiction.** Merging is only safe when one memory
  strictly contains the other. Anything ambiguous gets reported, not resolved.
- **Never touch a project whose repo you cannot see.** If the decoded project
  path does not exist on disk, audit it and stop — the encoding of project
  directories is lossy, and a wrong guess would edit the wrong project's memory.

If the routine finds nothing to do — the normal case on a healthy setup — it
should exit quietly rather than manufacturing work.
