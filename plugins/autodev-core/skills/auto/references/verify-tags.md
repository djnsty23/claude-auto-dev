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

If no `verify` field exists, auto infers from the task type (UI → visual+a11y+design, API → api+security, etc.).

## The acceptance principle

Before marking a task done, verify each acceptance criterion. "Does it compile?" is not acceptance — "does it behave correctly?" is.
