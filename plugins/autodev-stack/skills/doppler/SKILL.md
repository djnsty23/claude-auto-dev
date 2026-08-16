---
name: doppler
description: Manage environment variables with Doppler — auto-install CLI, login, link projects, wrap commands with `doppler run`. Replaces scattered .env files with a hub/spoke architecture.
when_to_use: "Invoked when the user says \"doppler\", \"setup doppler\", \"add doppler\", \"env to doppler\", \"migrate env\"."
allowed-tools: Bash, Read, Write, Edit, Grep, Glob
model: opus
user-invocable: true
argument-hint: "[setup|link|run|migrate|rotate]"
---

# Doppler — Env Var Management

Centralize secrets across projects. Rotate once, propagates everywhere.

## When to use

- Project has `.env.local` / `.env.vercel` with 5+ secrets
- Secrets are reused across multiple projects (API keys, OAuth creds)
- Fresh Windows install — need to restore env vars fast

## Prereqs (auto-check before any action)

```bash
# 1. CLI installed?
doppler --version 2>&1 | head -1
# If not: winget install doppler.doppler  (Windows)
# OR: brew install dopplerhq/cli/doppler  (macOS)

# 2. Logged in?
doppler me 2>&1 | head -3
# If "Doppler Error: you must provide a token" → run `doppler login` (browser flow, user does this)

# 3. Inside a linked repo?
test -f doppler.yaml && echo "linked: $(cat doppler.yaml | grep project | awk '{print $2}')" || echo "not linked"
```

Do not proceed if any prereq fails. Tell the user exactly what to run.

## Architecture — hub/spoke on Developer plan

**Free tier caps at 10 projects.** Plan for this — consolidate with branch configs.

```
Hubs (secrets live here):
  ai-keys/prd       — shared LLM/API keys (Gemini, OpenAI, Anthropic, Perplexity, Resend)
  accounts/prd      — shared passwords + gmail aliases
  stripe            — dev config (test mode), prd config (live mode)
  supabase          — 1 branch config per Supabase project: prd_<name>

Spokes (one Doppler project per app):
  app-<name>/prd    — values are ${ref://hub.config.KEY} cross-project references
```

**Cross-project refs** (`${project.config.SECRET}`) work on Developer plan. Verified.

## Commands

### `doppler` or `setup doppler` (interactive)

1. Run prereq checks above. Guide user to fix issues before continuing.
2. If no `doppler.yaml` in current repo → link it:
   ```bash
   # Check if a project exists for this repo
   PROJECT_NAME="app-$(basename $(pwd) | tr '[:upper:]' '[:lower:]' | tr '._' '--')"
   doppler projects --json | python -c "import sys,json; names=[p['name'] for p in json.load(sys.stdin)]; print('exists' if '$PROJECT_NAME' in names else 'missing')"
   ```
3. If project missing, check the 10-project quota before creating:
   ```bash
   COUNT=$(doppler projects --json | python -c "import sys,json; print(len(json.load(sys.stdin)))")
   # If COUNT >= 10: tell user they must delete a project or consolidate before proceeding
   ```
4. If space available, create the project:
   ```bash
   doppler projects create --name "$PROJECT_NAME" --description "App spoke"
   ```
5. Upload existing env values:
   ```bash
   # Find best file
   for f in .env.local .env.vercel .env; do
     [ -f "$f" ] && ENV_FILE="$f" && break
   done
   doppler secrets upload "$ENV_FILE" --project "$PROJECT_NAME" --config prd
   ```
6. Write `doppler.yaml`:
   ```yaml
   setup:
     project: app-<name>
     config: prd
   ```
7. Smoke test:
   ```bash
   doppler run -- node -e "console.log(Object.keys(process.env).filter(k => !k.startsWith('DOPPLER_')).length, 'vars injected')"
   ```

### `doppler migrate` (move secrets from .env to Doppler)

For a repo that already has `doppler.yaml`:

```bash
ENV_FILE=$(for f in .env.local .env.vercel .env; do [ -f "$f" ] && echo "$f" && break; done)
doppler secrets upload "$ENV_FILE" --project app-<name> --config prd
# Verify
doppler run -- printenv | grep -v '^DOPPLER_' | wc -l
# If verified good, DO NOT delete the .env file yet — user decides
```

Never auto-delete `.env.local`. User confirms after testing.

### `doppler rotate <KEY> <NEW_VALUE>`

For a key in a hub:
```bash
doppler secrets set "<KEY>=<NEW_VALUE>" --project <hub-project> --config <config>
```

All spoke apps that use `${<hub>.<config>.<KEY>}` get the new value on next `doppler run`. No per-app edits.

### `doppler run` wrapping

If `doppler.yaml` exists in the current working directory:
- Wrap all dev/build/test commands: `doppler run -- <cmd>`
- Alternatively, add `doppler run --` prefix to npm scripts in `package.json`:
  ```json
  {
    "scripts": {
      "dev": "doppler run -- next dev",
      "build": "doppler run -- next build",
      "start": "doppler run -- next start"
    }
  }
  ```

Do not double-wrap if the script already starts with `doppler run`.

## Extracting shared secrets to hubs

When you find the same secret across 2+ apps, move it to a hub and replace with `${ref://...}` — load `references/extract-to-hub.md` for the exact commands (shared API keys → `ai-keys`, Supabase creds → `supabase.prd_<name>` branch configs, safety rules around shell-variable handling).

## Install CLI (platform-aware)

```bash
case "$OSTYPE" in
  msys*|cygwin*|win32*)
    winget install doppler.doppler --accept-source-agreements --accept-package-agreements --silent
    ;;
  darwin*)
    brew install dopplerhq/cli/doppler
    ;;
  linux*)
    curl -Ls --tlsv1.2 --proto "=https" --retry 3 https://cli.doppler.com/install.sh | sh
    ;;
esac
```

After install, **new shells need the PATH update**. For Windows, the CLI lives at `$APPDATA\Local\Microsoft\WinGet\Packages\Doppler.doppler_*/doppler.exe` — may need full-path invocation in the same shell that ran winget.

## Login flow

```bash
doppler login
# Browser opens → authorize → paste code
# Git Bash bug: use `winpty doppler login` on Windows if using Git Bash
```

**Claude cannot run `doppler login` autonomously** — browser OAuth requires the user. Always direct them to run it in their terminal.

## Backup your Doppler structure

Export all projects + secrets to encrypted JSON for disaster recovery:

```bash
mkdir -p ~/claude-backups/doppler-$(date +%Y-%m-%d)
cd ~/claude-backups/doppler-$(date +%Y-%m-%d)
doppler projects --json > projects.json
for p in $(doppler projects --json | python -c "import sys,json; [print(p['id']) for p in json.load(sys.stdin)]"); do
  for c in $(doppler configs --project "$p" --json | python -c "import sys,json; [print(x['name']) for x in json.load(sys.stdin)]"); do
    doppler secrets download --project "$p" --config "$c" --format env --no-file > "${p}__${c}.env" 2>/dev/null
  done
done
# Encrypt the backup
tar -czf doppler-backup.tar.gz *.env projects.json
rm *.env projects.json
# Move tar.gz to your cloud drive (OneDrive/iCloud)
```

Only do this when rotating keys or before major changes. Doppler's own activity log handles most recovery needs.

## Integration with auto-dev skills

- `setup-project` — offers Doppler during onboard when `.env.local` has 3+ vars
- `env-vars` — treats Doppler as the default pattern
- `auto` — detects `doppler.yaml` and wraps dev/build/test commands automatically
- `deploy` — uses `doppler secrets download --format docker --no-file` for CI/CD

## Rules

- **Never log secret values.** Use `--plain` only to pipe into `set`, never to echo/print.
- **Cap at 10 projects** (Developer plan limit). Consolidate with branch configs when approaching the cap.
- **Don't auto-delete .env.local** — always after user-verified `doppler run` smoke test.
- **Commit `doppler.yaml`** — it's safe (project name + config only, no secrets).
- **`.gitignore` all `.env*`** except `.env.example` and `.env.template`.
- **Rotation flow uses refs** — update in hub, all spokes see the new value on next `doppler run`.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `doppler: command not found` | Install per platform (see above) + restart shell for PATH |
| `you must provide a token` | `doppler login` (browser flow) |
| `you must specify a project` | `doppler setup` in repo OR create `doppler.yaml` |
| `your workplace has reached its limit of 10 projects` | Delete a project OR consolidate with branch configs |
| Ref doesn't resolve | Check spelling: `${project.config.KEY}` exactly. Hub project must exist, config must exist, key must exist |
| Values missing after `doppler run` | Check the app's config has that key: `doppler secrets --project app-X --config prd` |
