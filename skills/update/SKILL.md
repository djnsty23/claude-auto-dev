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

**IMPORTANT:** Always use bash commands (works in Git Bash and Mac/Linux). Never use cmd or PowerShell syntax — Claude Code runs bash.

### Step 1: Find repo and pull

```bash
REPO=$(cat ~/.claude/repo-path.txt 2>/dev/null | tr -d '\r\n')

# If no repo-path.txt, clone to temp
if [ -z "$REPO" ] || [ ! -d "$REPO" ]; then
  REPO=/tmp/claude-auto-dev
  rm -rf "$REPO"
  gh repo clone djnsty23/claude-auto-dev "$REPO"
fi

cd "$REPO" && git pull
VERSION=$(cat VERSION)
```

### Step 2: Sync files (cp -r works everywhere including Git Bash)

```bash
DEST="$HOME/.claude"

# Skills (includes commands.md)
cp -r "$REPO/skills/"* "$DEST/skills/"

# Hooks
cp "$REPO/hooks/"* "$DEST/hooks/"

# Rules (add/update only, no delete)
cp "$REPO/config/rules/"* "$DEST/rules/" 2>/dev/null

# Settings (hooks config + security deny rules)
# Detect OS for correct settings file
if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" || -n "$WINDIR" ]]; then
  cp "$REPO/config/settings.json" "$DEST/settings.json"
else
  cp "$REPO/config/settings-unix.json" "$DEST/settings.json"
fi
```

### Step 3: Report

```
[Update] Now at v{VERSION}
[Update] Skills: synced
[Update] Hooks: synced
[Update] Settings: synced
```

### Step 4: Cleanup (if cloned to temp)

```bash
[ "$REPO" = "/tmp/claude-auto-dev" ] && rm -rf "$REPO"
```

## What Gets Synced

| Source | Destination | Mode |
|--------|-------------|------|
| `repo/skills/` | `~/.claude/skills/` | Copy (overwrite) |
| `repo/hooks/` | `~/.claude/hooks/` | Copy (overwrite) |
| `repo/config/rules/` | `~/.claude/rules/` | Copy (add/update only, no delete) |
| `repo/config/settings.json` | `~/.claude/settings.json` | Overwrite (security-critical) |

Note: `commands.md` lives inside `skills/` — it syncs automatically with skills.

## What Does NOT Get Synced

- `~/.claude/CLAUDE.md` - User instructions, never touched (uses @include for commands.md)

## Execution

When user says "update dev":

1. Find repo via `~/.claude/repo-path.txt` or clone from GitHub
2. Pull latest
3. Copy skills/ and hooks/ (cp -r, works in Git Bash + Mac/Linux)
4. Copy rules/ (add/update only)
5. Overwrite settings.json (hooks config + security deny rules)
6. Report version
7. Clean up temp clone if used
