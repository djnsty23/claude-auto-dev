---
name: setup
description: Initialize claude-auto-dev in a new project
allowed-tools: Bash, Read, Write, Edit
model: sonnet
user-invocable: true
---

# Setup

Initialize claude-auto-dev in a new project.

## What It Does

1. Creates `.env.local` from template (with API links)
2. Creates `project-meta.json` for sprint tracking
3. Creates `.claude/` folder structure
4. Updates `.gitignore`

## Execution

```bash
# 1. Copy env template
cp ~/.claude/templates/env.local.template .env.local

# 2. Create project-meta.json
cat > project-meta.json << 'EOF'
{
  "name": "PROJECT_NAME",
  "currentSprint": "sprint-1",
  "totalCompleted": 0,
  "sprints": {}
}
EOF

# 3. Create .claude folder
mkdir -p .claude/screenshots

# 4. Update .gitignore
echo -e "\n# Claude Auto-Dev\n.claude/\n.env.local" >> .gitignore
```

## After Setup

Tell user:
```
Setup complete.

Next steps:
1. Edit .env.local - fill in API keys (links provided in file)
2. Run "audit" to scan project and create initial stories
3. Run "auto" to start working

Each project has isolated credentials - no system var conflicts.
```

## Key Principle

**No system vars** - All credentials in project .env.local:
- Auto-loaded by session hook
- No conflicts between projects
- Safe for 4 parallel Cursor instances
