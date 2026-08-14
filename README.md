# Claude Auto-Dev

[![Claude Code](https://img.shields.io/badge/Claude%20Code-Compatible-blueviolet)](https://claude.ai/code)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-7.6-blue.svg)](https://github.com/djnsty23/claude-auto-dev/releases)

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

---

## Full Environment Restore (post-reinstall / new machine)

**Use this section when:** fresh OS install, new dev machine, or onboarding to an existing claude-auto-dev setup.

### For humans (manual)

```powershell
# Windows — run in an admin PowerShell
# 1. Prereqs
winget install -e Git.Git OpenJS.NodeJS GitHub.cli Doppler.doppler Microsoft.VisualStudioCode

# 2. claude-auto-dev itself (this repo)
git clone https://github.com/djnsty23/claude-auto-dev $env:USERPROFILE\claude-auto-dev
cd $env:USERPROFILE\claude-auto-dev; .\install.ps1 -Full

# 3. Authenticate all services
gh auth login              # GitHub — browser flow
doppler login              # Doppler — browser flow
# claude login             # If Claude Code CLI installed separately

# 4. Restore personal memory + config (PRIVATE repo — requires gh auth from step 3)
#    This assumes you have a `claude-memory` private repo (see memory-backup skill)
gh repo clone <your-username>/claude-memory $env:USERPROFILE\claude-memory
cd $env:USERPROFILE\claude-memory
# Follow RECOVERY.md in that repo for the per-user restore
```

```bash
# Mac/Linux equivalent
brew install git node gh dopplerhq/cli/doppler
git clone https://github.com/djnsty23/claude-auto-dev ~/claude-auto-dev
cd ~/claude-auto-dev && ./install.sh --full
gh auth login
doppler login
gh repo clone <your-username>/claude-memory ~/claude-memory
cat ~/claude-memory/RECOVERY.md
```

### For Claude (you're reading this as the agent)

If the user points you at this repo post-reinstall and says "configure everything", walk this order — **stop and ask for authorization at each interactive step**:

1. **Detect OS + missing prereqs** — check for `git`, `node`, `gh`, `doppler`. Install any missing via the OS package manager (`winget` on Windows, `brew` on macOS, distro-appropriate on Linux).
2. **Verify `~/.claude/` install** — if this repo is cloned to `~/claude-auto-dev`, run `install.ps1 -Full` (Windows) or `install.sh --full` (Unix).
3. **Check `gh auth status`** — if broken, tell the user to run `gh auth login` in their terminal. DO NOT try to run the OAuth flow yourself (requires browser).
4. **Check `doppler me`** — if broken, tell the user to run `doppler login`. Same reason.
5. **Offer memory restore** — ask the user if they have a private `claude-memory` repo. If yes, `gh repo clone <user>/claude-memory ~/claude-memory`, then copy `memory/projects/*` into `~/.claude/projects/*/memory/`, copy `CLAUDE.md` to `~/.claude/CLAUDE.md`, copy `rules/` to `~/.claude/rules/`. Set `~/.claude/.memory-backup-path` to the restored path so future `memory backup now` calls work.
6. **Per-project `doppler setup`** — for each repo under `~/Downloads/code/` or `~/code/` that has a `doppler.yaml`, ensure the bind is live: `cd <repo> && doppler run -- node -e "console.log(Object.keys(process.env).length)"` should return a sensible number. If not, `doppler setup` manually.
7. **Report** — produce a checklist showing what's restored, what the user still needs to touch (e.g. rotating a stale token, reconnecting OneDrive).

**Never**:
- Autonomously run `gh auth login` or `doppler login` — they open browsers and block waiting on user input.
- Commit to any repo without the user having configured `git config user.email / user.name`.
- Restore secrets into local `.env` files — they belong in Doppler only.

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
Claude: [pulls latest, re-syncs skills/hooks/agents] Updated to v7.6
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
