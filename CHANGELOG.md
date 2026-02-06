# Changelog

## [5.4] - 2026-02-06

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
