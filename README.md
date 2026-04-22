# Claude Auto-Dev

[![Claude Code](https://img.shields.io/badge/Claude%20Code-Compatible-blueviolet)](https://claude.ai/code)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-7.2-blue.svg)](https://github.com/djnsty23/claude-auto-dev/releases)

**Autonomous development workflow for Claude Code.** Say what you want to build — Claude handles the rest.

---

## Quick Start

```bash
# Mac/Linux
git clone https://github.com/djnsty23/claude-auto-dev ~/claude-auto-dev
cd ~/claude-auto-dev && ./install.sh

# Windows (PowerShell)
git clone https://github.com/djnsty23/claude-auto-dev $env:USERPROFILE\claude-auto-dev
cd $env:USERPROFILE\claude-auto-dev; .\install.ps1
```

Then run `claude` and say `brainstorm` — Claude scans the codebase, proposes improvements, creates stories, and works through them autonomously.

```
You: brainstorm         → Claude finds 5 improvements
You: brainstorm apply   → Creates 5 stories in prd.json
You: auto               → Works through all tasks
You: ship               → Review, security scan, deploy
```

---

## Install

**Prerequisites:** [Git](https://git-scm.com/) and [Node.js 18+](https://nodejs.org/) (the installer adds Claude Code for you if it's missing).

**Options:**
| Flag | What it does |
|------|--------------|
| `--full` / `-Full` | Also install rules + settings templates |
| `--init` / `-Init` | Scaffold `prd.json` in the current project |
| `--force` | Back up and overwrite files that collide with shipped names |

**What it does:**
- Copies `skills/`, `hooks/`, and `agents/` into `~/.claude/`
- Writes `~/.claude/.auto-dev-installed.json` — a sidecar recording exactly what got installed (used by uninstall)
- Adds an `update-dev` command to your shell
- Saves your repo path so updates are portable

**Collision handling.** Install leaves user-owned files alone. If `~/.claude/skills/` or `~/.claude/hooks/` already contains something with the same name as a shipped file (and it's not byte-identical), install **refuses** and lists the conflicts. Re-run with `--force` to back them up to `~/.claude/.user-backup-<timestamp>/` before overwriting.

Your own skills with different names (e.g. `my-company-skill/`) are always preserved.

---

## Updates

```
You: update dev
Claude: [pulls latest, re-syncs skills/hooks/agents] Updated to v7.2
```

Or from the shell:

```bash
update-dev
```

---

## Commands

| Say | Does |
|-----|------|
| `brainstorm` | Scan codebase + live site, propose improvements |
| `brainstorm apply` | Create stories from the last brainstorm |
| `auto` | Work through all pending stories autonomously |
| `iterate` | Convergence loop: brainstorm → fix → re-scan until clean |
| `audit` | 7-agent parallel quality audit |
| `review` | Code quality check (add `quick` or `deep`) |
| `ship` | Build, test, review, deploy, verify |
| `scan` / `qa` | Live site QA (visual + a11y + console) |
| `fix` | Debug issues |
| `commit` | Conventional commit + push + PR |
| `test` | Unit + browser tests |
| `security` | Pre-deploy security scan |
| `perf` | Core Web Vitals audit |
| `a11y` | WCAG 2.1 AA audit |
| `design` / `ui` | UI design with anti-slop checklist |
| `progress` | Show sprint progress |
| `sprint` | Create/advance sprint |
| `update dev` | Sync latest from GitHub |

See [`skills/commands.md`](skills/commands.md) for the full list.

**Quick fixes — skip the ceremony.** For small tasks, just describe what you want. No `auto`, no sprints, no `prd.json`:

```
fix the button overflow on mobile
add loading state to the dashboard
```

---

## Workflow

```
brainstorm → scans codebase + live site, proposes improvements
auto       → implements all pending stories + visual verification
ship       → review + security + deploy + post-deploy scan
iterate    → brainstorm → fix → re-scan loop until clean
```

**Visual verification.** Start your dev server before `auto`. Claude screenshots pages (desktop + mobile) after each UI change and catches console errors before marking tasks complete.

**Image auto-scan.** Attach a screenshot to any turn and Claude surfaces every distinct issue it sees, not only the one you asked about. Add `[focus]` in your message to opt out.

---

## Files

**Global** (`~/.claude/`):
```
skills/                     # 36 skills (copied from repo)
hooks/                      # 6 hooks
agents/                     # 4 specialized agents
rules/                      # Workflow/security/design rules (only with --full)
settings.json               # Merged with your existing settings (only with --full)
repo-path.txt               # Points to your clone location
.auto-dev-installed.json    # Install sidecar — what this install put on disk
```

**Per project:**
```
prd.json       # Tasks and sprint history
```

Tasks use `passes: null` (pending), `true` (done), or `"deferred"`.

---

## Uninstall

```bash
# Mac/Linux
cd ~/claude-auto-dev && ./uninstall.sh

# Windows (PowerShell)
cd $env:USERPROFILE\claude-auto-dev; .\uninstall.ps1

# Preview first (no changes)
./uninstall.sh --dry-run        # or: .\uninstall.ps1 -DryRun
```

Uninstall reads `.auto-dev-installed.json` and removes exactly what this install created. Your own skills, hooks, agents, and user-modified rules stay. It strips auto-dev hook entries from `~/.claude/settings.json` without touching other entries, then deletes the sidecar and `repo-path.txt`.

**Manual step:** remove the `update-dev` function from your shell profile (`~/.bashrc`, `~/.zshrc`, or the PowerShell profile) if you don't want it anymore.

---

## Troubleshooting

**Install refuses with "REFUSING TO OVERWRITE".** You have a file or directory with the same name as something we ship, and it's not byte-identical to ours. Either rename yours or re-run with `--force` (which backs yours up first).

**Not seeing updates?** Check `~/.claude/repo-path.txt` points to your clone. Manual fallback: `cd ~/claude-auto-dev && git pull && update-dev`.

**Skills not loading?** Verify `~/.claude/skills/` exists and contains skill directories. Restart your terminal after install.

**Hook errors?** Requires Node.js 18+. Check with `node -v`. Hooks fail silently by design — run `node validate.js` to check consistency.

---

## License

MIT
