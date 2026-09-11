---
name: security
description: "Pre-deploy security check for changed attack paths: source and migration secrets, Supabase access policies, and cloud key hygiene. Reports reproduced findings and checks that could not run."
when_to_use: "Invoked when the user says \"security\", \"security scan\", \"security audit\", or before a deploy that touches auth, data, or secrets."
allowed-tools: Bash, Read, Grep, Glob, Task
model: opus
user-invocable: true
---

# Security

Use the host’s security review capability when available, with its actual
supported invocation. If unavailable, review the relevant attack paths directly
and record which tool/manual checks ran. Cover injection, XSS, unsafe
deserialization, path traversal, authorization and secret handling; a tool’s
name does not establish its coverage. The stack-specific checks below supplement
that review. Work within existing authorization, including credential rotation
or infrastructure changes already authorized by the user.

## 1. Secrets in source and migrations

Enumerate relevant tracked/untracked source and migration files first, excluding
vendor/generated populations only with a reason. Use the project’s secret
scanner when present; otherwise use targeted `rg --files-with-matches` searches
for provider key formats, passwords and privileged-key assignments. Review
candidates without printing secret values. Names such as `service_role`,
`cron` or `api_key` are candidates, not proof that a credential is embedded.
Record searched paths, match counts and scanner exit status; a missing directory
or unreadable file is not clean.

A real secret committed in a migration/history requires rotation and removal
from active use, not just deleting the source line. Use the project’s approved
secret store (for example Supabase Vault for database jobs). A harmless fixture
or variable name alone does not require rotating anything.

## 2. Env files not committed

Inspect tracked paths as well as worktree changes:

```bash
git ls-files -- '.env' '.env.*' '**/.env' '**/.env.*'
git status --short --untracked-files=all -- '.env' '.env.*' '**/.env' '**/.env.*'
```

Classify each path: sanitized `.env.example` templates can be intentional; real
credentials must not be committed. A clean `git status` says nothing about
secrets already tracked. Use a history-capable secret scanner for historical
exposure; a symbol-name search alone cannot rule it out. Adding `.gitignore`
does not untrack an existing file or remove its history.

## 3. Supabase RLS

```bash
npx --no-install supabase db lint
```

Run lint against the intended local/test database and record its target/status;
it does not prove RLS. For each exposed table, define the intended role/operation
access matrix, inspect grants, RLS and policy composition, and test access. A
public-read `USING (true)` can be intentional; applying it to private rows is a
security defect. Secret credentials belong in trusted server runtimes, never
client-reachable code. Load the applicable Supabase guidance.

## 4. Cloud key hygiene

Check key types, permitted callers and provider restrictions against current
provider guidance. A public client identifier is not automatically a secret; a
server credential embedded in client code is. Inspect current access and usage
without printing values. Use least privilege and the project/provider rotation
policy; do not disable a key solely because a generic age threshold elapsed.

Review monitoring relevant to the changed service: security contacts, unusual
usage/billing signals and actionable alerts. Distinguish missing information
from confirmed misconfiguration. Do not change provider settings outside the
existing authorized scope.

## Reporting

One list, most severe first, combining findings from the reviews/checks that
actually ran. For each: severity, `file:line`, what an attacker gets, and the fix.

**Never auto-fix a leaked credential by deleting the line.** The value is
already in git history. Rotate/revoke it when that action is authorized and
available, then verify the replacement works and the old value no longer does.
Otherwise name the remaining owner action without marking remediation done.

Source/config fixes still need validation: preserve sanitized env templates,
wire runtime secret loading, and test legitimate as well as denied access
before applying an RLS migration. Enabling RLS without suitable grants/policies
can block the application; it is not an automatically safe standalone fix.

## Proving the run

**Observable:** every finding carries a `file:line` and the command that found
it, and every "clean" carries the population it scanned.

For RLS, use a local/test fixture with a known private row: the owner can read
it, anon and a different account cannot, and permitted/forbidden writes behave
according to the access matrix. Capture status plus response and stored-state
assertions. An RLS-filtered SELECT may return `200 []`; that is not meaningful
without the populated owner control. Do not use a service-role credential for
a deny test, and do not infer security from a truncated curl body. Keep live
mutations within existing authorization and use isolated test records.

A security pass that reports nothing is the single most dangerous output in this
repo, because a broken grep and a clean codebase produce the same text. Run each
check against something you know is findable first, then report both the count of
findings and the number of files scanned. If the scan did not run, say so. If it ran but its detector/control is
unverified, report that limitation rather than falsely saying it never ran.
