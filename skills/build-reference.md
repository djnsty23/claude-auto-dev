---
name: Command Reference
description: Quick reference for all commands. Details in individual SKILL.md files.
---

# Command Reference

## Core Commands

| Command | Skill | Description |
|---------|-------|-------------|
| `auto` | auto/SKILL.md | Work through all tasks without stopping |
| `status` | status/SKILL.md | Show progress dashboard |
| `brainstorm` | brainstorm/SKILL.md | Generate new stories |
| `sprint` | sprint/SKILL.md | Advance to next sprint |

## Development Commands

| Command | Skill | Description |
|---------|-------|-------------|
| `fix [issue]` | fix.md | Debug and fix bugs |
| `test` | test/SKILL.md | Run unit + browser tests |
| `review` | review/SKILL.md | Code quality check |
| `ship` | ship.md | Build and deploy |

## Setup Commands

| Command | Skill | Description |
|---------|-------|-------------|
| `setup` | setup/SKILL.md | Initialize claude-auto-dev |
| `supabase` | supabase/SKILL.md | Database operations |
| `audit` | audit/SKILL.md | Quality audit (6 parallel agents) |

## Session Commands

| Command | Action |
|---------|--------|
| `clean` | Remove temp artifacts |
| `checkpoint` | Save context state |

## File Schemas

### prd.json Story
```json
{
  "id": "S26-001",
  "title": "Brief description",
  "priority": 1,
  "passes": null,
  "type": "fix",
  "category": "components",
  "notes": "",
  "resolution": ""
}
```

See `prd-schema.json` for full validation schema.

### Priority Values
- 0 = Critical
- 1 = High
- 2 = Medium
- 3 = Low

### Passes Values
- `null` = Pending
- `true` = Complete
- `false` = Failed
- `"deferred"` = Postponed

## Design Principles

1. **AI-First Defaults** - Pre-fill, user tweaks
2. **Build must pass** - Never mark complete with errors
3. **Resolution learning** - Document HOW fixes work
4. **Token efficiency** - Read selectively, not everything

## Security

- Never hardcode API keys
- Use `process.env.VAR_NAME`
- Secrets in .env.local only
- Never commit .env files
