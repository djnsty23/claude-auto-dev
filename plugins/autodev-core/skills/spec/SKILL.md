---
name: spec
description: Turns a one-line product idea into a spec, a data model and a prd.json backlog, so setup-project and auto can run without a manual planning hop. Use when the user describes something to build rather than a change to make.
when_to_use: "Invoked when the user says \"spec\", or describes a product in a sentence — \"build me a habit tracker with streaks\", \"I want a tool that watches competitor pricing\". NOT for changes to an existing feature; that is a story, not a spec."
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, AskUserQuestion
model: opus
user-invocable: true
---

# spec

One sentence in, three artifacts out: `SPEC.md`, a schema, and a `prd.json`
backlog `auto` can work. This is the step between "build me X" and a running
sprint, and it exists because `setup-project` deliberately refuses to invent one
— it will scaffold a project and skip `prd.json` entirely unless a plan already
exists. This skill is where the plan comes from.

## The failure mode this skill is designed against

A planning skill does not crash. It emits confident filler: *Auth flow*,
*Dashboard layout*, *Set up the database*, *Polish UI*. That list looks like a
plan, fits any product ever conceived, and its cost lands later — `auto` grinds
through stories nobody can tell are finished, and the sprint ends with everything
green and nothing working.

So the bar is not "produced a backlog". It is **every story names something a
person can do, and says how you would know it works.** `check-spec-output.js`
catches structural omissions and several vague wording patterns. A pass does
not establish that the plan is complete or its acceptance conditions useful;
review the actual core loop before handing it to a worker.

## Step 1 — Infer hard, ask at most once

The point of this skill is that a sentence is enough. Infer the obvious:
"habit tracker with streaks" implies users, habits, daily check-ins, a streak
derived from check-ins — do not ask about any of that.

Ask only where the answer **changes the data model or the security model**, and
ask once, in a single `AskUserQuestion` call with at most two questions:

| Ask about | Because |
|---|---|
| Multi-user vs single-user | Decides whether every table carries a user id and an RLS policy |
| Money | Payments pull in Stripe, webhooks, an orders table, and idempotency |
| Real-time vs request/response | Decides subscriptions vs plain queries |
| Who can see whose data | Team/org scoping is expensive to retrofit |

Anything else, decide yourself and write the decision into SPEC.md under
**Assumptions**. A stated assumption is correctable in one line; an interview
costs the thing the user came here for.

## Step 2 — SPEC.md

Short and load-bearing. Sections, in this order:

1. **What it is** — one paragraph, in the user's words, sharpened.
2. **The core loop** — the thing someone does repeatedly. If you cannot name it
   in a sentence, the idea is not ready and you should say so rather than plan.
3. **Assumptions** — every inference from step 1, as a list, each one falsifiable.
4. **Non-goals** — what this is explicitly not doing in v1. This section is what
   makes the scope real; a spec without it will grow to fill the sprint.
5. **Done means** — the observable that ends v1. Not "it works" — "a signed-in
   user can log a habit for today and see a streak count that survives a reload."
6. **External services** — every account, credential, domain, payment method,
   legal page, store listing or third-party approval the product implies. One
   bullet per item, the service name first, then what is needed and the exact
   console URL:

   ```
   ## External services

   - Supabase — a project, its URL and anon key (https://supabase.com/dashboard)
   - Vercel — a project linked to the repo, with the two Supabase variables set (https://vercel.com/new)
   - Stripe — an account, a webhook endpoint and its signing secret (https://dashboard.stripe.com/register)
   ```

   Or the single word `none`. This section is read mechanically: `check-spec-output`
   requires it, and every item in it becomes a setup story in step 4. The prose
   above it will name services in passing ("Supabase holds the members") and
   the checker cross-reads them; a service named in the prose and missing here
   is a note, but a missing section is a failure, because that is the case that
   shipped: `[measured 2026-09-07]` a greenfield spec named Supabase and Vercel
   and planned no human step for either, and `auto` discovered the missing
   project on its first story.

## Step 3 — The data model first

Write the schema before the stories. It is the expensive thing to get wrong and
the cheap thing to reason about now, and the stories fall out of it almost for
free.

For a Supabase project, emit `supabase/migrations/0001_init.sql` with:

- Tables with real column types, not `text` for everything. Timestamps are
  `timestamptz`. Money is `integer` cents, never a float.
- `alter table <t> enable row level security;` on **every** table, and at least
  one policy. RLS enabled with no policy denies everyone, including the app —
  that reads as "auth is broken" and wastes a debugging session.
- Policies that are deny-by-default: grant to `auth.uid() = user_id`, never
  `using (true)` on a table holding user data.
- Foreign keys with an explicit `on delete` — deciding it now is free.

For anything else, emit the equivalent (`schema.sql`, a Drizzle schema, a
`models.py`) and keep the same rules about ownership and defaults.

## Step 4 — Stories from capabilities, not layers

Walk the core loop and ask, at each step, what a person must be able to do. Each
of those is a story. The schema tells you what data each one touches.

Follow the `core` skill's story shape and load its `references/requirements.md`.
Two fields carry the weight here:

- **`title`** — a capability, phrased so a stranger knows what changed when it is
  done. "Log a habit for today from the home screen", not "Habit UI".
- **`acceptance`** — observable outcomes with stable `{id, description}` entries:
  what appears, what a query returns, what gets rejected. Keep diagnostic context
  in `notes`; it cannot replace an explicit acceptance list. Record verification
  tags or explicit obligations in `verify`.

Link each spec-driven story through `specRefs` to the reviewed requirement files
that constrain it. Keep their plain-English content in `specs/`, linked from
SPEC.md, and record exact revisions as described in core's requirements reference.

Everything else: `passes: null`, `realness: null`, `priority` 0-3 with at most a
couple of 0s, `type` from fix/feature/refactor/qa/perf.

Record dependencies as `blockedBy: ["S1-001"]`, not just ordering in prose.
The first story should have nothing in front of it. Group 5-8 into sprint 1
and put later work in later sprints using the same container shape. Do not mix
root-level stories with sprint-level stories: runtime readers prefer the latter
and can hide the former. Keep every story id unique across the fresh spec.

### Setup stories: the human steps, as stories, on day one

Every item under **External services** becomes a story too, and it is the only
kind of story that is born blocked:

```json
"S1-000": {
  "id": "S1-000",
  "title": "Create the Supabase project and put its URL and anon key in Vercel",
  "priority": 0,
  "passes": "needs-setup",
  "realness": null,
  "type": "setup",
  "category": "setup",
  "acceptance": [
    { "id": "env-listed", "description": "The Vercel project lists NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY" },
    { "id": "home-renders", "description": "A deploy renders the home page rather than the setup notice" }
  ],
  "blockedReason": "Create a project at https://supabase.com/dashboard (about 5 minutes), apply supabase/migrations/0001_init.sql in the SQL editor, then paste the project URL and anon key into the Vercel project's environment variables.",
  "resolution": ""
}
```

- `type: "setup"` and `passes: "needs-setup"` go together; the checker rejects
  one without the other.
- `acceptance` is still the outcome list — the observable an AGENT verifies
  once the person says it is done. `blockedReason` is what the person does and
  where, with the URL; it is the handback, and `wizard`'s rules for a handback
  apply to it (atomic, exact target, how long).
- **Every story that cannot run without it lists it in `blockedBy`.** That is
  what makes `auto` wait for the person instead of failing the sign-in story
  against a project that does not exist. Sign-in depends on the Supabase
  project; the payment flow depends on the Stripe account; the "no config"
  notice story depends on nothing.

The operator sees these under "Blocked on you" in `status` from the first run,
which is the point: the accounts get created while the agent builds the parts
that do not need them, instead of being discovered one at a time.

## Step 5 — Verify before handing over

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/check-spec-output.js" prd.json supabase/migrations/0001_init.sql --spec SPEC.md
```

Resolve the installed scripts directory from this skill when the plugin-root
environment variable is unavailable. Pass the actual PostgreSQL initial-schema
path; a supplied missing or empty file is a failure. For another backend, omit
that argument and run its native schema checks separately, naming what ran.

The checker rejects malformed/duplicate stories, several generic title and
acceptance patterns, malformed/missing/cyclic dependencies, stale spec revisions,
and new PostgreSQL tables without explicit RLS and policy
declarations. Comments and strings do not count. It supports ALTER TABLE for
RLS settings only, and refuses other ALTER/DROP lifecycle forms (except DROP
POLICY). Put initial columns and constraints in CREATE TABLE.
Use direct declarations in the initial schema; execute migrations in an isolated
database to verify SQL and the actual access model. A policy declaration does
not prove ownership, operation coverage or grants. Verify authorized and denied
access with real queries before calling the data layer complete.

With `--spec SPEC.md` it also rejects a SPEC.md with no **External services**
section, a declared service with no setup story naming it, a setup story that is
not born `needs-setup`, and a setup story whose `blockedReason` has no URL. A
service it rejects as unplanned is one `auto` would have hit on its first story.

Read each rejection: wording heuristics can reject concrete criteria too.
Clarify the observable instead of inferring that the feature is impossible.

Then report:

```
Spec: <name>
  SPEC.md         — core loop, N assumptions, M non-goals, E external services
  0001_init.sql   — T tables, RLS/policy declarations checked; runtime pending
  prd.json        — S stories in sprint 1, K held back
  Blocked on you  — E setup stories (ids): one line each, what and where

Assumptions I made without asking: <list>

Next: continue to setup-project and auto when implementation was requested;
otherwise hand over the spec and its assumptions. The setup stories can be done
while auto builds the rest.
```

Surfacing the assumptions in the handover is the cheap half of this skill. The
user reads five lines and catches the wrong one now, instead of after `auto` has
built on it.

## When to refuse

If the idea has no core loop you can name — "an AI platform for business", "a
social app" — do not plan it. Say what is missing and ask for the one sentence
that would fix it. A backlog generated from a vague idea is worse than none: it
looks like progress and it commits the project to a shape nobody chose.
