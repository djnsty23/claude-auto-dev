# Security (Always Applied)
- Never commit .env, API keys, credentials
- Validate user input with Zod
- Use parameterized queries
- Supabase: RLS policies required, secrets in Edge Functions only
- Test edge functions after deploy (curl with real params, verify response)
- Verify bulk changes eliminated the old pattern completely (grep for remnants)
