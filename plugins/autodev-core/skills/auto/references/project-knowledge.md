# Project knowledge

What auto saves to auto-memory after a hard problem, and the events that trigger a save.

After solving hard problems (debugging, retries, unexpected errors), save reusable lessons to auto-memory:

| What to Save | Example |
|-------------|---------|
| **Environment quirks** | "This project uses Vite on port 5173, not CRA on 3000" |
| **Error fix recipes** | "RLS 'permission denied' → check auth.uid() in policy, not custom function" |
| **Architecture patterns** | "API routes follow /api/v1/[resource]/route.ts pattern" |
| **Build gotchas** | "Must run `npm run generate` before build (Prisma client)" |
| **Test setup** | "Tests need `TEST_DB_URL` env var, seed with `npm run seed:test`" |
| **Deploy requirements** | "Vercel needs `ANALYZE=true` for bundle analysis" |

Also save after these events:
- **Same error 3+ times across tasks** → save as known pattern with fix recipe
- **Unexpected project structure** → save the actual structure for next session
- **Workarounds discovered** → save so next session doesn't rediscover them

This builds per-project context that compounds across sessions.
