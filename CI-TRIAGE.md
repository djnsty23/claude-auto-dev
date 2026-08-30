# Why CI is dark, and whether main would pass

`[measured 2026-08-29T21:00Z to 2026-08-30T04:50Z]` against `origin/main` at **5087cac**,
VERSION 8.142.0. Workflow `CI` (`.github/workflows/ci.yml`, id 333126439) is
`disabled_manually`. **Nothing has been re-enabled and no workflow setting was changed.**

**Population: 200 workflow runs examined, 325 recorded in total, 11 sibling repos checked.**
Sibling repos are anonymised as Project A through D because this repo is public.

## Verdict

The question "why did CI fail on 2026-08-25" contains a false premise. **Two unrelated
things happened five days apart, and only the first was a test failure.**

| when | what | ran? |
|---|---|---|
| through 2026-08-20T14:02Z | a real test failure, one assertion, **identical on both platforms** | yes |
| 2026-08-21T18:04Z to 2026-08-25T13:43Z | **account locked due to a billing issue**, 91 runs refused | **no** |
| 2026-08-25, after the last run | somebody disabled the workflow | n/a |

**Would main pass today?** On Windows, yes, measured. On Linux, unverified: I cannot
execute it here and am not going to claim otherwise.

## The 91 "failures" from 08-21 onward are not test results

Every run in that window completed in 3 to 4 seconds with **zero steps** and **no runner
assigned**. The annotation on the check-run carries the reason verbatim:

```text
"The job was not started because your account is locked due to a billing issue."
```

Confirmed identical at the start, middle and end of the window (runs 32511457133,
32724055346, 32855089882). GitHub reports this as `conclusion: failure`, which renders as
an ordinary red X and is indistinguishable from a failing test. **A gate that cannot start
is not a gate that failed.**

Two probes disagreed about this and one of them is a trap worth recording:

- `actions/jobs/<id>/logs` returns **HTTP 404** for these runs.
- `actions/runs/<id>/logs` returns a **valid, empty** zip archive, exactly 22 bytes.

Neither is evidence about the tests. The job-level 404 is the endpoint failing; the 22-byte
zip is a genuine empty archive, because a job with no steps produces no logs.

**The account is not locked now.** Sibling repos ran successfully tonight while this
workflow sat disabled: Project A at 2026-08-29T21:15Z (122s, success), Project B at 20:08Z
(63s, success), Project C at 12:49Z (11s, success). So the block that produced those 91 red
Xs is gone, and CI is dark now only because the workflow is still switched off.

**One thing the billing story does not explain, stated rather than smoothed over:**
Project D ran successfully **eight times** between 2026-08-21T20:02Z and 23:28Z, all after
this repo's first billing-lock refusal at 18:04Z the same day. Same account, same window.
Whatever the lock actually scoped to, it was not uniformly account-wide, and I could not
determine why from the API available to me.

## The last real failure was not platform-specific

Run 32377704635, 2026-08-20T14:02Z, sha `b907390c`, the most recent run that actually
executed. Its logs survive.

| job | result | failing assertion |
|---|---|---|
| `test (ubuntu-latest)` | 27/28 suites | `test-preflight-template`, "and it is a warning, not a failure" |
| `test (windows-latest)` | 27/28 suites | **the same one** |

Both platforms, same suite, same single assertion, 20 passed 1 failed on each. So there is
no ubuntu-side mystery to explain. The assertion is
`tooling/test-preflight-template.js:124`, `check('  and it is a warning, not a failure',
r.status === 0)`, which tests exit-code handling and touches nothing platform-dependent.

**It passes today.** `test-preflight-template` is green in the local run of main below.

## Would main pass today: what I measured, and what I did not

Run in a clean detached worktree at `5087cac`, reproducing each CI step:

| CI step | command | result on Windows |
|---|---|---|
| Run test suites and validator | `npm test` | **72/72, exit 0** |
| Check every hook parses | `node --check` over `plugins/*/hooks/*.js` | **16 files, all parse** |
| Prove every suite can fail | `npm run check:suites` | **72 suites, 71 verified, 0 NOT verified, exit 0** |

**I could not run the ubuntu half.** There is no Linux available to this session, so the
whole of the section below is reading and reasoning, not execution. Treat it accordingly.

## Linux-side and environment-specific audit

The mirror image of the Windows work. Every check below prints the population it scanned.

### Clean

| check | population | result |
|---|---|---|
| `require()` case sensitivity | 288 files, 150 `.js`, 9 relative specifiers | **0 mismatches** |
| literal repo-path strings | 150 `.js`, 24 strings resolving to real files | **0 mismatches** |
| case-only filename collisions | 288 files | **0** |
| executable bits on git hooks | 288 tracked files, 2 non-644 | `commit-msg` and `pre-push` both **100755**, correct |
| line endings | `.gitattributes` | `text=auto` plus explicit `eol=lf` for `.js/.json/.md/.sh` |
| Windows constructs in shipped hooks | 16 hooks | **all guarded**, see below |

Both case checks were validated against a known positive before being believed. A planted
`require('./Test-All.js')` against the real `tooling/test-all.js` was reported as
`CASE MISMATCH: wanted "Test-All.js", on disk "test-all.js"`. The first attempt at that
control fired the **UNRESOLVED** branch instead, which would have proved nothing about the
branch under test, so it was redone.

**Hooks are the part that ships and runs inside other people's sessions, including Linux
and macOS ones, so they matter more than CI.** `agent-browser-cleanup.js` is the only hook
with real Windows constructs (`taskkill`, `powershell`, 14 occurrences) and every one sits
inside `if (isWin) { ... } else { ... }`. Three other hooks matched my pattern and were
**false positives**: `.exec(` matching my `\.exe` regex, and comments mentioning `cmd.exe`.

### The one real inconsistency: four ways to resolve "home"

Across 30+ sites in shipped code:

| pattern | example | risk |
|---|---|---|
| `USERPROFILE \|\| HOME \|\| ''` | `claude-paths.js:27` | Windows-first precedence |
| `HOME \|\| USERPROFILE` | `drift-audit.js:19`, `memory-db.js:10` | POSIX-first, opposite order |
| `HOME \|\| ''` only | `session-sweep.js:36` | ignores `USERPROFILE` entirely |
| `USERPROFILE \|\| HOME` with **no** `\|\| ''` | `fleet-heartbeat.js:26`, `fleet-notify.js:33`, `fleet-publish.js:43`, `fleet-status.js:35`, `steer-log.js:100` | `path.join(undefined, ...)` **throws** |

**None of these breaks Linux CI**, and I want to be exact about why rather than leave it
implied: on an ubuntu runner `HOME` is set and `USERPROFILE` is unset, so every one of the
four patterns resolves to `HOME`. The fourth pattern is the only one that can throw, and it
throws only where **both** variables are unset, which is a scrubbed container or a service
account rather than a normal runner.

That failure is not hypothetical, it already happened here, and the repo documents it:
`watch-panels.js:20` records "with USERPROFILE unset, path.join threw". Five sites still
carry the unguarded form.

### The APPDATA seam, which is what I was asked to confirm

`claude-paths.js:56` consults `process.env.APPDATA` on **every** platform, not just win32,
and the test harness sets `APPDATA: ''`.

**Confirmed correct on Linux, and it needed checking rather than assuming.** The read is
guarded by truthiness (`if (process.env.APPDATA)`). On Linux the variable is normally
unset, so it is `undefined`, falsy, skipped. The test sets it to `''`, also falsy, also
skipped. So the harness reproduces Linux's natural state exactly rather than diverging
from it.

The test seam controls **both** `HOME` and `USERPROFILE` (`test-claude-paths.js:53`), which
is what makes it portable. Setting only `USERPROFILE` would pass on Windows and silently
read the developer's real store on Linux.

Residual risk, low and stated for completeness: if anything ever sets `APPDATA` on a Linux
box, the store resolution would consult a Windows-shaped path. Nothing here does.

### Unexercised on this machine

These branches only run off-Windows, so nothing in my measurements covers them:

- `tooling/test-agent-browser-cleanup.js:206`, the `!== 'win32'` branch
- `tooling/test-claude-paths.js:122,142`, darwin-only assertions
- `tooling/test-session-sweep.js:252,260`, darwin-only expectations
- the `else` side of `test-brain-brief.js:85`, `test-drift-audit.js:227`,
  `test-workflow-liveness.js:124`

They are the honest gap in this audit. An ubuntu run would cover the first and the last
group; only a macOS runner covers the darwin ones, and macOS was deliberately dropped from
the matrix on 2026-08-17.

## For the operator, decided by you not me

**The workflow was not re-enabled and I did not touch any Actions setting.** It was disabled
deliberately and neither session knows the reason, so reversing it is yours.

What the evidence supports, if you are deciding:

1. **The reason those 91 runs were red is gone.** The billing lock no longer applies; three
   sibling repos ran tonight.
2. **The one real test failure is fixed.** `test-preflight-template` failed on both
   platforms through 08-20 and passes on main today.
3. **The Windows half of the matrix passes**, measured here at `5087cac`: 72/72, hooks
   parse, `check:suites` clean.
4. **The ubuntu half is unverified.** Re-enabling is the cheapest way to learn it, and it is
   also the only way, because nothing local can answer it.
5. Three PRs merged tonight reporting `mergeStateStatus: CLEAN` with **checks=0**. That
   reads like a pass and measured nothing. It is the same shape as the vacuous green in
   `BRANCH-TRIAGE.md` F4, one layer up: absent verification presenting as satisfied
   verification.
