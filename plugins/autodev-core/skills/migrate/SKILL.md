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
| `migrate all` | Update authorized patch + minor candidates |
| `migrate react` | Update specific package |
| `upgrade` | Same as migrate |
| `outdated` | Just show outdated deps, no changes |

## Step 1: Audit Current State

Read the lockfile, package manager and actual project gate first. For npm,
capture `npm outdated --json` and `npm audit --json` with their real exit status
and full output. An outdated/vulnerability result can be nonzero; distinguish
that result from network, authentication or malformed-output failure. Missing
metadata is unknown, not zero vulnerabilities. Do not silence stderr or use
`|| true` as the verdict.

Record dependency populations and exact installed/requested versions before
changing them. Consult the package's official version-specific migration notes.

## Step 2: Classify Updates

Sort all outdated packages into safety tiers:

| Tier | Type | Action |
|------|------|--------|
| **Candidate** | Patch updates (1.2.3 → 1.2.4) | Update within the authorized scope, then verify |
| **Candidate** | Minor updates (1.2.3 → 1.3.0) | Update within the authorized scope, then verify |
| **Review** | Major updates (1.x → 2.x) | Check changelog for breaking changes |
| **Critical** | Security vulnerabilities | Prioritize regardless of version jump |
| **Skip** | Pinned for a reason | Check if pin reason still applies |

## Step 3: Patch and minor candidates

The following all-package example applies only to `migrate all`. For a named
package, restrict the update to that package and its required compatible peers;
inspect the package-manager diff before installing. Do not use an all-dependency
command for a targeted request.

```bash
# Update all authorized patch and minor candidates
npx npm-check-updates -u --target minor
npm install

# Verify nothing broke
npm run typecheck
npm run build
npm test
# Use these only if they are the actual project scripts; retain each exit status.
# An absent test suite is a verification gap, not a pass.
```

Patch/minor labels are compatibility intent, not a safety guarantee. If a check
fails, preserve its output, restore only this attempt's dependency edits, and
isolate the responsible package. Do not discard unrelated work. Run the actual
project gate and affected runtime flows before calling the migration complete.

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
   npm run typecheck
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
- [N] patch updates (verified scope named)
- [N] minor updates (verified scope named)
- [N] major updates (breaking changes resolved)
- [N] security fixes

Skipped: [N] packages
- [package]: pinned at X.Y.Z because [reason]

Vulnerabilities: [before] → [after]

Checks: [actual commands, exit statuses and observed scope; missing checks named]
```

## Rules

- Never update all major versions at once — one at a time
- Always run typecheck + build + tests after each update
- Commit patch/minor updates together, major updates separately
- If a major update breaks things and the fix isn't obvious, defer it and note why
- Check if lockfile (package-lock.json) is committed — if yes, commit the updated lockfile too
