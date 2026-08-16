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

- Never commit .env, API keys, credentials
- Validate user input with Zod
- Use parameterized queries
- Supabase: RLS policies required, secrets in Edge Functions only
- Test edge functions after deploy (curl with real params, verify response)
- Verify bulk changes eliminated the old pattern completely (grep for remnants)
