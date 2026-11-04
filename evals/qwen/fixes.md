# Qwen fix taxonomy

Every correction Claude makes to a Qwen draft in arm b gets a code: the rule Qwen broke, plus a
one-line example from the draft. `node evals/qwen/run.js taxonomy` rebuilds the table from the
arm b rows in `results.jsonl`, reusing a code when Claude cites it or the rule text matches.
Codes that recur become rules in `system-prompt.md`, and the next run measures whether they helped.

| Code | Rule Qwen broke | Example | Count |
|---|---|---|---|
