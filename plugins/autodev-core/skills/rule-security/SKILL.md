---
name: rule-security
description: "Security rules this project always applies: secret handling, input validation, parameterized queries, and Supabase RLS. Load before writing code that touches credentials, user input, queries, or auth."
when_to_use: "Always-on background rules. Not user-invocable."
user-invocable: false
allowed-tools: Read, Grep, Glob
paths:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.js"
  - "**/*.jsx"
  - "**/*.sql"
  - "**/*.env*"
---

- Keep credentials and secret-bearing env files out of commits and logs. Safe example files contain names/placeholders only.
- Validate untrusted input at its actual boundary using the project's supported validator or explicit schema checks; Zod is one implementation, not a prerequisite for every language/runtime.
- Use parameterized queries and validate identifiers separately.
- Enforce authorization where the operation executes, including hook-internal subprocesses; an outer tool guard does not constrain every child action.
- Keep privileged credentials in server-side secret mechanisms. Edge Functions are one server environment, not the only permitted one.
- For exposed Supabase tables, apply and test grants/RLS using representative identities and populated controls; policy text alone is not runtime access proof.
- After an authorized function deployment, verify the known deployed version with real representative inputs and resulting state.
- Before a deploy, run `security-gate.js` from this plugin's scripts: exit 1 blocks, exit 2 is "not run". A green run proves its listed rules, not the app.
- Serve a per-request nonce CSP with `'strict-dynamic'`, `object-src 'none'`, `base-uri` and `frame-ancestors`; a static `'unsafe-inline'` script policy is no policy.
- A browser extension checks every message's sender and allows each message type only from the contexts that need it; privileged tokens live where content scripts cannot read them.
- Anything a stolen credential can repeat gets a server-side ceiling: a rate limit, a maximum quantity, a token expiry.
- Check related occurrences before declaring a class fixed. A no-hit search needs an eligible population and known-positive control; identical syntax in another context may be legitimate.
