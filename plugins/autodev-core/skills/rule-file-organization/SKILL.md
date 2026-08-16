---
name: rule-file-organization
description: Where generated files belong. Archives, backups, handoffs, reports, and screenshots go under .claude/, never the project root. Load before writing any generated artifact.
when_to_use: "Always-on background rules. Not user-invocable."
user-invocable: false
allowed-tools: Read, Grep, Glob
---

## Never Put in Project Root
- Archive files (`prd-archive-*.json`)
- Backup files (`prd-backup-*.json`)
- Handoff files (`handoff-*.md`)
- Audit/report markdown files (`AUDIT-*.md`, `*-report.md`)
- Any generated `.md` or `.json` artifacts from skills

## Output Directory Map

| Type | Path | Retention |
|------|------|-----------|
| Archives | `.claude/archives/prd-archive-*.json` | 30 days |
| Backups | `.claude/archives/prd-backup-*.json` | 7 days |
| Handoffs | `.claude/handoffs/handoff-*.md` | 7 days |
| Reports | `.claude/reports/*.md` | 7 days |
| Screenshots | `.claude/screenshots/*.png` | Cleaned each run |
| Sprint History | `.claude/sprint-history.md` | Persistent |
| Agent Memory | `.claude/agent-memory/*.md` | Persistent (audit-patterns.md, brainstorm-history.md) |
| Session carriers | `.claude/memory-sessions/*` | Deleted at SessionEnd. Holds **verbatim user prompts** — the directory writes its own `.gitignore` so it can never be committed. Never move these files elsewhere. |
| Compaction snapshot | `.claude/pre-compact-state.json` | Overwritten each compaction |

## Rules
- Create subdirectories on first use (`mkdir -p` / `New-Item -Force`)
- Only `prd.json` and source code belong in project root
- If a skill generates a file, it goes under `.claude/`
- Add `.claude/` to `.gitignore` (it's ephemeral tooling state)
