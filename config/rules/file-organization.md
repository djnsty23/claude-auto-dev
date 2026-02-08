# File Organization Rules

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
| Decisions | `.claude/decisions.md` | Persistent |
| Mistakes | `.claude/mistakes.md` | Persistent |

## Rules
- Create subdirectories on first use (`mkdir -p` / `New-Item -Force`)
- Only `prd.json` and source code belong in project root
- If a skill generates a file, it goes under `.claude/`
- Add `.claude/` to `.gitignore` (it's ephemeral tooling state)
