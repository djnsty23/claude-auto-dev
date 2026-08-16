---
name: memory-backup
description: Backs up auto-memory files to a private GitHub repo. One-command setup, committed daily via Task Scheduler (or on-demand). Restore is a single clone.
when_to_use: "Invoked when the user says \"memory backup\", \"backup memory\", \"restore memory\"."
allowed-tools: Bash, Read, Write, Edit, Glob
model: opus
user-invocable: true
argument-hint: "[setup|now|restore|status]"
---

# Memory Backup

Version-controlled snapshot of `~/.claude/projects/*/memory/` in a private GitHub repo. Survives Windows reinstalls, gives you `git diff` on your agent memory over time.

## What gets backed up

ONLY:
- `~/.claude/projects/*/memory/*.md` — auto-memory, feedback files, project notes
- `~/.claude/CLAUDE.md` — global user config (if present)
- `~/.claude/rules/*.md` — shared rules

NOT:
- `~/.claude/projects/*/sessions/` — session JSONL (huge, ephemeral)
- `~/.claude/projects/*/tasks/` — native tasks (per-session, ephemeral)
- Installed plugin files — reinstallable from the marketplace, never user data
- `~/.claude/settings.json` — may contain machine-specific paths and secrets

## Setup (one-time per machine)

```bash
# 1. Create the private repo
gh repo create $(gh api user --jq .login)/claude-memory --private --description "Auto-memory backups (claude-auto-dev)" --clone --add-readme
cd claude-memory

# 2. Initial snapshot
mkdir -p memory rules
cp -r ~/.claude/projects memory/projects-raw  # we'll filter next
# Keep only memory/ subdirs, drop everything else
find memory/projects-raw -mindepth 2 -maxdepth 2 -type d ! -name memory -exec rm -rf {} +
# Flatten: projects/<slug>/memory/*.md → projects/<slug>/*.md
# (keeping slug as dir so we know which project)
mv memory/projects-raw memory/projects
cp ~/.claude/CLAUDE.md . 2>/dev/null || true
cp -r ~/.claude/rules . 2>/dev/null || true

# 3. Commit
git add .
git commit -m "feat: initial memory snapshot"
git push -u origin main

# 4. Save repo path for future runs
echo "$(pwd)" > ~/.claude/.memory-backup-path
```

Report the repo URL. User should bookmark it.

## `memory backup now` (on-demand sync)

```bash
BACKUP_DIR=$(cat ~/.claude/.memory-backup-path)
cd "$BACKUP_DIR"

# Refresh memory/ subtree
rm -rf memory/projects
mkdir -p memory/projects
for dir in ~/.claude/projects/*/; do
  slug=$(basename "$dir")
  if [ -d "$dir/memory" ]; then
    cp -r "$dir/memory" "memory/projects/$slug"
  fi
done

# Refresh top-level files
cp ~/.claude/CLAUDE.md . 2>/dev/null
rm -rf rules && cp -r ~/.claude/rules . 2>/dev/null

# Commit only if changed
if ! git diff --quiet || ! git diff --cached --quiet; then
  git add .
  git commit -m "backup: $(date +%Y-%m-%d\ %H:%M)"
  git push 2>&1 | tail -3
  echo "Backed up."
else
  echo "No changes since last backup."
fi
```

## `memory backup status`

```bash
BACKUP_DIR=$(cat ~/.claude/.memory-backup-path 2>/dev/null) || { echo "Not set up. Run 'memory backup setup'."; exit 0; }
cd "$BACKUP_DIR"
echo "Repo: $(git config --get remote.origin.url)"
echo "Last commit: $(git log -1 --format='%ar — %s')"
echo "Local memory dir timestamps:"
ls -la ~/.claude/projects/*/memory/*.md 2>/dev/null | awk '{print $NF, $6, $7, $8}' | sort | tail -10
```

## `memory restore`

After Windows reinstall, restore memory state in one command:

```bash
# Assumes you've already installed claude-auto-dev (hooks/skills/agents)
gh repo clone $(gh api user --jq .login)/claude-memory ~/claude-memory
cd ~/claude-memory

# Restore memory files
for dir in memory/projects/*/; do
  slug=$(basename "$dir")
  mkdir -p ~/.claude/projects/$slug/memory
  cp -r "$dir"/* ~/.claude/projects/$slug/memory/ 2>/dev/null
done

# Restore CLAUDE.md + rules
cp CLAUDE.md ~/.claude/CLAUDE.md 2>/dev/null
cp -r rules ~/.claude/ 2>/dev/null

# Save path for future backups
echo "$(pwd)" > ~/.claude/.memory-backup-path

echo "Restored. Memory loaded on next Claude session start."
```

## Automated daily backup (Windows Task Scheduler)

Create `~/claude-memory/backup.cmd`:
Write the `memory backup now` block above into `backup.sh` inside the backup
repo, then have the scheduled task call it. (Earlier versions of this skill
pointed the task at a `memory-backup.sh` in the global hooks directory that was
never shipped, so the scheduled task silently did nothing.)

```batch
@echo off
cd /d %USERPROFILE%\claude-memory
bash -c "./backup.sh"
```

Register task (runs at 11 PM daily):
```powershell
$action = New-ScheduledTaskAction -Execute "$env:USERPROFILE\claude-memory\backup.cmd"
$trigger = New-ScheduledTaskTrigger -Daily -At "23:00"
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd
Register-ScheduledTask -TaskName "ClaudeMemoryBackup" -Action $action -Trigger $trigger -Settings $settings -Description "Daily backup of ~/.claude/projects/*/memory/"
```

Verify it runs:
```powershell
Get-ScheduledTask -TaskName "ClaudeMemoryBackup" | Get-ScheduledTaskInfo
```

## Privacy notes

- Repo is **private** — only djnsty23 can access
- Memory files may contain project names, client info, architecture decisions
- Do NOT back up `~/.claude/secrets/` or anything under `~/.claude/projects/*/tasks/` — those can contain ephemeral sensitive state
- `.env` values never touch memory files (that's Doppler's job)

## Size expectations

- Initial backup: ~100-500KB (text only)
- After a year of daily commits: ~5-20MB repo size — well within GitHub limits
- If memory grows past 100MB, add `.gitattributes` LFS rule for files >10MB

## Integration with other skills

- `auto` — on session end (via Stop hook), fires background `memory backup now` if repo exists
- `iterate` — after convergence, commits the new learnings
- Post-reinstall: `setup-project` offers to restore memory first

## Rules

- **Private repo only** — never public
- **No secrets in memory files** — if Claude ever writes a token to memory, treat as incident and rotate
- **Don't backup sessions/** — huge, ephemeral, not worth the bytes
- **Restore before first session** on a fresh install — otherwise Claude starts cold
