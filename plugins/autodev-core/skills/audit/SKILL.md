---
name: audit
description: Parallel quality audit across specialized agents. Finds bugs, violations, and quality issues. Use audit for fixes, brainstorm for features.
when_to_use: "Invoked when the user says \"audit\"."
allowed-tools: Bash, Read, Grep, Glob, Task, Write, Edit
model: opus
user-invocable: true
argument-hint: "[scope: full|auth|dashboard|latest]"
---

# Audit

Find bugs, violations, and quality issues. Creates fix stories in prd.json.

**Scope:** Audit validates bug/quality findings; brainstorm develops feature and
architecture proposals. Route findings accordingly without discarding defects
discovered during ideation or pausing work already authorized by the user.

**Rules precedence.** If `.claude/project-rules.md` exists, pass its contents to
every agent you spawn; it overrides the shipped `standards` defaults while
current user instructions and repository guidance retain their authority.
It was measured from this codebase; `standards` is a shipped default. Anything
it lists as "Undecided" is not a violation — flagging it produces exactly the
false positives that make an audit worth ignoring. Generate it with
`/autodev-init`.

## Scope and execution

Load `core` before reading/writing `prd.json`. Use the current `prd-states.js`
helpers and `workPlan()` for dependency-ready state; inspect their actual API.
Do not select the last sprint by array position or treat unreadable JSON as an
empty backlog. Record the task/PR baseline and current tested revision.

Enumerate relevant source paths (`rg --files` with explicit globs/exclusions),
entry points and live flows. Count files scanned separately from matching files.
Choose the dimensions below according to the project and requested scope. Load
`rule-agent-concurrency` before dispatching and inspect available agent tools:
`Task`, `Agent`, background flags, subagent types and model names are runtime
capabilities, not APIs this skill can guarantee. Use bounded independent agents
when supported; otherwise execute the dimensions locally/sequentially and report
the limits. Do not infer model execution from a requested model label.

Each assignment names the exact worktree/ref, owned paths, questions, tool/time
budget, expected artifact and no-overlap edit boundary. Review-only agents do
not mutate the product. Returns name confirmed findings, clean checks,
unexecuted checks and evidence paths; timed-out output is incomplete.

## Framework patterns: verify safe conditions

Before scanning, load `references/known-safe-patterns.md` and pass relevant
preconditions to reviewers. These are counterexamples to naive detectors, not
blanket exemptions. Dismiss a finding only after verifying the safe conditions
apply to this instance; preserve a distinct reproduced defect in the same code.

## Agent Memory (read before scanning)

Before launching the swarm, read `.claude/agent-memory/audit-patterns.md` if it exists. This file contains:

- **Accepted noise** — scoped intentional patterns with the reason, source
  decision and last verification. Re-check the preconditions when code changes.
- **Recurring issues** — items already captured as prd.json stories. Deduplicate against these.
- **Hotspots** — files/directories that consistently surface issues. Agents can prioritize these.

If the file doesn't exist, create it with this seed (first audit only):
```markdown
# Audit Patterns (auto-maintained)

## Accepted Noise
<!-- Patterns marked as intentional — don't re-report. Format: path pattern | reason -->

## Recurring Issues
<!-- Issues already in prd.json. Format: file:line | prd-id | title -->

## Hotspots
<!-- Files with 3+ findings across audits. Format: file | count | last-seen -->
```

Pass relevant entries as context with their scope and provenance, not
instructions to skip an entire file or a newly demonstrated failure.

After the swarm completes and before writing to prd.json, append any new hotspots (files with 3+ new findings) and mark accepted-noise items if the user explicitly dismisses a class of finding.

## Audit dimensions

For each candidate: inspect the actual caller/entry point, reproduce the
behavior where possible, name a known-good control and falsifier, and retain
command/flow, ref, file:line, observed/expected result and impact. Distinguish
confirmed, unmerged, missing and unverified. Missing tooling is a gap; a zero
result needs a positive control.

| Dimension | Concrete checks |
|-----------|-----------------|
| Security | Source/migration secrets without printing values; reachable injection/XSS; input validation; CORS; SSRF; intended public/protected operations; grants/RLS and allowed/denied roles/accounts |
| Performance | Measured waterfalls, payload/bundle, N+1 queries, repeated work and resource leaks. Missing memoization or an inline object alone is not a defect |
| Accessibility | Effective names/labels, keyboard/focus, native-control semantics, contrast, input type/inputmode/autocomplete/paste, reduced motion, zoom and effective hit targets. Use `a11y`; native buttons need no extra key handler |
| Types / errors | Unsafe external data, conflicting declarations, suppression directives and error/rejection boundaries. Intentional CLI output and diagnostics are valid; investigate secret leakage/noise by context |
| UX / UI | Loading/error/empty/content, actionable feedback, persistence, actual desktop/mobile layout, overflow/long content and tokens. Verify effective image dimensions and list performance rather than requiring one CSS pattern, fullscreen modal or virtualization threshold |
| Test integrity | Critical acceptance/deny/retry paths; actual assertions and entry points; a missing test filename or raw coverage percentage alone does not establish a gap |
| Release readiness | Required config/target without exposing values; runtime asset/PWA paths; rewrites/headers; current gate checks, deployment identity and affected live flows when authorized. Do not infer deployment readiness from one successful unrelated job |

Use `security`, `perf`, `a11y`, `test`, `scan` and `rule-verification` for the
applicable execution details. Prefer focused probes over inventories of
syntactic “offenders.” Preserve domain-specific project requirements.

## Output Format

```markdown
## Audit Report

**Revision / scope:** [actual] | **Elapsed / reviewers:** [observed] | **Files / flows scanned:** [enumerated]

### Summary

| Category | Critical | High | Medium | Low | Total |
|----------|----------|------|--------|-----|-------|
| Security | X | X | X | X | XX |
| Performance | X | X | X | X | XX |
| Accessibility | X | X | X | X | XX |
| Type Safety | X | X | X | X | XX |
| UX/UI | X | X | X | X | XX |
| Test Coverage | X | X | X | X | XX |
| Deploy Ready | X | X | X | X | XX |
| **TOTAL** | **X** | **X** | **X** | **X** | **XX** |

### Critical Issues (Fix Immediately)

| # | Category | File:Line | Issue | Fix |
|---|----------|-----------|-------|-----|
| 1 | [category] | [file:line] | [observed defect + impact + reproduction] | [fix + verification] |

### High Priority (Top 10)

1. [Category] File:line - Issue
2. ...

```

### Ratings

When requested, rate dimensions /10 using an explicit rubric and current
evidence. Explain deductions, unmeasured coverage and what would improve each
score. Counts of casts/logs, absent memoization or story completion rates are
not themselves correctness evidence. Scores never authorize completion.

## Severity Definitions

| Severity | Definition | Example |
|----------|------------|---------|
| **Critical** | Security vulnerability or app-breaking | XSS, auth bypass, crash |
| **High** | Significant UX degradation or major debt | 5s load, no error handling |
| **Medium** | Noticeable but not blocking | Missing loading state |
| **Low** | Limited demonstrated impact or polish | A confirmed noisy debug message in a user-facing flow |

## Persist Findings to prd.json

After aggregation, load `references/persist-findings.md` before writing. It
uses `core` for story IDs/states, deduplicates by root cause and observable
behavior, preserves acceptance/evidence and records gaps without turning
unverified candidates into completed work.

## Focused Audit

User can audit specific features:
- `audit auth` → Only scan auth-related files
- `audit dashboard` → Only scan dashboard components
- `audit latest` → Audit the task/PR diff against its identified baseline, plus affected callers

## Quick Validation (No Agents)

Run the project’s declared validation command and retain its exit/output. In
this marketplace, quick validation is `node tooling/validate.js`; the full gate
is `npm run gate` on the clean committed tree. Another project has its own
commands. Static validation supplements the behavioral audit. Record actual
time/resource use instead of promising a fixed duration or seven agents.

## Real Results (From Production Test)

Historical report excerpt (247 files; date/raw artifacts not supplied here).
These were reported candidates/ratings, not independently reverified current
defects. Do not use this excerpt as a baseline or proof of today’s quality:

| Category | Critical | High | Total |
|----------|----------|------|-------|
| Security | 2 | 5 | 14 |
| Performance | 0 | 4 | 8 |
| Accessibility | 2 | 5 | 7 |
| Type Safety | 1 | 2 | 8 |
| UX/UI | 3 | 4 | 10 |
| Test Coverage | 23 | 15 | 38 |
| **Overall Score** | **5.5/10** | - | **85 issues** |

Key findings:
- Test coverage is the biggest gap (95% hooks untested)
- 68 components use hardcoded colors
- Edge Functions lack input validation
- 530 console statements reported; count alone does not establish a defect

## Quality Framework Reference

When rating findings, apply principles from related skills:

| Skill | What to Reference |
|-------|-------------------|
| `standards` | Type safety, design tokens, all UI states, React patterns, error handling |
| `design` | Color tokens vs hardcoded, typography consistency, structural integrity for UI changes |

**UX/UI Agent should check:**
- Styling → Reference the project’s design rules and `rule-design-system`;
  prove the applicable convention and rendered impact before flagging a choice
- Missing states → Reference `standards` (loading, empty, error)
- Design tokens → Reference `standards` design system rules

**Type Safety Agent should check:**
- Against `standards` patterns (single source of truth, complete Records, strict mode, no any)

## Log Patterns to Mistakes

When audit finds repeated issues (3+ files):
```markdown
## Pattern: [Category]
- **Task:** Audit finding
- **Root cause:** Why pattern violated
- **Prevention:** Rule to add
```
Log to `.claude/mistakes.md` for future reference.

## Plan the authorized fixes

Group confirmed issues by root cause, order fixes by impact and dependencies,
and state the verification for each. Do this before editing when the changes
interact; no threshold of five findings or extra “plan/auto” command is needed.
Continue remediation already authorized by the task. Keep unrelated feature
ideas as proposals and name any actual missing decision or external authority.
