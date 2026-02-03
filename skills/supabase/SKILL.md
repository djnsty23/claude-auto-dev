---
name: supabase
description: Supabase CLI patterns - replaces MCP (more reliable)
allowed-tools: Bash
model: haiku
user-invocable: false
---

# Supabase CLI

Use CLI instead of MCP - more reliable, fewer permission issues.

## Common Commands

```bash
# Apply migrations (limit output)
supabase db push --project-ref PROJECT_ID 2>&1 | tail -10

# Run SQL directly
supabase db execute --sql "SELECT * FROM table LIMIT 5" --project-ref PROJECT_ID

# Deploy edge functions
supabase functions deploy FUNCTION_NAME --project-ref PROJECT_ID

# Deploy all functions
supabase functions deploy --project-ref PROJECT_ID

# List projects
supabase projects list

# Check status
supabase status --project-ref PROJECT_ID
```

## Context-Efficient Patterns

```bash
# Limit output to reduce context
supabase db push 2>&1 | tail -5

# Check if migration exists before applying
supabase db execute --sql "SELECT 1 FROM table LIMIT 1" 2>&1 | grep -q "1" && echo "exists"

# Run in background for long operations
Bash({ command: "supabase functions deploy --project-ref X", run_in_background: true })
```

## Project IDs

Get from CLAUDE.md or:
```bash
supabase projects list 2>&1 | grep -E "^\w"
```

## Auth

Uses `SUPABASE_ACCESS_TOKEN` env var. Set per-project tokens:
- `SUPABASE_ACCESS_TOKEN_REELR`
- `SUPABASE_ACCESS_TOKEN_CCB`
- etc.

## Skip MCP

MCP has permission issues. Always prefer CLI:
- More reliable
- Better error messages
- Easier to debug
- Output can be limited
