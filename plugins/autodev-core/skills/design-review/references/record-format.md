# Record format

The CLI prints JSON to stdout and never modifies an input file. Evidence paths
are relative to each review's directory. Absolute paths, parent escapes and
symlink escapes are refused. Preserve each capture in a new directory.

Minimal definition (the full 26-criterion matrix will initially be unknown):

```json
{
  "product": "Maintenance enquiry",
  "audience": "Customers requesting a site quotation",
  "primaryTask": "Submit enough detail to prepare a quotation",
  "brandRules": ["Use this product's existing tokens"],
  "references": [],
  "calibration": "unavailable",
  "revision": "exact commit plus build or dirty-source digest",
  "cases": [{"id":"mobile-long", "route":"/enquiry", "viewport":{"width":390,"height":844}, "role":"customer", "data":"long description, optional reference absent", "state":"error then retry"}],
  "acceptance": {
    "task-completion": [{"name":"saved enquiry matches submitted values", "operator":"eq", "expected":true}]
  }
}
```

Checks support `eq` for finite scalar values and `lte`/`gte` for finite numbers.
Their names/operators/expected values are frozen with the definition and catalog.
Set acceptance for every applicable measurable/usability criterion. An omitted
acceptance contract is unknown even if an observation claims success.

An observation in `review.observations`:

```json
{"criterion":"task-completion", "caseId":"mobile-long", "revision":"exact commit plus build or dirty-source digest", "evidence":[{"path":"task.json", "sha256":"REPLACE_WITH_SHA256_OF_FILE_BYTES", "kind":"interaction"}]}
```

Contents of `task.json`:

```json
{"criterion":"task-completion", "caseId":"mobile-long", "revision":"exact commit plus build or dirty-source digest", "checks":[{"name":"saved enquiry matches submitted values", "operator":"eq", "expected":true, "observed":true}]}
```

Keep collector command, timestamp, environment, raw assertion output and captures
in the evidence record as additional fields. `observed` is a recorded claim from
the collector, not independently re-run by the ledger. The CLI derives pass/fail
from file assertions, never an observation's hand-entered status.

For judgment, use a `review` artifact with the same identity fields and
`judgment: {disposition: "concern" or "acceptable", rationale: "...", reviewer: "..."}`.
Also attach a `screenshot` artifact. Screenshot hashes prove byte identity. The
reviewer must actually inspect the image. Review artifacts can include annotated
areas, affected user task, contrary evidence and alternative interpretations.

Use `{criterion, caseId, revision, applicable:false, rationale:"..."}` only for
actual non-applicability. This is an explicit scoped exclusion, never a pass.
All-N/A reviews cannot be verified. Calibration `approved` requires at least one
reference with `source`, `approvedBy` and `approvedAt`. This records approval,
it does not obtain it. Never invent approval data.

For after evidence retain the same definition except `revision`. The contract
hash intentionally excludes revision so comparable candidates can differ. A
changed audience, scope, viewport, data/state, reference, criterion catalog or
acceptance condition requires a fresh comparable baseline. Hashes are integrity
checks, not signatures or authorization.

Record diagnoses and batches as reviewable notes, for example:

```json
{"cause":"Independent card row sizing", "component":"ServiceOptions", "evidence":["desktop-layout.json"], "hypothesis":false, "impact":"Comparison actions move after wrapped titles"}
```

Outcome values start at null. When measured, use records such as
`{"value":12,"unit":"minutes","population":"3 enquiry reviews","period":"pilot week 1","source":"owner time log"}`.
Task completion should carry attempts and successes. Track support requests,
staff quote-preparation time and qualified enquiries only when those observations
exist. These notes are reported unchanged. The ledger does not validate commercial
causality or compare incomparable populations automatically.
