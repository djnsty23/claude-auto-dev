---
title: Optimize RLS Policies for Performance
impact: HIGH
impactDescription: 5-10x faster RLS queries with proper patterns
tags: rls, performance, security, optimization
---

## Optimize RLS Policies for Performance

Poorly written RLS policies can cause severe performance issues. Use subqueries and indexes strategically.

**Incorrect (function called for every row):**

```sql
create policy orders_policy on orders
  using (auth.uid() = user_id);  -- auth.uid() called per row!

-- Per-row work depends on the actual execution plan
```

**Correct (wrap functions in SELECT):**

```sql
create policy orders_policy on orders
  using ((select auth.uid()) = user_id);  -- Inspect the actual plan

-- Measure before/after on the actual policy set and representative data
```

Use a security-definer helper only when its ownership, schema, search path and
execute grants are deliberately constrained. Review its privileged access and
qualified column names; do not treat SECURITY DEFINER as a free optimization:

```sql
-- Create helper function (runs as definer, bypasses RLS)
create or replace function is_team_member(team_id bigint)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.team_members
    where team_members.team_id = $1 and team_members.user_id = (select auth.uid())
  );
$$;

-- team_id depends on the outer row: SELECT does not make this statement-constant
create policy team_orders_policy on orders
  using ((select is_team_member(team_id)));
```

Consider indexes on policy predicates using the actual plan and write/storage
tradeoffs. A possible index to evaluate:

```sql
create index orders_user_id_idx on orders (user_id);
```

Reference: [RLS Performance](https://supabase.com/docs/guides/database/postgres/row-level-security#rls-performance-recommendations)
