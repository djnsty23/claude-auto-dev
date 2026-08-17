---
name: security
description: Pre-deploy security check. Runs Claude Code's built-in security review, then the stack-specific scans it does not cover — Supabase RLS, migration secrets, and cloud key hygiene.
when_to_use: "Invoked when the user says \"security\", \"security scan\", \"security audit\", or before a deploy that touches auth, data, or secrets."
allowed-tools: Bash, Read, Grep, Glob, Task
model: opus
user-invocable: true
---

# Security

**Run Claude Code's built-in security review first.**

```
/security-review
```

It covers the language-level vulnerability classes — injection, XSS, unsafe
deserialization, path traversal, authz gaps, secret handling in code. Do not
re-derive that list here.

Everything below is stack-specific: it depends on Supabase, on this project's
migration layout, or on cloud key policy, none of which a general reviewer can
check.

## 1. Secrets in source and migrations

```bash
grep -rn "sk_live\|sk_test\|api_key\s*=\s*['\"][^'\"]\+" src/ supabase/ --include="*.ts" --include="*.tsx" --include="*.sql"
grep -rn "password\s*=\s*['\"][^'\"]\+" src/ supabase/ --include="*.ts" --include="*.tsx" --include="*.sql"
grep -rn "service_role\|supabase_admin\|cron\.\|pg_cron" supabase/migrations/ --include="*.sql" 2>/dev/null
```

Migrations are the part general scanners miss. A `service_role` key or a cron
secret written into a migration is committed history — rotate it, don't just
delete the line. CRON secrets belong in `vault.secrets`.

## 2. Env files not committed

```bash
git status --short | grep "\.env" || echo "clean"
git log --oneline -S "SUPABASE_SERVICE_ROLE_KEY" -- . 2>/dev/null | head -5
```

A tracked `.env` needs `.gitignore` **and** a rotation, because it is already in
history.

## 3. Supabase RLS

```bash
npx supabase db lint
```

Every table needs RLS enabled and a policy that is deny-by-default. "RLS
enabled" with a permissive `USING (true)` policy is not protection — read the
policy body, don't just check the flag. Secrets belong in Edge Function
environment, never in client-reachable code.

## 4. Cloud key hygiene

```bash
grep -rn "AIza\|GOOG\|ya29\.\|service_account" src/ --include="*.ts" --include="*.tsx" --include="*.json" --include="*.env*"
git log -p --all -S "AIza" --diff-filter=A -- "*.ts" "*.json" 2>/dev/null | head -20
```

- Never commit API keys or service-account JSON — Secret Manager or runtime env only.
- Restrict every key to specific APIs and bind it to an IP, referrer, or bundle id.
- Service accounts get least privilege; prune unused roles.
- Decommission any key unused for 30+ days, and enforce a max key lifespan.

Flag as missing, if absent: security contacts, billing anomaly alerts (a
consumption spike is usually the first sign of a leaked credential), and budget
alerts routed somewhere a human reads.

## Reporting

One list, most severe first, combining the built-in review's findings with
these. For each: severity, `file:line`, what an attacker gets, and the fix.

**Never auto-fix a leaked credential by deleting the line.** The value is
already in git history. Say so, and tell the user to rotate it.

Safe auto-fixes: adding `.env*` to `.gitignore`, moving a value to
`.env.local`, adding `ALTER TABLE x ENABLE ROW LEVEL SECURITY` — each still
paired with the rotation note when a real secret was exposed.

## Proving the run

**Observable:** every finding carries a `file:line` and the command that found
it, and every "clean" carries the population it scanned.

```bash
# RLS is not proven by reading the policy — query as anon and require the denial
curl -s "$SUPABASE_URL/rest/v1/<table>?select=*" -H "apikey: $ANON_KEY" | head -c 200
```

A security pass that reports nothing is the single most dangerous output in this
repo, because a broken grep and a clean codebase produce the same text. Run each
check against something you know is findable first, then report both the count of
findings and the number of files scanned. An unproven "no secrets found" should
be reported as "the scan did not run".
