# Claude Auto-Dev

[![Claude Code](https://img.shields.io/badge/Claude%20Code-Compatible-blueviolet)](https://claude.ai/code)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-6.6.3-blue.svg)](https://github.com/djnsty23/claude-auto-dev/releases)

**Autonomous development workflow for Claude Code.** Say what you want to build - Claude handles the rest.

---

## Quick Start

```bash
# Mac/Linux
git clone https://github.com/djnsty23/claude-auto-dev ~/claude-auto-dev
cd ~/claude-auto-dev && chmod +x install.sh && ./install.sh

# Windows (PowerShell)
git clone https://github.com/djnsty23/claude-auto-dev $env:USERPROFILE\claude-auto-dev
cd $env:USERPROFILE\claude-auto-dev; .\install.ps1
```
```
claude
```
```
You: brainstorm
Claude: [Scans codebase, finds improvements] → Created 5 stories in prd.json

You: auto
Claude: [Works through all tasks autonomously] → 5/5 complete

You: ship
Claude: [Review → security scan → deploy] → Shipped to production
```

---

## Install

**Prerequisites:** [Git](https://git-scm.com/), [Claude Code](https://github.com/anthropics/claude-code)

```bash
# Mac/Linux
git clone https://github.com/djnsty23/claude-auto-dev ~/claude-auto-dev
cd ~/claude-auto-dev && chmod +x install.sh && ./install.sh

# Windows (PowerShell)
git clone https://github.com/djnsty23/claude-auto-dev $env:USERPROFILE\claude-auto-dev
cd $env:USERPROFILE\claude-auto-dev; .\install.ps1
```

**What it does:**
- Symlinks `skills/` and `hooks/` to `~/.claude/` (auto-sync with repo)
- Adds `update-dev` command to your shell
- Saves repo path for portable updates

**Options:**
- `--full` / `-Full` - Also install rules and settings templates
- `--init` / `-Init` - Initialize current project with prd.json
- `--copy` / `-Copy` - Use copy instead of symlinks (if symlinks fail)

---

## Updates

**Option 1: Say "update dev"** (recommended)
```
You: update dev
Claude: [pulls latest, syncs skills/hooks, removes stale files]
        Updated to v6.6.3
```

**Option 2: Shell command**
```bash
update-dev   # Added to your shell profile by installer
```

**Option 3: Manual**
```bash
cd ~/claude-auto-dev && git pull
# Then say "update dev" to sync
```

---

## Commands

| Say | Does |
|-----|------|
| `iterate` | Convergence loop: brainstorm→fix→re-scan until clean |
| `brainstorm` | Scan codebase + live site, propose improvements |
| `auto` | Work through all tasks autonomously |
| `scan` / `qa` | Live site QA via audiq (visual + functional + a11y) |
| `audit` | 7-agent parallel quality audit |
| `review` | Code quality check (add `quick` or `deep`) |
| `ship` | Build, test, review, deploy with post-deploy verification |
| `progress` | Show sprint progress |
| `sprint` | Create/advance sprint |
| `test` | Run unit + browser tests |
| `fix` | Debug issues |
| `commit` | Conventional commit + push + PR |
| `security` | Pre-deploy security scan |
| `perf` | Performance audit (Core Web Vitals) |
| `a11y` | Accessibility audit (WCAG 2.1 AA) |
| `design` / `ui` | UI design with anti-slop checklist |
| `refactor` | Code refactoring patterns |
| `clean` | Remove temp files |
| `setup` | Initialize new project |
| `update dev` | Sync latest from GitHub to ~/.claude |

**Note:** `/help`, `/status`, `/init`, `/compact`, `/btw` are Claude Code built-ins.

---

## Workflow

```
brainstorm → scans codebase + live site, creates stories
auto       → implements all pending stories + visual verification
ship       → review + security + deploy + post-deploy scan
iterate    → brainstorm→fix→re-scan loop until clean (3-4 rounds)
```

See [`skills/commands.md`](skills/commands.md) for the full list of 36 skills (33 active + 3 deprecated redirects).

---

## Tips & Tricks

### Parallel work while Claude is busy

| Method | When to Use |
|--------|------------|
| `/btw what was that config?` | Quick question without affecting context — answer appears in overlay, never enters history |
| `& plan the payment system` | Background a task while main thread keeps working |
| `Ctrl+B` | Move current running task to background, then type something new |
| `/branch` | Fork the conversation — try an approach without losing the current one |

### Get more from brainstorm

```
brainstorm              → Full scan (5 parallel agents + competitor research)
brainstorm auth         → Targeted scan on auth code only
brainstorm features     → Skip code quality, focus on product gaps
brainstorm apply        → Create prd.json stories from last findings
```

The 5th scan agent runs live site QA if a dev server is detected — start your dev server first for visual/a11y/perf findings alongside code issues.

### Convergence loop

Instead of manually cycling `brainstorm → brainstorm apply → auto`, use:
```
iterate        → runs until codebase converges (typically 3-4 rounds)
iterate 2      → quick pass (max 2 rounds)
iterate design → focus on visual/design issues only
```

Each round finds fewer issues. When findings drop to 0, it stops.

### Visual verification

Auto mode now requires visual verification for UI tasks. To get the most out of it:
1. Start your dev server before running `auto`
2. Claude will screenshot pages (desktop + mobile) after each UI change
3. Console errors and broken layouts are caught before tasks are marked complete

Works with [audiq MCP](https://github.com/nicholasgriffintn/audiq) for deep scans, falls back to agent-browser if unavailable.

### Agent teams for big features

For complex multi-file features, use Claude Code's agent teams:
```
Create an agent team with 3 teammates:
- Frontend: owns src/components/ and src/app/
- Backend: owns supabase/functions/ and src/lib/
- Tests: owns tests/ and writes integration tests
```

Each teammate works independently with its own context. Requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in settings (auto-dev enables this by default).

### Manage context in long sessions

- `/btw` for quick questions that don't need to persist
- `/clear` between unrelated tasks to reset context
- `/compact focus on the API changes` to compress with specific focus
- Use subagents for research: "use a subagent to investigate the auth flow"
- With 1M context on Opus 4.6, you rarely need to worry about this

### Design without AI slop

The design skill includes a 9-point slop detection checklist. If 3+ of these are present, it starts over:
- Safe font (Inter, Roboto) → Pick distinctive Google Font
- Purple gradient on white → Commit to a real palette
- 3 identical cards in a row → Break the pattern
- Centered everything → Use asymmetry
- No texture, no motion, stock illustrations → Add depth

Reference sites studied before designing: linear.app, vercel.com, stripe.com, raycast.com, notion.so, cal.com

### Quick fixes — skip the ceremony

For small tasks (< 5), skip sprints entirely:
```
fix the button overflow on mobile
add loading state to the dashboard
update the footer links
```

No `auto`, no `sprint`, no prd.json. Just describe it and Claude fixes it.

---

## Files

**Global** (`~/.claude/`):
```
skills/        # Synced from repo (36 skills)
hooks/         # Symlink to repo
rules/         # Your custom rules (optional)
repo-path.txt  # Points to your clone location
```

**Per Project**:
```
prd.json       # Tasks and sprint history
```

---

## Task Format

```json
{
  "projectName": "my-app",
  "sprint": "S1",
  "stories": {
    "S1-001": {
      "title": "Add user auth",
      "passes": null
    }
  }
}
```

**States:** `null` = pending, `true` = done, `"deferred"` = postponed

---

## New PC Setup

```bash
# Clone anywhere
git clone https://github.com/djnsty23/claude-auto-dev /path/to/claude-auto-dev

# Run installer (creates symlinks + update-dev alias)
cd /path/to/claude-auto-dev
./install.sh   # or .\install.ps1 on Windows

# Done - open new terminal and use update-dev
```

---

## Troubleshooting

**Symlinks fail on Windows?**
- Enable Developer Mode in Settings > Update & Security > For developers
- Or run PowerShell as Administrator
- Or use `.\install.ps1 -Copy` (auto-updates still work, just slower)

**Not seeing updates?**
- Check `~/.claude/repo-path.txt` points to your clone
- Ensure you have internet on Claude start
- Manual: `cd ~/claude-auto-dev && git pull`

**Skills not loading?**
- Verify `~/.claude/skills/` exists and contains skill directories
- Restart terminal after install

**Hook errors?**
- Requires Node.js v18+. Check: `node -v`
- Hooks fail silently by design — run `node validate.js` to check consistency

---

## Uninstall

```bash
rm -rf ~/.claude/skills ~/.claude/hooks ~/.claude/repo-path.txt
# Remove update-dev function from your shell profile
```

---

## License

MIT
