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

Use the host’s code review capability when available. Inspect the installed
command/tool and its supported arguments; do not infer effort flags or cloud
behavior from a skill example. If unavailable, perform the review directly and
state which reviewer ran. For CLI review channels load `docs/codex-channels.md`
when present. Existing authorization applies; an unavailable preferred reviewer
does not prevent local review.

Review correctness, edge cases, error handling, data boundaries, reuse and
simplification. The project-specific checks below supplement that review.

## Before a release: review twice, independently

**Independent passes can find different defects.** In one measurement on
2026-08-17: two reviewers were given a byte-identical prompt over the same two
files, and both ran the same model. They converged on about six findings — and
each surfaced about six more the other missed entirely. One caught a
`git rev-parse HEAD^` that silently returned HEAD's own sha because `execSync`
routes through `cmd.exe`, where `^` is the escape character. The other caught two
live instructions in shipped skills that contradicted a rule in the same plugin.
Neither pass was worse; their overlap was simply partial.

For a risky release, use **two independent passes** where capability and budget
allow. Load `rule-agent-concurrency` before dispatching; use supported tools and
sequential passes if independent agents are unavailable. Record that limitation:

- Identical prompt, both read the files themselves. Do not hand the second pass
  the first one's findings — priming collapses the independence that produces the
  extra yield.
- Merge and de-duplicate afterwards, then check each surviving finding against the
  code before acting on it. Extra passes can add false positives too.
- **Ask each pass to state what it checked and found clean**, not only what it
  found. The categories one pass declares empty are where the other's unique
  findings tend to land.

Do **not** do this for routine edits. It doubles review cost for a yield that only
matters when a mistake ships — pre-release, a risky migration, anything touching
money, auth, or data you cannot re-derive. For a one-line change, one pass is the
right amount of review.

## Then check the project-specific delta

**Read `.claude/project-rules.md` first if it exists** — it was measured from
this codebase and outranks both the list below and the `standards` skill. A rule
listed there as "Undecided" must not be flagged in either direction. If it does
not exist, suggest `/autodev-init` once, then continue with the defaults below.

Work through these against the changed files and affected callers/contracts;
keep the review tied to the change’s reachable behavior.

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
real params and expected status/body/side effects, a UI change needs the
affected user flow and states in a browser, and a bulk change needs an enumerated
search proving the old behavior is gone. Check the tested revision/environment
and preserve failures or gaps; an unrelated green run is not current proof. "Types pass" is not
verification for any of those.

### 5. Supabase specifics (if the diff touches the database)
RLS policies enforce the intended access matrix. Secrets remain in trusted
server runtimes, never client-reachable code. For deployment scope, verify the
deployed revision and exercise affected functions after deploy. Defer to the `supabase` skill
for the details.

## Reporting

Report the built-in reviewer's findings and yours as one list, most severe
first. Do not repeat a finding the built-in reviewer already made — add to it.

If the delta above turns up nothing, say so in one line. A review that
manufactures findings to look thorough is worse than a short one.

## Feeding the learning loop

**Threshold — a reproduced failure recurring in separate changes suggests a
class.** Two reviewers reporting the same instance is one observation, not
recurrence. Distinguish independently confirmed incidents from duplicate reports.

When that happens, add the class to `.claude/project-rules.md` under
`## What this project keeps getting wrong` with its count, rather than writing
the comment a third time. `review` and `audit` both read that file, so a class
recorded once is checked on everything after it — which is the difference between
reviewing and teaching.
