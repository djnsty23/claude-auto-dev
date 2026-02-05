# claude-auto-dev (v4.9.3)

## Commands

| Say | Action |
|-----|--------|
| `auto` | Work through all tasks autonomously |
| `progress` | Show sprint progress |
| `brainstorm` | Scan codebase, propose improvements and features |
| `audit` | Parallel quality audit (6 agents) |
| `sprint` | Create/advance sprint |
| `verify` | Quality checks on completed work |
| `ship` | Build, test, review, deploy |
| `clean` | Remove temp files |
| `test` | Run unit + browser tests |
| `review` | Code quality check |
| `fix` | Debug and fix issues |
| `setup` | Initialize new project |
| `commit` | Conventional commit + push + PR |
| `perf` | Performance audit (Core Web Vitals) |
| `a11y` | Accessibility audit (WCAG 2.1 AA) |
| `refactor` | Refactoring patterns |
| `security` | Pre-deploy security scan |
| `update dev` | Sync latest skills from GitHub |

**Note:** `/help`, `/status`, `/init`, `/compact` are Claude Code built-ins.

## Files
- `prd.json` - Stories with `passes: true/null/"deferred"`
- Stories as object: `{ "S1-001": { ... } }`

## Skills
- 40 skills in directory format (`skill-name/SKILL.md`)
- See `~/.claude/skills/manifest.json` for triggers and requires chains
- Auto-loaded: core (with prd.json), quality, code-quality, security-patterns

## Cleanup
- Screenshots: `.claude/screenshots/` (cleaned by `clean`)
- Backups: `prd-backup-*.json` (7 days)
- Handoffs: `handoff-*.md` (7 days)
