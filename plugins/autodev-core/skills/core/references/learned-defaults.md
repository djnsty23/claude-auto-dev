# Defaults learned from a security and performance sweep

Build these in from the first commit. Each one was found late, in a shipped product, by a sweep that
read the code. A default costs a line at build time and a migration, a deploy and an incident later.

Eight of the classes have a static signature and an advisory rule in `security-gate.js`. The rest
need a decision at design time, so they live here. `docs/learned-rules.md` holds the measured precision.

## Classes with a gate rule (advisory)

| Class | Rule | Default to build in |
|---|---|---|
| Inline `require` in an ES module | `esm-inline-require` | Static `import` at the top. `createRequire` only when a CJS-only package forces it. A build that targets a new module system re-greps for `require(` first. |
| Admin or operator route with no server-side role check | `admin-no-role-check` | One layout per operator tree (`admin`, `debug`, `workers`, `internal`, `staff`) that checks the role on the server and returns not-found, never a redirect that leaks the route. Each page and route handler also checks, so a moved file stays closed. Hiding a nav link is not a gate. |
| RLS policy calling `auth.uid()` or a role helper per row | `sql-policy-initplan` | Write `(select auth.uid())` and `(select public.has_role(...))` in every policy. The planner then evaluates once per query, not once per row. |
| Foreign key with no covering index | `sql-fk-unindexed` | The migration that adds `references` adds `create index` on the referencing column in the same file. A cascade delete or a join on an unindexed FK scans the child table. |
| `select('*')` | `select-star` | Name the columns. A wide row (jsonb, text, embeddings) rides every read otherwise. A head-only count is the exception. |
| Cron job calling `fetch` with no timeout | `cron-fetch-no-timeout` | `signal: AbortSignal.timeout(ms)` on every fetch, and a per-step share of the function's time limit. One hung upstream otherwise holds the whole run. |
| Backup, export or dump reading a table unranged | `backup-unbounded-read` | Page with `.range()` until a short page returns. The API caps one response (1000 rows on Supabase) and truncates silently, so a backup is incomplete and says nothing. |
| Third-party list call on a hot path with no cache | `uncached-stripe-list` | Wrap list and search calls in a cached read with a TTL, and revalidate on the webhook that changes the data. Billing pages are read far more often than billing changes. |

## Classes with no signature

These need a design decision. A grep cannot tell a bug from a choice.

- **Fail closed on identity.** A route checks a role by comparing ids with `===`. A `bigint` column
  arrives as a string through PostgREST, so `1 === '1'` is false and the check falls to the least
  privileged branch. Parse every id at the boundary with a Zod schema that coerces int8 to a number
  or a string, and compare after parsing. Absent or unparseable means no access.
- **Zod at every boundary.** Request bodies, query strings, webhook payloads, third-party responses and
  RPC results. `as` casts on external data are the same defect as unchecked input.
- **Counters stay out of hot rows.** A per-scan or per-view increment on a row that readers also load
  makes every write take a row lock and every read wait on it. Put counters in an append-only table or
  a separate counter table, and roll them up on a schedule.
- **Bounded windows.** A stats query takes a date range with a default and a cap. "All time" is a
  parameter someone must ask for, not the default.
- **Local JWT claims for auth on read paths.** `getUser()` is a network round trip to the auth server on
  every request. Verify the token locally with `getClaims()` and keep `getUser()` for the writes that
  need a fresh revocation check.
- **ISR for public pages.** A public page with no per-user content sets `revalidate` and renders from
  the cache. `force-dynamic` on a marketing or content route is a decision that needs a reason.
- **Batched sends with resume.** A bulk email or notification job sends in batches, records each
  recipient's outcome before the next batch, and picks up where it stopped. A restart must not
  resend or skip.
- **Cache the token, not the request.** Minting a third-party token per request spends the vendor's
  rate limit. Cache it until shortly before expiry. Cache retention must be at least the reader's TTL,
  and every cache table has a prune.
- **Scope cache keys to the account.** A key built from the resource id alone serves one account's data
  to another.
- **Pause hidden tabs.** Polling checks `document.visibilityState` and stops when hidden.
- **Sign-out clears state on both sides.** Revoke the server session, clear role and account state held
  by the client, and send `Clear-Site-Data` for the cache and storage the user could have filled.
  A user switch in one tab must not leave the previous user's role in memory.
- **One role store.** Two places that say who is an admin drift apart. Keep one, read it fresh, and
  have every other surface derive from it.
- **OAuth callbacks and SSO linking.** The callback signs out a user who is not on the allowlist. Link
  an identity to an account only on a verified email.
- **Cron routes fail closed.** A route guarded by `CRON_SECRET` rejects every call when the secret is
  unset, never accepts them.
- **No dev surfaces in production.** Token-minting endpoints, staging routes and debug tools are
  excluded from the production build, not hidden by an env check at run time.
- **Admin data stays out of public bundles.** An admin list imported by a public page ships to every
  visitor. Load it from an admin-only route.
- **Test output does not trigger the dev watcher.** Write test and report output outside the
  directories the dev server watches, or each run reloads the browser.
