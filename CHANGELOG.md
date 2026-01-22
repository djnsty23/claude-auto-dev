# Changelog

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
