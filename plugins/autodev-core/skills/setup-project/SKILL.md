---
name: setup-project
description: Scaffolds new projects or onboards existing ones. Detects stack, creates monorepo/single-app, configures strict tooling. Use for greenfield or first-time setup.
when_to_use: "Invoked when the user says \"setup project\", \"scaffold\", \"new project\", \"init project\"."
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent, AskUserQuestion, mcp__Claude_Browser__*
model: opus
user-invocable: true
---

# Setup Project

When setup changes behavior, verify it using tools actually exposed by the
running host and their current schemas. Resolve the browser driver before any
UI verification; a historical tool name or an opened browser window does not
establish a controllable verification channel.

## Mode Detection

Check the working directory:
- Inspect repository history, files, language manifests and the current request.
  A project without package.json may be an existing non-Node project.
- **Empty/new destination within the requested scope** → **Create mode**.
- **Existing project** → **Onboard mode**; preserve its stack and conventions
  unless the request authorizes a migration. Do not scaffold over existing work.

---

## Create Mode (Greenfield)

### Step 1: Gather Requirements

Infer from user description, or ask if unclear:

1. **Project type**: SaaS, e-commerce, marketing, API, library/CLI, full-stack app
2. **Structure**: monorepo (multiple packages) or single-app
3. **Services**: Supabase, Stripe, Trigger.dev, Sentry, PostHog, Resend, R2, etc.

If the user said "build a SaaS with Supabase and Stripe" — infer all three, don't ask.

### Step 2: Scaffold

For a new Next.js app with pnpm selected, first verify the scaffold CLI version
and flags from current official documentation, then run its equivalent of:

**Single-app:**
```bash
pnpm create next-app . --typescript --tailwind --app --src-dir --use-pnpm --skip-install
```
Use the selected project lint policy. Replace generated lint configuration only
when adopting Biome intentionally and its replacement checks cover the required
rules; preserve existing lint tooling during onboarding.

**Monorepo:** load `references/monorepo-scaffold.md` for the full directory layout, `pnpm-workspace.yaml`, root `package.json`, and shared-package `package.json` templates. Scaffold into the new `packages/web/` directory. Inspect generated files before
cleanup: transfer useful ignore rules and documentation; remove a nested git
directory only if this scaffold just created it and it has no work/history to
preserve. Existing nested repositories are not scaffolding debris.

### Step 3: Configure Tooling

Load `references/tooling-config.md` — it has templates for TypeScript, lint/formatting, components and git metadata.
Adapt them to the installed versions, selected stack and existing policy, then
validate their syntax with the actual tools. A template is not a verified config.

### Step 4: Install and Verify

Use the project's detected package manager and the scripts actually created by
scaffolding. Install dependencies, then run the required type, lint, build and
behavior checks with their real exit status preserved. Missing scripts are a
setup gap to resolve, not successful checks. Verify the smallest usable vertical
slice through its intended interface; UI changes require a browser flow.

Fix observed setup failures and rerun the affected checks. Restrict automatic
format/lint fixes to owned files and inspect the resulting diff.

### Step 5: Generate CLAUDE.md

Read real project state with Read and Glob tools (not `node -e` one-liners). Include:

- Project name + one-line description
- Stack and resolved versions from actual manifests/lockfile
- Every script from all package.json files
- Key directories (from file tree)
- Environment variables (from .env.example)
- Test runner (whatever is installed)

If CLAUDE.md already exists, merge new info — don't overwrite.

### Step 6: Environment Setup

Create `.env.example` with documented variable names and placeholder values for
detected/requested services. Confirm each name against the installed SDK and
project configuration; never copy live secrets into examples or reports:

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

Initialize git only when the requested destination is not already a repository.
Load `commit`: inspect generated/ignored files for secrets and unrelated work,
stage only explicit owned paths, review the staged diff, and write the commit
message to a file for `git commit -F`. A scaffold commit proves recoverability,
not completed product behavior. Follow the current mandate for any later publish.

### Step 9: Continue the Requested Outcome

Record what exists, the actual stack/tool versions, checks and outcomes, remaining
setup requirements and PRD scope. If the user requested a build, continue through
`auto` with the dependency-ready plan and appropriate verification. Do not require
another invocation of `auto` for work already authorized. If the request was only
to scaffold/onboard, finish with the usable setup and concrete remaining gaps.
Do not report unavailable checks as passed or service accounts as configured just
because `.env.example` contains their names.

---

## Onboard Mode (Existing Project)

### Step 1: Stack Detection

Read the existing language manifests, lockfiles and config files. The table below
is a Node/web example; use the equivalent actual tooling for another stack.

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

Load `review` and `commit` when their workflows are needed. For each conditional
capability below, check the current installed skill/tool catalog and use its
actual name. A package dependency does not prove the integration is available.

**Conditional:**

| If Detected | Recommend |
|-------------|-----------|
| @supabase/* | supabase |
| stripe | stripe |
| next | perf, seo |
| tailwindcss | design |
| vercel.json | ship plus the installed platform deployment skill |
| playwright/cypress | test |
| remotion | remotion |
| @sentry/nextjs | production-radar or the installed observability capability |
| Any auth | security |

### Step 4: Check for Gaps

- `.env.example` missing → create it
- Ignore secrets and ephemeral tool output according to `rule-file-organization`;
  preserve tracked acceptance evidence, durable queues and PRD archives. Do not
  introduce a blanket ignore that hides the only cross-session delivery record.
- `.gitattributes` missing → create it
- TypeScript missing `noUncheckedIndexedAccess` → suggest enabling
- No linter → suggest Biome
- `.claude/agent-memory/` missing → create it (audit and brainstorm will seed the files themselves on first run)
- `.env.local` has 3+ vars AND no `doppler.yaml` → offer to migrate to Doppler via the `doppler` skill (hub/spoke pattern, rotate once = propagate everywhere)

### Step 5: Continue or Report

Record the actual stack, documentation changes, gaps fixed and checks/results.
Continue any already authorized implementation using the existing PRD and `auto`.
A request only to onboard ends with the reviewable setup; unresolved credentials,
permissions or verification remain explicit with their owner and next action.

### Step 6: Documentation Tools (optional)

Use an available documentation connector when useful. If it is absent, use the
library's official documentation. Installation is not a prerequisite to ordinary
setup and a command remembered from another host is not evidence that an installer
is available or appropriate here. Follow the host's actual installation workflow
only when the user requested that integration.

---

## Version Defaults

Load `references/version-defaults.md` as a dated starting point, then verify the
selected versions and compatibility against official sources before scaffolding.
Keep existing lockfile versions when onboarding unless upgrading is in scope.
Record the resolved versions and successful install/build/behavior evidence;
this skill does not maintain a second independent version table.
