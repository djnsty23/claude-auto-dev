# Independent architecture review — incremental

Source: committed Brain flow `08cd93c3e02f622adc613f0cd683e88641afe3ab`; ignored v3 runtime freeze supplied by operations on 2026-09-09. Review is bounded to local synthetic execution/readiness and responsibility handoffs. No native/model/product workers, schedulers, deployment, tracked writes, or draft edits.

## Responsibilities already correctly separated

Brain owns the observable promised outcome, explicit authorization, worker context and ownership, independent acceptance, promotion and live target readback. Auto owns bounded implementation and project checks. Spec owns a testable mission description; planning is not completion of authorized building. Prove owns reproducible before/after evidence. Ship owns exact candidate, previous deployment baseline, authorized promotion and live identity/behavior readback. These are written contracts; they do not constitute an executable supervisor.

The v3 store currently owns admission, local reservation/fencing, bounded bootstrap permissions, metadata/result transport and conservative settlement. The fixed synthetic adapter owns its actual child handle and close receipt. `reviewReadiness` explicitly returns `verified:false`; it does not run the promised acceptance itself. Worker registration, a hook-completed event, native turn completion, envelope acceptance and transport ACK must remain separate facts.

## Known integration gap, not a newly discovered defect

`integration-inventory.json` records actual `git grep` at the committed source above: `mission-store` has 0 matching lines under core; the positive `workPlan` control has 21. The v3 draft is therefore not consumed by committed Brain. That is the known next implementation slice, not evidence that the draft already dispatches autonomous work or finishes a mission.

## Narrow next handoff slice

1. A trusted coordinator binds an immutable story/acceptance snapshot, admitted repository/base/worktree, exact authorized effects, host-admission receipt and selected canonical store identity to one mission. Preserve existing user authorization; do not treat owner labels or same-user SQLite access as authentication.
2. A host-specific adapter receives only that assignment through a real supported interface. Before side effects it consumes a durable bootstrap permission and registers a stable identity. The synthetic worker demonstrates this ordering only for itself. A native adapter must separately establish filesystem/process containment and account for descendants before release.
3. The coordinator consumes a durable result receipt and requests current status using the active fence. Historical replay responses and accepted envelope metadata are never current launch or verification authority. Persist rejected evidence and bounded retry disposition; retain reservations while worker disposition is unknown.
4. An independent verifier checks an immutable candidate, current acceptance criteria, actual artifacts and required local/live behavior. The future verifier receipt must identify the exact candidate and criteria; edits, base changes or changed criteria require new evidence. Only this layer may authorize a PRD completion write, with a compare-before-write check against the original story snapshot.
5. Integration/promotion transfers an explicit candidate to the authorized target and records readback. Until a separately specified verified/finished transition exists, do not reinterpret `envelope-accepted`, `settled_at` or `review-ready` as successful mission closure. Keep a named owner for unresolved acceptance, recovery or release work.

These are integration requirements. Their absence from this intentionally limited slice is not reported as a runtime bypass. There is no claim of exactly-once external spawn, arbitrary descendant termination, a distributed lease, untrusted-worker containment, native host compatibility, or production success.

## Independent execution evidence

Pending bounded fixture run. Falsifier for the current safety reading: a stale/cancelled worker changes the owned artifact, metadata-only acceptance produces review-ready, a retired result changes current attempt ownership, or any readiness receipt asserts verified success without independent acceptance.

## Final bounded verdict

No new blocker reproduced in the reviewed v3 transitions. Command `node .claude/reports/brain-live-audit/mission-v3-architecture-independent/probe.cjs` exited 0 and printed `{"population":6,"passed":6,"failed":0,"helpers":6,"remainingChildren":0,"fixtureRemoved":true,"modelCalls":0}`. All three runtime SHA256 values were asserted before import; `results.json` retains those identities and the exact six case outputs.

Positive controls include an actual fixed worker, its durable result delivery/ACK and a parent-owned function behavior assertion. The replacement worker in the cancelled-bootstrap case also reached review-ready. Negative cases cover metadata-only acceptance, cancelled pre-registration helper and replayed historical claim, retired result delivery, blocked native hook completion despite child exit 0 and ACK, and changed artifact content after readiness. The retired result became `quarantined` while the replacement reservation stayed `claimed`; the stale historical claim receipt did not change current authority.

Relevant reviewed boundaries: store lines 151–168 expose current status/fence with `verified:false`; lines 234–257 separate conservative failure/rejection and envelope-only acceptance; lines 265–274 quarantine late ingestion; lines 290–307 consume bounded bootstrap permissions and gate actual registration. Adapter line references are recorded in `source-references.json` against the frozen bytes. Its own-child close receipt is persisted before reading SQLite, and review-readiness checks current ownership, terminal/hook disposition, ACK, candidate/base, actual scope and artifacts while still returning `verified:false`.

The tests are admission/readiness evidence for this deterministic fixture, not a production acceptance protocol. No source was changed, no peer draft was edited, no model/network/product worker was started. All six child handles closed and the one owned temporary fixture root was removed in `finally`. The test and this report remain under ignored audit storage for reproduction.

Review limit: the next executable integration must not derive a successful PRD update or released production mission from `review-ready` or `envelope-accepted`; the independent verifier/source-snapshot binding and successful final handoff are intentionally not implemented in this slice. Existing native adapter/process containment limits remain as documented. No additional broad review was started after the account-budget instruction.
