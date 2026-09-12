---
name: supabase
description: Supabase CLI, Postgres performance, and schema patterns. Use for database operations, queries, RLS, and migrations.
when_to_use: "Invoked when the user says \"db\", \"supabase\", \"postgres\", \"rls\", \"migration\", \"schema\", \"table\", \"database\", \"edge function\"."
allowed-tools: Bash, Read, Write, Edit, Grep, Glob
model: opus
user-invocable: true
---

# Supabase

Resolve the actual project, database environment and current authorization before
any remote write. Use an available supported CLI, connector or approved SQL
connection; no transport is inherently more reliable or more authorized.

## Discover commands and target

Read the project's Supabase config, installed CLI version and relevant help.
Consult the [CLI reference](https://supabase.com/docs/reference/cli/introduction)
when the local command differs. Do not invent `db execute` or assume every
command accepts `--project-ref`.

```bash
supabase --version
supabase db push --help
supabase functions deploy --help
```

`supabase status` describes the local stack and can print credentials. It is
not a remote health probe; keep secret-bearing output out of the transcript.
Database pushes use the verified linked target or supported explicit database
connection. Function deployment has its own target flags. Check each operation.

Existing login/profile or environment credentials may be reused within scope.
A 401 can indicate expired, missing or insufficient credentials as well as the
wrong account. Inspect without printing tokens; do not repeat an unchanged
request or silently fall back to another account. Load
[rules/multi-account.md](rules/multi-account.md) when relevant.

## Migrate and prove

1. Read migration history and the intended schema/data change. Capture before
   behavior and the exact target; distinguish local, preview and production.
2. Prepare a versioned migration, including data backfill and recovery where
   needed. Existing scope determines whether remote application is authorized.
3. Exercise it on a disposable local or approved preview database. A reset
   destroys data; it is not a generic repair step for a shared database.
4. For a linked target, `supabase db push --dry-run` shows pending migrations;
   it does not execute or verify them. Apply only after reconciling that list
   with the intended target and migration history.
5. Capture each command's real exit status and output before summarizing.
   A `tail`, `grep`, background start or “up to date” message is not proof.
6. Read back schema/history and run the relevant access and business queries.
   For functions, call the known deployed version with representative inputs;
   deploy success alone does not prove runtime behavior.

Use the project's approved SQL mechanism for direct queries. With psql, enable
`ON_ERROR_STOP` so a script error cannot appear successful. Read connection
metadata without displaying passwords. Select direct/session/transaction
connections for the actual client requirements; use the dashboard's connection
string rather than guessing pooler hostnames, ports or modes.

## Access control is a runtime property

RLS declarations are only a structural start. Verify grants, role identities and
policy behavior against populated fixtures. An empty anonymous response can
mean no rows or the wrong target, so it is insufficient by itself.

For a private per-user table, a starting example is:

```sql
CREATE TABLE public.notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY notes_owner ON public.notes
  FOR ALL TO authenticated
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);
```

Grant only the operations the application needs. Test the owning user, a second
user and anonymous access for those operations; verify denied attempts leave
data unchanged. Also test intended privileged/service behavior. Keep service
credentials server-side. The example does not establish a finished schema,
authorization model or tested migration.

A profile creation trigger needs its own least-privilege review and signup
failure tests. Do not copy a trigger that creates a new table without applying
and testing that table's access rules. Choose FK deletion behavior from the data
lifecycle; `ON DELETE CASCADE` is not a universal default.

See [RLS guidance](https://supabase.com/docs/guides/database/postgres/row-level-security)
for current policy semantics and query-planning considerations.

## Performance follows measurements

Measure the actual query plan and representative data before adding indexes,
rewriting policies or changing connection limits. A sequential scan can be
appropriate for a small table. Check indexes, N+1 round trips, pool saturation
and row-dependent policy work; compare before/after latency and plans.

Load the relevant shipped reference for a concrete question:

- [Query indexes](references/query-missing-indexes.md)
- [Connection pooling](references/conn-pooling.md)
- [RLS performance](references/security-rls-performance.md)
- [RLS basics](references/security-rls-basics.md)
- [N+1 queries](references/data-n-plus-one.md)
- [EXPLAIN ANALYZE](references/monitor-explain-analyze.md)

Illustrative counts or speedups in references are hypotheses for this project,
not measured results. `EXPLAIN ANALYZE` executes the statement; use an appropriate
fixture/transaction for writes and account for external side effects.

## Recovery and completion

For additive changes, retain compatible readers/writers until the migration is
verified. For destructive changes, prove a restore or forward-repair path and
preserve the data it requires. A commented inverse DROP statement is not a
tested rollback.

Report the candidate/migration IDs, target, executed checks, observed data/access
outcomes and remaining gaps. Continue other authorized work if credentials or a
remote action is blocked; keep the database-dependent acceptance incomplete.
