---
name: migrate
description: Dependency updates, major version upgrades, and breaking change resolution. Use when updating packages or handling deprecations.
when_to_use: "Invoked when the user says \"migrate\", \"upgrade\", \"update deps\", \"outdated\"."
allowed-tools: Bash, Read, Write, Edit, Grep, Glob
model: opus
user-invocable: true
argument-hint: "[package name or 'all']"
---

# Migrate — Dependency Management

Safe dependency updates with breaking change detection and resolution.

## Usage

| Command | What It Does |
|---------|-------------|
| `migrate` | Check all outdated deps, suggest updates |
| `migrate all` | Update all safe deps (patch + minor) |
| `migrate react` | Update specific package |
| `upgrade` | Same as migrate |
| `outdated` | Just show outdated deps, no changes |

## Step 1: Audit Current State

```bash
# List outdated packages
npm outdated 2>/dev/null || true

# Check for known vulnerabilities
npm audit --json 2>/dev/null | node -e "const d=require('fs').readFileSync(0,'utf8');try{const a=JSON.parse(d);console.log('Vulnerabilities:',a.metadata?.vulnerabilities?.total||0)}catch{}"

# Current package counts
node -e "const p=require('./package.json');console.log('deps:',Object.keys(p.dependencies||{}).length,'devDeps:',Object.keys(p.devDependencies||{}).length)"
```

## Step 2: Classify Updates

Sort all outdated packages into safety tiers:

| Tier | Type | Action |
|------|------|--------|
| **Safe** | Patch updates (1.2.3 → 1.2.4) | Auto-update |
| **Safe** | Minor updates (1.2.3 → 1.3.0) | Auto-update |
| **Review** | Major updates (1.x → 2.x) | Check changelog for breaking changes |
| **Critical** | Security vulnerabilities | Prioritize regardless of version jump |
| **Skip** | Pinned for a reason | Check if pin reason still applies |

## Step 3: Safe Updates (Patch + Minor)

```bash
# Update all patch and minor versions
npx npm-check-updates -u --target minor
npm install

# Verify nothing broke
npm run typecheck 2>/dev/null
npm run build
npm test -- --passWithNoTests --watchAll=false 2>/dev/null
```

If any check fails, revert and update one package at a time to isolate the issue.

## Step 4: Major Updates (One at a Time)

For each major update:

1. **Read the changelog/migration guide:**
   ```bash
   # Check the package's release notes
   npm info [package] changelog 2>/dev/null || echo "Check GitHub releases"
   ```

   If `mcp__plugin_context7_context7__*` tools are available, prefer them over WebSearch for version-specific breaking changes:
   ```
   resolve-library-id({ libraryName: "Next.js", query: "migrating from 14 to 15" })
   query-docs({ libraryId: "/vercel/next.js/v15.3.0", query: "breaking changes from v14" })
   ```
   Context7 returns version-pinned docs, which avoids the common trap of applying stale migration advice from old blog posts.

2. **Update and test:**
   ```bash
   npm install [package]@latest
   npm run typecheck 2>/dev/null
   npm run build
   ```

3. **Fix breaking changes** — common patterns:
   | Breaking Change | How to Fix |
   |----------------|-----------|
   | API renamed | Find-and-replace old → new names |
   | Config format changed | Update config file to new schema |
   | Peer dep mismatch | Update related packages together |
   | Type signature changed | Update interfaces and type assertions |
   | Removed feature | Replace with recommended alternative |

4. **Commit separately** — one commit per major update for easy revert

## Step 5: Security Fixes

```bash
# Auto-fix what's safe
npm audit fix

# For breaking fixes that need major updates
npm audit fix --force --dry-run  # Preview first
```

Review `--force` changes before applying — they may introduce breaking changes.

## Step 6: Report

```
Dependency Migration
═══════════════════

Updated: [N] packages
- [N] patch updates (safe)
- [N] minor updates (safe)
- [N] major updates (breaking changes resolved)
- [N] security fixes

Skipped: [N] packages
- [package]: pinned at X.Y.Z because [reason]

Vulnerabilities: [before] → [after]

All checks pass: typecheck ✓ build ✓ tests ✓
```

## Rules

- Never update all major versions at once — one at a time
- Always run typecheck + build + tests after each update
- Commit patch/minor updates together, major updates separately
- If a major update breaks things and the fix isn't obvious, defer it and note why
- Check if lockfile (package-lock.json) is committed — if yes, commit the updated lockfile too
