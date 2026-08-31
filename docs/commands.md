# claude-auto-dev commands

Skills are namespaced by plugin, so every command below also works as
`/<plugin>:<name>` — e.g. `/autodev-core:audit` — when a bare name is ambiguous.

## Primary Commands

These are what you type. Everything else is handled automatically by `auto`.

| Say | Action |
|-----|--------|
| `autodev init` | Derive this project's real conventions into `.claude/project-rules.md` |
| `learn from fixes` | Rank the failure classes this project actually ships, from its git history |
| `preflight` | Scaffold / extend the executable pre-deploy gate file |
| `memory maintenance` | Dedup memories, repair the index, refresh CLAUDE.md (nightly-schedulable) |
| `auto` | Work through all tasks autonomously (deploys, tests, transitions sprints) |
| `audit` | Find bugs + violations (7 parallel agents) → creates fix stories |
| `brainstorm` | Feature ideas + architecture improvements → present findings |
| `brainstorm quick` | Diff-based scan, only recently changed files (~10s) |
| `brainstorm apply` | Create stories from last brainstorm |
| `framework radar` | Research coding agents, SDKs, frameworks and harnesses; execute measured experiments |
| `progress` | Show sprint progress |
| Natural language | "fix this", "add that", "remove X" — just describe it |

## On-Demand Commands

Use when you need something specific. Auto mode calls these internally too.

| Say | Action |
|-----|--------|
| `review` / `review quick` / `review deep` | Code quality check (adaptive effort) |
| `ship` | Build, test, review, deploy |
| `scan` / `qa` | Live site QA in a real browser (built-in Browser pane, or the agent-browser CLI in a terminal) |
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
| `update dev` | Reminds you to run `/plugin marketplace update autodev` |
| `doppler` / `setup doppler` | Install + link + migrate secrets to Doppler (hub/spoke pattern) |
| `memory backup` | Backup/restore auto-memory to private GitHub repo |
| `mem search <query>` / `mem recent` / `mem decisions` | Search persistent project memory across sessions |
| `knowledge <area>` / `what do we know about` / `brief me on` | Distill a domain knowledge brief for a code area from memory |
| `framework radar [days or video URL]` | Collect broad agent-development evidence, test every selected hypothesis, and report A/B/simpler verdicts |

For quick fixes, just describe what to fix — no commands needed.

**Note:** `/help`, `/status`, `/init`, `/compact` are Claude Code built-ins.

## Files
- `prd.json` - Stories with `passes: true/null/"deferred"`
- Stories as object: `{ "S1-001": { ... } }`

## Skills
- 62 skills across three plugins: 53 in `autodev-core`, 5 in `autodev-memory`, 4 in `autodev-stack`
- Claude picks a skill from its `description` and `when_to_use`; run `/plugin` to see what is installed
- Auto-loaded by file context: `core` (on prd.json), `standards` and the `rule-*` skills (on matching source files)

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

## Also available

Less-used commands, complete for reference.

| Say | Action |
|-----|--------|
| `setup project` | Scaffold a new project, or onboard an existing one — detects the stack and configures strict tooling |
| `env` / `secrets` | Manage environment variables and credentials without pasting them into the chat |
| `telemetry` / `tool stats` | Which tools a session burned context on, which days were busy, what failed |
| `knowledge` / `brief me on` | Distil stored observations for a code area into a focused domain brief |
| `archive` / `compact prd` | Move completed stories out of `prd.json` to cut its token cost |

## The rules you never type

Twelve always-on `rule-*` skills load themselves by path and shape every session —
diagnosis, gate integrity, verification, agent concurrency and more. They are not
commands and cannot be invoked. See **[rules.md](rules.md)**.
