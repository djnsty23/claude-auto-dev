---
name: setup-project
description: Scaffolds new projects or onboards existing ones. Detects stack, creates monorepo/single-app, configures strict tooling. Use for greenfield or first-time setup.
when_to_use: "Invoked when the user says \"setup project\", \"scaffold\", \"new project\", \"init project\"."
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent, AskUserQuestion
model: opus
user-invocable: true
---

# Setup Project

> **Browser access.** Prefer the built-in browser tools (`mcp__Claude_Browser__*`)
> when the session has them — that is the default in the desktop app. The
> `agent-browser` commands below are the terminal-only fallback. The `browser`
> skill owns the driver-selection rule; follow it before running either.

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

**Single-app:**
```bash
pnpm create next-app . --typescript --tailwind --app --src-dir --use-pnpm --skip-install
```
Then delete `eslint.config.mjs` and remove `eslint` / `eslint-config-next` from devDeps — we use Biome.

**Monorepo:** load `references/monorepo-scaffold.md` for the full directory layout, `pnpm-workspace.yaml`, root `package.json`, and shared-package `package.json` templates. Run `pnpm create next-app` into `packages/web/` and clean up the nested `.git` / `.gitignore` / README / ESLint config.

### Step 3: Configure Tooling

Load `references/tooling-config.md` — it has the ready-to-paste templates for TypeScript (strict with `noUncheckedIndexedAccess` et al.), Biome (replaces ESLint + Prettier, excludes CSS for Tailwind v4), shadcn/ui v4, `.gitattributes` (cross-platform EOLs), `.gitignore` additions beyond create-next-app, and `.npmrc`.

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
- `.env.local` has 3+ vars AND no `doppler.yaml` → offer to migrate to Doppler via the `doppler` skill (hub/spoke pattern, rotate once = propagate everywhere)

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

## Version Defaults

Load `references/version-defaults.md` for the pinned safe-version table (Next 15.3, React 19.2, TS 5.8, Tailwind 4.2, Biome 2.4, Supabase 2.101 / SSR 0.10, Zod 3.24, shadcn 4.1, pnpm 10.x, Vitest 4.1, Playwright 1.59, Stripe 21.x, Sentry 10.47, PostHog 1.364, Trigger.dev 4.4, Drizzle 0.45, lucide-react 1.7). Updated April 2026.
