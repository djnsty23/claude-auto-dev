# Brain orchestration audit — pass 1

Scope: baseline `9f9746f7907721921ce3d15fa5ae5020c0ebd227` in isolated worktree. Read-only source inspection, safe temporary fixtures, and open-PR review; no product changes or external dispatch.

Provenance: `git rev-parse HEAD` printed the baseline above. `git status --short` printed zero bytes. `git check-ignore -v .claude/reports/brain-live-audit/orchestration/findings.md` printed `.gitignore:68:.claude/reports/`.

PR snapshot: `gh pr view <id> --json number,state,headRefName,headRefOid,baseRefName,mergeCommit,title,files` found all five OPEN: #218 redispatch `18d31161e94d710174f000e602d2ede60337476a`; #215 intention ledger `85517303e868c76aa882796c58874c48e08631dc`; #214 checkpoint `271fed05f78ada7af28b8127f5bbe55368878c67`; #222 role refresh `13873e584517d218c3a30afb9974191258b7e827`; #224 coordinator reachability `3c42938a08c000c3099d61fe6aa09dcd575fc01c`. These must be distinguished from baseline omissions.

Falsifiers prepared before probes: an existing live dispatcher with durable claim/ack/retry invalidates a missing-execution-path claim; stop-hook tests that preserve runnable failed/dependency work invalidate a liveness claim; a current parent/PR implementation of any proposed gap reduces it to integration debt.

## Confirmed findings and fixes

### O1 — Task selection and Stop disagreed about the work graph (P1, fixed locally)

Baseline references: `plugins/autodev-core/skills/auto/SKILL.md:129-145` selects only the newest sprint and checks `blockedBy`; `plugins/autodev-core/hooks/stop-auto-check.js:216-259` merges every sprint but checks state alone. `prd-states.js:143-158` explicitly explains why newest-sprint-only loses work, while auto still did precisely that.

Reproduction command: `node .claude/reports/brain-live-audit/orchestration/probe-stop.cjs`. The baseline invocation's actual output is preserved in `probe-stop.jsonl` (8 fixtures, two real Stop subprocesses per fixture). Before: `older_sprint_pending`, `human_dependency`, and `dependency_cycle` each selected `[]` but both Stop invocations returned `decision:block` and `tasks remaining`. Control `control_pending` selected `[S1-001]` and blocked; `control_done` selected `[]` and approved on the second Stop. This confirms disagreement, not a claim about how often a live model would override its instructions.

Falsifier: the skill-selected set and Stop-ready set agree on a pending older sprint, a human prerequisite, and a cycle. Fixed via `workPlan(prd)` in `scripts/prd-states.js:66`, consumed by auto at `skills/auto/SKILL.md:119` and Stop at `hooks/stop-auto-check.js:215`. The planner keeps all five states and both story containers, names invalid/missing/cyclic prerequisites, and never rewrites the PRD. Blocked graphs get one reconciliation turn, then an honest bounded stop carrying unresolved reasons.

Comparison command: `node .claude/reports/brain-live-audit/orchestration/compare.cjs`; actual results are `comparison.jsonl`. Across the 8 fixtures, the baseline lost the 1 earlier-sprint ready story; the simple variant (`storiesOf` + state-only `isActionable`) restored it but selected 1 human-dependent story and 2 cyclic stories as ready; the shared plan restored the earlier story and selected none of those blocked stories. This is why merely changing the container was insufficient.

### O2 — Blocked, unknown and empty work was called complete; the test endorsed the lie (P1, fixed locally)

Baseline references: `hooks/stop-auto-check.js:242-243` calculated `blockedOnOperator` and did not use it; lines 271-294 printed `Sprint complete`. `tooling/test-stop-auto-check.js:114-120` asserted the completion text and accepted `decision !== null` as evidence that the reason named a setup blocker.

Same 8-case command/output as O1: `setup_only` had `summary.outstanding:1`, `unknown_state` had `summary.unrecognised:1`, and `empty_shape` had `summary.total:0`; all three emitted `Sprint complete` then approved. The positive control was a genuinely done story producing the same old completion path. Falsifier: setup/unknown/empty no longer asserts completion, while done/deferred still does.

Tests-first evidence: `node tooling/test-stop-auto-check.js` against the first test-only edit exited 1 with `71 passed, 19 failed` (`stop-tests-before.log`), including the exact setup naming and completion assertions. The fixed run is `91 passed, 0 failed` (`stop-tests-after.log`). Reasons are capped at 12 entries/300 characters each, naming the omitted count; a 100-story/large-reason fixture initially reproduced invalid/truncated hook JSON and now passes (`stop-large-before.log`). An approval here deliberately means the turn may end; it is not a success status.

### O3 — Shared decision allocation was not atomic (P1, fixed locally)

Baseline references: `scripts/fleet-decisions.js:113-138` reads max then appends; lines 198-222 check other authors then append. `tooling/test-fleet-decisions.js:180-192` tested three sequential CLI calls as the protection against simultaneous reservations.

Reproduction: `node .claude/reports/brain-live-audit/orchestration/probe-decisions.cjs`, original output `probe-decisions.jsonl`. Two real CLIs were paused after reading the same actual log, then released. Serial control printed `D1`, `D2`; simultaneous processes both printed `D1`, exit 0. Serial opposite pricing decisions exited 0/3 and stored one row; simultaneous `free`/`paid` both exited 0 and stored both contradictory rows. The fixture preloader delays the actual filesystem read; it does not replace allocation or validation logic.

Falsifier: real concurrent processes cannot allocate equal ids or record two unforced opposing decisions. An exclusive `wx` lock now covers the whole read/check/append transaction (`scripts/fleet-decisions.js:50`, calls at 151 and 236), with bounded wait and exit 4 identifying the lock/owner. Read-only commands remain read-only. Locks are never stolen based on age or guessed PID death.

`node tooling/test-fleet-decisions.js` first exited 1 with `37/44 passed, 7 FAILED` (`decisions-tests-before.log`). Now `44/44 passed` (`decisions-tests-after.log`), including four simultaneous reservations, two opposing writers, and live/unreadable lock preservation. Serialized controls remain in the suite.

Crash limitation is explicit and measured: `node .claude/reports/brain-live-audit/orchestration/probe-lock-crash.cjs` killed only its own fixture writer after lock acquisition. The next command refused in 2417 ms, exit 4, and preserved the lock. After `kill(pid,0)` returned ESRCH and the probe explicitly removed that confirmed orphan, a new CLI printed D1 and exited 0; normal exit removed its lock. Evidence: `probe-lock-crash.jsonl`. Automated orphan reclamation is not implemented: unsafe age-based unlocking would recreate simultaneous writers. Parent accepted this narrow bounded refusal.

#211 was checked before this fix: OPEN `ed07fb748719ebb2aae5d864948632bd49356e91`; its 6 changed files implement generated per-decision repo documentation, not the runtime fleet log or this CLI. `git show ed07fb7:docs/DECISIONS-2026-09-08-decisions-directory.md` says the subject is merge conflicts in `docs/decisions.md`. No overlap with the two race-fix files.

### O4 — The documented unattended dispatch still requires a human click (P1, architectural gap remains)

Baseline references: `skills/brain/SKILL.md:705-717`, `skills/auto-brain/SKILL.md:212-217` explicitly say `spawn_task` creates a chip that starts a session with one operator click. Auto-brain's intended setting is nobody awake (`auto-brain:13-20`). The finding is this concrete documented human handoff, not an unbounded claim that no other host can run a worker.

Control/evidence command: `git show 18d31161:plugins/autodev-core/scripts/fleet-redispatch.js`. #218's title says a killed session gets restarted, but its executable source header at lines 4-17 says rank for a human / never spawns, rule 3 at line 41 says propose, and `main()` at lines 646-734 classifies/reports rows and returns an exit code. This is a useful triage component, not an autonomous dispatcher. The live PR query confirmed OPEN, not deployed. Falsifier: a configured dispatcher consumes eligible pending chips/restart candidates, starts actual workers without human transport, and records durable acceptance/ownership; a proposal or a task chip alone does not falsify it. No such product/session action was attempted in this audit.

Known work is credited: #215 adds fleet intention records and a Stop writer, #214 adds exposure/usage checkpoint commit/push plus intent write, #218 reads those intentions and verifies/ranks restart candidates, #222/#224 fix coordinator identity/reachability. All five heads are not ancestors of baseline: `compare.cjs` runs and prints each exact `git merge-base --is-ancestor <head> 9f9746f` command, each exit 1. Their feature files were inspected with `git show`, not inferred from titles. These are integration dependencies, not missing inventions.

### O5 — Auto supplied a competing release/verification contract (P1 guidance, fixed locally)

Baseline `skills/auto/SKILL.md:107` piped build into tail; line119 allowed skipping checks over ten seconds; lines203-205 waived browser verification for internal/admin UI and treated an API deploy/status as verification; lines394-411 separately instructed direct database migration, function deployment, and production-triggering push based on `HEAD~1`. `skills/ship/SKILL.md:94-128` already has exact-commit gate, eligibility, ledger, undo and special-case escalation requirements. This was a conflicting nearer instruction, not an absent ship skill.

At parent's request auto now detects project commands/manager, runs checks without losing exit status, applies real browser/flow checks to internal UI, delegates every deployment/production-triggering push/merge to ship, reads the entire range from verified live deployment SHA, and verifies live version plus behavior. Preexisting authorization persists. Deferred work remains deferred until an explicit changed mandate, removing a second conflict at old auto:478.

Validation: `node tooling/test-skill-prd-commands.js` exits 0: `68 SKILL.md scanned`, `10 inline commands`, `6 prd readers`, 5 runnable readers detect all 6 state fixtures; one preexisting archive-prd illustrative command is explicitly not runnable. Auto's duplicated inline latest-sprint status command was removed and the shared plan now supplies that status. Its actual selector code is executed in `test-prd-states.js`, so this does not leave selector correctness to prose. `node tooling/test-prd-container-class.js`: `20 passed, 0 failed`.

## Independent review and remaining risks

The proof-audit peer found my first cycle implementation missed a member of overlapping cycles. I reproduced the exact A→B/C, B→A, C→B graph with a failing test (`prd-overlap-before.log`), replaced the partial DFS labeling with iterative strongly connected components, and retained the downstream-only control. `node tooling/test-prd-states.js` now prints `70/70 passed`. Independent exhaustive reference reachability in `probe-graph.cjs` compared all 512 directed three-node graphs / 1536 cycle memberships and found 0 mismatches (`probe-graph.json`). This correction is an audit result, not something the original implementation had right.

Remaining source-level hypotheses/opportunities, not implementation claims:

- `auto` still has a retry budget in prose (`passes:false` after two retries), while failed stories are eligible again and no durable attempt budget is supplied by this patch. Durable per-task attempts/backoff and explicit retry exhaustion would prevent semantic retry loops across wakeups. A failed state with an attempt history and scheduler policy is the falsifier; a retry paragraph alone is not.
- The >2h auto flag rule dates activation, not productive work. A long running session can exceed it. Existing tests deliberately assert this behavior; it is a safety cap, not a liveness proof. A supervisor/renewable owned lease could distinguish dead session from old flag. Do not simply remove the escape hatch.
- A working branch's queue is not automatically the newly written trunk queue. Auto-brain says sessions pull trunk, while current auto reads the working PRD. Dispatch/claim/refresh policies need an integration rehearsal with two workers and moving trunk, not another broad statement about autonomy.
- Locked-out decision writers now fail safely and visibly. A killed writer still requires verified orphan cleanup. This is bounded recovery debt, explicitly accepted instead of an unsafe stale-lock takeover.

## Delivery state

Owned tracked edits: `plugins/autodev-core/scripts/prd-states.js`, `plugins/autodev-core/hooks/stop-auto-check.js`, `plugins/autodev-core/skills/auto/SKILL.md`, `plugins/autodev-core/scripts/fleet-decisions.js`, and existing tests `tooling/test-prd-states.js`, `tooling/test-stop-auto-check.js`, `tooling/test-fleet-decisions.js`. No commit or push by this agent. Parent coordinates the full gate and final commit. `git diff --check` exited 0. No product mutation, installed-config change, external session message, or surviving fixture process. All probes use removable temporary directories; only ignored evidence remains here.

## Final population-integrity correction before freeze

Parent/spec review supplied a focused counterexample: parsed JSON `{"sprints":[{"stories":{"__proto__":null,"GOOD":{"passes":true}}}]}`. The shared nested reader assigned `merged[id] = story`, invoking the inherited prototype setter. `Object.entries` then saw only GOOD and `workPlan` incorrectly returned `complete:true`. Tests-first: `node tooling/test-prd-states.js` exited 1, `70/74 passed, 4 FAILED`, including own-key visibility, preserved ordinary prototype, invalid-record/incomplete reporting, and later-sprint override (`prototype-tests-before.log`).

`Object.defineProperty` now copies enumerable own keys safely while retaining the ordinary object prototype and later-sprint-wins semantics. Inspection found the explicitly duplicated memory reader using `Object.assign(stories || {}, sp.stories)` with the same setter behavior. Its focused real SessionEnd regression exited 1, `30 passed, 1 failed` (`memory-prototype-before.log`); the ordinary GOOD record positive control passed. The same safe own-property copy fixes that reader.

After: PRD states 74/74, memory SessionEnd31/31, container class20/20, Stop91/91; `git diff --check` exit0. Actual outputs: `prototype-tests-after.log`, `memory-prototype-after.log`, `container-tests-after.log`, `stop-tests-after.log`. Two additional owned files are `plugins/autodev-memory/hooks/memory-session-end.js` and its existing `tooling/test-memory-session-end.js`. No commit. Tracked edits frozen for the parent's full gate.
