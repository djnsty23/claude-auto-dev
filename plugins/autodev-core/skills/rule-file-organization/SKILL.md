---
name: rule-file-organization
description: Choose recoverable paths for generated artifacts. Keep scratch state private, and preserve shared PRD archives, project rules and verification evidence in tracked locations. Load before writing an artifact.
when_to_use: "Before writing any generated file: archives, backups, handoffs, reports, screenshots."
user-invocable: false
allowed-tools: Read, Grep, Glob
paths:
  - "**/prd.json"
  - "**/.claude/**/*.md"
  - "**/.claude/**/*.json"
---

## Separate scratch state from recoverable evidence

Generated artifacts need a known home and recovery path. Use the project's
established layout; classify by purpose before choosing an ignore rule.

| Type | Default path | Recovery / retention |
|---|---|---|
| Raw reports, temporary backups, handoffs | `.claude/reports/`, `.claude/archives/`, `.claude/handoffs/` | Local; append reports and retain while work depends on them |
| Temporary screenshots | `.claude/screenshots/` | Local; remove only when no active evidence references them |
| PRD archives needed by another session | `prd-archives/` | Tracked; follow `archive-prd` and preserve dependency-supporting records |
| Portable before/after proof | `.claude/evidence/<story>/` | Tracked after checking for secrets and private data; follow `prove` |
| Project conventions | `.claude/project-rules.md` | Tracked, human edits preserved; follow `autodev-init` |
| Shared publish queue | `PUBLISH-QUEUE.md` | Tracked; follow `rule-local-first` |
| Local agent memory and sprint notes | `.claude/agent-memory/`, `.claude/sprint-history.md` | Local unless the project deliberately shares a sanitized subset |
| Session carriers | `.claude/memory-sessions/` | Verbatim prompts; never copy or commit; owned lifecycle cleanup only |
| Compaction snapshot | `.claude/pre-compact-state.json` | Local checkpoint; retain until superseded safely |

Create subdirectories on first use. Existing root manifests, source, config and
shared records belong where the project expects them; “generated” does not mean
“disposable.”

A bare `.claude/` ignore prevents nested negations from re-including evidence or
project rules. If the project tracks such files, ignore contents selectively
(e.g. `.claude/*` with explicit directory/file exceptions), preserve other rules,
and check the effective result. Use `git check-ignore -q --no-index -- <path>`
to test ignoredness; verbose output can name a negation even for a committable
file. Confirm a synthetic scratch/secret carrier stays ignored beside a
committable evidence control. Never solve this by staging raw reports.

Retention values are cleanup guidance, not scheduled deletion or permission to
discard active work. Before removing a worktree, retain referenced ignored
reports somewhere recoverable and record their new location.
