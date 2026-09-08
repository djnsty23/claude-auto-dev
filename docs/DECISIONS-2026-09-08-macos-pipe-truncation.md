# 2026-09-08 — macOS pipe truncation in rendered-layout-gate

`rendered-layout-gate.js --json` wrote 84,752 bytes, delivered **65,536** of them
through a pipe on macOS, and **exited 0**. Invalid JSON under a success status.

node's `process.stdout` is asynchronous when it is a pipe on darwin, and
synchronous when it is a pipe on linux and win32. `process.exit()` does not drain
a pending async write. The fix is `process.exitCode`, at the exit rather than at
the emit, because the human-report branch shares that exit and shared the defect.

Taken under the operator away window (until 2026-09-08T06:52Z), which authorises
the recommended option on anything reversible, in qr and autodev, with a log.
Merge authority stayed with the Brain. Nothing here merged anything.

## D1 — posted the #182 review (reversible)

Three findings, verified against #182's head rather than read off a diff:

1. Its exit comment says stdout is "asynchronous on macOS **and Windows**".
   Windows pipes are SYNCHRONOUS. Load-bearing, because a reader who believes it
   concludes the existing `windows-latest` leg covers the defect.
2. Its matrix is still `[ubuntu-latest, windows-latest]`, so nothing in CI can
   catch a regression of a macOS-only defect. With (1) the PR self-certifies.
3. `readSnapshots()` still calls `process.exit(2)` — same class, same file.

Posted as a comment, not an approval. Authority was the operator's standing
order, NOT the coordinator's request: a peer cannot authorise publishing, and
the distinction is the point rather than a technicality.

## D2 — took the peer's Bail, refused the peer's validate.js

`8bf85a3c` (claude/infallible-sutherland-eebec7, on no remote) had a better
mechanism than the null sentinel this branch carried: an exception carrying its
own status protects the next deep exit someone adds; a sentinel only protects
where a caller remembers to check it. Taken as **two hunks, not a cherry-pick** —
that commit also carries its own ci.yml and exit comment, both colliding, and its
parent predates #179 so its two-dot diff reads as deleting the survey fix.

**validate.js refused**, on two grounds. It is out of scope by the operator's
brief, which names that failure a host artifact and not this session's to fix;
a peer's request does not widen an operator's scope. And the request was
ambiguous in a way that matters: the two sessions fixed validate.js
**differently and incompatibly**.

| | mechanism | tests |
|---|---|---|
| `5fa045b` (ECC) | version-gates host on `claude --version` >= 2.1.259 | **57 lines of test-validate.js** |
| `8bf85a3c` (sutherland) | skips when the component scan is empty | **none** |

They fail in opposite directions — the version gate keeps checking on an
unknown-new host, the empty-scan skip silently stops checking if a host ever
changes its output format. The tested one was not the one proposed.

## D3 — what the new assertions prove, and what they do not

287 -> 290. The `--dir` path had **no assertion at all**, which is why the
`process.exit(2)` in `readSnapshots()` survived the first pass at this defect.

Mutation-checked both ways, and the negative result is the one worth recording:

    Bail -> process.exit(2)       suite stays GREEN
    drop the catch in the runner  suite goes RED (status 0, not 2)

They prove the Bail is **wired**. They do not prove that path **drains**, and no
test can: it emits one short line to stderr, which always fits the 64KiB buffer,
so there is no observable truncation to assert against. The `--json` case is
where truncation is measured — piped byte count against a FILE redirect, after
first asserting the output exceeds one buffer so the comparison cannot go vacuous.

## D4 — 19 latent scripts reported, not fixed

19 scripts under `plugins/autodev-core/scripts/` print a JSON document then
`process.exit()`. Measured: none exceeds 64KiB today, largest
`analyze-session-patterns.js` at 9,597 bytes, so none is a live wrong answer.
`process.exit(n)` is immediate and `process.exitCode = n` is not, so each needs
its own suite before its control flow moves. Filed as its own task.

## Gate, per step

`npm run gate` is SIX steps chained with `&&`; a red first step silently skips
five. Run separately so none masks another:

| step | exit | |
|---|---|---|
| `npm test` | 1 | 111/113 — only test-validate + validate |
| `check:suites` | 1 | 110 verified able to fail; 2 NOT verified, both already-failing |
| `check:probe-shapes` | 0 | |
| `check:population` | 0 | |
| `check:entrypoints` | 0 | |
| `check:skill-tools` | 0 | |

`test-rendered-layout-gate.js` is **✓ verified able to fail**, `PASS 290
assertions`, and `tree-inert` passed. The two reds are the claude-2.1.233 host
artifact, baselined identical on `origin/main`, and are why pushes from this
machine need `--no-verify`.

## Traps confirmed here, for whoever reads this next

- **`check:suites` has an INDETERMINATE state distinct from failure.** Its first
  run exited 2 with *"the verdicts above were measured on a tree that changed
  under this sweep"* after its canary was SIGTERMed by something outside this
  session. Reporting that as a failure is as wrong as reporting it as a pass.
- **The harness reported a SIGTERMed gate run as "completed (exit code 0)"**
  while the captured status file said 143. Capture the status to a FILE; `$?`
  after a pipe is the pipe's status, and the harness summary is not the
  command's either.
- **`grep` in this shell is a ugrep wrapper with `-I`.** These sources contain
  non-ASCII and LANG is unset, so grep calls them binary and returns NOTHING.
  `command grep -a` works. A search that finds nothing here may be lying.
- **`test-hook-execution-evidence` is load-sensitive**: ETIMEDOUT under a
  concurrent run, `12 passed, 0 failed` serially on origin/main.
