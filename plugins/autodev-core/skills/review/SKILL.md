---
name: review
description: Review changed code for correctness and quality, then apply the project-specific checks Claude Code's built-in reviewer does not know about.
when_to_use: "Invoked when the user says \"review\", \"check this\", \"review the diff\", or before shipping a change."
allowed-tools: Bash, Read, Grep, Glob, Task
model: opus
user-invocable: true
argument-hint: "[quick|deep]"
---

# Review

**Run Claude Code's built-in reviewer first. Do not re-implement it here.**

```
/code-review
```

Pass an effort level when the user asked for one: `/code-review low` for a quick
look, `/code-review high` or `max` for a thorough pass. `/code-review ultra`
launches a multi-agent cloud review — it is user-triggered and billed, so
suggest it rather than assuming it.

That skill already covers correctness bugs, edge cases, error handling, unsafe
casts, reuse and simplification, and it verifies its own findings before
reporting. Everything below is the delta: things it cannot know because they are
decisions this project made.

## Then check the project-specific delta

Work through these against the changed files only.

### 1. prd.json alignment
If a `prd.json` story covers this change, does the diff actually satisfy its
acceptance criteria — or only the easy half? Flag partial completion explicitly
rather than marking the story done.

### 2. Design tokens
No hardcoded colors. Semantic tokens only (`text-foreground`, `bg-background`),
with the one exception the `rule-design-system` skill documents for dynamic
gradient surfaces. This is a project convention, not a general rule, so a
general-purpose reviewer will not flag it.

### 3. UI states
Every component that fetches handles all four: `loading → error → empty →
content`. A component that renders only the happy path is incomplete here even
when it compiles.

### 4. Verification actually ran
Cross-check against `rule-verification`: an API change needs a real curl with
real params, a UI change needs a browser check with a clean console, a bulk
change needs a grep proving the old pattern is gone. "Types pass" is not
verification for any of those.

### 5. Supabase specifics (if the diff touches the database)
RLS policies present and deny-by-default. Secrets only in Edge Functions. Edge
functions tested after deploy, not just deployed. Defer to the `supabase` skill
for the details.

## Reporting

Report the built-in reviewer's findings and yours as one list, most severe
first. Do not repeat a finding the built-in reviewer already made — add to it.

If the delta above turns up nothing, say so in one line. A review that
manufactures findings to look thorough is worse than a short one.
