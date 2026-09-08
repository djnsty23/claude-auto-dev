# Acceptance Criteria & Verify Tags

When creating stories in prd.json (via audit, brainstorm, or bootstrap), include testable acceptance criteria and a `verify` array that tells auto which checks matter for this specific task.

## Example

```json
{
  "S13-001": {
    "title": "Fix SSRF in webhook endpoints",
    "verify": ["security", "test"],
    "acceptance": [
      "curl to http://169.254.169.254 from webhook returns 400",
      "curl to https://example.com from webhook returns 200"
    ],
    "passes": null
  },
  "S13-002": {
    "title": "Add dashboard page",
    "verify": ["visual", "a11y", "design"],
    "passes": null
  }
}
```

## Tag meanings

| Tag | What auto checks |
|-----|-----------------|
| `visual` | `computer` screenshots at 390 and 414, `read_console_messages` clean |
| `a11y` | Labels on inputs, focus-visible rings, aria-labels, keyboard nav |
| `design` | Design token compliance check |
| `security` | Hardening check patterns (fail-open, unsafe casts, SSRF) |
| `auth` | Auth deny-by-default verified, middleware coverage |
| `test` | Write or verify a test for the critical path |
| `api` | curl with real params, verify 200 + response shape |
| `flow` | Drive the primary flow the acceptance criterion describes in the browser, read the outcome back as a value, write `.claude/evidence/<story>/flow.json`, and pass it through `scripts/flow-evidence.js` — exit 0 closes the story; a record with no assertion is refused (SKILL.md, "Runtime flow check") |

If no `verify` field exists, auto infers from the task type (UI → visual+a11y+design, API → api+security, etc.). `flow` is inferred whenever an acceptance criterion names something the user sees or gets — "the row appears in the list", "the total on the card equals the total in the header", "the request carries the account id" — regardless of task type. A criterion that names no user-visible outcome ("typecheck passes", "the helper returns null on empty") gets no flow check; the `visual` tag's screenshots are not a substitute for it, and it is not a substitute for them.

```json
{
  "S13-003": {
    "title": "Save a generated QR to the dashboard",
    "verify": ["visual", "flow"],
    "acceptance": [
      "after Save, the dashboard lists one new row with the entered URL",
      "the POST to /api/codes carries {url, label} and returns 201"
    ],
    "passes": null
  }
}
```

The `flow.json` for that story asserts `subject: "dom"`, `expected: 1` for the row count read back with `find`, or `subject: "network"` with the request shape read back with `read_network_requests`. "The dashboard looked right" is refused by the validator.

## The acceptance principle

Before marking a task done, verify each acceptance criterion. "Does it compile?" is not acceptance — "does it behave correctly?" is.
