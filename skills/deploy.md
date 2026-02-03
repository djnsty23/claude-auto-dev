# Deploy Workflow

## Vercel (default)
```bash
# Preview
npx vercel --yes

# Production
npx vercel --prod --yes
```

## Pre-deploy Checklist
1. `npm run typecheck` - passes
2. `npm run build` - passes
3. `npm run test` - passes (if available)
4. No `console.log` in production code
5. Environment variables set in hosting platform
6. `.env` not committed

## Supabase Edge Functions
```bash
# Deploy single function
supabase functions deploy [name] --project-ref [ref]

# Deploy all
supabase functions deploy --project-ref [ref]
```

## Post-deploy
- Verify production URL loads
- Check critical user flows
- Monitor error logs for 5 minutes
