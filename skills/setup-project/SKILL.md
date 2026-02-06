---
name: setup-project
description: Initializes project with prd.json and standard config. Use when starting a new project.
triggers:
  - setup
  - scaffold
  - new-project
allowed-tools: Bash, Read, Write, Edit, Glob
model: opus
user-invocable: true
disable-model-invocation: true
---

# Setup Project Workflow

## On "set up" or "setup"

### Step 1: Detect Project Type
```
Check for:
- package.json → Node/JS project
- pyproject.toml → Python project
- Cargo.toml → Rust project
- go.mod → Go project
```

### Step 2: Gather Requirements
```
question: "What are you building?"
options:
  - { label: "Web app", description: "Next.js + Supabase + Auth" }
  - { label: "API", description: "Backend service" }
  - { label: "CLI tool", description: "Command-line application" }
  - { label: "Library", description: "Reusable package" }
```

### Step 3: Create Project Files

**For all projects:**
```
1. Create/update CLAUDE.md with project context
2. Create prd.json with initial tasks
3. Create progress.txt
4. Create .claude/briefs/ directory
```

**For web apps (Next.js):**
```
1. Verify dependencies: npm install
2. Check for Supabase config
3. Setup auth if needed
4. Configure environment variables
```

### Step 4: Supabase Integration

If project uses Supabase:
```bash
# 1. Check for NEXT_PUBLIC_SUPABASE_URL in .env.local
# 2. If missing, ask user for project ref
# 3. Generate .env.local template
# 4. Verify connection with CLI:
npx supabase db ping --db-url "$DATABASE_URL"
```

### Step 5: Environment Setup
```
Create .env.example with required vars (no values):

# Supabase
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=

# OAuth (set in system env vars)
# GOOGLE_CLIENT_ID
# GOOGLE_CLIENT_SECRET
```

### Step 6: Install agent-browser (for browser testing)
```bash
# Check if installed
which agent-browser || npm install -g agent-browser && agent-browser install
```

### Step 7: Git Setup
```
1. Check .gitignore includes:
   - .env.local
   - .env
   - node_modules/
   - .next/
2. Add if missing
```

### Step 8: Report
```
"Project setup complete:
- CLAUDE.md: Created with project context
- prd.json: Ready for tasks
- Environment: Configured
- Supabase: [Connected/Not configured]
- agent-browser: [Installed/Skipped]

Next: Say 'brainstorm' to generate tasks."
```

## Quick Setup

If user provides description:
"Set up this project - I want to build [description]"

1. Parse the description
2. Generate initial stories based on requirements
3. Add to prd.json
4. Skip the questions, use smart defaults

## Project Templates

**Next.js + Supabase + Auth:**
- User authentication (signup, login, logout)
- Protected routes
- User profile management
- Database schema setup

**API Service:**
- Route structure
- Error handling
- Input validation
- Authentication middleware
