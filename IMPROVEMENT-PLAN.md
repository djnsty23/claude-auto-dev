# Claude Auto-Dev v4.4 Comprehensive Review & Improvement Plan

## Review Summary (4 Pass Analysis)

### Pass 1: Token Cost Analysis

**Current State:**
| Component | Count | Est. Tokens/Each | Total Tokens |
|-----------|-------|------------------|--------------|
| Skill metadata (always loaded) | 33 | ~100 | ~3,300 |
| SKILL.md bodies (on-demand) | 33 | ~500-2000 | varies |
| `requires` chain loading | 6 entries | ~1000 | ~6,000 extra |

**Concerns:**
- `audit` loads 3 skills via `requires` → 3,000+ extra tokens
- `brainstorm` loads 2 skills via `requires` → 2,000+ extra tokens
- Some skills exceed 500 line recommendation (see below)

**Skill Size Audit:**
| Skill | Lines | Status |
|-------|-------|--------|
| agent-browser.md | 277 | ✓ OK |
| build-reference.md | 83 | ✓ OK |
| supabase-schema.md | 361 | ⚠️ Consider splitting |
| audit/SKILL.md | ~200 | ✓ OK |
| auto/SKILL.md | ~168 | ✓ OK |

**Recommendation:** Token costs are acceptable. The `requires` mechanism adds value that justifies extra tokens.

---

### Pass 2: Inconsistencies & Conflicts Found

#### A. Naming Convention Issues
Official spec: `name` must be lowercase letters, numbers, hyphens only (max 64 chars)

| Current | Should Be |
|---------|-----------|
| `Agent Browser` | `agent-browser` |
| `Code Quality Rules` | `code-quality-rules` |
| Various CamelCase in code | lowercase-hyphen |

#### B. Description Issues
Official spec: Third person, specific, includes trigger words

**Vague descriptions found:**
- `quality` - "Code quality principles - guides judgment" (too vague)
- `workflow` - "Skill orchestration - user commands vs auto-triggered" (unclear when to trigger)

**Should be:**
- `quality` - "Enforces code quality principles including type safety, design tokens, and UI states. Load when reviewing code or implementing features."
- `workflow` - "Documents skill orchestration patterns. Reference for understanding command flow."

#### C. Duplicate Triggers
| Trigger | Skills |
|---------|--------|
| `setup` | setup-project, setup |
| `deploy` | ship, deploy |
| `test`, `verify` | test |

**Action:** Consolidate or clarify precedence.

#### D. Missing Cross-References
| Skill | Should Reference | Currently References |
|-------|------------------|---------------------|
| `test` | `browser-test`, `agent-browser` | None (just mentions agent-browser) |
| `verify` | `quality`, `code-quality` | None |
| `ship` | `security`, `review` | None |

#### E. `requires` Inconsistency
Current:
```json
"auto": { "requires": ["code-quality", "quality", "react-patterns"] }
"audit": { "requires": ["quality", "code-quality", "frontend-design"] }
"test": { "requires": [] }  // MISSING!
```

Test should require: `["browser-test", "agent-browser"]`

---

### Pass 3: Research - Official Claude Code Plugins

**Available from anthropics/claude-code:**
1. `frontend-design` ✓ (we have)
2. `code-review` - **SHOULD ADD**
3. `pr-review-toolkit` - **SHOULD ADD**
4. `security-guidance` - **SHOULD ADD**
5. `commit-commands` - Consider adding
6. `ralph-wiggum` - Ralph Loop integration (we reference but don't have)

**Official Best Practices (from docs):**
1. Keep SKILL.md under 500 lines
2. Use progressive disclosure - split large files
3. Descriptions must be specific and include trigger words
4. Name: lowercase-hyphen only
5. Cross-references ONE level deep from SKILL.md
6. Write in third person for descriptions
7. Test with Haiku, Sonnet, AND Opus

---

### Pass 4: Synergy Analysis

#### Current Flow
```
User says "test"
    ↓
test/SKILL.md loads (no requires)
    ↓
Mentions agent-browser but doesn't load browser-test skill
    ↓
Knowledge gap - agent-browser patterns not in context
```

#### Desired Flow
```
User says "test"
    ↓
test/SKILL.md loads
    ↓
requires: ["browser-test"] → browser-test/SKILL.md loads
    ↓
browser-test references agent-browser.md → available if needed
    ↓
Full testing knowledge in context
```

#### Synergy Matrix (Current vs Target)

| Command | Current Requires | Target Requires |
|---------|-----------------|-----------------|
| `auto` | code-quality, quality, react-patterns | ✓ Good |
| `audit` | quality, code-quality, frontend-design | ✓ Good |
| `review` | quality, code-quality | Add: self-review |
| `brainstorm` | quality, frontend-design | Add: preserve-ui |
| `test` | None | **Add: browser-test** |
| `ship` | None | **Add: review, security** |
| `verify` | None | Add: quality |

---

## Recommended Improvements

### Priority 1: Fix Critical Synergies (15 min)

```json
// In manifest.json, update:
"test": {
  "requires": ["browser-test"]
},
"ship": {
  "requires": ["review"]  // security check before deploy
},
"verify": {
  "requires": ["quality"]
}
```

### Priority 2: Add Official Skills (30 min)

Fetch and add from anthropics/claude-code:
1. `code-review` - Comprehensive code review patterns
2. `pr-review-toolkit` - PR creation and review
3. `security-guidance` - Security best practices

```bash
# Fetch command
gh api repos/anthropics/claude-code/contents/plugins/code-review/skills/code-review/SKILL.md --jq '.content' | base64 -d > skills/code-review/SKILL.md
gh api repos/anthropics/claude-code/contents/plugins/security-guidance/skills/security-guidance/SKILL.md --jq '.content' | base64 -d > skills/security-guidance/SKILL.md
```

### Priority 3: Fix Naming Conventions (15 min)

Update YAML frontmatter in all skills:
```yaml
# WRONG
---
name: Agent Browser
---

# RIGHT
---
name: agent-browser
description: Browser automation CLI for AI agents. Use when testing UI, forms, or auth flows. Provides 5-6x token savings over Playwright MCP.
---
```

### Priority 4: Improve Descriptions (30 min)

Make descriptions:
- Third person
- Specific about when to use
- Include trigger words

Example fixes:
```yaml
# quality/SKILL.md
---
name: quality
description: Enforces code quality principles including type safety, design tokens, and all UI states. Loaded automatically with auto, review, and audit commands.
---

# test/SKILL.md
---
name: test
description: Runs unit tests and browser tests on latest changes. Use when verifying implementations, testing auth flows, or checking UI states. Triggers on 'test', 'verify', 'e2e', 'browser'.
---
```

### Priority 5: Consolidate Duplicate Triggers (10 min)

```json
// Remove duplicate
"setup-project": {
  "triggers": ["init", "new project"],  // Remove "setup"
  ...
},
"setup": {
  "triggers": ["setup"],  // Keep only here
  ...
}
```

### Priority 6: Add test→browser-test Integration (20 min)

Update `test/SKILL.md` to:
1. Explicitly reference browser-test patterns
2. Add requires in manifest
3. Document the flow

---

## Token Cost Justification

| Change | Token Impact | Value |
|--------|--------------|-------|
| Add `requires` to test | +500 | Browser test patterns always available |
| Add `requires` to ship | +1000 | Security/review before deploy |
| Add code-review skill | +800 | Better PR reviews |
| Add security-guidance | +600 | Security patterns |
| **Total** | ~2,900 | High value for quality |

**Verdict:** Token costs are justified. Better to have comprehensive knowledge than miss critical patterns.

---

## Implementation Checklist

- [x] Update manifest.json with new `requires` entries (v4.5.0)
- [x] Fix naming conventions (lowercase-hyphen) - already correct in manifest
- [x] Improve descriptions (third person, specific) - updated quality, workflow, test, ship, verify, browser-test
- [ ] Add code-review skill from official repo (optional - user decision)
- [ ] Add security-guidance skill from official repo (optional - user decision)
- [x] Consolidate duplicate triggers (setup-project, test, ship)
- [x] Update test/SKILL.md to reference browser-test (via requires chain)
- [x] Update ship.md to reference security checks (via review requires)
- [ ] Test with Haiku model (ensure guidance is sufficient)
- [x] Update CHANGELOG.md (v4.5.0)
- [x] Update README.md (v4.5.0)

---

## Decision Points for User

1. **Add official skills from Claude Code repo?**
   - code-review (PR quality)
   - security-guidance (security patterns)
   - pr-review-toolkit (PR workflows)

2. **Token budget priority?**
   - Option A: Full synergy (add all requires) - ~6K extra tokens
   - Option B: Minimal synergy (critical only) - ~2K extra tokens
   - Option C: Current state (no change) - 0 extra tokens

3. **Consolidate setup vs setup-project?**
   - They seem to overlap - merge or clarify?

4. **browser-agent mentioned in user message?**
   - Did you mean agent-browser (which we have)?
   - Or a different tool?

---

## Summary

**What's Working Well:**
- Core skill structure is solid
- Progressive disclosure pattern good
- Synergy additions from earlier session valuable
- frontend-design skill properly integrated

**What Needs Improvement:**
- test skill missing browser-test requires
- ship skill missing security requires
- Some naming conventions wrong
- Some descriptions too vague
- Missing official skills (code-review, security-guidance)

**Recommendation:** Implement Priority 1-3 (1 hour total). Token costs are justified by quality improvements.
