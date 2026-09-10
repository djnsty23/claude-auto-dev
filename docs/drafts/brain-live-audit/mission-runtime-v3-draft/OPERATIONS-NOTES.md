# Operations-owned v3 hardening — frozen review slice

This is an ignored, unadopted synthetic runtime draft. It is not installed, scheduled, connected to Brain, full-gated or a production worker. V2 and the independent reproduction snapshots were preserved. Parent owns the fixed synthetic worker and write-boundary suite; this slice preserves the parent's adapter write-effect requirement.

## Changes and supported boundary

- Store schema3 adds a `bootstraps` ledger and `authorize-bootstrap`. At most3 one-use nonce permits may be issued per existing mission attempt. Issuance commits before the adapter calls fork; repeating the exact event rejects with `bootstrap-already-issued`, a new event cannot reuse the nonce, and registration requires that attempt's issued nonce. Two distinct helpers can still exist, but only one may cross executor registration. Claim attempts, bootstrap permits, delivery sends and reconciliation polls are separate bounded counters.
- A permit spent before an uncertain fork is never refunded. SIGKILL after permit COMMIT and before its reply preserves the debit; replay grants nothing. This does not assert that a permit created a process, exactly-once external spawn or authentication against another same-user caller. The fixed adapter is the sole permitted consumer. Prepared cancellation still fences late registration; registered unknown execution still retains its reservation.
- Every owned child-close callback synchronizes its private identity/fence receipt before querying SQLite. A transient DB read failure no longer loses that receipt. Reconciliation looks up the currently registered nonce/PID and checks exact fence/identity/source before applying it. A duplicate unregistered helper may leave its own close receipt, which does not acquire terminal authority over the winner. These receipts prove only the fixed direct child closed, not arbitrary descendant termination or host/power-loss recovery.
- Readiness compares out-of-scope tracked files against actual admitted Git blob bytes, symlink-target bytes and executable mode, independently of index visibility; it also checks staged path changes. Assume-unchanged and skip-worktree flags are left intact. Unchanged flagged source remains supported, changed bytes refuse readiness. Unsupported tree entries, invalid UTF-8 path listings and failed readback refuse readiness; submodule/filter/checkout-normalization support is not implemented by this fixed fixture. This remains point-in-time source readback, not an OS sandbox or concurrent hostile filesystem defense.

The schema is intentionally incompatible with v1/v2 private prototype stores. No migration, unsafe legacy registration fallback, customer commands, model invocation, scheduler, production release or successful-PRD transition was added. Results continue to say `verified:false`; the synthetic inline manifest identifies the candidate bytes rather than labeling the base commit as a produced implementation.

## Actual validation

The new executable suite was written and run before repair: `hardening-before.log` / `.json`: **3 passed,7 failed /10**. Failures include the actual locked-SQLite lost receipt, both hidden-index source cases, repeated failed bootstrap creation, unissued/replayed permit boundary and new concurrent/crash authorization cases. The replay check's diagnostic was later refined to assert the negative response before reading its error field; the final suite hash is frozen separately.

Final command:

```sh
MISSION_HARDENING_REPORT=.claude/reports/brain-live-audit/mission-runtime-v3-draft/hardening-final.json node .claude/reports/brain-live-audit/mission-runtime-v3-draft/tooling/test-hardening.cjs
```

Actual result **10/10**,10 fixed helper children,0 remaining children,0 model calls,fixtureRemovedtrue. This includes six concurrent actual CLI authorization requests:3 permits and3 budget refusals. An actual child SIGKILL at COMMIT proves the first permit remains spent despite a lost reply. Known-positive authorized output, unchanged flagged source, ordinary dirty rejection and mismatched close-identity controls distinguish the repairs.

Inherited actual suites, rerun on schema3 with direct-registration setups now obtaining authorization:

| Suite | Result |
|---|---|
| test-mission-store.js |22/22|
| test-runtime-boundaries.js |4/4|
| test-synthetic-runtime.js |20/20,26 helpers,0 children/servers left|
| test-runtime-crashes.js |4/4,4 actual SIGKILLs,0 children left|

These populations overlap behaviorally and are not summed into a claim of independent autonomous-development proofs. Their commands and exact output are retained in `v3-test-*.log`.

`python3 .../tooling/check-hardening-mutations.py`: **5/5 mutations detected**, each failing its predicted assertion and each accompanied by its own passing authorized-worker control. Mutations reintroduce SQLite-before-receipt ordering, remove independent byte readback, raise the bootstrap cap, permit authorization replay, or permit registration without issuance. Exact failure text and copied source hashes are in `hardening-mutation-results.json`. The existing `check-runtime-mutations.py` also passes **5/5 detected +5/5 controls** on v3, preserving duplicate registration, disposition, ACK, hook-status and send-replay boundaries.

The simpler comparison variant rejects every assume-unchanged/skip-worktree index before content checking. On the same two flagged fixtures it fails both unchanged-source positive assertions, while its ordinary control passes1/1. The selected byte comparison passes both unchanged and changed cases; v2 passed unchanged but incorrectly accepted changed bytes. No latency claim is made. Variant copies and logs remain private under `hardening-mutations/`.

All tests used private disposable fixtures and cleaned their owned children/fixtures; mutation source copies remain intentionally as ignored evidence. No tracked source, live memory, installed cache or user settings were changed. No further work was started after the parent's usage-budget freeze request.
