---
name: setup-project
description: Initializes project with smart stack detection, skill recommendations, and standard config. Use when starting a new project.
triggers:
  - setup
  - scaffold
  - new-project
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
model: opus
user-invocable: true
---

# Setup Project Workflow

## On "set up" or "setup"

### Step 1: Stack Detection

Scan for dependency files and detect the project stack:

```
Check for: package.json, pyproject.toml, Cargo.toml, go.mod
```

**If package.json exists**, read dependencies and devDependencies to detect:

| Signal | Detection |
|--------|-----------|
| Framework | next, react, vue, svelte, express, fastify, remix, astro |
| CSS | tailwindcss, styled-components, @emotion/react |
| Database | @supabase/supabase-js, prisma, mongoose, drizzle-orm |
| Auth | next-auth, @supabase/auth-helpers, @auth/core, passport |
| Payments | stripe, @stripe/stripe-js, @stripe/react-stripe-js |
| Testing | vitest, jest, playwright, @playwright/test, cypress |
| Video | remotion, @remotion/cli |

**Also check for config files:**
- `vercel.json` or `.vercel/` -> Vercel deployment
- `netlify.toml` -> Netlify deployment
- `Dockerfile` -> Container deployment
- `supabase/` directory -> Supabase project
- `.github/workflows/` -> CI/CD pipelines

### Step 2: Project Type Classification

Based on detected signals + user description, classify the project:

| Type | Signals |
|------|---------|
| E-commerce | stripe + product pages or store |
| SaaS | auth + subscription/billing + dashboard |
| Marketing / Portfolio | static pages, SEO focus, no auth |
| API | express/fastify + no frontend framework |
| Full-stack app | framework + DB + auth |
| Library / CLI | no framework, bin field in package.json |

If unclear, ask:
```
question: "What best describes this project?"
options:
  - { label: "E-commerce", description: "Online store with payments" }
  - { label: "SaaS", description: "Subscription app with auth" }
  - { label: "Marketing site", description: "Landing pages, SEO focus" }
  - { label: "Full-stack app", description: "Web app with database" }
```

### Step 3: Generate CLAUDE.md

Create a project-level CLAUDE.md by analyzing the actual codebase — don't guess, read:

```bash
# Extract real commands from package.json scripts
node -e "const p=require('./package.json');Object.entries(p.scripts||{}).forEach(([k,v])=>console.log('- \`npm run '+k+'\` — '+v))"

# Detect test runner
node -e "const d={...require('./package.json').dependencies,...require('./package.json').devDependencies};console.log(d.vitest?'vitest':d.jest?'jest':d['@playwright/test']?'playwright':'npm test')"

# Map src/ structure (top 2 levels)
find src/ -maxdepth 2 -type d 2>/dev/null | head -20

# Detect dev server port from scripts
node -e "const s=require('./package.json').scripts||{};const dev=s.dev||'';const m=dev.match(/--port\s+(\d+)|-p\s+(\d+)/);console.log(m?m[1]||m[2]:dev.includes('vite')?'5173':'3000')"
```

Generate CLAUDE.md from real data:

```markdown
# [Project Name]

## Overview
[One-line description from package.json description field]

## Stack
[Detected from dependencies — be specific: "Next.js 15 + Supabase + Tailwind + shadcn/ui"]

## Commands
[Actual scripts from package.json — every one, not just dev/build/test]

## Dev Server
- Port: [detected port]
- Start: `npm run dev`
- Test runner: [vitest/jest/playwright]

## Key Directories
[Actual src/ structure from find output]

## Environment
[List all NEXT_PUBLIC_* and other env vars referenced in code]
```

Also check for existing CLAUDE.md — if it exists, merge new info rather than overwriting.

### Step 4: Recommend Skills

Based on detected stack, list relevant auto-dev skills:

**Always relevant:** review, commit, fix

**Conditional recommendations:**

| If Detected | Recommend |
|-------------|-----------|
| @supabase/supabase-js | supabase (db, rls, migrations) |
| stripe | stripe (payments, webhooks, checkout) |
| next | perf (Core Web Vitals), seo (meta tags, schema) |
| tailwindcss | design (UI patterns, design tokens) |
| vercel.json | deploy (Vercel deployment) |
| playwright/cypress | test (unit + browser tests), browser (automation) |
| remotion | remotion (video creation) |
| Marketing/E-commerce type | seo (meta tags, schema markup) |
| Any auth detected | security (pre-deploy scanning) |

Output format:
```
Detected: Next.js + Supabase + Stripe + Tailwind

Recommended skills for this project:
- supabase — database, RLS policies, migrations
- stripe — payments, webhooks, checkout
- seo — meta tags, schema markup, Open Graph
- design — UI patterns, design tokens
- deploy — Vercel deployment
- security — pre-deploy scanning
- perf — Core Web Vitals

These load automatically when you use their trigger words.
```

### Step 5: Environment Setup

Create `.env.example` based on detected services:

```bash
# Generated based on detected stack

# Supabase (if @supabase/supabase-js detected)
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=

# Stripe (if stripe detected)
STRIPE_SECRET_KEY=
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=
STRIPE_WEBHOOK_SECRET=

# Auth (if next-auth detected)
NEXTAUTH_SECRET=
NEXTAUTH_URL=

# App
NEXT_PUBLIC_APP_URL=
```

Ensure `.gitignore` includes:
- `.env.local`, `.env`
- `node_modules/`
- `.next/` (for Next.js)
- `.claude/` (auto-dev artifacts)

### Step 6: Create prd.json

Based on project type, create initial stories:

**E-commerce starter:**
- Product listing page with schema markup
- Shopping cart
- Stripe Checkout integration
- Order confirmation and webhooks
- SEO: meta tags, Open Graph, sitemap

**SaaS starter:**
- Auth flow (signup, login, logout)
- Subscription billing with Stripe
- Dashboard layout
- User settings and profile
- Protected API routes

**Marketing site starter:**
- Landing page with hero section
- SEO: meta tags, Open Graph, JSON-LD
- Contact form
- Responsive design
- Sitemap and robots.txt

### Step 7: Report

```
Project setup complete:
- CLAUDE.md: Created with [detected stack] context
- prd.json: [N] initial stories based on [project type]
- .env.example: Configured for [detected services]
- .gitignore: Updated

Recommended skills: [list]

Next: Say 'auto' to start working through tasks,
or 'brainstorm' to scan for more improvements.
```

## Quick Setup

If user provides a description:
"Set up this project - I want to build [description]"

1. Run stack detection (Steps 1-2)
2. Generate all files using smart defaults (Steps 3-6)
3. Skip questions when the description provides enough context
4. Show the report (Step 7)
