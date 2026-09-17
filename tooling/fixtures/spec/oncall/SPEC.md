# On-call this week

## What it is

A single page for one small team. It shows who is on call for the current
week, lets any member of the team change it, and, when it changes, renders a
Slack-style preview of the announcement the team would post ("**Priya** is on
call this week, taking over from **Sam**"). Supabase holds the members, the
weekly assignments and the change log. Vercel serves the page.

## The core loop

A member opens the page, sees this week's on-call person, changes it when the
rota moves, and reads the Slack-style message that the change produced.

## Assumptions

Each of these was inferred from the one-line idea, not asked. Each is
falsifiable by one line of correction.

1. **One team.** There is exactly one team in v1; every signed-in member sees
   and can edit the whole rota. No organisations, no invitations.
2. **Anyone who signs in is a member.** Sign-in is a Supabase magic link to an
   email address. The first sign-in creates the member row. Gating who may
   sign in is a non-goal for v1 (the page URL is private to the team).
3. **A week starts on Monday** and is stored as its Monday date (`week_start`,
   a `date`). "This week" is computed from the browser's local date.
4. **One person on call per week.** No shifts, no secondary, no overlaps.
5. **The preview is rendered, not sent.** Nothing posts to Slack. The message
   text is stored with the change so the preview is reproducible after reload.
6. **Request/response, not real-time.** A change updates the page that made
   it; another member sees it on their next load. No subscriptions.
7. **No money, no roles.** Every member has the same rights.
8. **Missing Supabase configuration is a first-class state.** A deploy to
   Vercel before the two Supabase variables are set shows a setup notice
   naming them, and does not crash.

## Non-goals (v1)

- Posting to Slack (webhook or bot). The preview is the product.
- Multiple teams, invitations, admin roles, removing a member.
- Recurring rotations or automatic scheduling.
- Calendar integrations, reminders, e-mail.
- Time zones other than the browser's.
- Editing weeks in the past.

## Done means

A member signs in with a magic link, sets this week's on-call person from the
member list, reloads, still sees that person, and sees under the rota a
Slack-style preview naming the new person, the previous person, and who made
the change, with the same text after the reload. A second member signing in
sees the same assignment. On a deployment with no Supabase variables, the page
shows the setup notice instead of an error.

## Data model

See `supabase/migrations/0001_init.sql`: `members`, `oncall_weeks`,
`oncall_changes`, all with RLS scoped to signed-in members of the team.
