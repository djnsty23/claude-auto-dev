# Brain proof/release audit — 2026-09-09

Source baseline `9f9746f`, installed release source worktree. Scope: completion evidence and deployment readiness. No production actions. Reproduction command: `node .claude/reports/brain-live-audit/proof/probes.cjs`; full argv, cwd, exit and stdout/stderr for every case in `probe-results.json`. Fixture is entirely under this ignored report directory (`git check-ignore -v` printed `.gitignore:68:.claude/reports/`). Note: probes.cjs initializes fixture once; remove its fixture directory before an intentional rerun.

## Confirmed P1: a passing unrelated job masks a skipped gate; artifacts alone imply READY

Baseline `plugins/autodev-core/scripts/check-pr-ready.js:131-137` only blocks skipped jobs if *no* job passed, and only invokes the missing-workflow analysis for raw array length zero. `fleet-snapshot.js:91` consumes this exact binary; its line 233 presents these instruments as what the fleet merges on.

CLI subprocess positive controls: 2/2 successful jobs → READY/0; 1 success plus 1 FAILURE → NOT_READY/2. Counterexamples: 1 successful lint plus 1 SKIPPED test → READY/0 with population `passing:1, skipped:1`; artifact-only → READY/0 with `passing:0, rollupArtifacts:1`. These are opposite to the header's "safe to merge" contract. Falsifier: same real binary refuses these cases and still permits a docs-only change proven excluded by every trunk workflow.

All 16 open PR file lists were captured by `gh pr list --state open --limit 100 --json number,headRefOid,title,files`. Only #204 also changes this script. Its exact head `13fa92144efdd9b61c64d332d29f5a87a5832f25` retains both predicates; diff adds stdout draining, not readiness semantics. Root authorised this baseline fix with CLI regression tests; work underway. Do not duplicate #204 stdout work.

## Confirmed P1: #208 promotes stale verification onto a newer commit

Open/unmerged #208 head `b18f0f7c4ca3e7f9cb3659fa0b12c2b6147783a0`, `plugins/autodev-core/scripts/deploy-ledger.js:459-473,519-530`: freshness is keyed to *base only*. Regeneration replaces commit with new HEAD but keeps prior gate, output, evidence, ticks, metrics, rollback and authorisation. Verify line 418 only compares the now-replaced commit. Baseline has even weaker unbound checkboxes; #208 does not close this class.

Fixture: one UI route, base + first change, fill a valid record and genuine before/after text → verify/0. Commit a second change that throws on render, same last-deploy base, do not run a gate: verify correctly exits1/STale. Follow the printed remedy (`--write` then `--verify`): exits0 and prints `Promotion ... is pre-authorised` with first-change gate output and screenshots. Falsifier: regeneration against changed HEAD invalidates proof and requires re-verification, while unchanged base+HEAD preserves it. Fix suggestion for existing PR: bind proof to both resolved base SHA and exact verified HEAD; preserve only while both match. This is a refinement of its existing invalidation mechanism, not a new gate.

## Confirmed P1: deleting surface rows yields verified; retained by #208

Baseline `deploy-ledger.js:214-225`; #208 `deploy-ledger.js:599-606`. Verify counts unchecked rows found in markdown; it never checks expected rows from the independently calculated diff against actual ledger rows. Positive control: generated ledger over 1 changed UI route fails1 with an unchecked `/` row. Delete all rows, leaving metrics: baseline exits0 and prints `every surface in this window has been checked`. In #208, delete all rows but retain otherwise valid promotion fields: exits0, `every surface checked`, `Promotion ... is pre-authorised`. Falsifier: missing one required route fails by that route's identity, and correctly completed full rows remain green. Correct lever: verify the expected surface set, then each row's five required marks; reject missing and malformed rows, not just unchecked ones.

## Confirmed P1: #208 authorises a dirty deployment tree

#208 `deploy-ledger.js:194-208,599-624` derives only `<base>..HEAD`, and default-branch containment compares HEAD. With a valid record, changing app/page.tsx without committing yields `--verify --verbose` exit0 and pre-authorised promotion. The ship skill invokes the deploy CLI against working-directory files, so those files can differ from the commit whose gate was recorded. Falsifier: verifier refuses tracked modifications / staging divergence, and deploy artifacts bind to a clean revision. Any untracked upload treatment must coordinate with #209's separate ignore-floor work.

## Confirmed P2: #206 flow evidence is reusable across arbitrary revisions/deployments

Open/unmerged #206 head `838d025455bfb3aec9d601b437bece888e62d085`, `scripts/flow-evidence.js:102-157`. It checks string story identity, steps, expected==observed, and future timestamps, but no code/build/deployment identity and no age bound. CLI record timestamp `2000-01-01T00:00:00Z`, expected1/observed1 → PASS/0. Positive control expected1/observed0 → FAIL/1 names assertion. It explicitly does not enforce at Stop; auto skill says that choice avoids holding turns in environments lacking browsers. The schema validator is useful, but author-supplied observations remain an attestation; PASS means internally consistent record, not the current story/build succeeded. Falsifier: validation against explicit expected story + verified revision + build URL refuses mismatches. Prefer revision/build binding over arbitrary age cutoff: the same old proof can remain valid if deployed artifact did not change.

## Additional source-backed opportunities, not yet adopted fixes

- `deploy-ledger.js` UI_EXT excludes .js/.ts. Its WIDE regex knows `tailwind.config`, `tokens`, `theme`, but filtering UI_EXT first removes typical `.js`/`.ts` forms before WIDE sees them (baseline 76-101; #208 175-199). Its selftest only tests WIDE directly, so passes while production pipeline drops those files. Needs integration fixture with a real token/config diff before recommending classifier expansion.
- Auto still has conflicting admin/internal UI exemption (`typecheck + build only`) vs later mandatory all-UI browser verification. #206 retained it. Server-only edits affecting user-visible outcomes also explicitly skip visual verification; runtime-flow inference partially mitigates this only in unmerged #206.
- #209 adds target readback and ignore floor, but its after-deploy target comparison does not bind JSON to intended deployment URL/id and cannot prevent initial publication. Treat as detection/recovery, not deployment authorization. No live deployment was attempted here.

## Existing work correctly accounted for

#206 adds runtime state comparisons, #208 adds commit/promotion fields, sensitive-path refusal, default-branch check and deployment archive, #209 adds Vercel target result and upload floor. All OPEN, source copied byte-for-byte using `git show <head>:<path>` into report directory; none of the three heads is ancestor of baseline (`git merge-base --is-ancestor`, each exit1 captured in ancestry pass below). #203 adds coverage floor; #213 fast tier explicitly says partial and preserves full gate. Neither is evidence that a user flow succeeded.

## Pass 2: implemented baseline correction and measured alternatives

Root authorised only `plugins/autodev-core/scripts/check-pr-ready.js` and `tooling/test-check-pr-ready.js`; those are the only tracked edits by this auditor. No commit, push or production action. `node tooling/test-check-pr-ready.js` after writing independent CLI regressions but before implementation exited1: **45 passed, 5 failed out of 50**. The failure lines name skipped-test masking, same-name masking, artifact-only due workflow, missing explanation for legitimate artifact-only docs, and artifact-only without changed files. Output saved in `readiness-before.txt`.

Implemented: any observed skipped check withholds READY, naming the check and the unresolved required/optional status; effective empty rollups use the existing trunk-path analysis after artifacts are excluded. The proven docs-only exemption survives. After: same command exited0 **50/50**, `node tooling/test-pr-path-filters.js` exited0 **26/26**; `node --check plugins/autodev-core/scripts/check-pr-ready.js` and `git diff --check` exited0. Output in `readiness-after.txt` and `path-filters-after.txt`.

All 16 open PRs' actual GitHub responses were fetched once using `gh pr view <number> --json number,state,isDraft,mergeable,mergeStateStatus,statusCheckRollup,baseRefName,headRefName,files`; replays drive the real CLI with only the GitHub subprocess response injected. Command: `node .claude/reports/brain-live-audit/proof/compare-readiness.cjs`. Full raw responses in `live-pr-responses/`, results in `readiness-live-comparison.json`.

| Policy | Live corpus (16 PRs) | 1 lint SUCCESS + test SKIPPED fixture | same-name SUCCESS + SKIPPED fixture |
|---|---|---|---|
| Baseline | 1 READY, 15 NOT_READY, 0 unknown | READY, unsafe inference | READY, unsafe inference |
| Refuse unresolved skipped jobs (implemented) | Same, no changed verdicts | NOT_READY | NOT_READY |
| Allow a skipped name if that name also succeeded (alternative) | Same, no changed verdicts | NOT_READY | READY: workflow identities may differ |

The live corpus doesn't contain a discriminating mixed skip state, so it establishes no present regression, not broad precision. Controlled fixtures provide that discrimination. Restriction: legitimate optional skips also require explicit reconciliation because this tool has no authoritative required-job policy; it does not invent an exemption. This remains a rollup readiness check, not evidence every required local gate or current production flow succeeded. Missing *unreported* required jobs beside an unrelated success remain a broader policy gap.

## Pass 2: additional executed candidate-PR probes

Command: `node .claude/reports/brain-live-audit/proof/supplemental-probes.cjs`; full outputs in `supplemental-results.json`.

1. **P1, baseline and #208:** commit only `tailwind.config.js` changing the global theme. Both actual CLIs report **1 changed file, 0 user-facing, 0 wide-effect**, exit0. Their `--selftest` positive control still PASSes `WIDE(tailwind.config.js)`. This confirms the pipeline drops the very input its isolated regex test claims to cover. Falsifier: that one-file diff produces a required WIDE row. No fix written because root froze further source changes and #208 owns the pending ledger work.
2. **P2, #206:** run `--template`, fill observed1, save at the documented `.claude/evidence/S00-000/flow.json`, create the documented `.claude/evidence/S00-000/after.png`. CLI exits2 `screenshots: .claude/evidence/S00-000/after.png does not exist`. `main` resolves paths relative to the record directory (line201), while template line74 emits a repository-relative path. Change only screenshot path to `after.png`: exit0 PASS. Falsifier: the generated template and documented invocation agree on one resolution base. This false refusal adds avoidable loops at exactly the verification step.

Ancestry authority is `ancestry.json`: baseline self-control exits0; #204/#206/#208/#209 heads each exit1 against `9f9746f`.

## Pass 3: independent review of peers' uncommitted fixes

Read diffs and ran `cross-review.cjs`, with full outputs in `cross-review-results.json` and `cross-review-test-*.txt`. `test-stop-auto-check.js` **90/90**, `test-stop-brain-report.js` **37/37**; `test-prd-states.js` exit0. Unknown passes state, malformed dependency record, deferred prerequisite, and unresolved dependencies preserve `complete:false`; done+deferred is `complete:true` as defined by project policy. Stop's second-turn approval retains unresolved reasons, correctly distinguishing a bounded stop from completion.

One new **P2 review issue** was sent to the owning agent: A→[B,C], B→A, C→B means all three are cycle members, but the proposed iterative DFS labels only A/B, because C points to already-visited B. Removing A→C produces identical output even though C becomes downstream-only. Both graphs remain correctly unready/incomplete; this is inaccurate diagnosis, not a false completion. Falsifier: C cycle label appears only in the first graph.

One prose contradiction was sent to that agent: auto's Decision Matrix still reactivates deferred stories (`Carry forward, start working`) despite shared planner correctly treating deferment as a decision not to execute. This needs explicit changed mandate, not automatic retry.

The stop-brain-report fix correctly preserves the last-notified HEAD during cooldown and its tests prove later same-HEAD delivery. It remains event-driven: no later Stop means no delayed delivery. That is a pre-existing liveness limit, and should stay visible in Brain's durable queue/reconciliation design instead of being called a delivery guarantee.
