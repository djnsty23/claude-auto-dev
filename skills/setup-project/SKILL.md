---
name: setup-project
description: Scaffolds new projects or onboards existing ones. Detects stack, creates monorepo/single-app, configures strict tooling. Use for greenfield or first-time setup.
triggers:
  - setup project
  - scaffold
  - new project
  - init project
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent, AskUserQuestion
model: opus
user-invocable: true
---

# Setup Project

## Mode Detection

Check the working directory:
- **No package.json** or user says "new/create project" → **Create mode**
- **Existing package.json** → **Onboard mode**

---

## Create Mode (Greenfield)

### Step 1: Gather Requirements

Infer from user description, or ask if unclear:

1. **Project type**: SaaS, e-commerce, marketing, API, library/CLI, full-stack app
2. **Structure**: monorepo (multiple packages) or single-app
3. **Services**: Supabase, Stripe, Trigger.dev, Sentry, PostHog, Resend, R2, etc.

If the user said "build a SaaS with Supabase and Stripe" — infer all three, don't ask.

### Step 2: Scaffold

#### Single-app

```bash
pnpm create next-app . --typescript --tailwind --app --src-dir --use-pnpm --skip-install
```

Then remove ESLint artifacts (we use Biome): delete `eslint.config.mjs`, remove `eslint`/`eslint-config-next` from devDeps.

#### Monorepo

Do NOT use create-next-app for the root. Scaffold manually:

```
project/
├── pnpm-workspace.yaml
├── package.json            # root: orchestration only
├── tsconfig.base.json      # shared compiler options
├── tsconfig.json           # solution-style references
├── biome.json
├── .npmrc
├── .gitattributes
├── .gitignore
├── packages/
│   ├── engine/             # shared types + logic
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/index.ts
│   └── web/                # Next.js app
│       ├── package.json
│       ├── tsconfig.json
│       └── src/app/
└── [optional: cli/, trigger/, supabase/]
```

**pnpm-workspace.yaml:**
```yaml
packages:
  - 'packages/*'
onlyBuiltDependencies:
  - sharp
  - unrs-resolver
  - esbuild
```

**Root package.json** — orchestration scripts only:
```json
{
  "private": true,
  "packageManager": "pnpm@10.8.0",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "pnpm -r run build",
    "dev": "pnpm -r --parallel run dev",
    "typecheck": "pnpm -r run typecheck",
    "lint": "biome check .",
    "format": "biome check --write .",
    "preinstall": "npx only-allow pnpm"
  },
  "devDependencies": {
    "@biomejs/biome": "^2.4.0",
    "typescript": "^5.8.0"
  }
}
```

For the web package, use create-next-app into `packages/web/` then clean up (remove .git, .gitignore, README, ESLint config).

**Shared package** (e.g., `packages/engine`):
```json
{
  "name": "@<project>/engine",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" }
  },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit"
  }
}
```

Consumer references: `"@<project>/engine": "workspace:*"`.

### Step 3: Configure Tooling

#### TypeScript — maximum strictness

Start from Next.js defaults, add these flags to every tsconfig:
```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitReturns": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

For monorepos: `tsconfig.base.json` at root with shared options (target ES2022, module ESNext, moduleResolution bundler, composite true). Per-package configs extend it. Root `tsconfig.json` is solution-style: `"files": []` with `"references"` only.

Prefer TS 5.8 over TS 6 — TS 6 released March 2026, ecosystem support still uncertain.

#### Biome — replaces ESLint + Prettier

```json
{
  "$schema": "https://biomejs.dev/schemas/2.4.10/schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "formatter": { "indentStyle": "space", "indentWidth": 2, "lineWidth": 100 },
  "linter": {
    "rules": {
      "recommended": true,
      "correctness": { "noUnusedImports": "error", "noUnusedVariables": "error" },
      "style": { "noNonNullAssertion": "error", "useImportType": "error" },
      "suspicious": { "noExplicitAny": "error" }
    }
  },
  "javascript": { "formatter": { "quoteStyle": "double", "semicolons": "always" } },
  "files": {
    "includes": ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.mjs", "**/*.json"],
    "ignore": ["**/dist", "**/node_modules", "**/.next", "**/coverage", "**/*.css"]
  }
}
```

Exclude `**/*.css` — Biome cannot parse Tailwind v4 `@theme` syntax.

#### shadcn/ui v4

After `pnpm install`:
```bash
pnpm dlx shadcn@latest init --defaults --force
pnpm dlx shadcn@latest add button input card badge --yes
```

For monorepos, run from the web package directory.

shadcn v4 defaults: `base-nova` style, Base UI primitives, `oklch()` colors, Tailwind v4 CSS variables. No `tailwind.config.ts` needed.

#### .gitattributes — always create (cross-platform essential)

```
* text=auto
*.ts text eol=lf
*.tsx text eol=lf
*.js text eol=lf
*.mjs text eol=lf
*.json text eol=lf
*.css text eol=lf
*.md text eol=lf
*.yaml text eol=lf
*.yml text eol=lf
*.sql text eol=lf
*.sh text eol=lf
*.cmd text eol=crlf
*.bat text eol=crlf
*.ps1 text eol=crlf
*.png binary
*.jpg binary
*.ico binary
*.woff2 binary
pnpm-lock.yaml -diff
```

#### .gitignore additions (beyond create-next-app)

Ensure these entries exist:
```
.env
.env.*
!.env.example
supabase/.branches
supabase/.temp
.turbo/
.claude/
*.tsbuildinfo
```

#### .npmrc

```ini
strict-peer-dependencies=false
auto-install-peers=true
```

### Step 4: Install and Verify

```bash
pnpm install
pnpm typecheck       # must pass clean
pnpm run build       # must pass clean
pnpm run lint        # biome check must pass clean
```

Fix any issues before proceeding. Auto-fix Biome lint: `biome check --write .`

### Step 5: Generate CLAUDE.md

Read real project state with Read and Glob tools (not `node -e` one-liners). Include:

- Project name + one-line description
- Stack (from actual deps: "Next.js 15 + Tailwind 4 + shadcn v4 + Supabase + Biome")
- Every script from all package.json files
- Key directories (from file tree)
- Environment variables (from .env.example)
- Test runner (whatever is installed)

If CLAUDE.md already exists, merge new info — don't overwrite.

### Step 6: Environment Setup

Create `.env.example` with variables for detected/requested services:

| Service | Variables |
|---------|-----------|
| Supabase | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` |
| Stripe | `STRIPE_SECRET_KEY`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` |
| Trigger.dev | `TRIGGER_SECRET_KEY`, `TRIGGER_API_URL` |
| Sentry | `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_AUTH_TOKEN` |
| PostHog | `NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_POSTHOG_HOST` |
| Resend | `RESEND_API_KEY` |
| R2 | `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_ENDPOINT` |
| App | `NEXT_PUBLIC_APP_URL` |

### Step 7: Create prd.json (only if user has a plan)

If the user described features or provided a plan:
- Parse into real stories with acceptance criteria
- Group into sprints (5-8 stories, max 40 points)
- Follow the core skill's story format

Do NOT generate generic starters ("Auth flow", "Dashboard layout"). If there is no plan, skip prd.json entirely.

### Step 8: Git Init + First Commit

If not already a git repo:
```bash
git init
git add -A
git commit -m "feat: initial project scaffold"
```

### Step 9: Report

```
Project created:
- Structure: [monorepo/single-app] with [N] packages
- Stack: [detected]
- Tooling: Biome 2.4 (strict), TS 5.8 (strict + noUncheckedIndexedAccess)
- Components: shadcn v4 (base-nova, oklch)
- CLAUDE.md: Created
- .env.example: [N] services configured
- [prd.json: N stories in sprint 1] (if created)

All checks pass: typecheck, build, lint

Say 'auto' to start working, or describe what to build next.
```

---

## Onboard Mode (Existing Project)

### Step 1: Stack Detection

Read package.json dependencies and scan for config files using Read and Glob.

**Dependency signals:**

| Signal | Packages |
|--------|----------|
| Framework | next, react, vue, svelte, express, fastify, remix, astro, solid |
| CSS | tailwindcss, styled-components, @emotion/react |
| Database | @supabase/supabase-js, prisma, drizzle-orm, mongoose |
| Auth | next-auth, @supabase/ssr, @auth/core, passport |
| Payments | stripe, @stripe/stripe-js |
| Jobs | @trigger.dev/sdk |
| Monitoring | @sentry/nextjs, posthog-js |
| Testing | vitest, jest, @playwright/test, cypress |
| Linting | @biomejs/biome, eslint |
| Video | remotion |

**Config file signals:**

| File | Indicates |
|------|-----------|
| `pnpm-workspace.yaml` / `turbo.json` | Monorepo |
| `vercel.json` / `.vercel/` | Vercel |
| `supabase/` | Supabase |
| `.github/workflows/` | CI/CD |
| `biome.json` | Biome |
| `components.json` | shadcn/ui |

### Step 2: Generate CLAUDE.md

Same as Create mode Step 5. Read real project state, generate from actual data.

### Step 3: Recommend Skills

**Always:** review, commit, fix

**Conditional:**

| If Detected | Recommend |
|-------------|-----------|
| @supabase/* | supabase |
| stripe | stripe |
| next | perf, seo |
| tailwindcss | design |
| vercel.json | deploy |
| playwright/cypress | test, agent-browser |
| remotion | remotion |
| @sentry/nextjs | monitoring |
| Any auth | security |

### Step 4: Check for Gaps

- `.env.example` missing → create it
- `.gitignore` missing `.claude/`, `.env` → add entries
- `.gitattributes` missing → create it
- TypeScript missing `noUncheckedIndexedAccess` → suggest enabling
- No linter → suggest Biome
- `.claude/agent-memory/` missing → create it (audit and brainstorm will seed the files themselves on first run)

### Step 5: Report

```
Project onboarded:
- Stack: [detected]
- CLAUDE.md: Created/Updated
- Gaps fixed: [list]
- Recommended skills: [list]

Say 'auto' to start working, or describe what to build.
```

### Step 6: Recommend Context7 MCP (optional)

Check if Context7 tools are already available (`mcp__plugin_context7_context7__*`). If not, suggest installing:

```
Context7 MCP — real-time library docs for migrate/fix (optional but recommended):
  npx ctx7 setup --claude
```

claude-auto-dev skills (migrate, fix) will use Context7 automatically when available.

---

## Version Defaults (updated April 2026)

Safe choices for greenfield projects. Pin with caret ranges.

| Package | Version | Risk |
|---------|---------|------|
| next | ^15.3 | Stable. 16 available but 15 is battle-tested |
| react / react-dom | ^19.2 | Mature |
| typescript | ^5.8 | Safe. TS 6 too fresh (March 2026) |
| tailwindcss | ^4.2 | Stable v4, uses @theme not config file |
| @biomejs/biome | ^2.4 | Stable. Exclude CSS (Tailwind v4) |
| @supabase/supabase-js | ^2.101 | Mature v2 |
| @supabase/ssr | ^0.10 | Pre-1.0 but stable API |
| zod | ^3.24 | Safe. v4 available but ecosystem on v3 |
| shadcn CLI | ^4.1 | Requires Tailwind v4 |
| pnpm | 10.x | Set in packageManager field |
| vitest | ^4.1 | Stable |
| @playwright/test | ^1.59 | Stable v1 |
| stripe (Node) | ^21.x | v22 too fresh (April 2026) |
| lucide-react | ^1.7 | Stable |
| @trigger.dev/sdk | ^4.4 | Stable v4 |
| drizzle-orm | ^0.45 | Pre-1.0, pin exact minor |
| @sentry/nextjs | ^10.47 | Stable v10 |
| posthog-js | ^1.364 | Stable v1 |
