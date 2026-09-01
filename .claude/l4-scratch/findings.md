Measured: `node .claude/l4-scratch/tooling/check-population-reporting.js --strict` printed:

```text
  NO-POPULATION NO-CONTROL  tooling/fixture-absence.js
[population] 2 script(s) read across 1 directory(ies), 2 report an absence or all-clear, 1 of those are missing a population line or a control
[scope] control detection is per-FILE: a guard on one branch clears the whole file, and a control living in a separate suite is not seen. A clean result means a control exists, not that every absence is guarded.
[population] FAIL: 1 script(s) missing a population line or a control
```

and exited 0.

## F1 — Strict failure exits successfully

When at least one script is flagged and `--strict` is supplied, `scan()` prints an explicit `FAIL` verdict but then unconditionally calls `process.exit(0)`. CI therefore accepts the failed strict gate.

Acceptance test: `.claude/l4-scratch/test-strict-exit.js`

Command: `node .claude/l4-scratch/test-strict-exit.js`

Output (exit 1):

```text
node:assert:152
  throw new AssertionError(obj);
  ^

AssertionError [ERR_ASSERTION]: strict failure output must produce a failing exit code; stdout:
  NO-POPULATION NO-CONTROL  tooling/fixture-absence.js
[population] 2 script(s) read across 1 directory(ies), 2 report an absence or all-clear, 1 of those are missing a population line or a control
[scope] control detection is per-FILE: a guard on one branch clears the whole file, and a control living in a separate suite is not seen. A clean result means a control exists, not that every absence is guarded.
[population] FAIL: 1 script(s) missing a population line or a control

    at Object.<anonymous> (C:\Users\nstyp\claude-auto-dev\.claude\worktrees\vigorous-maxwell-7ac5dc\.claude\l4-scratch\test-strict-exit.js:30:12)
    at Module._compile (node:internal/modules/cjs/loader:1830:14)
    at Object..js (node:internal/modules/cjs/loader:1961:10)
    at Module.load (node:internal/modules/cjs/loader:1553:32)
    at Module._load (node:internal/modules/cjs/loader:1355:12)
    at wrapModuleLoad (node:internal/modules/cjs/loader:255:19)
    at Module.executeUserEntryPoint [as runMain] (node:internal/modules/run_main:154:5)
    at node:internal/main/run_main_module:33:47 {
  generatedMessage: false,
  code: 'ERR_ASSERTION',
  actual: 0,
  expected: 0,
  operator: 'notStrictEqual',
  diff: 'simple'
}

Node.js v24.15.0
```

## Exhaustiveness check

Command: `findstr /n /c:FAIL /c:process.exit .claude\l4-scratch\tooling\check-population-reporting.js`

Output (exit 0):

```text
445:        process.exit(0);
447:    if (strict) console.log(`[population] FAIL: ${flagged.length} script(s) missing a population line or a control`);
449:    process.exit(0);
659:            console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${c.name}${ok ? '' : `  got [${got}] want [${want}]`}`);
666:    process.exit(failed ? 1 : 0);
```

The strict scan failure at line 447 reaches the unconditional zero exit at line 449 (F1). The only other executable `FAIL` output is the selftest case reporter at line 659, whose aggregate exit at line 666 is nonzero when any case failed.

Known-positive control command: `node .claude/l4-scratch/tooling/check-population-reporting.js --selftest`

Output (exit 0):

```text
  PASS  absence with no population and no control is flagged twice
  PASS  absence with a population and a control is clean
  PASS  absence with a population but no control keeps NO-CONTROL
  PASS  a script making no absence claim is never inspected
  PASS  an absence pattern in a non-printing line is not a verdict
  PASS  the N/N idiom counts as a population
  PASS  a suite gets no exemption from NO-CONTROL
  PASS  a population on a continuation line of the same call is seen
  PASS  a population word with no quantity is prose, not a denominator
  PASS  a control named only in a comment is not a control
  PASS  a population spliced with + counts, not only a template literal
  PASS  bare scanned/examined/population without a number do not count
  PASS  a closing paren inside a string does not truncate the call
  PASS  an opening paren in a comment or a regex does not extend the call
  PASS  console.log named inside a string is not a call
  PASS  an inert string holding the vocabulary is not a control
  PASS  a regex after return does not truncate the emitting call
  PASS  a leading-operator continuation cannot drop the verdict
  PASS  a method named throw does not supply a control
  PASS  a multi-line call inside the radius is read whole
  PASS  a verdict beyond the radius is missed, and that is the stated limit
[selftest] 21 case(s) run, 21 passed, 0 failed
```

## Out of scope

- The scanner-radius and control-scope limits already documented in the subject header were not treated as findings.

## T1 - defect in the acceptance test

The original test required `[population] FAIL:`, a banner emitted only by the defective subject. The corrected precondition instead requires the fixture's `NO-POPULATION NO-CONTROL` finding row, which both implementations emit, and then asserts only the contract: strict mode must return a nonzero status when a script is flagged.

Planted-subject command: `node .claude/l4-scratch/test-strict-exit.js`

Output (exit 1):

```text
node:assert:152
  throw new AssertionError(obj);
  ^

AssertionError [ERR_ASSERTION]: strict failure output must produce a failing exit code; stdout:
  NO-POPULATION NO-CONTROL  tooling/fixture-absence.js
[population] 2 script(s) read across 1 directory(ies), 2 report an absence or all-clear, 1 of those are missing a population line or a control
[scope] control detection is per-FILE: a guard on one branch clears the whole file, and a control living in a separate suite is not seen. A clean result means a control exists, not that every absence is guarded.
[population] FAIL: 1 script(s) missing a population line or a control

    at Object.<anonymous> (C:\Users\nstyp\claude-auto-dev\.claude\worktrees\vigorous-maxwell-7ac5dc\.claude\l4-scratch\test-strict-exit.js:34:12)
    at Module._compile (node:internal/modules/cjs/loader:1830:14)
    at Object..js (node:internal/modules/cjs/loader:1961:10)
    at Module.load (node:internal/modules/cjs/loader:1553:32)
    at Module._load (node:internal/modules/cjs/loader:1355:12)
    at wrapModuleLoad (node:internal/modules/cjs/loader:255:19)
    at Module.executeUserEntryPoint [as runMain] (node:internal/modules/run_main:154:5)
    at node:internal/main/run_main_module:33:47 {
  generatedMessage: false,
  code: 'ERR_ASSERTION',
  actual: 0,
  expected: 0,
  operator: 'notStrictEqual',
  diff: 'simple'
}

Node.js v24.15.0
```

Control-subject command: `node .claude/l4-control/test-strict-exit.js`

Output (exit 0): empty.

The temporary control test copy was deleted after the run.
