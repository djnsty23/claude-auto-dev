# Changelog

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
