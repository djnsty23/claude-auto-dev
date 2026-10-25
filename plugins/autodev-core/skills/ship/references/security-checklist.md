# What the security gate cannot decide

Loaded from Step 2 of `ship`. The gate (`security-gate.js`) is the blocking
check; this list covers the judgement it cannot make. Fix any critical item
before deploying.

- [ ] No hardcoded API keys, tokens, or secrets in code
- [ ] Inspect the actual staged paths and candidate commit for secret-bearing
      `.env` files and credentials, allowing only reviewed placeholder examples.
      `.gitignore` prevents new untracked additions; it does not remove a file
      that is already tracked or prove the candidate contains no secrets.
- [ ] Supabase RLS enabled on all public tables
- [ ] Input validation on all user-facing forms
- [ ] No `dangerouslySetInnerHTML` without sanitization
- [ ] Protected routes probed as every role, server-side:
      `node "${CLAUDE_PLUGIN_ROOT}/scripts/auth-matrix.js" auth-matrix.json`
      exits 0 (matrix format: `security` skill, section 5). Exit 1 is a leak or
      a refused allowed role; exit 2 is an unmeasured cell, not a pass.
- [ ] Fail-closed auth (deny by default, not allow by default)
- [ ] No SSRF vectors (user URLs validated against private IPs)
- [ ] Middleware covers all /dashboard/* and /api/* routes
- [ ] HTTP security headers set (X-Frame-Options, CSP, X-Content-Type-Options)
- [ ] Rate limiting on auth endpoints
