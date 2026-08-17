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
enforces that mechanically; the rules below are how to satisfy it honestly rather
than by wording around it.

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

Follow the `core` skill's story shape exactly. Two fields carry the weight here:

- **`title`** — a capability, phrased so a stranger knows what changed when it is
  done. "Log a habit for today from the home screen", not "Habit UI".
- **`notes`** — the acceptance criterion, stating an **observable**: what appears,
  what a query returns, what gets rejected. "Tapping a habit inserts a check-in
  for today and the streak count increments without a reload." This is the field
  `auto` reads to decide whether it is finished, so vagueness here is what causes
  a story to be closed early.

Everything else: `passes: null`, `realness: null`, `priority` 0-3 with at most a
couple of 0s, `type` from fix/feature/refactor/qa/perf.

Order by dependency, not importance — the first story should be the one with
nothing in front of it. Group 5-8 into sprint 1 and leave the rest unsprinted;
a 40-story sprint 1 is a wish, not a plan.

## Step 5 — Verify before handing over

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/check-spec-output.js" prd.json supabase/migrations/0001_init.sql
```

It fails on generic titles, ids that do not match `S{n}-{nnn}`, stories that are
already marked done, acceptance criteria that lean on "works" / "correctly" /
"as expected" instead of saying what is observably true, and any table created
without RLS. **A failure is a real finding about the plan, not a
formatting nit** — a story it rejects as generic is one `auto` could not have
finished either.

Then report:

```
Spec: <name>
  SPEC.md         — core loop, N assumptions, M non-goals
  0001_init.sql   — T tables, all with RLS
  prd.json        — S stories in sprint 1, K held back

Assumptions I made without asking: <list>

Say 'auto' to start building, or correct any assumption first — they are one
line each in SPEC.md.
```

Surfacing the assumptions in the handover is the cheap half of this skill. The
user reads five lines and catches the wrong one now, instead of after `auto` has
built on it.

## When to refuse

If the idea has no core loop you can name — "an AI platform for business", "a
social app" — do not plan it. Say what is missing and ask for the one sentence
that would fix it. A backlog generated from a vague idea is worse than none: it
looks like progress and it commits the project to a shape nobody chose.
