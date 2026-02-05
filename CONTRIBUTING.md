# Contributing to Claude Auto-Dev

## Skill Authoring Guide

### Directory Structure

Skills should follow this structure:
```
skills/
├── skill-name/
│   ├── SKILL.md          # Main skill file (required)
│   └── rules/            # Optional detailed rules
│       ├── rule-1.md
│       └── rule-2.md
└── manifest.json         # Skill registry
```

### SKILL.md Format

```markdown
---
name: skill-name
description: Third-person description. Use when [specific trigger conditions].
user-invocable: true|false
triggers: trigger1, trigger2
---

# Skill Name

Brief description of what this skill does.

## When to Use

- Condition 1
- Condition 2

## Quick Reference

[Concise, actionable guidance]

## Detailed Rules

Load specific rules for detailed guidance:

| Rule | When to Load |
|------|--------------|
| `rules/rule-1.md` | Condition |
```

### Manifest Entry

```json
"skill-name": {
  "triggers": ["trigger1", "trigger2"],
  "context": ["optional/path/"],
  "file": "skill-name/SKILL.md",
  "requires": ["other-skill"],
  "priority": 2,
  "description": "Third-person description under 100 chars."
}
```

### Best Practices

1. **Keep SKILL.md under 500 lines** - Use references/ for details
2. **Use progressive disclosure** - Load rules on-demand
3. **Third-person descriptions** - "Runs tests" not "Run tests"
4. **Specific triggers** - Avoid conflicts with existing skills
5. **Include examples** - Show correct vs incorrect patterns
6. **Source attribution** - Credit external skill sources

### Priority Levels

| Priority | Use For |
|----------|---------|
| 0 | Foundation skills (quality, core) |
| 1 | Primary commands (auto, audit, review) |
| 2 | Secondary commands (test, verify) |
| 3 | Utility skills (help, setup) |

### Requires Chains

Use `requires` to auto-load dependencies:
```json
"review": {
  "requires": ["quality", "code-quality", "security"]
}
```

**Rules:**
- Max depth: 2 levels
- Don't create circular dependencies
- Only require skills that add value

## Adding External Skills

### From GitHub

```bash
# Check repo structure
gh api repos/owner/repo/contents/skills --jq ".[].name"

# Fetch skill
gh api repos/owner/repo/contents/skills/name/SKILL.md --jq ".content" | base64 -d > skills/name/SKILL.md
```

### Adapting External Skills

1. Keep core content intact
2. Add integration section for our system
3. Update manifest.json
4. Credit the source

## Testing

1. Copy skill to `~/.claude/skills/`
2. Start new Claude Code session
3. Verify skill appears in `/skills` list
4. Test trigger words activate skill
5. Verify requires chains load correctly

## Pull Request Checklist

- [ ] SKILL.md under 200 lines
- [ ] Manifest entry added
- [ ] Description is third-person
- [ ] No trigger conflicts
- [ ] Source credited (if external)
- [ ] CHANGELOG.md updated
- [ ] README.md skill count updated
