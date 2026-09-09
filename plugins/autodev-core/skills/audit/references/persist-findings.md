# Persist Findings to prd.json

After aggregating audit results, write findings to prd.json so they survive session restart and /compact.

## 1. Read current prd.json

Load `core` and use the current `prd-states.js` helpers to enumerate all story
containers and select the intended sprint/work plan. Read the helper API before
calling it. Distinguish an absent file from malformed/unreadable JSON: only the
former permits creating a new file. Never overwrite an unreadable backlog.
Preserve all existing states and use `core`’s schema for a new backlog.

## 2. Deduplicate against existing stories

Compare root cause, affected operation/entry point, location and observable
acceptance behavior across existing stories. Title-prefix or same-filename
matches are candidate links, not proof of duplication: one file can contain
both an XSS issue and an unrelated authorization issue. Reconfirm whether a
previously done story’s fix is present on the current revision before deciding
a new reproduction is already resolved. Preserve distinct defects and link
related stories without deleting their separate acceptance criteria.

## 3. Batch trivial findings

Story count is not a quality metric. A sprint of 12 aria-label stories inflates output and hides real work.

- 1-line fixes in the same category and area → one story (e.g. "Add missing aria-labels to components (5 files)")
- Same root cause, different files → one story with `notes` listing all files
- Mechanically similar fixes → one story only when their root cause and
  verification are shared; inspect the sites before bulk replacement
- Distinct root causes → distinct stories

Only split when issues require individual reasoning.

## 4. Add new stories

Use `core`’s `S{sprint}-{nnn}` ID format (for example `S3-001`), choosing an
unused ID across all existing story containers. Store audit provenance in
`notes`, not an incompatible ID prefix. Preserve evidence: revision, file:line,
reproduction command/flow, observed/expected behavior and acceptance criterion.

```json
{
  "S3-001": {
    "id": "S3-001",
    "title": "Display saved profile names without executing scripts",
    "priority": 0,
    "passes": null,
    "type": "fix",
    "category": "security",
    "notes": "src/profile.tsx:45 at <revision>: <reproduction command/flow> executes a script from a saved name. Acceptance: saving a script as the profile name displays literal text after reload and no script executes. <evidence path>",
    "resolution": ""
  }
}
```

**Category → type + priority mapping:**

| Audit Category | `type` | Critical | High | Medium | Low |
|---------------|--------|----------|------|--------|-----|
| Security | fix | 0 | 1 | 2 | 3 |
| Performance | perf | 0 | 1 | 2 | 3 |
| Accessibility | fix | 0 | 1 | 2 | 3 |
| Type Safety | fix | 0 | 1 | 2 | 3 |
| UX/UI | fix | 0 | 1 | 2 | 3 |
| Test Coverage | qa | 0 | 1 | 2 | 3 |
| Deploy Readiness | fix | 0 | 1 | 2 | 3 |

## 5. Optional session task mirror

`prd.json` is the durable shared task record. If this host exposes a native task
UI, inspect its actual schema before mirroring stories and retain the story ID
in a supported field. Do not assume `TaskCreate` or `metadata` exists, or that
session-only tasks survive restart and drive the same scheduler.

## 6. Report

Report created/updated stories by severity, confirmed duplicate links,
unverified candidates and blocked checks, with their evidence paths. If fixing
is already authorized, proceed through `auto`’s dependency-ready execution.
Otherwise deliver the audit and concrete proposed fixes at the requested
boundary; do not silently turn an audit-only request into product changes.

## 7. Score tracking

When ratings are requested, record the rubric, evidence and unmeasured scope
alongside /10 ratings in `.claude/sprint-history.md`. Compare only equivalent
populations/checks, and do not use scores or completed-story counts as proof of
correctness. Example format (fill from actual evidence):

```markdown
## Audit [DATE]
| Category | Score |
|----------|-------|
| Security | X/10 |
| Performance | X/10 |
| ... | ... |
| **Overall** | **X/10** |
| **Delta** | **+/-X from last audit** |
```

## 8. npm audit

Run alongside the agent swarm (bash, not an agent):

```bash
npm audit --omit=dev --json
```

For an npm project, inspect the installed command/options and retain the full
JSON, stderr and process exit status. Distinguish advisories from registry/tool
failures; a nonzero status alone does not identify which. Production-only audit
omits dev dependencies, so include build/tooling supply-chain scope when relevant
and report that population separately. Do not run an automatic dependency fix
without reviewing its changes and verification.
