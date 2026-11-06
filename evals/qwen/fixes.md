# Qwen fix taxonomy

Every correction Claude makes to a Qwen draft in arm b gets a code: the rule Qwen broke, plus a
one-line example from the draft. `node evals/qwen/run.js taxonomy` rebuilds the table from the
arm b rows in `results.jsonl`, reusing a code when Claude cites it or the rule text matches.
Codes that recur become rules in `system-prompt.md`, and the next run measures whether they helped.

| Code | Rule Qwen broke | Example | Count |
|---|---|---|---|
| Q1 | Apply the rule to every case it covers, and update the comment that states the rule | cad-383f548: anchored 4 of 13 build and cache names at the root, left the header comment on the old rule | cited in 4 of 4 corrected arm b drafts |
| Q2 | Export a name the task implies with exactly that name and the shape its name says | a list constant the test iterates was never exported (`is not iterable`) | 1 arm b, 3 arm a failures |
| Q3 | Copy SEARCH text verbatim from the file shown, or the edit applies nothing | cad-3d877e2: `SEARCH text not found` on a retyped line | 2 arm a failures |

Codes as of 2026-11-04, from 20 tasks with terse briefs (the private set). Adding Q1 to Q3 to
`system-prompt.md` moved Qwen alone from 4/20 first-attempt and 10/20 final passes to 6/20 and
14/20, one sample at temperature 0.6.
