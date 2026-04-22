# claude-auto-dev (v7.5)

## Primary Commands

These are what you type. Everything else is handled automatically by `auto`.

| Say | Action |
|-----|--------|
| `auto` | Work through all tasks autonomously (deploys, tests, transitions sprints) |
| `audit` | Find bugs + violations (7 parallel agents) → creates fix stories |
| `brainstorm` | Feature ideas + architecture improvements → present findings |
| `brainstorm quick` | Diff-based scan, only recently changed files (~10s) |
| `brainstorm apply` | Create stories from last brainstorm |
| `progress` | Show sprint progress |
| Natural language | "fix this", "add that", "remove X" — just describe it |

## On-Demand Commands

Use when you need something specific. Auto mode calls these internally too.

| Say | Action |
|-----|--------|
| `review` / `review quick` / `review deep` | Code quality check (adaptive effort) |
| `ship` | Build, test, review, deploy |
| `scan` / `qa` | Live site QA via agent-browser + Playwright |
| `test` | Run unit + browser tests |
| `fix` | Debug and fix issues |
| `commit` | Conventional commit + push + PR |
| `deploy` / `ci` | Deploy workflow (Vercel, Supabase, CI/CD) |
| `clean` | Remove temp files |
| `iterate` | Convergence loop: brainstorm→fix→re-scan until clean |
| `sprint` | Create/advance sprint |

## Specialized Commands

Pattern libraries for specific domains. Auto-loaded when relevant.

| Say | Action |
|-----|--------|
| `setup` | Initialize new project |
| `perf` | Performance audit (Core Web Vitals) |
| `a11y` | Accessibility audit (WCAG 2.1 AA) |
| `refactor` | Refactoring patterns |
| `migrate` / `upgrade` | Dependency updates |
| `security` | Pre-deploy security scan |
| `pr` / `pr-review` | PR review with specialized agents |
| `db` / `supabase` | Database operations, RLS, migrations |
| `archive` | Archive completed stories |
| `env` | Environment variable patterns |
| `design` / `ui` | UI design patterns |
| `browser` | Browser automation |
| `logs` / `monitoring` | Logging and observability |
| `stripe` / `payment` | Stripe integration |
| `seo` / `schema` | SEO and structured data |
| `remotion` / `video` | Remotion video creation |
| `update dev` | Sync latest skills from GitHub |
| `doppler` / `setup doppler` | Install + link + migrate secrets to Doppler (hub/spoke pattern) |
| `memory backup` | Backup/restore auto-memory to private GitHub repo |
| `mem search <query>` / `mem recent` / `mem decisions` | Search persistent project memory across sessions |
| `telemetry` / `usage stats` | Show tool usage stats from local telemetry log |

For quick fixes, just describe what to fix — no commands needed.

**Note:** `/help`, `/status`, `/init`, `/compact` are Claude Code built-ins.

## Files
- `prd.json` - Stories with `passes: true/null/"deferred"`
- Stories as object: `{ "S1-001": { ... } }`

## Skills
- 36 skills in directory format (33 active + 3 deprecated redirects)
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
