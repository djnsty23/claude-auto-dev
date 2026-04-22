# Changelog

## [7.5] - 2026-04-22

### Added — telemetry (audit finding 3.2)
- **`hooks/telemetry.js`** — new PostToolUse hook. On every tool call, appends one JSONL line to `.claude/reports/telemetry-YYYY-MM-DD.jsonl`. Logs metadata only (tool name, input/output sizes, cwd, session, timestamp, success heuristic) — never tool input/output **contents**. Privacy-safe by design. Exit 0 always; 500ms timeout cap.
- **`skills/telemetry/`** — read-side skill. Commands: `telemetry`, `usage stats`, `tool stats`, `token stats`. Reports top tools by event count + total bytes, per-day activity, week view. Runs on Haiku.
- **Optional OTLP export** — set `CLAUDE_OTEL_ENDPOINT` env var to also POST each event to an OTLP JSON endpoint (Honeycomb, local collector, Jaeger). Fire-and-forget, 500ms HTTP timeout, won't slow sessions if endpoint is down.
- **Opt-out** — set `CLAUDE_TELEMETRY_DISABLED=1` or remove the hook from settings.
- **`scripts/test-telemetry-hook.js`** — 15-case suite: field coverage, privacy (no secret leakage), error detection, opt-out, malformed stdin resilience, unreachable-endpoint resilience, speed (<500ms). 15/15 pass. Local run: 39ms end-to-end.

### Registered
- Added a second `PostToolUse` entry with matcher `.*` in both `settings.json` and `settings-unix.json` so telemetry fires on every tool call (existing `Write|Edit` typecheck entry unchanged).

### Context
Closes audit finding 3.2 ("No OTEL / telemetry — industry standard in 2026"). The design choice: local JSONL by default so there's zero-config visibility on day one, with OTLP forwarding available to anyone who wants to wire a collector later. Honeycomb and Jaeger both accept OTLP JSON directly; no vendor lock-in.

## [7.4] - 2026-04-22

### Changed — Progressive disclosure on three more skills
Continuing v7.3's Anthropic-idiomatic split pattern. Three more heavy skills now load long reference sections on demand instead of inlining everything.

- **`audit/SKILL.md`** — 398 → 280 lines (~4765 → 3675 tokens, 23% reduction).
  - New `references/known-safe-patterns.md` — false-positive list (shadcn nesting, React 19 server actions, Supabase RLS, etc.) that every audit agent prompt needs
  - New `references/persist-findings.md` — the 8-step prd.json persistence flow (read, dedupe, batch, add, session tasks, report, score tracking, npm audit)
  - Dropped the one remaining `MUST` in the body

- **`setup-project/SKILL.md`** — 417 → 217 lines (~2948 → 1806 tokens, 39% reduction — biggest win).
  - New `references/monorepo-scaffold.md` — full directory layout + pnpm-workspace.yaml + root package.json + shared-package template
  - New `references/tooling-config.md` — TypeScript strict flags, Biome config, shadcn init, .gitattributes, .gitignore, .npmrc ready-to-paste templates
  - New `references/version-defaults.md` — the April 2026 pinned version table

- **`doppler/SKILL.md`** — 255 → 218 lines (~2353 → 2074 tokens, 12% reduction).
  - New `references/extract-to-hub.md` — shared-key and Supabase extraction command sequences with safety rules (the migration steps are rare but dense)

### Not done
- Consolidation of `clean` / `status` / `archive-prd` — `clean` (68 lines) and `status` (42) are already lean; `archive-prd` (141) has a clear user-facing responsibility called from auto. Consolidation would break muscle memory without meaningful token savings.
- OTEL telemetry exporter — needs a design decision on destination (local collector vs Honeycomb free tier vs Jaeger). Deferred.

### Aggregate impact
Running `auto` with `audit` and `setup-project` triggered (common combo) saves ~2,500 tokens per session vs v7.2. Over a typical multi-session day, meaningful.

## [7.3] - 2026-04-22

### Added
- **`scripts/test-pre-tool-filter.js`** — 33-case test suite for the PreToolUse hook. Caught a real bug on first run: `rm -rf ~/` (home-dir wipe) was not being blocked. Now blocked.
- **Auto-lint loop in `post-tool-typecheck.js`** (Aider-style) — after typecheck, runs the project's linter (Biome > ESLint, via package.json `lint` script or `biome check .` / `eslint .` fallback). Lint failures get printed to stderr (first 30 lines, truncation notice) so Claude can self-fix in the next turn. Skipped silently if no linter is configured.

### Changed
- **`auto/SKILL.md`** — split into `references/generation-constraints.md` + `references/verify-tags.md` (Anthropic-idiomatic progressive disclosure). Main body dropped from 590 lines / ~7k tokens to 501 lines / ~6k tokens. Also dropped all 12 `MUST` / `NEVER` ALL-CAPS directives — rewritten as reasoned prose explaining the failure mode each rule prevents. Follows Anthropic's [skill-creator guidance](https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md): "yellow flag — if possible, reframe and explain the reasoning."
- **Haiku tier for mechanical skills** — `status`, `archive-prd`, `clean`, `update`, `env-vars` moved from Opus to Haiku. ~12× cheaper per token on operations that don't require reasoning.

### Fixed
- **`hooks/session-start.js`** — added `process.exit(0)` at end so the hook can't exit non-zero if an unhandled error slips past the try/catch. Every other hook had this; session-start was the one gap.
- **`hooks/pre-tool-filter.js`** — `rm -rf ~` and `rm -rf ~/` are now blocked. Tests caught the gap on first run.

### Removed
- **Deprecated skill dirs deleted:** `skills/verify/`, `skills/checkpoint/`, `skills/browser-auth/`. Manifest entries in `deprecated` retained so rename history stays discoverable.

### Context
Post-audit pass (see `.claude/reports/AUDIT-2026-04-22.md`). Findings were cross-referenced against Anthropic's official Agent Skills spec ([agentskills.io](https://agentskills.io)) and 10 popular 2026 Claude Code frameworks.

## [7.2] - 2026-04-22

### Added
- **`doppler` skill** — Hub/spoke secret management via Doppler. Handles install detection (`winget install doppler.doppler` on Windows, brew on macOS, curl on Linux), login guidance (`doppler login`), per-project linking via `doppler.yaml`, command wrapping (`doppler run -- npm run dev`), and shared-key extraction to hub projects with cross-project `${ref://hub.config.KEY}` references. Fits the Developer plan's 10-project cap by consolidating supabase accounts into branch configs. Rotate once in a hub, all spokes pick up the new value.
- **`memory-backup` skill** — Private GitHub repo mirroring `~/.claude/projects/*/memory/`. One-command setup creates `<your-username>/claude-memory` (private), on-demand `memory backup now`, Windows Task Scheduler recipe for daily auto-commits, one-command `memory restore` after Windows reinstall. Explicitly excludes `sessions/`, `tasks/`, and other ephemeral state.

### Changed
- **`env-vars` skill** — Doppler is now the recommended pattern. Skill defers to the `doppler` skill when `doppler.yaml` is present, otherwise falls back to `.env.local` flow. Added "Migrate to Doppler" option.
- **`auto` Context Loading** — Step 6 added: detect `doppler.yaml` and prepend `doppler run --` to dev/build/test commands automatically. Installs CLI if missing, guides login if not authenticated.
- **`setup-project` onboarding** — Gap check now suggests Doppler migration when `.env.local` has 3+ vars and no `doppler.yaml` exists yet.

### Notes
- Doppler Developer plan is free; cross-project secret references work on it (confirmed 2026-04-22)
- Project cap is 10 on free tier — skill enforces this check before creating new projects
- `doppler login` is a browser OAuth flow; Claude cannot run it autonomously — always guide user

## [7.1] - 2026-04-09

### Added
- **Collision-safe install** — `scripts/sync.js` enumerates shipped items and refuses to overwrite user-owned files/dirs with the same name unless they're byte-identical. Use `--force` to back up collisions to `.user-backup-<timestamp>/` and install on top.
- **Install sidecar** — `~/.claude/.auto-dev-installed.json` records exactly what this install put on disk, enabling symmetric uninstall. Legacy installs without a sidecar are auto-detected via `skills/manifest.json`.
- **Surgical uninstall** — `scripts/uninstall.js` + `uninstall.sh` / `uninstall.ps1` remove only items the install created. User skills, hooks, agents, and user-modified rules are preserved. Strips auto-dev hook entries from `settings.json` without touching other entries. Supports `--dry-run`.
- **Image auto-scan hook** — `hooks/user-prompt-image-scan.js` (UserPromptSubmit). When you attach an image, Claude surfaces every distinct issue it sees, not just what you asked about. Tail-reads transcript JSONL (~35 ms flat regardless of size). Auto mode logs findings to `.claude/reports/image-scan-*.md` instead of acting. Skip with `[focus]` marker in your prompt.
- **`auto-exit` flag** — Writing `.claude/auto-exit` unconditionally releases the Stop hook on the next cycle. Gives the auto skill a clean exit path without fighting the idle detector.

### Fixed
- **Auto-active flag path divergence** — Stop hook was reading `$HOME/.claude/auto-active` while the auto skill and writers used `<project>/.claude/auto-active`. All three flags (`auto-active`, `auto-exit`, `auto-idle-triggered`) are now project-relative under `process.cwd()/.claude/`.
- **Install was silently destructive** — Previous install wiped `~/.claude/skills/` and `~/.claude/hooks/` on every run, destroying any user-added content. Fixed at the root: install now tracks what it owns and leaves everything else alone.
- **README uninstall instructions** — Old `rm -rf ~/.claude/skills ~/.claude/hooks` would have blown away unrelated user work. Replaced with the scripted uninstall flow.
- **README staleness** — Removed obsolete `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` reference (replaced by `teammateMode: "auto"` in v6.9).

### Removed
- **Symlink install mode** — Fundamentally incompatible with user-owned skills (users couldn't add their own). `--copy` / `-Copy` flags kept as silent no-ops for back-compat.

## [7.0] - 2026-04-05

### Added
- **Generation constraints in auto** — Security, a11y, design anti-slop rules applied at code-generation time, not just post-hoc audit
- **Self-critique step** — 8-question checklist auto runs after writing code, before typecheck
- **Hardening check** — 12-pattern per-task diff scan (fail-open auth, unsafe casts, fire-and-forget fetch, missing labels, stock UI, dark mode, chart colors)
- **Per-story verify tags** — `"verify": ["visual", "a11y", "design", "security", "auth", "test", "api"]` in prd.json stories for targeted checks
- **Design token compliance check** — Auto verifies UI output uses project tokens, not stock shadcn defaults
- **Test generation table** — Auto writes tests for API routes, auth, hooks, data mutations, RLS policies
- **Risk-shaped testing** — Test effort matches risk (100% auth/billing, 70% hooks, optional for static pages)
- **Coverage thresholds** — 70% lines, 60% branches, 100% auth/billing paths
- **Deferred task distinction** — `passes: "needs-setup"` + `blockedReason` separates infrastructure blockers from skipped tasks
- **Security checks 6-11** — SSRF prevention, fail-open auth, HTTP headers, open redirect, rate limiting, npm audit
- **Score tracking** — Audit logs scores to sprint-history.md with delta from previous audit
- **Migration safety** — Deploy checks for destructive SQL operations, nullable defaults rule
- **Simplify suggestion** — Auto recommends simplify after 5+ task sprints

### Changed
- **audiq MCP removed from all skills** — Replaced with agent-browser (preferred) and Playwright (fallback) across ship, commit, design, brainstorm
- **Ship: blocking quality gates** — npm audit critical/high now blocks deploy alongside typecheck/build/tests
- **Ship: expanded security checklist** — 11 items including fail-closed auth, SSRF, middleware coverage, HTTP headers, rate limiting
- **Review: tests run in default mode** — Not just deep mode; also adds npm audit, breaking change detection, hardening scan
- **Audit: reduced noise** — A11y agent skips transition-all (perf not a11y), type agent skips console.error and test files
- **Audit: expanded security agent** — RLS policy logic, fail-open auth, SSRF, middleware gaps, unsafe casts, fire-and-forget fetch
- **Fix: regression tests mandatory** — For auth/billing/RLS paths after fix; escalation after 3 failures
- **Commit: story ID in messages** — `feat(S13-001): description` format; tests added to safety checklist
- **Standards: anti-patterns reorganized** — Split into accessibility, design system, security/data safety categories
- **Standards: fail-closed patterns** — Auth deny-by-default, fetch error handling, Zod validation for external data
- **Supabase: RLS runtime verification** — REST API test after migrations to verify policies actually restrict access
- **Supabase: migration rollback pattern** — Nullable defaults, separate drop migrations
- **Design: quality gate expanded** — Dark mode, a11y focus rings, reduced motion, form UX checks
- **Workflow rules: cross-cutting verification** — 6 patterns applied to all task types regardless of category
- **Auto: exactOptionalPropertyTypes** — Generates `foo?: string | undefined` on first pass in strict projects

## [6.9.1] - 2026-04-05

### Fixed
- **Auto skill: use Write tool for auto-active flag** — Bash echo to `.claude/auto-active` triggered sensitive file permission prompt every time. Now uses Write tool which is already in the allowlist.

## [6.9] - 2026-04-05

### Added
- **scripts/sync.js** — Single source of truth for syncing repo files to ~/.claude. Handles symlink/copy, settings merge, rules, agents, deprecated cleanup, and validation in one cross-platform Node.js script.

### Changed
- **install.sh / install.ps1** — Sync logic delegated to sync.js, removing ~90 lines of duplicated copy/symlink code
- **scripts/update.sh** — Reduced from 114 lines to 12, delegates to sync.js
- **Embedded update-dev functions** — Both bash and PowerShell versions now call sync.js instead of manual copy blocks
- **Brainstorm dedup threshold** — Fixed drift: standardized to 25-char match (was 20 in brainstorm, 25 in audit)
- **Settings: removed CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS** — Redundant since teammateMode: "auto" is set

### Removed
- **5 dead files** — templates/progress.txt, templates/settings.local.json, templates/env.local.template, templates/task-patterns.json, skills/prd-schema.json
- **Dead chmod in install.sh** — Was targeting *.sh hooks but all hooks are .js

## [6.8] - 2026-04-04

### Added
- **setup-project: greenfield mode** — Full scaffolding from description to working build. Monorepo support (pnpm workspaces), package manager detection, Biome over ESLint, shadcn v4, TS strict defaults, .gitattributes, version table with risk notes
- **setup-project: onboard mode** — Gap detection (.gitattributes missing, TS strictness, missing .env.example)
- **Audit size gate** — Scales agent count by codebase size: 1 agent (<50 files), 3 agents (50-200), full 7-swarm (200+)

### Changed
- **Typecheck hook detects package manager** — Reads lockfile (pnpm-lock.yaml/yarn.lock/bun.lockb) instead of hardcoding `npm run typecheck`
- **Commit: solo projects stay on main** — Checks contributor count + remote before forcing feature branches. Solo devs commit to main.
- **Auto: /compact threshold raised** — "Do NOT suggest unless >70%" (was "after 10+ tasks"). 1M context makes premature compaction wasteful.
- **setup-project triggers narrowed** — `"setup"` → `"setup project"` to avoid false matches on "set up the database"

### Fixed
- **bash -c filter narrowed** — Only blocks at command position or after chain operators, not inside quoted arguments (e.g., `docker exec` wrapping)

## [6.7.3] - 2026-03-31

### Changed
- **Windows: Supabase CLI rule** — `supabase db query --linked` blocked (triggers firewall, times out). Use REST API with curl instead.

## [6.7.2] - 2026-03-30

### Changed
- **Auto: removed unused sections** — Worktree parallel execution (never used), decisions.md logging (nobody reads it), mistakes.md reference
- **Auto: tool-aware verification** — Audiq/agent-browser instructions now check if MCP is connected before suggesting visual scans. Falls back gracefully to WebFetch or skipping with a note.

## [6.7.1] - 2026-03-30

### Fixed
- **npx regex false positive** — Anchored pattern to command position (like `node -e` fix from v6.6.3). No longer triggers inside quoted strings like `git commit -m "...npx..."`
- **config/rules/ out of sync** — Updated repo config templates (security, design-system, file-organization, workflow) so `update dev` preserves v6.7.0 rule changes instead of overwriting them
- **config/CLAUDE.md template** — Added `@rules/workflow.md` to includes

## [6.7.0] - 2026-03-30

### Added
- **Auto integration test gate** — API/edge function tasks require real request verification (curl + response shape check) before marking done
- **Auto sprint transitions** — Automatically archives completed stories, carries forward deferred, bumps sprint number, logs to `.claude/sprint-history.md`
- **Auto deploy phase** — Detects changed `supabase/functions/` files after commit and auto-deploys edge functions
- **Sweeping change verification** — Self-review step 4b: grep for old patterns after bulk find-and-replace to confirm full elimination
- **`rules/workflow.md`** — New global rule documenting audit/brainstorm scope split and verification requirements by task type

### Changed
- **Audit = bugs/fixes** — Absorbs quality scans (console.log, empty catch blocks) from brainstorm. Type Safety agent expanded to include code quality.
- **Brainstorm = features/architecture** — Removed quality scans. Now runs 3 agents (dead code, complexity, unused deps) instead of 5. Competitor research is optional.
- **Agent tool call cap** — All scan agents capped at ~80 tool calls to prevent rate limits
- **Pre-flight simplified** — Replaced `node -e` one-liners with simpler checks that don't trigger security filter on Windows
- **Size-gate** — Removed Plan Mode suggestion (dead path). Large tasks get inline 3-sentence plan instead.
- **Commands.md** — Reorganized into Primary / On-Demand / Specialized tiers
- **Manifest descriptions** — Synced audit and brainstorm descriptions to reflect scope boundary
- **Design system** — Added gradient/themed surface exception for hardcoded colors
- **Security rules** — Added edge function testing and bulk change verification
- **npx allowlist** — Added `tsx`, `shadcn`, `shadcn-ui`, `create-next-app`, `prisma`
- **File organization** — Replaced unused `decisions.md`/`mistakes.md` with `sprint-history.md`

## [6.6.4] - 2026-03-22

### Fixed
- **npx allowlist expanded** — Added `npm-check-updates`, `axe-core-cli`, `@next/bundle-analyzer`, `lighthouse`, `netlify`, `remotion` to pre-tool filter. These were referenced in skills but would be blocked at runtime.

## [6.6.3] - 2026-03-22

### Fixed
- **pre-tool-filter: node -e false positive** — pattern now only matches at command start, not inside grep/echo arguments. Fixes the filter blocking searches for "node -e" strings.
- **Contradictions resolved across skills:**
  - commit: "never git add -A" softened to "prefer targeted adds" (batch mode with exclusions is acceptable)
  - core: "don't read full prd.json" updated for 1M context (fine for <50 stories)
  - review: "go beyond acceptance criteria" → "flag opportunities but don't implement during review"

## [6.6.2] - 2026-03-22

### Added
- **`brainstorm quick`** — Diff-based scan that only checks files changed since last brainstorm (~10s vs ~3min). Skips full agent scan for recently-cleaned codebases.
- **Size-gating for stories** — Tasks touching 5+ files or needing UI design flagged as `size: "large"` with Plan Mode suggestion instead of auto-executing
- **Progress output** — Auto mode now outputs `[3/8] ✓ S6-003 | Next: S6-004` between tasks for visibility
- **Resource validation** — Self-review step 3 validates external URLs (images, fonts, API endpoints) with curl before committing
- **Worktree cleanup** — Auto pre-flight now runs `git worktree prune` to clean orphaned worktrees from previous sessions

## [6.6.1] - 2026-03-21

### Security
- **pre-tool-filter: outer catch now fail-closed** — exit 2 instead of exit 0 on unexpected errors
- **pre-tool-filter: block `node -e`/`node --eval`/`node -p`** — closes the `Bash(node *)` bypass vector
- **pre-tool-filter: block `npx` except allowlisted tools** (tsc, supabase, vercel, next, vite, vitest, jest, playwright, eslint, prettier)
- **pre-tool-filter: tightened `bash -c` regex** — `\s*` instead of `\s+` catches `bash -c"cmd"` without space
- **pre-tool-filter: tightened `eval` regex** — `[\s"']` catches `eval"cmd"`, avoids false positives on `evaluate`
- **pre-tool-filter: block `cp`/`mv` targeting `.claude/hooks/` and `.claude/settings`**
- **session-start: expanded PROTECTED_VARS** — added LD_PRELOAD, LD_LIBRARY_PATH, DYLD_INSERT_LIBRARIES, BASH_ENV, ENV, PROMPT_COMMAND, CDPATH, NODE_EXTRA_CA_CERTS, GH_TOKEN, VERCEL_TOKEN, SUPABASE_ACCESS_TOKEN

### Fixed
- **pr-review: stale `browser-auth` reference** → changed to `agent-browser`
- **update skill: ALL-CAPS "NOT" and "SINGLE"** → lowercased per tone moderation
- **commands.md: version and migrate entry** — bump.sh handles version; migrate row was missing

## [6.6] - 2026-03-20

### Added
- **Migrate skill** — Dependency updates, major version upgrades, and breaking change resolution. Safety tiers (patch→minor→major), one-at-a-time major updates with changelog checks, security audit integration.
- **PreCompact promoted to .js file** — `hooks/pre-compact.js` with error reporting, replacing inline `node -e` one-liner

### Changed
- **Merged browser-auth into agent-browser** — Auth token injection, security rules, and test patterns now in one skill. browser-auth is deprecated. Saves 229 lines from 4 requires chains (auto, test, audit, ship).
- **Requires chains updated** — auto, test, audit now require `agent-browser` directly instead of `browser-auth`

## [6.5.2] - 2026-03-20

### Security
- **pre-tool-filter: fail-closed on parse error** — was exit 0 (allow), now exit 2 (block). Malformed input can no longer bypass security checks.
- **pre-tool-filter: block `bash -c`, `sh -c`, `eval`** — prevents shell escape wrappers that bypass regex patterns
- **session-start: expanded PROTECTED_VARS** — now blocks NODE_ENV, CI, HTTP_PROXY, HTTPS_PROXY, NODE_TLS_REJECT_UNAUTHORIZED, ANTHROPIC_API_KEY, GITHUB_TOKEN, GITHUB_PAT from .env.local override
- **bump.sh: env vars instead of shell interpolation** — version strings passed via `process.env` instead of string interpolation in `node -e`

### Fixed
- **post-tool-typecheck: 10-second debounce** — skips typecheck if last run was <10s ago, preventing dozens of redundant 30s runs during rapid edits
- **session-start: strip trailing \r from .env.local values** — CRLF files on Windows no longer leave carriage returns in env values
- **clean skill: added .typecheck-stamp** to cleanup targets

## [6.5.1] - 2026-03-20

### Fixed
- **allowed-tools mismatches** — 5 skills (auto, brainstorm, ship, commit, design) referenced audiq MCP tools they couldn't call. Added the specific tools each skill needs.
- **auto: added Agent + SendMessage** to allowed-tools — parallel worktree execution was dead code
- **auto: removed ghost `simplify` references** — replaced with `refactor` (actual skill)
- **auto: consolidated duplicate audiq verification blocks** — single reference instead of repeated code
- **auto: fixed `date -I` (GNU-only)** — replaced with portable `date +%Y-%m-%dT%H:%M:%S`
- **auto: quoted glob in find command** — prevents shell expansion of `*/node_modules/*`
- **iterate: trimmed 12 unused audiq tools** from allowed-tools — sub-skills handle audiq calls
- **audit: removed unused TaskUpdate, TaskList** from allowed-tools
- **ALL-CAPS cleanup** — lowercased NOT, BOLD, UNFORGETTABLE across auto, ship, design skills
- **Stale skill counts** — README and commands.md now say "35 skills (33 active + 2 deprecated)"

## [6.5] - 2026-03-20

### Added
- **Smart pre-flight** — Auto `npm install` when package.json is newer than node_modules, detect test runner (vitest/jest/playwright) instead of hardcoding `npm test`, detect monorepo structure, auto-create feature branch if on main
- **Error pattern recognition** — Tracks recurring errors across tasks; after 3+ occurrences, saves fix recipe to auto-memory for instant resolution. Includes common pattern→fix table.
- **Post-commit quick scan** — After every commit, runs build check + console error scan (~5s) to catch regressions immediately
- **PR description from prd.json** — Auto-generates PR body from completed stories with titles, resolutions, and test plan
- **Auto feature branch** — Commit skill auto-creates feature branch when on main/master instead of committing directly
- **Screenshot baseline** — First scan saves as `baseline-YYYY-MM-DD.json` (never overwritten); all future `scan compare` diffs against it
- **CLAUDE.md from real data** — setup-project reads actual package.json scripts, detects dev port, maps src/ structure, finds env vars — no guessing
- **Expanded project knowledge saving** — Auto skill saves environment quirks, build gotchas, test setup, deploy requirements, and error patterns to auto-memory

## [6.4.1] - 2026-03-20

### Added
- **README Tips & Tricks** — Comprehensive guide covering /btw side questions, parallel work patterns, convergence loop, visual verification, agent teams, context management, design anti-slop, and quick fix workflow
- Updated commands table with scan/qa, iterate, design skills
- Fixed stale "30 skills" references to "33 skills"

## [6.4] - 2026-03-19

### Added
- **Iterate skill** — Convergence loop that chains brainstorm→apply→auto in one command. Runs until codebase is clean (typically 3-4 rounds). Supports focus modes (`iterate auth`, `iterate design`) and configurable round limits. Safety check: stops if a round finds more issues than previous.
- Triggers: `iterate`, `deep work`, `converge`

## [6.3.2] - 2026-03-19

### Changed
- **Brainstorm product thinking** — Feature ideation now requires product identity analysis, competitor research with differentiation focus, and rejects generic SaaS playbook suggestions
- **Auto visual enforcement** — UI tasks cannot be marked complete without visual verification (audiq screenshots). Added explicit step 7 in execution flow and hard gate at step 5.
- **Auto archive check** — Pre-flight now checks prd.json size and auto-archives when >50KB
- **Core archive trigger** — Archive runs automatically (no prompt) when starting new sprint with completed previous sprint

## [6.3.1] - 2026-03-19

### Fixed
- **Audit skill** — Removed /compact prompt gate (unnecessary with 1M context)
- **validate.js** — Fixed version check failing for X.Y.Z semver (was only handling X.Y)

## [6.3] - 2026-03-18

### Added
- **Scan skill** — Live site QA via audiq MCP (17 tools): visual bugs, console errors, a11y, perf, SEO, design quality analysis, baseline comparison, fix plan generation
- **Brainstorm Phase 1 Scan 5** — Live QA scan runs in parallel with code scans; surfaces visual, design, and a11y issues alongside code issues
- **Auto visual verification** — UI/UX tasks verified with audiq screenshots (desktop + mobile) + console error check before marking complete
- **Design AI slop checklist** — 9-point detection checklist (safe font, purple gradient, card grid, etc.) with audiq visual analysis integration
- **Design reference sites** — linear.app, vercel.com, stripe.com, raycast.com, notion.so, cal.com as quality benchmarks

### Changed
- **Auto IDLE detection** — Added "dev server + UI changes" and "scan score <70" as signals to trigger QA scan and fix stories
- **Ship post-deploy** — Now uses audiq MCP for verification (preferred over agent-browser)
- **Deploy skill** — Added Read, Grep, Glob to allowed-tools
- **Token management** — Relaxed for 1M context; removed aggressive /compact suggestions

### Fixed
- **Hook paths** — `%USERPROFILE%` replaced with `$HOME` (Claude Code 2.1.69 runs hooks via Git Bash)
- **Stop hook schema** — `ALLOW`/`REJECT` replaced with `approve`/`block` (new CC schema)
- **Stop hook infinite loop** — Added idle marker to prevent re-blocking after IDLE detection runs
- **Pre-tool filter** — Block `rm --recursive --force` (reversed flag order) and `git restore --staged .`
- **Settings sync** — Both config files now identical (unified on `$HOME`); validate.js does deep equality
- **bump.sh** — X.Y.Z input no longer creates invalid semver X.Y.Z.0
- **Install scripts** — Removed misleading "auto-pull on session start" claim
- **session-start.js** — Fixed quote stripping (matching pairs only), hoisted PROTECTED_VARS outside loop, fixed section numbering
- **brainstorm** — Stronger deduplication against prd.json AND native Tasks
- **browser-auth** — Fixed agent-browser `--task` syntax, added Windows fallback note
- **sprint** — Fixed stale "quality skill" reference
- **seo/supabase** — Resolved "schema" trigger overlap
- **Parallel agents** — Added file ownership rules, worktree commit requirement, overhead guidance (<3 files skip worktree)
- **Auto retry** — Auto-fix trivial errors (missing import, type mismatch) before counting as retry
- **Supabase/design** — Use `${CLAUDE_SKILL_DIR}` for portable reference paths

## [6.2] - 2026-02-09

### Added
- **Stripe skill** — Stripe integration patterns (API keys, webhooks, checkout, subscriptions) based on stripe/ai (MIT)
- **SEO skill** — SEO audit and structured data patterns (meta tags, Open Graph, JSON-LD schema) merged from marketingskills repo (MIT)

### Changed
- **Setup-project rewritten** — smart stack detection from package.json dependencies, project type classification, automatic skill recommendations, environment scaffolding based on detected services

## [6.1] - 2026-02-08

### Fixed
- **disable-model-invocation blocks Skill tool** — removed flag from all 11 user-invocable skills; kept only on passive/deprecated (core, standards, checkpoint, verify)
- **Supabase deploy uses wrong token** — deploy skill now sources project `.env` first; 401 flagged as wrong token, not retried

### Changed
- **Brainstorm rewritten** — architecture-level scans (dead code, unused deps, splittability, client-vs-server fetch) replace linter-level checks (TODOs, any types). Adds competitor web search, user journey walkthrough, validation-before-claiming. "Codebase is clean" is a valid outcome.

## [6.0] - 2026-02-08

### Changed
- **Merged quality + code-quality into standards** — single passive reference skill, not in system prompt listing
- **Merged review + verify into review** — depth levels: `review`, `review quick`, `review deep`
- **Brainstorm reports first** — presents findings table, user decides whether to create stories (`brainstorm apply`)
- **Tone moderation** — replaced ALL-CAPS aggressive language with natural prose (44 instances across 13 files) for Opus 4.6 compatibility
- **"Just do it" mode** — < 5 tasks skip sprint/story overhead entirely
- **Archive threshold** — auto-suggests at 4+ sprints, keeps last 3 active

### Removed
- **Checkpoint skill deprecated** — Claude's built-in memory and `/compact` handle persistence now
- **quality, code-quality directories deleted** — merged into standards
- **verify reduced to redirect** — points to `review deep`

### Improved
- **System prompt listing reduced** — ~25 visible skills down to ~17 via `disable-model-invocation: true` on niche skills
- **Token savings** — ~200 tokens/turn fewer in system prompt, cleaner context

## [5.5] - 2026-02-08

### Fixed
- **prd.json dual-shape support** — all 7 dynamic injections across 5 skills now handle both flat (`p.stories`) and nested (`p.sprints[].stories`) shapes
- **Force-push short flag blocked** — `git push -f` now caught alongside `--force` in settings and pre-tool-filter

### Changed
- **Browser verification upgraded** — auto mode now checks console errors and network requests alongside visual snapshots (mirrors real DevTools workflow)
- **Update skill reminder** — reminds user to restart session for CLAUDE.md changes to take effect

## [5.4] - 2026-02-06

### Added
- **Custom agents** — 4 read-only Opus agents in `agents/` directory
  - `code-reviewer` — Reviews changes, learns project patterns (project memory)
  - `security-scanner` — Vulnerability scanning with cross-project learning (user memory)
  - `architect` — Feature planning, dependency mapping, architecture decisions (project memory)
  - `researcher` — Deep codebase/web research, bug investigation (project memory)
  - All use `permissionMode: plan` (read-only enforcement, no Write/Edit)
  - Synced via install scripts and `update dev` (copy mode, preserves user agents)

### Security
- **Shell injection prevention** — bump.sh validates version format, update.sh passes paths via `process.env` instead of string interpolation
- **Expanded deny rules** — `rm -r`, `git stash drop/clear`, `git branch -D` blocked in settings and pre-tool-filter
- **Env var protection** — session-start blocks overriding `PATH`, `HOME`, `NODE_OPTIONS` from .env.local
- **Fallback validation** — update.sh validates JSON before fallback copy

### Changed
- **All agents now use Opus** — 27 skills on Opus, 5 simple commands on Haiku (update, status, clean, archive, env)
- **Audit compact detection** — skips `/compact` suggestion if user already compacted this session
- **Pre-tool-filter refactored** — patterns moved to module-level constants (compiled once, not per call)
- **Error logging** — all empty catch blocks now log parse errors to stderr

### Fixed
- **README badge** — was stuck on 5.0, now auto-bumped
- **README skill count** — 34 → 32 (actual)
- **README Quick Start** — added PowerShell instructions, example session
- **`git branch -D` pattern** — case-sensitive to not block safe `git branch -d`
- **validate.js** — safe regex match, escaped special chars in trigger matching
- **.gitignore** — added `settings.backup.json`, `.claude/pre-compact-state.json`

## [5.3] - 2026-02-06

### Added
- **Agent Teams** enabled via `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` env var in settings
- **Settings merge** — `update dev` deep-merges permissions (user-added allow/deny rules preserved)
- **Settings backup** — `settings.backup.json` created before every merge
- **Post-install validation** — checks manifest, hooks, settings, commands after sync
- **`.gitattributes`** — CRLF normalization, no more warnings on commit

### Changed
- **Removed prompt-type Stop hook** — only command-type `stop-auto-check.js` remains (saves tokens every session)
- **Audit skill** — launches immediately, tells user to type `/compact` themselves (not invoke as skill)
- **Removed fake token estimates** from audit skill

## [5.2] - 2026-02-06

### Changed
- **Update logic moved to `scripts/update.sh`** — deterministic execution, no model improvisation
- **Deprecated skills list** in manifest.json — stale cleanup only removes known deprecated skills, never user-created ones
- **`${HOME:-$USERPROFILE}` fallback** in update script for Windows compatibility

### Fixed
- **update dev exit code 1** — three root causes fixed:
  - Git Bash `$HOME` paths (`/c/Users/...`) passed to Node.js — fixed with `cygpath -m`
  - `[ "$REPO" = "/tmp/..." ] && rm` returns exit 1 when test is false — removed from SKILL.md
  - Haiku combining bash steps caused variable loss — single Bash call + external script

## [5.1] - 2026-02-06

### Security
- **Remove auto-pull from session-start hook** — updates now manual via `update dev` only
- **Write/Edit protection** for `~/.claude/hooks/` and `settings.json` in pre-tool-filter.js
- **Settings backup** — `update dev` backs up settings.json before overwrite

### Changed
- **Node.js hooks** — all 4 hooks converted from .sh/.ps1 pairs to unified .js files
- **Skill consolidation** (34 -> 32): `react-patterns` into `code-quality`, `preserve-ui` into `design`
- **Preserve-ui extracted** to `design/references/preserve-ui.md` (loaded on demand, saves ~400 tokens)
- **Manifest cleaned** — removed 20 empty `context: []` arrays
- **CLAUDE.md deduplicated** — `~/CLAUDE.md` slimmed from 49 to 6 lines
- **Windows settings** use `%USERPROFILE%` instead of `$HOME` for hook paths

### Fixed
- **Git Bash path translation** in session-start.js (`/c/Users/...` -> `C:/Users/...`)
- **Bash `!` escaping** in update skill stale cleanup (`=== false` instead of `!`)
- **validate.js** updated for .js hooks and CRLF normalization
- **All frontmatter complete** — 0 WARN (was 2)

## [5.0] - 2026-02-05

### Breaking Changes
- **Skill consolidation** (40 -> 34): 6 skills merged into parent skills
  - `supabase-postgres` + `supabase-schema` merged into `supabase`
  - `browser-test` + `auth-token-injection` merged into new `browser-auth`
  - `security-patterns` merged into `security`
  - `self-review` merged into `review`
  - `ci-cd` merged into `deploy`
- **Requires chains updated**: All downstream skills (auto, ship, audit, test, review, pr-review) reference new consolidated names
- **Deleted directories**: supabase-postgres/, supabase-schema/, browser-test/, auth-token-injection/, security-patterns/, self-review/, ci-cd/

### Added
- **Dynamic context injection** (`!`command`` syntax) on 5 skills
  - `auto` - Pre-injects git status and prd.json sprint stats
  - `status` - Pre-injects sprint data (project, done/pending/deferred counts)
  - `commit` - Pre-injects working tree status, diff stats, recent log
  - `audit` - Pre-injects existing task list from prd.json
  - `brainstorm` - Pre-injects existing task list from prd.json
  - Estimated savings: 18-24 tool calls, 23-37K tokens per auto session
- **`argument-hint` frontmatter** on 6 user-facing skills
  - `commit` -> `[type] [message]`
  - `fix` -> `[error or file]`
  - `security` -> `[scope: full|quick|file]`
  - `refactor` -> `[target file or pattern]`
  - `brainstorm` -> `[focus area]`
  - `sprint` -> `[new|advance|close]`
- **Skill-scoped Stop hook** in `auto/SKILL.md` frontmatter (forward-looking: blocked by Claude Code bug #19225)
- **PreCompact hook** in all 3 settings files - preserves prd.json to `.claude/pre-compact-state.json` before context compaction
- **Permission deny rules** in all 3 settings files - blocks `rm -rf /`, `rm -rf ~`, `git push --force origin main/master`, `git reset --hard`
- **New skill**: `browser-auth` (merged browser-test + auth-token-injection)

### Changed
- **Supabase triggers expanded**: now includes `postgres`, `rls` (absorbed from merged skills)
- **Deploy triggers expanded**: now includes `ci`, `deploy` (absorbed from ci-cd)
- **Security priority**: changed to 0 (auto-loaded with review, audit, ship)
- **Sprint skill**: now user-invocable with argument-hint
- **Manifest description**: updated to reflect 34 skills
- All version files bumped to 5.0

Total skills: 34 | Version: 5.0

## [4.9.4] - 2026-02-05

### Fixed
- **CRITICAL: Stop hooks disabled** - Installed settings.json had empty Stop array; auto-mode protection was non-functional
- **CRITICAL: Unwired hooks** - PreToolUse (security filter) and PostToolUse (typecheck) now wired in all settings files
- **Orphaned build/ skill** - Deleted dead directory (not in manifest, unreachable)
- **6 invalid skill names** - Uppercase/spaces fixed to lowercase-hyphens per Anthropic spec (agent-browser, archive-prd, env-vars, fix, ship)
- **Settings divergence** - Installed, repo, and unix configs now aligned (ExecutionPolicy, WindowStyle, hook wiring)
- **README missing commands** - Added sprint and verify to command table (18 commands)
- **Install script fallbacks** - Updated from 4.9.0 to 4.9.4

### Added
- **disable-model-invocation** on 8 side-effect skills (auto, commit, ship, deploy, clean, setup-project, update, archive-prd)
- **PreToolUse hook** - Blocks dangerous commands (rm -rf, DROP TABLE, git push --force) and skips large file reads
- **PostToolUse hook** - Auto-runs typecheck after TS/JS edits
- **.gitignore** - Added node_modules/, .env*, dist/, build/, .next/

### Changed
- **Manifest descriptions** improved with "use when..." context for 7 skills (sprint, fix, self-review, auth-token-injection, clean, verify, security)
- **Skill count** 40 → 39 (build removed)

Total skills: 39 | Version: 4.9.4

## [4.9.3] - 2026-02-05

### Added
- **Commit Skill** - Standardized git commit, push, and PR workflow
  - Conventional commits format (feat|fix|refactor|chore|docs|test|perf)
  - Safety checks: no .env, no console.log, no hardcoded secrets
  - Batch commit pattern for auto mode (every 3 tasks)
  - Full PR flow with gh CLI
  - Triggers: "commit", "push", "pr", "commit-push-pr"
- **Perf Skill** - Web performance audit patterns
  - Core Web Vitals targets (LCP, INP, CLS, FCP, TTFB)
  - Bundle size rules and common fixes (images, code splitting, React.memo, fonts)
  - Supabase query optimization
  - Audit report format
  - Triggers: "perf", "performance", "lighthouse", "bundle size", "core web vitals"
- **A11y Skill** - Accessibility audit (WCAG 2.1 AA)
  - Keyboard navigation, focus management, color contrast
  - Images/media, forms, ARIA, semantic HTML patterns
  - Bad vs good code examples for each pattern
  - Audit report format with scoring
  - Triggers: "a11y", "accessibility", "wcag", "screen reader"
- **Refactor Skill** - Code refactoring patterns
  - Split large file, extract component, extract hook
  - Replace prop drilling, consolidate duplicates
  - Safety checklist (typecheck before/after each step)
  - Triggers: "refactor", "extract", "split", "restructure"

### Changed
- **Requires Chains Updated** - New skills integrated into critical workflows
  - `auto` now requires: commit (for batch commits)
  - `ship` now requires: commit (for clean commits before deploy)
  - `audit` now requires: perf, a11y (comprehensive quality audit)
- **Auto Skill Fixed** - No longer auto-creates new sprints when all tasks done
  - Explicit STOP rule added to IDLE Detection
  - Suggests `brainstorm` or `sprint` for next work

### Fixed
- **Duplicate "pr" trigger** - removed from commit, kept in pr-review
- **Missing YAML frontmatter** - added to auth-token-injection and design skills
- **Trigger mismatches** - synced pr-review and setup-project with manifest
- **Orphaned hooks** - removed unused auto-continue.ps1/.sh
- **Dead build skill** - removed from manifest (directory kept as reference)
- **Missing jq checks** - added to stop-auto-check.sh, pre-tool-filter.sh, post-tool-typecheck.sh
- **Auto skill language** - dialed back aggressive caps/bold for Opus 4.5+ compatibility

**Total skills:** 40 | **Version:** 4.9.3

---

## [4.9.2] - 2026-02-05

### Added
- **Update Skill** - Say "update dev" to sync latest changes
  - Pulls from GitHub
  - Mirrors skills/ and hooks/ to ~/.claude
  - Removes stale files (robocopy /MIR on Windows, rsync --delete on Mac/Linux)
  - Reports version and changes
  - Triggers: "update dev", "update auto-dev", "update skills", "sync skills"

### Changed
- Session-start hook now has 5s timeout (no hang offline)
- Copy mode auto-detects and re-syncs on updates

**Total skills:** 37 | **Version:** 4.9.2

---

## [4.9.0] - 2026-02-05

### Added
- **Zero-Maintenance Updates** - Symlink-based installation
  - Skills/hooks symlinked to repo (changes auto-sync)
  - `update-dev` command added to shell profile
  - `repo-path.txt` stores clone location for portability
  - `--copy` flag for systems where symlinks fail
- **Plan Mode Integration** - brainstorm and audit now suggest plan mode for complex work
  - `brainstorm` suggests plan mode for features spanning 3+ files
  - `audit` suggests plan mode when 5+ critical/high issues found
- **Enhanced Triggers** - More natural language activation
  - `fix` now responds to: "broken", "error"
  - `env-vars` now responds to: "environment", "credentials", "secrets", "api key"
  - `agent-browser` now responds to: "browser", "web test", "ui test"

### Changed
- **Install Scripts Rewritten** - Now use symlinks by default
  - `install.ps1` / `install.sh` create symlinks instead of copying
  - Automatic fallback to copy if symlinks fail (Windows without admin/dev mode)
  - Adds `update-dev` function to PowerShell profile / bashrc / zshrc
- **Complete Synergy Chains** - All critical workflows now fully connected
  - `auto` requires: code-quality, quality, react-patterns, verify, browser-test, security-patterns
  - `ship` requires: review, security-patterns, test
  - `audit` requires: quality, code-quality, design, security-patterns, browser-test
- **Built-in Command Conflicts Resolved**
  - `status` skill trigger changed to "progress" (status is Claude Code built-in)
  - `deploy` marked internal-only (use `ship` for user-facing deploys)
- **Enhanced Clean Skill** - Age-based cleanup
  - Screenshots: all deleted on clean
  - Backups: delete older than 7 days
  - Handoffs: delete older than 7 days
  - Archives: prompt before deleting (30+ days)

### Fixed
- **prd.json Schema** - Corrected skills referencing stories as array (now object)
- **Deprecated MCP Reference** - Removed from settings.local.json template

**Total skills:** 36 | **Requires chains:** 14 | **Version:** 4.9.0

---

## [4.8.0] - 2026-02-05

### Added
- **Security Skill** - Pre-deploy security audit (user-invocable)
  - Secrets scan, env file check, RLS validation, XSS detection
  - Trigger: `security`
  - Auto-runs before ship

### Fixed
- **Version sync** - All version files now 4.8.0 (VERSION, package.json, manifest)
- **status skill** - Now uses TaskList + prd.json (removed project-meta.json reference)
- **prd.json template** - Fixed to match schema (projectName, stories as object)
- **ship skill** - Added security check step before deploy
- **Auto requires** - Added verify to chain (ensures completion quality)
- **Deduplication** - audit/brainstorm now check existing tasks before creating

### Changed
- **Quality skills consolidated** - Clear boundaries, no overlap
  - `quality` = Core principles (judgment, UI states)
  - `code-quality` = Production patterns (learned rules)
- **deploy skill** - Now internal only (use `ship` for deploys)
- **Single-word commands** - All triggers simplified

### Removed
- Unused templates (ab-test, context, learnings, project-meta)
- Plugin files (marketplace not approved yet)
- Redundant QUICKSTART files
- **Stale scripts** - setup-keys.ps1, setup-keys.sh, scripts/, bin/install.js
- **MCP template** - config/mcp.template.json (not using MCPs)

### Changed (Install Scripts)
- **Simplified install.ps1/sh** - From ~200 lines to ~80 lines
- **Removed credential setup** - No longer saves API keys during init
- **README simplified** - From 772 lines to 120 lines (accurate, concise)

**Total skills:** 39 | **Requires chains:** 14

---

## [4.6.3] - 2026-02-05

### Added
- **CI/CD Skill** - GitHub Actions workflows and CI/CD patterns
  - Standard CI workflow template
  - Vercel deploy workflow
  - Supabase Edge Functions deploy
  - Matrix builds for multi-version testing
  - Triggers: `ci`, `github actions`, `workflow`, `pipeline`
- **Monitoring Skill** - Observability patterns for production
  - Structured JSON logging
  - Error boundaries with logging
  - Vercel Analytics integration
  - API route monitoring
  - Health check endpoint
  - Triggers: `monitoring`, `logging`, `observability`, `analytics`
- **New requires chain**: `deploy` → `ci-cd`

### Changed
- **Directory structure normalized** - All skills now use `skill-name/SKILL.md` format
  - Migrated 12 flat files to directory structure
  - Updated manifest.json with new paths
- **supabase-schema split** - Was 361 lines, now modular:
  - `SKILL.md` - Main reference (~80 lines)
  - `rules/rls-patterns.md` - RLS policy examples
  - `rules/security-patterns.md` - Security hardening
  - `rules/multi-account.md` - Multi-account CLI setup
- **Total skills**: 39 (was 37)
- **Total requires chains**: 12 (was 11)

---

## [4.6.2] - 2026-02-05

### Added
- **Supabase Postgres Skill** - Official Postgres best practices from Supabase
  - Query performance (missing indexes, composite indexes)
  - Connection management (pooling, limits)
  - Security & RLS (basics, performance optimization)
  - Schema design (foreign key indexes, data types)
  - N+1 query prevention
  - 8 detailed reference files included
  - Source: [supabase/agent-skills](https://github.com/supabase/agent-skills)
- **CONTRIBUTING.md** - Skill authoring guide
  - Directory structure conventions
  - SKILL.md format specification
  - Manifest entry guidelines
  - Best practices and checklist
- **New requires chain**: `supabase` → `supabase-postgres`
- **Total skills**: 37 (was 36)
- **Total requires chains**: 11 (was 10)

---

## [4.6.1] - 2026-02-05

### Added
- **Remotion Skill** - Best practices for video creation in React
  - Compositions, animations, sequencing, timing
  - Subtitles and captions
  - Media embedding (videos, images, audio)
  - 5 detailed rule files included
  - Source: [remotion-dev/skills](https://github.com/remotion-dev/skills)
- **Total skills**: 36 (was 35)

### Changed
- Updated muzic.ai, reelr, cloud-connect-build to v4.6
- Removed stale skills folder from cloud-connect-build

---

## [4.6.0] - 2026-02-05

### Added
- **Security Patterns Skill** - Vulnerability detection patterns from Anthropic's security-guidance
  - Command injection (GitHub Actions, child_process, os.system)
  - Code injection (eval, new Function, pickle)
  - XSS patterns (dangerouslySetInnerHTML, document.write, innerHTML)
  - Auto-loaded with review, audit, ship, pr-review
- **PR Review Skill** - Comprehensive PR review using specialized agents
  - Triggers: `pr-review`, `review-pr`, `code-review`
  - CLAUDE.md compliance checking
  - Bug hunting with validation
  - Security scanning
  - Requires: security-patterns, code-quality

### Changed
- **Renamed** `frontend-design` → `design` (simpler, clearer)
  - Triggers: `design`, `ui`, `landing page`, `marketing page`
  - Creates distinctive UI, avoids generic AI aesthetics
- **Total skills**: 35 (was 33)
- **Total requires chains**: 10 (optimized from 6 in v4.4)
- Updated all skills referencing `frontend-design` to use `design`

### Requires Chain Updates
```
review     → quality + code-quality + security-patterns (NEW)
pr-review  → security-patterns + code-quality (NEW skill)
audit      → quality + code-quality + design + security-patterns (design renamed)
ship       → review + security-patterns (security added)
brainstorm → quality + design (design renamed)
```

---

## [4.5.0] - 2026-02-05

### Added
- **Skill Synergy Chains** - Critical missing connections now in place
  - `test` → requires `browser-test` → requires `agent-browser`
  - `ship` → requires `review` (pre-deploy quality check)
  - `verify` → requires `quality` (standards enforcement)
- **Improved Descriptions** - Third-person, specific, with trigger words per API best practices
- **Trigger Deduplication** - Removed conflicting triggers between skills
  - `setup-project` triggers: `init`, `new project`, `scaffold` (removed `setup`)
  - `test` triggers: `test`, `e2e`, `browser` (removed duplicate `verify`)
  - `ship` triggers: `ship` only (removed duplicate `deploy`)

### Changed
- Total `requires` entries: 10 (was 6)
- Quality skill description now specific about what it enforces
- Workflow skill description clarifies it's for reference
- Browser-test now chains to agent-browser automatically
- Version: 4.5.0

### Optimized (from API best practices review)
- **Progressive Disclosure**: Skills load only when needed via requires chains
- **Token Efficiency**: Metadata always loaded (~100 tokens), SKILL.md on-demand
- **Cross-references**: ONE level deep maximum (e.g., test→browser-test→agent-browser)
- **Trigger Specificity**: Each trigger maps to exactly one skill

---

## [4.4.0] - 2026-02-05

### Added
- **Frontend Design Skill** - Anthropic's official skill for high-quality UI design
  - Avoids "AI slop" (purple gradients, Inter/Roboto, generic layouts)
  - Guides toward intentional design choices (typography, color, motion, composition)
  - Pro tips: generate 5 variants, iterate on favorites
  - Triggers: `design`, `frontend`, `ui`, `landing page`, `marketing page`
  - Source: [anthropics/claude-code](https://github.com/anthropics/claude-code/blob/main/plugins/frontend-design/skills/frontend-design/SKILL.md)
- **Skill Synergy System** - Skills now cross-reference each other
  - `audit` → references `quality`, `code-quality`, `frontend-design`, `preserve-ui`
  - `review` → references `quality`, `code-quality`, `self-review`
  - `brainstorm` → references `quality`, `frontend-design`, `preserve-ui`
  - `auto` → requires `code-quality`, `quality`, `react-patterns`
  - Design validation step in brainstorm for UI features

### Changed
- Total skills: 33
- Manifest now has 6 `requires` entries (was 1)
- Skills include "Quality Framework Reference" sections
- Design system principles flow into audit/review checks

---

## [4.3.0] - 2026-02-04

### Added
- **32 skills now registered** - Consolidated all skills from installed versions
  - agent-browser (browser automation CLI reference)
  - archive-prd (archive completed stories)
  - auth-token-injection (auth patterns for testing)
  - build (build commands and error handling)
  - build-reference (build documentation)
  - env-vars (environment variable patterns)
  - help (list available commands)
  - supabase-schema (schema reference)
- **6 hooks added** - Full hook system for all platforms
  - auto-continue.ps1/.sh - Auto-continues if tasks remain
  - post-tool-typecheck.ps1/.sh - Runs typecheck after TS/JS edits
  - pre-tool-filter.ps1/.sh - Blocks dangerous commands
- **Brainstorm Phase 2** - Feature ideation after cleanup proposals
- **Skills vs Plugins architecture** - Documentation clarifying the two systems

### Changed
- Repository is now single source of truth for all skills and hooks
- Installer synced to v4.3
- prd.json removed from repo (project-specific file)

### Fixed
- 8 missing skills now registered in manifest.json

---

## [4.0.0] - 2026-02-03

### Breaking Changes
- Archived v3.9 (19 commands, 14 skills, 8 hooks → archive/v3.9/)
- New skill structure using SKILL.md in directories
- Native TaskCreate/TaskUpdate replaces prd.json for active work

### Added
- **Native Tasks Integration** - Uses Claude Code's built-in task system
  - TaskCreate/TaskUpdate/TaskList/TaskGet with metadata
  - blocks/blockedBy dependencies built-in
  - Session-scoped persistence - no file I/O during work
- **Hybrid Task System** - Two-layer architecture
  - prd.json = Long-term memory (sprint history, verification notes)
  - Native Tasks = Short-term memory (current session work)
  - 92% token reduction (~35K → ~2.6K per session start)
- **Resolution Learning** - Documents HOW issues were fixed
  - `resolution` field in prd.json schema
  - Pattern format: `[CATEGORY]: [SPECIFIC FIX]`
  - Auto-inject warnings on similar errors
- **Parallel Swarm Audit** - 6 specialized agents run simultaneously
  - Security (secrets, XSS, CORS, injection)
  - Performance (memo, effects, re-renders, N+1)
  - Accessibility (WCAG, keyboard, contrast, aria)
  - Type Safety (any, ts-ignore, type conflicts)
  - UX/UI (loading states, empty states, error handling)
  - Test Coverage (critical paths, untested hooks)
  - Produces severity-rated report with scores
- **Proactive Brainstorm** - YOU propose, user doesn't ask
  - Parallel scans for TODOs, console.logs, hardcoded colors
  - Presents concrete improvement scenarios with impact/effort
  - Never asks "what do you want?" - proposes based on findings

### Changed
- **skills/audit/SKILL.md** - Parallel swarm architecture
- **skills/brainstorm/SKILL.md** - Proactive proposals
- **skills/core/SKILL.md** - Hybrid task system documentation
- **Auto mode** - No more Ralph Loop dependency

### Philosophy
- Context is expensive - minimize prd.json reads
- Learn from mistakes - document resolutions
- Parallel execution - 6 agents faster than 1 comprehensive scan
- Use native tools when available (TaskCreate over prd.json)

---

## [3.9.0] - 2025-01-25

### Added
- **Auto Mode v2** - Self-bootstrapping autonomous development
  - Detects Ralph Loop for true non-stop execution
  - Bootstrap from project context if no prd.json exists
  - Auto-verify UX tasks with browser checks
  - Outputs `<promise>` tag for Ralph completion
- **Brainstorm auto mode** - Generates tasks without asking when called programmatically
- **Ralph Loop integration** - Suggests `/ralph-loop` if not already running

### Changed
- **auto.md** - Complete rewrite with entry point flow diagram
- **brainstorm.md** - Added auto mode vs interactive mode distinction
- Never use `AskUserQuestion` in auto mode - make decisions autonomously

### Philosophy
- "Walk away" development - start it and come back to finished work
- Bootstrap intelligently from CLAUDE.md, README.md, package.json context

---

## [3.8.0] - 2025-01-25

### Added
- **Verification requirement** - Tasks need actual testing, not just build passing
  - `verified: "browser"|"test"|"e2e"` = truly complete
  - `verified: null|"build"` = code complete but unverified
- **Verification matrix** - Different task types require different verification
  - UX: Browser test required
  - Feature: Browser OR unit test
  - Bugfix: Reproduce and verify fix
  - AI: Test with real/mock data
- **Status shows verification** - Verified vs unverified counts

### Changed
- **auto.md** - Verification step required before marking complete
- **core.md** - Schema includes `verified` field
- **status.md** - Shows verification quality metric

### Philosophy
- Build passing is NOT done
- Unverified code is technical debt
- Story quality matters more than velocity

---

## [3.7.0] - 2025-01-25

### Added
- **code-quality.md** - Learned patterns from production mistakes
  - 5 type safety rules (single source of truth, complete Records, Supabase typing)
  - 2 React patterns (no nested interactives, hooks at top level)
  - Error handling patterns (auth errors, storage quota)
  - Query key factory pattern
  - Mistake logging format with categories

### Changed
- **core.md** - Enhanced prd.json schema
  - Added `type` as required field
  - Task scoping rules (split if >5 files, >8 criteria)
  - Field validation rules with examples
  - ID format: `TYPE-NAME##`
- **auto.md** - Added learned code quality rules section
  - Type safety checklist from recurring mistakes
  - Enhanced decision logging format with rationale/trade-offs
- **manifest.json** - Added `requires` field for skill dependencies

### Context Optimization
- code-quality.md auto-loads with auto/review commands
- Prevents recurring mistake patterns before they happen

---

## [3.6.0] - 2025-01-25

### Changed
- **94% context reduction** - Slimmed build.md from 548 to 61 lines
- **Granular skill loading** - Each command loads only its specific file
- **Archived build-reference.md** - 1074 lines of redundant content removed
- **New core.md** - Minimal 43-line prd.json schema reference

### Context Savings
- "status" command: ~3K → ~300 tokens
- "auto" command: ~3K → ~1K tokens
- Estimated 60-70% reduction in initial context per command

---

## [3.5.0] - 2025-01-25

### Added
- **Sprint mode** - Time/milestone-based development cycles
  - `sprint 3h` - Run for 3 hours
  - `sprint "all P1 done"` - Run until milestone
  - Cycles through: brainstorm → auto → review → polish → security → docs
- **Session lock** - Prevents parallel session conflicts via `.claude-lock`
- **Mistake tracking** - `/mistakes` command to view error patterns
- **Smart retry** - Auto-retry failed tasks with different approach (max 2)
- **Task templates** - Pre-built patterns: auth, crud, api, component, hook, supabase
  - `template auth` - Adds 6 authentication tasks
  - `template crud users` - Adds 5 CRUD tasks
- **Batch commits** - Commit every 3 tasks instead of per-task
- **Preflight check** - Validates git, build, types before auto mode
- **Handoff export** - `/handoff` generates session summary for continuity
- **Context audit** - Analyze and optimize context window usage

### Changed
- **Auto mode hardened** - Explicitly forbidden from using AskUserQuestion
- Decisions logged to `.claude/decisions.md` instead of asking user
- Ralph Loop integration for true non-stop operation

---

## [2.4.3] - 2026-01-22

### Fixed
- **Cross-platform archive** - Use Read/Write tools instead of shell copy commands
- Prevents `copy` vs `cp` command errors on Windows
- Fixed emoji encoding in install.ps1 (replaced with ASCII)

---

## [2.4.2] - 2026-01-22

### Added
- **Skill index injection** - SessionStart hook now outputs command→file mapping
- manifest.json now actively used for skill discovery at session start
- Claude can now instantly look up which skill file to read for any command

---

## [2.4.1] - 2026-01-22

### Fixed
- **QUICKSTART.md**: Fixed Windows path syntax in troubleshooting section
- **install.sh**: Added plugin installation for Mac/Linux users (was missing)
- **auto-continue hook**: Changed from blocking to informing behavior
  - Now respects user's "stop" command instead of forcing continuation
  - Shows remaining tasks as info message, not blocker

---

## [2.4.0] - 2026-01-22

### Added
- **Local plugin** for slash commands (`/auto`, `/status`, `/brainstorm`, etc.)
  - Auto-registered during install
  - Works alongside natural language commands
  - 8 commands: auto, status, brainstorm, continue, archive, clean, stop, reset
- **Archive system** for large prd.json files:
  - `archive` command moves completed stories to `prd-archive-YYYY-MM.json`
  - Keeps only active/QA stories in main prd.json
  - Adds `archived` section with summary for context
  - Reduces token usage by 60%+ on large projects
- **Clean command** to remove Claude Code artifacts:
  - Deletes `.claude/screenshots/*.png`
  - Removes `prd-backup-*.json` older than 7 days
  - Cleans `.playwright-mcp/` folder
- **Screenshot convention**: Save to `.claude/screenshots/` (auto-gitignored)
- **archive-prd.md** skill with detailed archival documentation

### Changed
- Updated `build.md` with archive and clean commands
- Updated `test.md` with screenshot folder convention
- Updated README with inline changelog
- Install script now auto-registers plugin in Claude Code

---

## [2.3.0] - 2026-01-22

### Added
- **Hooks system** for token optimization and automation:
  - `auto-continue.ps1/.sh` - Stop hook that auto-continues if tasks remain in prd.json
  - `session-start.ps1/.sh` - Injects task progress context at session start
  - `pre-tool-filter.ps1/.sh` - Blocks dangerous commands, skips large/generated files
  - `post-tool-typecheck.ps1/.sh` - Runs typecheck only for TS/JS files
- `config/settings.json` - Pre-configured hooks for Windows
- `config/settings-unix.json` - Pre-configured hooks for Mac/Linux
- Hooks documentation in README

### Changed
- Install scripts now copy hooks and settings.json
- Token savings of 30-60% through context injection and filtering

---

## [2.2.0] - 2025-01-22

### Added
- `agent-browser.md` skill - Browser automation CLI (5-6x more token-efficient than Playwright MCP)
- Browser testing section in README

### Changed
- `test.md` now uses agent-browser CLI instead of Playwright MCP
- Simplified README - focus on "brainstorm" and "auto" commands
- Simplified `config/CLAUDE.md` and `config/QUICKSTART.md` templates
- Updated install scripts to remove scripts directory references

### Removed
- `scripts/start-server.ps1` - No longer needed (use background bash instead)
- `scripts/start-server.sh` - No longer needed
- `scripts/` directory - Empty after removing start-server scripts

---

## [2.1.0] - 2025-01-15

### Added
- Heartbeat monitoring (3-min intervals for faster work stealing)
- Dependency tracking (`dependsOn` field in tasks)
- Pattern storm detection (detects same error across 3+ tasks)
- Rollback command (`rollback S42` to undo task changes)
- Enhanced status dashboard with emojis and ANSI colors
- ASCII dependency tree (`deps` / `tree` command)

### Changed
- Stale work detection reduced from 30min to 10min
- Task schema updated with `heartbeat`, `dependsOn`, `blockedBy` fields

---

## [2.0.0] - 2025-01-10

### Added
- Multi-agent coordination with claim system
- `claimedAt` field for task locking
- Offset algorithm for parallel agent starts
- `stop` command to release claims before closing
- `reset` command to clear all claims after crash

### Changed
- Complete rewrite of build.md for autonomous operation
- Simplified task schema

---

## [1.0.0] - 2024-12-01

### Added
- Initial release
- `prd.json` task management
- `progress.txt` learnings log
- Basic skills: build, ship, test, fix, setup-project
- Supabase MCP integration
