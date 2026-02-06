---
name: update
description: Updates claude-auto-dev to latest version. Syncs repo with ~/.claude.
triggers:
  - update dev
  - update auto-dev
  - update skills
  - sync skills
allowed-tools: Bash, Read, Write, Glob
model: haiku
user-invocable: true
---

# Update Claude Auto-Dev

Sync the local repo with ~/.claude installation.

## Process

**IMPORTANT:** Run this as a SINGLE bash command. Do not split into multiple Bash calls.

```bash
REPO=$(cat ~/.claude/repo-path.txt 2>/dev/null | tr -d '\r\n')
if [ -z "$REPO" ] || [ ! -d "$REPO" ]; then
  REPO=/tmp/claude-auto-dev
  rm -rf "$REPO"
  gh repo clone djnsty23/claude-auto-dev "$REPO"
fi
cd "$REPO" && git pull && bash "$REPO/scripts/update.sh" "$REPO"
```

That's it. The script handles copying skills, hooks, rules, settings, cleaning stale skills, and reporting the version.

If cloned to temp, clean up:
```bash
[ "$REPO" = "/tmp/claude-auto-dev" ] && rm -rf "$REPO"
```

## What Gets Synced

| Source | Destination | Mode |
|--------|-------------|------|
| `repo/skills/` | `~/.claude/skills/` | Copy + clean stale (manifest-based) |
| `repo/hooks/` | `~/.claude/hooks/` | Copy (overwrite) |
| `repo/config/rules/` | `~/.claude/rules/` | Copy (add/update only, no delete) |
| `repo/config/settings.json` | `~/.claude/settings.json` | Overwrite (security-critical) |

Note: `commands.md` lives inside `skills/` — it syncs automatically with skills.

## What Does NOT Get Synced

- `~/.claude/CLAUDE.md` - User instructions, never touched (uses @include for commands.md)
