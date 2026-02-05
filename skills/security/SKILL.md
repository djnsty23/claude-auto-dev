---
name: security
description: Pre-deploy security audit
triggers:
  - security
user-invocable: true
---

# Security Check

Run before every deploy.

## Checks

### 1. Secrets Scan
```bash
# Check for hardcoded secrets
grep -rn "sk_live\|sk_test\|api_key\s*=\s*['\"][^'\"]\+" src/ --include="*.ts" --include="*.tsx"
grep -rn "password\s*=\s*['\"][^'\"]\+" src/ --include="*.ts" --include="*.tsx"
```

If found: **STOP** - move to env vars.

### 2. Environment Variables
```bash
# Check .env files not committed
git status | grep ".env"
```

If .env tracked: **STOP** - add to .gitignore.

### 3. Supabase RLS
```bash
# Check all tables have RLS
npx supabase db lint
```

If RLS disabled: **STOP** - enable RLS.

### 4. Input Validation
```typescript
// Check for unvalidated inputs
grep -rn "req.body\." src/ --include="*.ts" | grep -v "zod\|schema\|validate"
```

If unvalidated: **WARN** - add Zod validation.

### 5. XSS Vectors
```bash
grep -rn "dangerouslySetInnerHTML\|innerHTML\|document.write" src/
```

If found: **WARN** - sanitize or remove.

## Report

```
Security Check
══════════════
Secrets:     ✓ None found
Env files:   ✓ Not tracked
RLS:         ✓ All tables protected
Validation:  ⚠ 2 endpoints need Zod
XSS:         ✓ None found

Result: PASS (1 warning)
Ready to deploy: Yes
```

## Auto-Fix

For common issues:
- Move secrets → `.env.local`
- Add `.env*` to `.gitignore`
- Add `ALTER TABLE x ENABLE ROW LEVEL SECURITY`
