---
description: Analyze and optimize context window usage
---

# Context Audit

Analyze what's consuming your context window and optimize for better AI accuracy.

## Why This Matters

Higher context consumption = Lower AI accuracy. The video showed:
- Initial context was 24-25% just from setup
- After optimization: 23% (removed redundant plugins)
- Savings: 8-12K tokens

## Process

### Step 1: Identify Context Contributors

Check these locations:

```bash
# Global plugins
ls ~/.claude/plugins/

# Project plugins
ls .claude/plugins/ 2>/dev/null

# CLAUDE.md files (can be large)
wc -l ~/.claude/CLAUDE.md
wc -l ./CLAUDE.md

# MCP servers
cat ~/.claude/settings.json | grep -A2 '"mcpServers"'

# Hooks (add context per invocation)
cat ~/.claude/settings.json | grep -A2 '"hooks"'
```

### Step 2: Analyze Redundancy

Common issues:
- **Duplicate skills** - Same skill in global + project
- **Unused MCP servers** - Servers you never call
- **Large CLAUDE.md** - Too many rules/instructions
- **Verbose hooks** - Hooks that output too much

### Step 3: Recommendations

After analysis, suggest:

```
Context Audit Results:

Contributors:
  System prompt: ~15K tokens (fixed)
  MCP tool definitions: ~8K tokens
  CLAUDE.md (global): 2.1K tokens
  CLAUDE.md (project): 1.8K tokens
  Plugins (5 active): ~3K tokens
  ─────────────────────────────
  Estimated initial: ~30K / 200K (15%)

Recommendations:
  1. REMOVE: typescript-lsp plugin (redundant with built-in)
  2. REMOVE: code-review plugin (use /review command instead)
  3. MERGE: Global + project CLAUDE.md have duplicates
  4. TRIM: ~/.claude/rules/design-system.md has examples that could be shorter

Potential savings: 4-6K tokens (2-3% context)
```

### Step 4: Apply Optimizations

With user confirmation:
- Disable/remove redundant plugins
- Consolidate CLAUDE.md files
- Trim verbose rule files
- Remove unused MCP servers

## Auto-Optimization Mode

```
context-audit --fix
```

Applies safe optimizations automatically:
- Removes clearly redundant plugins
- Trims excessive examples from rules
- Does NOT remove anything custom/user-created

## Status Line Setup

For ongoing monitoring, run:
```
/status line
```

This configures the status bar to show context % in real-time.

## Best Practices

1. **Keep initial context under 20%** - Leaves room for conversation
2. **Archive old tasks** - Use `/archive` when prd.json gets large
3. **Use /compact** - When context exceeds 60%
4. **Minimize CLAUDE.md** - Keep rules concise, not verbose
5. **Lazy-load plugins** - Only enable what you actively use
