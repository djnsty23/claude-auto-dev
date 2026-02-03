# Quality Checks

## TypeScript
- Strict mode: no `any`, no `as any`
- Run: `npm run typecheck`
- Fix: Use proper types, generics, or `unknown` with type guards

## Security
- No secrets in code (grep for password=, apiKey=, token=)
- Supabase: RLS policies on all tables
- Input validation with Zod at system boundaries
- Parameterized queries only

## Performance
- No N+1 queries (use joins or batch)
- Lazy load routes and heavy components
- Images: use next/image or proper sizing
- Bundle: check for unnecessary dependencies

## Code Style
- Remove console.log before commit
- No dead/commented code
- Imports: remove unused
- Components: handle loading, error, empty states
