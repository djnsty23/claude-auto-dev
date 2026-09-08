---
title: Enable Row Level Security for Multi-Tenant Data
impact: CRITICAL
impactDescription: Database-enforced tenant isolation, prevent data leaks
tags: rls, row-level-security, multi-tenant, security
---

## Bind row policies to a verified identity boundary

RLS applies policy expressions; it cannot make a user-controlled identity value
trustworthy. A direct SQL client able to set `app.current_user_id` can choose
another value, so that setting alone is not database-enforced authentication.
If a trusted backend sets request context, document and test who can set it,
how it is scoped/reset with pooling, and which database roles can bypass RLS.

For Supabase Auth with UUID ownership, a starting policy is:

```sql
alter table public.orders enable row level security;
create policy orders_user_policy on public.orders
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
```

Apply only the needed grants, and test the whole policy set with populated rows.
The owner can perform allowed operations; another user and anonymous callers
cannot access or mutate protected rows. Check denied writes left data unchanged.
Privileged/service paths need separate review because their access differs.

An empty response without a populated positive control is not isolation proof.
A declaration check cannot substitute for these runtime tests.

Reference: [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
