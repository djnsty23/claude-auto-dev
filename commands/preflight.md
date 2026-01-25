---
description: Pre-flight check before starting auto mode
---

# Preflight Check

Validates project state before starting autonomous work.

## Auto-Run

Preflight runs automatically when you use:
- `auto` command
- `sprint` command

## Checks Performed

### 1. Git Status
```bash
git status --porcelain
```
- ⚠️ WARN if uncommitted changes exist (but continue)
- ❌ FAIL if merge conflicts present

### 2. Build Health
```bash
npm run build 2>&1
```
- ❌ FAIL if build doesn't pass
- Cannot start auto mode with broken build

### 3. Type Check
```bash
npm run typecheck 2>&1
```
- ⚠️ WARN if type errors exist
- Lists first 5 errors for context

### 4. Session Lock
```bash
cat .claude-lock 2>/dev/null
```
- ❌ FAIL if another session is active (lock < 60s old)
- Suggest `reset` to force unlock if stale

### 5. prd.json Validity
```javascript
const prd = JSON.parse(fs.readFileSync('prd.json'));
if (!prd.stories || !Array.isArray(prd.stories)) {
  throw new Error('Invalid prd.json structure');
}
```
- ❌ FAIL if prd.json missing or invalid

### 6. Context Health (Optional)
- ⚠️ WARN if initial context > 30%
- Suggest `context-audit` to optimize

## Output Format

```
Preflight Check
───────────────────────────────
✓ Git: Clean working tree
✓ Build: Passing
✓ Types: No errors
✓ Lock: No active sessions
✓ prd.json: 23 tasks (15 pending)
⚠ Context: 28% initial (consider context-audit)

Ready to start auto mode!
```

## Failure Handling

If any ❌ FAIL check:
```
Preflight Check FAILED
───────────────────────────────
✓ Git: Clean working tree
❌ Build: FAILED
   Error: Module not found: @/components/Missing

Fix the build error before running auto mode.
```

## Skip Preflight

For experienced users:
```bash
auto --skip-preflight
```

Not recommended - may cause wasted work if project is broken.
