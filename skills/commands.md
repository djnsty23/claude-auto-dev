# claude-auto-dev (v6.0)

## Commands

| Say | Action |
|-----|--------|
| `auto` | Work through all tasks autonomously |
| `progress` | Show sprint progress |
| `brainstorm` | Scan codebase, propose improvements (report-first) |
| `brainstorm apply` | Create stories from last brainstorm scan |
| `audit` | Parallel quality audit (7 agents) |
| `sprint` | Create/advance sprint |
| `review` | Code quality check (adaptive effort) |
| `review quick` | Build + typecheck only |
| `review deep` | Full 7-step verification + UI check |
| `ship` | Build, test, review, deploy |
| `clean` | Remove temp files |
| `test` | Run unit + browser tests |
| `fix` | Debug and fix issues |
| `setup` | Initialize new project |
| `commit` | Conventional commit + push + PR |
| `perf` | Performance audit (Core Web Vitals) |
| `a11y` | Accessibility audit (WCAG 2.1 AA) |
| `refactor` | Refactoring patterns |
| `security` | Pre-deploy security scan |
| `pr` / `pr-review` | PR review with specialized agents |
| `db` / `supabase` | Database operations, RLS, migrations |
| `deploy` / `ci` | Deploy workflow (Vercel, Supabase, CI/CD) |
| `archive` | Archive completed prd.json stories |
| `env` | Environment variable patterns |
| `design` / `ui` | UI design patterns |
| `browser` | Browser automation (agent-browser) |
| `logs` / `monitoring` | Logging and observability |
| `remotion` / `video` | Remotion video creation |
| `update dev` | Sync latest skills from GitHub |

For quick fixes, just describe what to fix — no commands needed.

**Note:** `/help`, `/status`, `/init`, `/compact` are Claude Code built-ins.

## Files
- `prd.json` - Stories with `passes: true/null/"deferred"`
- Stories as object: `{ "S1-001": { ... } }`

## Skills
- 30 skills in directory format (`skill-name/SKILL.md`)
- See `~/.claude/skills/manifest.json` for triggers and requires chains
- Auto-loaded: core (with prd.json)
- Standards, security load via requires chains when review/audit/auto run

## When to Sprint
- 5+ related tasks: create a sprint
- < 5 tasks: just do them directly
- Quick fixes: no commands needed

## Cleanup
- Screenshots: `.claude/screenshots/` (cleaned by `clean`)
- Archives: `.claude/archives/prd-archive-*.json` (30 days)
- Backups: `.claude/archives/prd-backup-*.json` (7 days)
- Handoffs: `.claude/handoffs/handoff-*.md` (7 days)
- Reports: `.claude/reports/*.md` (7 days)
- All artifacts go under `.claude/`, never project root
