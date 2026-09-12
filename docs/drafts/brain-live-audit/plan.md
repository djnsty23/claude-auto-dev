# Brain live audit — execution plan

User request: thoroughly audit the live autodev harness from multiple perspectives; make Brain capable of taking ideas through autonomous execution to production-grade, live-verified delivery; fill evidenced gaps.

Scope: autodev source, installed autodev runtime and read-only local harness state. Product repositories, customer state and production mutations are outside this audit's implementation scope. Work in `codex/brain-live-audit`, isolated from main and peer worktrees.

Baseline: `9f9746f7907721921ce3d15fa5ae5020c0ebd227` (origin/main, 2026-09-09). `git status --short --branch` printed only the branch line. `git rev-list --left-right --count origin/main...HEAD` printed `0 0` in the main clone. Source inventory `rg --files plugins tooling | wc -l`: 390 files. `git check-ignore -v .claude/reports/brain-live-audit/plan.md` confirms reports are ignored.

## Passes and exit conditions

1. **Map reality and existing work.** Trace idea/spec → queue/selection → dispatch/ownership → execution → evidence → merge/deploy → production checks/recovery. Compare shipped files, installed cache, activation and open PR content. Exit: topology and exact refs recorded; overlapping work identified.
2. **Independent adversarial perspectives.** Three bounded reviewers: orchestration/liveness; proof/release correctness; permissions/recovery/operational cost. Root reviews product completeness and actual integration. Each writes incremental findings with command, output, falsifier, severity and source. No score-based stopping.
3. **Reproduce and prioritize.** Run real entrypoints with isolated controlled scenarios and read-only live inputs. Reproduce positive and negative controls, distinguish fixed/unmerged/missing/unknown, refute false positives. Compare proposed fixes with baseline and simpler variant.
4. **Fill confirmed gaps.** Implement coherent changes only in owned paths. Preserve legitimate authorization boundaries; reuse working mechanisms. Add meaningful behavior tests for state/evidence/ownership failures. Persist unresolved work as an actionable backlog with dependencies and acceptance criteria.
5. **Prove and review.** Capture before/after artifacts. Commit locally; run the full gate on a clean exact commit without concurrent tracked edits. If the first stage fails, execute remaining stages independently and attribute inherited failures. Independent review, fix or refute each finding, rerun checks warranted by changes. Publish a concise report with evidence, limitations and recovery path.

## Review policy

- No assertion of perfect reliability or exhaustive defect absence. Report concrete coverage and remaining unknowns.
- A written rule, queued chip, exit 0, passing fixture, successful tool send or merged PR is evidence of that event only, not successful product delivery.
- Reports append under this directory. Raw private runtime data stays ignored; portable source and documentation contain no private names, paths or credentials.
- Do not stop peers, alter installed settings, mutate product repos, trigger production, or contact unrelated sessions.
- Known-safe framework patterns are irrelevant to this Node/markdown harness; do not import UI style heuristics into correctness findings.

## Initial overlap inventory

`gh pr list --state open --limit 30 --json number,title,headRefName` returned 17 open PRs. Relevant items to inspect before implementing: #224 coordinator address recovery, #222 brain role staleness, #218 redispatch, #215 durable intent, #214 checkpoint, #213 fast gate, #211 decisions, #209 preview deploy semantics, #208 deploy authorization, #206 runtime story checks, #203 coverage floor, #199 bypass records, #194 setup handling, #190 memory scope. Open is not evidence that their content is absent from main; compare commits.


## Expanded pass ledger — through c1fa1c6

1. Live inventory and current-install/source comparison: completed. Source, plugin configuration, role readback and exact open-PR heads recorded.
2. Three independent boundary audits plus root spec/mission review: completed; reproduced runtime and integration blockers.
3. Implement and independently challenge the initial fixes: completed locally; graph/schema follow-up defects corrected.
4. First whole-gate pass: completed with a real failure in the new Brain/Auto Brain collision; all remaining stages separately inspected. No green claim.
5. Full skill-library pass and independent corrective review: all68 skills updated;64 additional skill files and12 references hash-checked;82 paths explicitly committed. Command-classifier false passes repaired with failing-before controls.
6. Full clean exact-candidate gate: all eight stages passed on e1b6aac; 122/122 suites, 121 direct failure controls and one separate canary, zero unverified.
7. Runtime follow-ups: ledger evidence integrity, private-region redaction before extraction/persistence, and corrected platform output guidance applied and committed. Mission-store prototype independently reviewed; not adopted.
8. Final runtime candidate c1fa1c6: all eight gate stages passed on frozen clean source; 122/122 suites, 121 directly verified failure controls and one separate canary, zero unverified. The earlier fixture-packaging failure is attributed and preserved in the journal.
9. Hourly overnight continuation in the same owned worktree until08:00Europe/Athens. Reconcile active work first, preserve local evidence and prioritize executable mission reliability rather than more instructions or scores.

The original broad goal is not certified complete by this audit. An arbitrary idea-to-production mission remains unproven until the runtime chain is integrated and repeated under failure/restart conditions.

10. Actual worker conformance: one native Codex fixture run passed six independent HTTP assertions, while native hook configuration rejection withheld harness admission. Pinned host compatibility source and a canary plan are retained; B26 is the next runtime priority.
11. Final consumer-contract and review pass: reproduced unsupported fleet envelope false-empty behavior with positive/empty controls; reviewed all 68 changed skill Git objects and recorded 17 evidence-scoped ratings. The backlog has 26 items with partial/implemented/prototype/unproven status distinguished.


12. Native host canaries and generated package repair: completed and gated on08cd93c (all eight stages,123/123 suites). Native patch payload repair and generated-manifest controls committed as c948221; final gate is running. All124 test suites passed; suite failure verification and remaining stages are pending.
13. Mission runtime v3: frozen fixture-only prototype, three review perspectives and actual crash/link/index/receipt controls passed. Real host adapter, independent acceptance and PRD/release integration remain the next implementation slice, not completed capability.
