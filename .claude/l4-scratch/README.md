# L4 bootstrap round — evidence tree

Committed on purpose. The adversarial-loop skill says a deliverable needs a
recovery path and an untracked one has none, so the round's evidence is tracked
even though the round LOG is not (`.claude/reports/` is gitignored by design so
raw audit output cannot be staged).

## What is in here

| path | what it is |
|---|---|
| `BRIEF.md` | the audit brief handed to the adversary, verbatim |
| `tooling/check-population-reporting.js` | a COPY of the real gate, carrying a DELIBERATELY PLANTED defect (see below). Not the real gate. Nothing runs it but this round |
| `tooling/fixture-absence.js` | a one-line script that claims an absence with no population and no control, so the copy has something to flag |
| `test-strict-exit.js` | the adversary's acceptance test |
| `findings.md` | the adversary's findings, appended incrementally as it worked |

`../l4-control/` holds the SAME tree with the gate UNMODIFIED. It exists so
every claim about the plant is a comparison rather than a single reading: the
two differ by the plant and by nothing else.

## The planted defect

The shape of F1 from PR #105: a gate that prints a failure verdict and exits 0,
so a CI step reading only the exit code accepts it. Planted here as

```
-    if (strict) process.exit(1);
+    if (strict) console.log(`[population] FAIL: ...`);
     process.exit(0);
```

**This copy is not a bug report about the real `tooling/check-population-reporting.js`.**
The real one exits 1 under `--strict` and is verified doing so in `../l4-control/`.
