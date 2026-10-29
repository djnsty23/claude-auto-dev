# Frontier routing evidence

`run.js prepare` and `run.js run` freeze `routing-split.json` in the frontier
data directory before a worker starts. Each task id is SHA-256 hashed with the
fixed seed `frontier-routing-v1`. Odd first-32-bit values are held out; even
values are training. The manifest records every id and hash. A changed task
population requires a new data directory. Historical runs are never backfilled.

Use `--routing-arm baseline` or `--routing-arm routed` instead of `--variant`
with `prepare` or `run`. Baseline executes V0. Routed executes H1 for locate
tasks and V1 for fix, review and decide tasks. The ordinary runner still selects
the plugin pin and grades the endpoint oracle. Every new run records its split
and executed variant as `route`; unrelated plan arms do not become routing arms.

The preregistered margin is 0.05 in absolute pass-rate units. The comparison is
descriptive over the finite frozen task set, not statistical population
non-inferiority. It requires one repeat-1 outcome in each arm for every held-out
task. Missing, duplicate, pre-split, leaked, ungraded or unmatched inputs cannot
pass. Both sides must share task content, account, harness revision, snapshot
and plugin pin. The actual model must equal the requested model on each row.

Run `node plugins/autodev-core/scripts/frontier-evidence.js observe` after
finishing the pairs. It writes `routing-comparisons.jsonl`, including incomplete
and inferior outcomes. Repeated unchanged observations print nothing and append
nothing. `--data DIR` selects a private test data directory. There are no model
calls in the observer.

A brain-clock observer entry can schedule the same writer beside the installed
clock, without relying on a repository checkout:

```json
{"id":"frontier-evidence","script":"frontier-evidence.js","args":["observe"],"everyMin":60}
```

The skill-window total uses the newest comparison for each split, dated by the
last source outcome rather than observer execution time. A stale success or a
success superseded by incomplete evidence cannot satisfy the current window.
Installing code or passing synthetic tests does not itself supply live outcomes.

## Learning seal

At split time, each task also gets a full SHA-256 content hash covering its JSON,
brief, answer key and support text. The hash never moves when task text changes.
The runner scans its frozen configuration, plugin pin and the frontier data
directories `lessons/`, `prompts/` and `learning/` immediately before starting
the worker. Learning jobs must put their consumed lessons and prompts in those
directories. Keep those inputs available until the corresponding runs start.
The current evaluation prompt is not a learning input.

Each run carries `heldOutHash`, `sealed` and a `seal` receipt with the check time,
input digest, files scanned, exposure hits and read errors. A changed task, a
copy of its brief or support text in learning inputs, or an unreadable input
sets `sealed` false. JSON-escaped text and whitespace changes are recognized.
Sealing does not claim to detect paraphrases, provider pretraining, deleted
history or inputs outside the declared corpus. It is an as-of content check;
finishing a run does not reclassify it using later lessons.

The learning-window total requires a nonempty set of held-out runs in the
window, all sealed with matching hashes before their start timestamps. Routing
comparisons also reject unsealed held-out outcomes. Existing calibration-arm
requirements remain in place.
