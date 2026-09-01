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

## Why `findings.md` is NOT tracked here

It was, for one commit, and the repo's own gate refused it: the adversary pastes
real stack traces, so the file carries absolute home paths and this repo is
public. `check-no-private-names` and `check-no-home-paths` both fired on it.

That is the correct outcome and the split the repo's rule prescribes. Raw audit
output is a REPORT; reports live under `.claude/reports/`, which is gitignored
so they cannot be staged, and they are durable by being appended rather than by
being committed. The copy of record is
`.claude/reports/l4-bootstrap-findings.md`. What stays tracked here is the
evidence a later reader needs and that carries no machine-specific path: the
brief, the two subjects, the fixture and the acceptance test.
