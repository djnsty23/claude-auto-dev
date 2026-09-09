# Brain mission runtime: B05–B08 implementation plan

Status: design only, 2026-09-09. No runtime, hook registration, installed configuration, fleet state, external session, or tracked source was changed for this pass. This is a proposed implementation slice, not a claim that unattended delivery now works.

## Decision and boundaries

Build one durable mission runtime with an explicit worker adapter and a supervisor that runs outside plugin hooks. First prove the complete local control loop with an isolated fixture worker; then admit a real worker adapter with a measured start/readback/recovery contract. Do not launch production missions from the fixture result.

B05 (durable mission state), B06 (actual dispatch/readback), B07 (durable result/acknowledgement), and B08 (persistent bounded retry) form one loop. Shipping a journal alone would improve recoverability but would not remove the user from transporting work and results. The first implementation must exercise all four with a fixture and visibly remain incomplete when an adapter is unavailable.

Keep the existing five PRD states. `prd-states.js::workPlan` remains the source for dependency-ready work across all sprints; runtime attempt states do not become new `passes` values. A commit, a model saying complete, a cleared queue, a Stop event, a score, and an adapter's exit zero are each insufficient to mark acceptance verified or a release successful.

The supervisor is a separately invoked local process or an explicitly registered host integration. Node plugin hooks cannot call this conversation's Codex desktop tools, `Workflow`, or a peer messaging tool merely because those tools are available to the assistant. A host integration must expose and test that bridge. Hooks are bounded event producers, not embedded agent schedulers.

## Source boundary and current evidence

Source was initially read at `c32a54ecfd596b19272efa67408247f7a1b99a22`. During this pass the parent committed skills at `e1b6aacde570ac4ab9ee44c8e1f3d86733410fab`; executable claims below were checked against that immutable ref. The relevant Stop report and Brain-role scripts are byte-identical between those two commits. The parent's current gate result is outside this plan's evidence.

Commands use the audit worktree `<audit-worktree>`. To reproduce source excerpts, run `git show <ref>:<path> | nl -ba` and inspect the indicated lines. No executable source was read from a potentially mutated live tree for these conclusions.

| Gap | Confirmed behavior and exact source | Consequence and falsifier |
|---|---|---|
| B05 | PR #215 at `85517303e868c76aa882796c58874c48e08631dc`, `plugins/autodev-core/scripts/fleet-intent.js:255,269–301`: five claim fields, four narrative states, read/merge/write then temporary-file rename. `claim_head` is preserved separately from observed facts. | Useful intent recovery; neither exclusive claims nor atomic multi-record acceptance/outbox transitions. Falsifier: an existing callable transaction/ownership/attempt API plus a concurrent-process test protecting those transitions, not an extra prose field. |
| B06 | PR #218 at `18d31161e94d710174f000e602d2ede60337476a`, `plugins/autodev-core/scripts/fleet-redispatch.js:5,15,646`: ranks candidates, explicitly never spawns. Lines 613–618 execute the narrative `record.verify` through `spawnSync` with `shell: true`. | Candidate diagnosis is not an execution adapter. Import its observations without promoting an arbitrary narrative shell string into unattended execution authority. Falsifier: actual start receipt and subsequent readback for a known worker produced by that path. |
| B07 | `e1b6aac…:plugins/autodev-core/hooks/stop-brain-report.js:12` says the hook does not send; lines 197–202 establish a silent first baseline; lines 210–222 distinguish cooldown but write `reportedAt` when producing context. Lines 359–364 return `additionalContext`. | A managed one-turn worker needs a durable result independent of a prior Stop. Emitted context is not sent, received, or accepted delivery. Falsifier: a persisted first-result record consumed once after a coordinator restart even if no later model turn occurs. |
| B08 | `e1b6aac…:plugins/autodev-core/hooks/stop-failure-note.js:64,73–77` appends `auto_active` and reason to an ignored per-day stall report and tolerates write failure; it does not persist an attempt budget or schedule a restart. | Failure visibility exists, but persistent retry/exhaustion is still missing integration. Falsifier: restart retains attempt counters and `nextEligibleAt`, with a measured bounded deterministic-failure outcome. |
| Existing recovery | `e1b6aac…:plugins/autodev-core/hooks/stop-workflow-wall-note.js:12,155,187` describes `Workflow({scriptPath, resumeFromRunId})`, suppresses an in-flight run, and emits model context. | Preserve the existing Workflow journal and keys when a real Workflow adapter is present. Do not translate that API into a Codex thread resume or pretend the hook executes it. |

Known-positive control for the narrowly stated source-absence claim: `git ls-tree -r --name-only e1b6aacde570ac4ab9ee44c8e1f3d86733410fab -- plugins/autodev-core` returned **173 tracked files**. Filtering that population by exact basename found `fleet-intent.js=0`, `fleet-redispatch.js=0`, `usage-checkpoint.js=0`; the same filter found **one each** of `stop-brain-report.js`, `stop-failure-note.js`, and `stop-workflow-wall-note.js`. This establishes that the three PR entrypoints are not shipped in this candidate, not that no similarly named capability could exist in another package or host.

### Exact open-PR overlap

Read-only command for each row: `gh pr view <number> --json number,state,headRefOid,baseRefName,title,files`. Actual heads/states from this pass:

| PR | State / exact head | Reuse and integration boundary |
|---|---|---|
| #215 | OPEN / `85517303e868c76aa882796c58874c48e08631dc` | Reuse its intent claim/observed-fact separation and recovery intake. Keep it a narrative projection or imported reference; do not fork its claim schema as a second competing intent source. Its branch/repo-name file key is not a globally unique mission/worker identity. |
| #218 | OPEN / `18d31161e94d710174f000e602d2ede60337476a` | Reuse quota reset, liveness, landed-work and verification observations as inputs. Its RESTART verdict is a proposal, not an ownership grant or spawn receipt. Unknown liveness must stay unresolved. Replace automatic execution of `record.verify` with the registered mission verification contract at the runtime boundary. |
| #214 | OPEN / `271fed05f78ada7af28b8127f5bbe55368878c67` | If adopting this checkpoint hook, B02 must first establish owned-path checkpointing, preserve another session's index, normal hooks and local-by-default persistence. Current lines 539–547 default to push and use `--no-verify`; `writeIntentRecord` at 355 is another intent writer. Do not integrate it wholesale or add a third independent checkpoint writer. |
| #222 | MERGED / original head `13873e584517d218c3a30afb9974191258b7e827` | Current candidate already incorporates the role-recovery change via merged commit `097d13f` and `c32a54e`. Do not reopen degraded peer-name recovery as an absent capability. A reachable coordinator identity still does not acknowledge a mission result. |
| #224 | OPEN / `3c42938a08c000c3099d61fe6aa09dcd575fc01c` | Overlaps role liveness/Stop report handling. Rebase any managed-result hook integration against its exact diff and #222's incorporated behavior; durable outbox correctness must not depend on whether a coordinator happens to be live at Stop. |

Ancestry command: `git merge-base --is-ancestor <original-head> e1b6aacde570ac4ab9ee44c8e1f3d86733410fab` returned **1 for all five original heads**. This does not prove absence after squash/merge. Positive incorporation control, `git log -5 --oneline e1b6aac…`, printed:

```text
e1b6aac fix(skills): preserve autonomous scope and verify actual outcomes
c32a54e Merge current Brain role recovery into the audit candidate
d88586b fix(brain): preserve work and require executable evidence
097d13f fix(brain-role): a decayed peer name is a stale field, not a lost coordinator (#222)
2efef77 docs(rule-gate-integrity): two ways a control is green because it cannot fail (#223)
```

Other backlog dependencies remain open rather than silently absorbed: B01/B09/B11/B24 bind verified artifacts and release evidence; B12 governs concurrent PRD edits; B14 governs proven-dead lock recovery; B17 measures actual model/cost; B10 is the repeated real mission evaluation. This slice must not claim to finish them through a fixture.

## Minimal durable state

Prefer one transactional local runtime database, separate from semantic memory, with explicit host admission. A SQLite prototype is the recommended design candidate because unique keys and atomic ownership/state/outbox changes are required together. This is a correctness-oriented design choice, not a measured performance claim. Compare these variants using the crash/concurrency fixtures before adoption:

| Variant | What already works | Required proof / reason not to assume it suffices |
|---|---|---|
| Baseline: atomic JSON snapshots from intent | A reader sees an old or new complete file. | Concurrent writers can read the same old snapshot; atomic rename does not itself compare-and-swap or bind acceptance to outbox insertion. Keep for narrative projection. |
| Simple alternative: append journal plus lock and snapshot | Portable built-in filesystem operations; event replay is reviewable. | Must implement partial-tail recovery, multi-process exclusion, fencing, compaction, and owner-death recovery. B14 is not solved by an age threshold. Benchmark/test this rather than asserting it is cheap. |
| Proposed: transactional SQLite state plus append-only audit events | A transaction can bind owner generation, attempt debit, state change and outbox insert; uniqueness handles duplicate event IDs. | Require actual supported Node/runtime capability, migration and backup tests, busy/IO failure behavior, and multi-process kill-point tests. No silent fallback to weaker JSON semantics. |

Host-only capability probe run during this pass:

```sh
node -e 'const s=require("node:sqlite"); console.log(JSON.stringify({node:process.version,DatabaseSync:typeof s.DatabaseSync})); const d=new s.DatabaseSync(":memory:"); d.exec("CREATE TABLE claims (id TEXT PRIMARY KEY, token TEXT NOT NULL)"); d.prepare("INSERT INTO claims VALUES (?, ?)").run("fixture", "owner-a"); try {d.prepare("INSERT INTO claims VALUES (?, ?)").run("fixture", "owner-b")} catch(e) { console.log(JSON.stringify({duplicateClaimRejected:true,code:e.code})); } console.log(JSON.stringify(d.prepare("SELECT * FROM claims").get())); d.close()'
```

Actual output, exit 0:

```json
{"node":"v24.19.0","DatabaseSync":"function"}
{"duplicateClaimRejected":true,"code":"ERR_SQLITE_ERROR"}
{"id":"fixture","token":"owner-a"}
```

This is only an availability/uniqueness control on this host. It is not a concurrency, durability, migration, distributed-filesystem or crash-recovery test. The package does not currently establish universal availability through an engines declaration. Admission must report `runtime-unavailable` when required capabilities are absent, before accepting a mission. Keep the database on a supported local filesystem; cross-host coordination needs an explicit service adapter, not a shared network SQLite file.

Four initial tables are sufficient; avoid a general orchestration framework:

1. **missions**: random `missionId`, immutable contract revision/hash, registered repo identity and host/worktree mapping, acceptance/verification contract, current phase, owner ID/generation, expected PRD revision, created time, terminal reason. Repo identity includes registered origin/project identity and verified common Git directory; basename or sanitized branch alone is insufficient. Contract changes create a revision and invalidate affected acceptance.
2. **attempts**: `attemptId`, mission/work item, monotonic attempt number, contract hash, owner generation, idempotency operation key, adapter identity/version, requested/start times, actual worker/run ID, actual repo/cwd/base/candidate, liveness evidence, failure signature/class, deadline, next eligibility, result reference. A unique live claim per work item/lane prevents conflicting workers; dependencies come from shared `workPlan`.
3. **events**: unique producer event ID, mission/attempt, generation, event type, timestamp, sanitized payload/hash. Append in the same transaction as state transitions. Observations retain provenance and observation time; they do not rewrite author claims. Preserve invalid/stale events as rejected evidence without advancing the mission.
4. **outbox**: unique result/event ID, payload hash/reference, destination coordinator identity, transport attempt count/next time, `pending | sent | received | accepted | rejected`, and corresponding receipts. Transport receipt and acceptance receipt are different facts. Result payloads/artifacts are immutable and retained until acknowledged according to an explicit retention policy.

Persist outside disposable worktrees in an explicitly resolved private runtime root. Store mission evidence with that mission or a durable artifact store, not only an ignored worktree report that vanishes on cleanup. Resolve the loaded plugin root and runtime root explicitly. A missing/invalid/unwritable runtime must surface an incomplete admission/result state, not fake success through an empty store.

Use transactions and uniqueness for transitions; state plus events are committed together. Do not promise that a database transaction also commits Git, PRD JSON, a subprocess start, or a deployment. Those boundaries need durable requests, receipts and reconciliation. Use database-supported backup/checkpoint procedures; copying only a live SQLite main file can omit WAL content.

### State and authority

Mission phases: `requested → ready → running → verifying → verified → releasing → released`, with explicit `blocked`, `exhausted`, `failed`, or `canceled` reasons. The CLI must distinguish runnable work, unresolved remaining work and actual completion. Only the authorized target decides whether `verified` or `released` is the terminal deliverable; “build locally” does not imply production deployment, and an existing production mandate must not trigger another generic approval ritual.

Attempt states: `requested → starting → running → result-pending → accepted/rejected`; add `start-unknown`, `lost`, `failed`, and `canceled` as necessary observations/outcomes. Do not collapse `starting` into `running` without a readback. A runtime accepted result says which contract was proven, not simply that the worker stopped.

Ownership uses an atomic generation/fencing token. Every state update and result includes the attempt and generation. A stale owner may report an observation but cannot accept work or perform a gated side effect. Lease expiry triggers reconciliation; it does not prove a worker is dead or authorize clearing its lock. Before replacing a worker, identify the actual host/process/native run and establish its disposition. A coordinator restart may attach to the known existing worker without spawning a second one. Distinct isolated worktrees reduce filesystem conflicts but do not themselves fence external writes.

## Adapter and supervisor contract

These are proposed internal interfaces, not claims about existing host APIs:

- `admit`: verify capability/version, authorization envelope, runtime root, repository mapping, worker executable and resume/lookup semantics. Return an explicit unsupported state when missing.
- `start(operationKey, immutableAssignment)`: request exactly the registered attempt. Assignment contains mission/contract hash, owner generation, repo/worktree/base, allowed scope/side effects, expected artifacts and completion protocol. Return a durable receipt with native identity and actual execution context, or `start-unknown`.
- `lookup(operationKey, nativeWorkerId)` and `poll`: recover receipt/liveness/outcome after restart. A timeout is not proof the worker terminated. A missing receipt is not permission to create another worker.
- `cancel`: request cancellation within the same authority envelope and confirm observed termination; never clear an active owner's record solely by age.
- `collectResult`: verify immutable result envelope identity, candidate SHA and artifact paths/hashes. Transport it through the durable outbox; do not convert worker prose into accepted evidence.

Supervisor order per bounded tick: reconcile existing starts/runs/results; consume and acknowledge results; resolve eligibility from persisted time/budget and current all-sprint `workPlan`; atomically claim eligible work and debit an attempt; call the admitted adapter outside the transaction; persist the receipt; schedule the next bounded wakeup. A busy store or unavailable adapter yields a recorded retry or blocker, never an unbounded loop.

There is no general exactly-once subprocess/network launch guarantee. The operation key deduplicates requests only if the adapter can persist and look up the launch. A local wrapper can write a receipt before starting the model subprocess and keep the operation directory stable; it still needs a measured kill-point protocol around child creation and process identity. If a crash leaves start ambiguous and the adapter cannot resolve it, keep `start-unknown` and reconcile or surface the precise limitation. Do not blindly reissue a fresh operation key.

### First real adapter candidate

The local CLI is a candidate, not yet an admitted integration. `codex exec --help` was run read-only in this pass and advertised `--json`, `--output-schema`, `--output-last-message`, `--cd`, `--thread-source`, `--sandbox`, and `resume`/`fork` subcommands. `docs/codex-channels.md` was read before proposing a CLI boundary: caller timeout need not stop the process; stdin must close; a resume needs the exact owned thread ID; desktop ownership can conflict with external resume. Historical measurements in that document require fresh conformance testing where load-bearing.

Do not invent JSONL event names from help text or hardcode a model from a preference. The admission fixture must capture the actual installed CLI's native run ID, cwd/repository/base and actual model readback, with exit and signal semantics. Do not use ephemeral sessions if durable resume is required. Use argv arrays and a closed stdin/brief file protocol; do not interpolate mission text into a shell. There is no verified CLI idempotency-key or lookup-by-operation-key flag in the help output; the wrapper must supply or explicitly lack those semantics.

A Workflow adapter, if supported by an actual host integration, should resume the original `resumeFromRunId` and preserve its journaled agent keys. It must not replay already completed journal entries. Desktop automation or messaging adapters likewise require a callable bridge with receipts; availability to an assistant conversation is not hook support. Activating a scheduler or external transport is separate from this design-only pass.

## Result acknowledgement and bounded retries

A managed worker receives its attempt identity and starting baseline before its first turn. It writes a structured result envelope before exit; the wrapper records exit/loss even if no Stop runs. Normal Stop, StopFailure, wrapper exit and recovery scans can emit duplicate observations with stable event IDs. A managed result is persisted before any notification cooldown. Cooldown limits repeated user-facing notices; it cannot suppress durable result creation or coordinator consumption.

For managed assignments, extend the existing Stop producer narrowly: append a bounded local result/observation reference rather than deciding success from HEAD movement. Keep current unmanaged-session behavior intact. If a store is busy, a uniquely named durable spool event can be replayed later, with an explicit receipt only after persistence. If both store and spool writes fail, the wrapper/supervisor must expose the missing durability and keep the mission incomplete; a hook's zero exit must not be interpreted as successful result capture.

Delivery transitions are independently observable: `pending` means durably available; `sent` means transport accepted a send; `received` means the coordinator durably ingested it; `accepted` means its validator accepted that result against the current contract. Insert receipt, state transition and next-work decision atomically. Lost acknowledgements produce harmless replay, not another worker or a second story completion. A rejected candidate retains its artifacts and reason.

Acceptance checks include mission/attempt/generation, contract revision, exact candidate/base/repo, actual verification command/result and nonempty expected test/route population, plus immutable required artifacts. A moving integration base invalidates affected evidence and creates a new bounded verification action. `verified` and `released` remain separate; release requires B01/B09/B11/B24 artifact and deployed-target proof.

For general PRD writes, depend on B12's compare/reconcile protocol: preserve unrelated stories/fields and reject a changed expected revision rather than overwrite it. There is no atomic transaction across SQLite and `prd.json`. Use a durable requested update plus verified readback/receipt and an idempotent reconcile rule. Until B12 is proven, the first fixture owns its disposable PRD exclusively and the runtime must not claim that arbitrary concurrent PRD writers are safe.

Persist worker attempts, transport retries, next eligible time, total elapsed budget, failure signature and terminal reason. Worker attempt allocation is atomic before launch. Replaying the same operation/result does not allocate another worker attempt. Adapter transport retries reuse the operation key, have a separate small bounded budget, and never turn start ambiguity into blind duplication.

Failure policy belongs to the mission contract: retryable transient failure uses bounded exponential backoff with jitter and a maximum delay; known quota recovery waits for observed reset data; unchanged deterministic acceptance failure reaches explicit exhaustion after the configured repair budget; external setup or unknown ownership blocks the affected lane while independent ready work can continue. A changed candidate or a validated repair may warrant another attempt only within persisted budgets. Do not reset counts on compaction, restart, a new Stop, or a changed narrative claim. Exhausted, blocked and start-unknown work remains incomplete.

## Concrete next implementation slice

Implement a private local runtime with **one managed fixture mission** before registering automatic production dispatch. Suggested files, subject to repository naming review:

- `plugins/autodev-core/scripts/mission-runtime.js`: schema/API/CLI, transaction-backed claims, attempts, events, result outbox and read-only status/reconcile operations.
- `plugins/autodev-core/scripts/mission-supervisor.js`: one bounded tick using an adapter interface, persisted eligibility and result acceptance. Explicit fixture mode only at first; no ambient fleet scan that starts arbitrary work.
- `plugins/autodev-core/scripts/mission-adapters/fixture.js`: real child-process fixture with durable operation receipts and controlled crash/failure points. It edits/builds only a disposable generated repo and serves a local test endpoint; it is not an LLM and cannot demonstrate idea interpretation.
- Narrow managed-mode event producers in the existing `stop-brain-report.js` and `stop-failure-note.js`, only after the durable event API is proven. Preserve existing hook timing and unmanaged behavior; do not register a long-running supervisor inside Stop.
- Existing test tooling plus dedicated runtime/adapter fixture suites. Add a real `codex-exec` adapter only after its live conformance probe establishes the missing event/receipt/liveness semantics; its first target is the same disposable mission, not production.

Start tests-first with crash-safe ownership/result delivery, then implement the smallest store and fixture adapter that satisfies the matrix below. Compare the baseline JSON snapshot behavior and simple journal alternative with the transactional candidate using the same independent expectations. Record populations, elapsed time and actual failure states; do not select by a subjective score. No activation until the bounded local gate, hook regressions and independent kill-point review pass.

Minimum fixture mission: start from a disposable repository containing a tiny HTTP service and an all-sprint PRD. An earlier sprint has a ready endpoint task; a later task depends on it. A later newest sprint contains completed work and an explicit deferred item. The assigned worker implements the endpoint, runs the discovered fixture checks, creates immutable evidence, and returns its candidate. The supervisor verifies the live local endpoint and dependency order, accepts both executable tasks, and reports the deferred item explicitly as excluded from the current execution scope. A second fixture with all obligations fulfilled provides the positive completion control. Use loopback and temporary roots, no credentials, external messages, Git pushes, deployments or paid model calls in the deterministic fixture suite.

The subsequent live agent fixture changes this assignment into a short product brief, uses the admitted real worker, and measures interpretation, actual edits, tests, local browser/API behavior and recovery without human transport. That live run is necessary for B10; a scripted worker cannot establish it. Production-grade release additionally requires the separate deployed artifact and flow gates.

## Acceptance tests and falsifiers

| Test | Injected boundary and expected outcome | Positive/control population |
|---|---|---|
| Durable admission | Restart after admitting a mission but before a worker exists; exact contract, scope, base and target survive; it remains requested/ready. Corrupt schema/unwritable root is explicit failure. | One valid persisted mission and one malformed/unwritable admission; neither is silently omitted. |
| Concurrent ownership | Start at least two actual supervisor processes claiming the same work item. Exactly one claim/generation and one worker allocation win. Stale result cannot change state. | A separate independent work item can be claimed concurrently; demonstrate concurrency is not merely globally disabled. |
| Dispatch readback | Worker-start receipt must identify actual cwd, repo/origin, base and native worker ID. Wrong cwd/base or missing adapter remains incomplete. | Fixture worker in the correct repo reaches running; intentional context mismatch is refused. |
| Start ambiguity | Kill supervisor before adapter call, during call, after child launch but before receipt ingestion, and after receipt commit. Restart reconciles the existing operation or records start-unknown, never blindly launches a duplicate. | Normal single start and a recoverable lost-response receipt; assert actual child count, not only rows in the database. |
| First result | A one-turn managed worker completes before its first Stop. The coordinator is unavailable and no later model turn occurs. Restart consumes its persisted result once. | An unmanaged first Stop preserves existing silence; the managed case has a nonempty outbox and actual later acceptance. |
| Ack loss / duplicate delivery | Kill after outbox insert, after send, after receipt ingestion and after acceptance commit. Duplicate Stop/wrapper events and lost acknowledgement do not double-apply. | Two different valid results are both accepted; deduplication must not suppress unrelated events. |
| Worker loss | Kill the worker without normal Stop and inject StopFailure separately. Supervisor observes loss/terminal failure from the wrapper, preserves evidence and uses the configured retry policy. | Live worker is never considered dead solely because a heartbeat/lease expired; unknown host remains unresolved. |
| Retry and exhaustion | Virtual clock plus persisted store: transient failure follows configured delays, deterministic failure exhausts the finite repair budget, restart preserves both. | A transient worker succeeds on its allowed later attempt; repeated identical fatal failure terminates incomplete with exact attempt count. |
| Dependency selection | Earlier-sprint ready task executes before its dependent even when newest sprint is complete. Missing/cyclic/malformed dependencies and deferred/needs-setup states never produce false complete. | Flat and nested PRDs, nonzero ready and nonzero blocked populations; use actual shared `workPlan`. |
| Acceptance binding | Wrong candidate SHA, old contract, stale owner, empty test population, missing artifact, gate failure and moved base are rejected. | Correct current candidate with nonempty independent expected checks is accepted; artifact filenames alone are insufficient. |
| PRD reconciliation | Own fixture writes are idempotent; a concurrent unrelated PRD edit causes reconciliation rather than overwrite. General multiwriter guarantee remains B12 until implemented/tested. | Preserve an unrelated story/field and retain a blocked/deferred record after acceptance. |
| Store interruption | Kill while transaction is pending, make store busy, truncate a spool tail, replay the same event, and restart. No half-transition or false acknowledgement; valid surviving events are counted. | Valid preceding/following events survive; empty replay input cannot satisfy the result-consumption test. |
| Hook compatibility | Managed Stop/StopFailure event production stays within registered timeout; disabled/unmanaged profile stays compatible. Busy store/full disk surfaces incomplete state in wrapper/status. | Existing Stop suites plus managed first-result case; preserve exact hook exit behavior without using exit zero as durability proof. |
| Recovery adapter | With an actual Workflow adapter, resume original journal keys and execute only missing work. CLI adapter must prove exact run ownership and native readback on the installed version. | Completed journaled work is reused; a different run/thread cannot be claimed as a recovery success. Unsupported adapter stays visibly unavailable. |
| Mission outcome | Deterministic fixture completes its authorized local acceptance without human transport; a needs-setup fixture remains explicitly incomplete while a deferred-only remainder does not block current-scope completion. Later real-agent run proves actual interpretation and live result. | Completion and incomplete fixtures both have nonempty tasks/artifacts. No claim of production delivery from a local fixture or CLI exit code. |

## Open design risks and rollout conditions

The largest remaining risks are launch ambiguity without adapter lookup, concurrent external effects without fencing, result loss before durable persistence, and a misleading verified status disconnected from the actual release. The design names rather than hides each. A long-lived supervisor adds its own deployment/restart/observability burden; an installed scheduler and measured adapter are still needed for overnight recovery. The current pass creates neither.

Roll out in order: store/fixture tests; managed hook integration; a real adapter's read-only capability and live disposable conformance run; bounded unattended local missions with injected failures; then explicitly authorized deployment through the existing ship/evidence contract. Preserve preexisting authorization and continue independent ready work while a lane is blocked. Report precise missing capabilities only when they block a concrete transition; do not turn routine implementation choices into permission hurdles.

Do not rate B05–B08 as fixed because this document exists. The next reviewable outcome is executable proof that a coordinator and worker can each die at the named boundaries and still produce one correctly acknowledged result, or a bounded, accurately incomplete state.


## Parent integration review

The parent corrected one planning error: an explicitly deferred PRD item is not
remaining work under the shared five-state contract. Use `needs-setup` or an
unfulfilled active acceptance criterion for the incomplete control; do not
reactivate deferred work or make it an automatic mission blocker. The unmerged
checkpoint PR is an integration blocker if adopted, not a prerequisite for
building every durable runtime primitive. Existing owned worktrees can preserve
uncommitted artifacts for reconciliation without publishing them.
