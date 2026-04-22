# Persist Findings to prd.json

After aggregating audit results, write findings to prd.json so they survive session restart and /compact.

## 1. Read current prd.json

```bash
node -e "try{const p=require('./prd.json');const sp=p.sprints?p.sprints[p.sprints.length-1]:p;console.log('sprint:',sp.id||sp.name||p.sprint||'unknown','stories:',Object.keys(sp.stories||p.stories||{}).length)}catch{console.log('no prd.json')}"
```

If no prd.json exists, create one with `sprint: 1`.

## 2. Deduplicate against existing stories

Before adding, check if a similar story already exists:

```javascript
const isDuplicate = (title, file) => Object.values(stories).some(s =>
  s.title.toLowerCase().includes(title.toLowerCase().slice(0, 25)) ||
  (file && s.notes?.includes(file))
);
```

## 3. Batch trivial findings

Story count is not a quality metric. A sprint of 12 aria-label stories inflates output and hides real work.

- 1-line fixes in the same category and area → one story (e.g. "Add missing aria-labels to components (5 files)")
- Same root cause, different files → one story with `notes` listing all files
- Auto-fixable by a grep + sed → one story
- Distinct root causes → distinct stories

Only split when issues require individual reasoning.

## 4. Add new stories

ID format: `S{sprint}-AUD-{number}` (e.g., `S3-AUD-001`).

```json
{
  "S3-AUD-001": {
    "id": "S3-AUD-001",
    "title": "Fix XSS vulnerability in user input",
    "priority": 0,
    "passes": null,
    "type": "fix",
    "category": "security",
    "notes": "src/api/auth.ts:45 - dangerouslySetInnerHTML with user data",
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

## 5. Create session Tasks

So `auto` can start fixing immediately:

```typescript
TaskCreate({
  subject: "Fix XSS vulnerability in user input",
  description: "src/api/auth.ts:45 - dangerouslySetInnerHTML with user data",
  metadata: { type: "security", priority: 0, prdId: "S3-AUD-001" }
});
```

## 6. Report

```
Created [X] stories in prd.json from audit findings.
- [N] Critical (priority 0)
- [N] High (priority 1)
- [N] Medium (priority 2)
- [N] Low (priority 3)
- [N] skipped (duplicates of existing stories)

Say "auto" to start fixing (works Critical→Low), or "audit [feature]" to audit specific area.
```

## 7. Score tracking

Log the score to `.claude/sprint-history.md` and compare against previous audits:

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
npm audit --production 2>/dev/null | tail -15
```

Include critical/high vulnerabilities in the Security category of the report.
