# Autodev / Brain live audit — 9 September 2026

## Decision

Brain is not yet a demonstrated unattended replacement for an operator from idea to production. The strongest current capability is local implementation with extensive checking. The weakest links are host compatibility, durable dispatch, recovery and proof tied to the deployed artifact. Skill contradictions have been corrected locally; model adherence remains unmeasured.

This audit has reproduced and corrected execution, evidence and instruction failures locally. It has also reproduced blockers in open recovery and deployment PRs; those PRs must not be counted as completed capability merely because they exist. No product, live customer data, production deployment, installed plugin setting or peer session was changed.

**Latest fully gated candidate:** `95f3737c21a6ee324d73116ec1a745beacd9f041`, branch `codex/brain-live-audit`. The full eight-stage gate passed on its clean, frozen source at 03:20 UTC: **126/126 suites**, 125 directly verified able to fail, one separately canaried, zero unverified suites. This includes both memory repairs and all earlier audited source changes. The [exact receipt](gate-memory-conflicts-receipt.json) binds unchanged refs, exit 0 and the log hash. All 68 shipped skills were reviewed and revised. Installed plugins remain unchanged, and the mission runtime remains a reviewed fixture-only prototype. Earlier candidate verdicts are preserved below.

## What was actually examined

- Baseline source `9f9746f7907721921ce3d15fa5ae5020c0ebd227`, 390 files returned by `rg --files plugins tooling`.
- Installed Claude plugins: core, memory and stack version 8.166.0 enabled; 5/5 sampled executable source files matched the baseline, and the memory hook manifest matched. This establishes configuration and sampled source parity, not proof of every hook firing.
- Read-only live Brain role: `checkBrainRole()` returned ok, zero fault codes, 3/3 recorded live pids; desktop store readable with 126 records. Away state was active. Raw identities and prompts are omitted.
- Open work was inspected by exact PR head, not title. Initial list had 17 PRs; the later single-snapshot readiness replay covered 16. These are different snapshots, not a disappearance claim.
- Three independent reviewers covered orchestration, proof/release, and operations. Root reviewed spec, mission integration and cross-skill consistency. Independent second reviews found additional defects in our proposed graph and schema checks; both were corrected.
- Every shipped skill and immediate reference was inventoried: **68 skills + 27 immediate references at c32a54ec** (28 immediate references at e1b6aac). The breadth manifest explicitly distinguishes a pattern scan from a semantic read; scanning a file is not a claim that every sentence was verified.
- Controlled fixtures drove actual entrypoints, with positive and negative controls. Live GitHub responses were fetched once and replayed against three readiness policies. Production user journeys were not executed in this harness repository.

The execution plan is in [plan.md](plan.md); detailed incremental evidence is in [orchestration/findings.md](orchestration/findings.md), [proof/report.md](proof/report.md), [proof/round2.md](proof/round2.md), and [operations/report.md](operations/report.md). Reproduction commands and their outputs are recorded there. Portable before/after evidence is committed under `.claude/evidence/brain-reliability/`.

## Local source and control maturity ratings /10

These rate the local source and its controls, including procedural maturity. They are engineering judgments, not measured success probabilities or evidence that the installed runtime now performs better. End-to-end mission performance remains unmeasured. The same rubric applies before and after: **0** absent; **2** mostly an instruction; **4** partial implementation with known failure paths; **6** executable nominal and relevant negative paths; **8** independent tests plus evidence at the real operating boundary; **10** repeated unattended end-to-end success with fault injection and recovery. A score never authorizes completion or release. No overall average is presented: the mission fails if any essential link fails.

| Aspect | Baseline | Current /10 | Remaining limit |
|---|---:|---:|---|
| Idea to executable acceptance | 4 | 6 | Structural checks and all-sprint criteria improved; semantic product evaluation remains. |
| Backlog and dependencies | 3 | 7 | Shared planner and graph controls; durable multi-worker completion is not integrated. |
| Worker dispatch | 3 | 4 | Actual start and identity distinguished; real mission adapter remains a prototype gap. |
| Ownership and concurrency | 4 | 7 | Local decision/fleet safeguards plus measured native containment; no distributed lease. |
| Authorization and scope | 5 | 6 | Native sandbox effects tested and missing hook workdir exposed; global away scope remains. |
| Implementation quality | 5 | 5 | These fixes are verified; arbitrary product delivery is unmeasured. |
| Tests and gates | 6 | 8 | Exact clean gates, independent mutations and native effect controls; not all OS paths tested. |
| Evidence and completion truthfulness | 4 | 7 | Artifact/hook/lifecycle distinctions and ledger repairs; end-to-end mission proof remains. |
| UX and live journeys | 3 | 4 | All relevant flows required in skills; representative product journeys remain unmeasured. |
| PR readiness and integration | 4 | 6 | Skipped-job masking fixed; authoritative missing required-job policy remains. |
| Deployment and rollback | 3 | 5 | Ledger binding improved; actual production artifact, recovery and live acceptance unproven. |
| Reporting and notification | 4 | 6 | Final SHA reporting fixed; durable outbox is tested only in the unintegrated prototype. |
| Crash, quota and retry recovery | 3 | 4 | Bounded conservative source behavior; tested mission recovery is not yet wired into Brain. |
| Memory and privacy | 5 | 6 | CLI health, conflicting payloads and writer scope repaired; imported API fallback, project identity, legacy privacy and restore remain. |
| Skills and host portability | 3 | 6 | 68 skills revised; native packaging and patch controls tested; installed activation and Windows remain. |
| Context and resource use | 5 | 6 | Skill bodies reduced by81265bytes; real mission cost/reliability tradeoff unmeasured. |
| Feedback and improvement | 4 | 7 | Independent passes falsified original and new assumptions; ranked reproducible backlog retained. |

The memory assessment first fell from 5 to 4 when the audit exposed new defects, then returned to 5 after the privacy repair. The native Codex trial also lowered the provisional authorization and portability assessments from 6 to 5. The later native packaging and patch repairs raise authorization and portability to 6; test credibility reaches 8 after independent native controls and exact-candidate gates. The source did not introduce those older defects. No rating of 10 or improved installed mission success is claimed.

## Fixed in the first source candidate

| Failure and consequence | Correction | Executed evidence |
|---|---|---|
| Newest-sprint-only selection hides unfinished work; dependency cycles can spin indefinitely; Stop calls malformed/blocked work complete | One `workPlan(prd)` shared by Auto and Stop; all sprints, dependencies, explicit invalid/blocked state, bounded reconciliation | PRD **74/74**, Stop **91/91**, containers **20/20**; independent **512** three-node graphs, **1,536** membership comparisons, **0** mismatch |
| Special `__proto__` story keys disappear while flattening, hiding malformed work | Safe own-property copying in core and deliberate memory duplicate | Memory suite **31/31**, previously **30/31** |
| Concurrent decision calls allocate the same ID or both accept mutually exclusive choices | Exclusive lock across read/check/append, bounded refusal, owner-safe release | **44/44**, previously **37/44**; killed fixture owner refuses in **2,417ms**, verified cleanup recovers |
| Cooldown consumes the final unreported commit | Preserve last-notified SHA until notice is emitted | Initial **37/37**, previously **35/37**; integrated role changes **49/49** |
| Quoted foreign paths containing spaces silently bypass coordinator write guard | Preserve quoted token boundaries through both tokenizers | **102/102**, previously **95/102**; filter **44/44** |
| Unrelated successful lint masks skipped tests; artifact-only rollup appears ready | Unresolved skips withhold READY; empty effective rollup uses actual workflow path analysis | **50/50**, previously **45/50**; path filters **26/26**; same **16** live PRs give **1 READY / 15 NOT_READY / 0 changed** across policies |
| Missing schemas, SQL comments, stale policy declarations and malformed stories falsely satisfy spec checker | Validate raw story containers and a deliberately narrow SQL declaration subset; unsupported transformations fail explicitly | Same **48** assertions: baseline **24 pass / 24 fail**, simple regex alternative **26/22**, candidate **48/0** |
| Huge overlapping Brain procedures import stale operating assumptions and stop at artificial handoffs | One compact mission procedure; Auto Brain loads it; earlier build authorization continues through spec/setup/auto | Exact old bodies preserved as historical references; independent contract review clean; arbitrary mission success still unproven |

The SQL checker proves initial structural declarations, not database permissions, SQL execution or business correctness. The lock does not automatically reclaim a crashed owner's lock. The Stop fix requires a later Stop after cooldown. The readiness live corpus had no discriminating mixed-skip case; fixtures provide that test.

## Fallacies that need to stop recurring

1. **Instructions equal capability.** “Start a worker,” a clickable chip, an intention row and a restart proposal are four different events. Only a started worker with read-back identity establishes execution.
2. **Activity equals progress.** Turns, commits, finding counts and high scores do not establish accepted product behavior.
3. **A gate is authoritative because it is green.** Empty populations, skipped jobs, a regex tested outside its actual filtering pipeline and source-text assertions can all go green while the real contract fails.
4. **The artifact has evidence, so this artifact has evidence.** Old screenshots, gate output or checked rows are invalid if the current code, data setup and deployment cannot be identified.
5. **Enumerated dirty paths are owned paths.** Explicitly listing every dirty file has the same cross-session capture problem as blanket staging.
6. **Safety wrappers constrain internal subprocesses.** A hook's own git call can bypass the outer Bash hook. Ownership and authorization must live at the executing boundary too.
7. **A timestamp is a lease or permission.** Activation age does not prove productive execution; machine-wide away state does not establish every repository's mandate.
8. **A fallback is recovery.** Reporting a restart candidate, refusing a lock or saving intent is useful, but none completes retry, claim, launch, acknowledgement and verification.
9. **A local cache is durable shared memory.** Ignored archives cannot travel with git; copying raw project directories can capture transcripts and still restore into the wrong layout.
10. **More rules make the agent more reliable.** Contradictory defaults, obsolete APIs and exception-heavy history increase ambiguity. Historical anecdotes are evidence to interpret, not fresh authority.

## Risk findings and current disposition

**P1 — Installed does not mean accepted or executed by the host.** The initial actual Codex 0.153.4 worker completed its code task while the loader rejected core 8.166.0's canonical Claude hooks file because of top-level `modules`; memory's SessionEnd timeout was clamped. The new host-specific source package now loads a separate native manifest, and generated command/root transport plus selected native patch controls have actual execution evidence. The original Read/Write/Edit matcher DOES select apply_patch; the payload handler needed repair. The installed plugin remains unchanged and unadmitted as a whole. Missing function-module support, incomplete event coverage, native content protections, arbitrary custom config roots and other operating systems remain explicit limits. The [host admission plan](host-compatibility-plan.md) preserves Claude capabilities and requires native canaries for each required control before relying on it.

**P1 — Deployment proof can be rebound to unverified code.** Exact OPEN PR #208 head `b18f0f7…` can write a new HEAD while preserving old gate output/ticks: the fixture rejects before rewrite (exit1) then accepts the broken new HEAD after rewrite (exit0). Removing an expected surface row also passes; a dirty deployment tree can be preauthorized. Baseline and #208 both drop a one-file `tailwind.config.js` change before WIDE classification despite the isolated WIDE selftest passing. See actual CLI probes in `proof/probe-results.json` and `proof/supplemental-results.json`. Local commit a806b7c fixes row membership, WIDE filtering and selected candidate/base identity without importing #208’s release authority. Actual artifact/environment binding and dirty-tree promotion remain unresolved.

**P1 — Checkpoint recovery can capture peer work and publish without its ordinary checks.** Exact OPEN PR #214 head `271fed05f78ada7af28b8127f5bbe55368878c67` committed both own and peer fixture files and pushed to a local bare remote while bypassing a working pre-push refusal via `--no-verify`. No checkpoint/push opt-in existed. The normal push control invoked the hook and failed. Do not integrate that candidate unchanged. No real remote or peer work was touched by the probe.

**P1 — The unattended delivery chain is incomplete.** #218 `18d31161…` proposes redispatch but explicitly never starts it. #215 persists intent; neither establishes an owner lease, actual start, result acknowledgement or reconciler. Current first Stop only establishes a baseline, and a cooldown notice has no scheduled wake. A worker can complete and never notify Brain.

**P1 — Memory backup recipe copies the wrong data and restores the wrong shape.** The literal setup recipe copies root session JSONL files while filtering directory names only. The fixture restore yields `memory/memory/MEMORY.md` and imports transcript-shaped data into memory; new-only backup changes print “No changes.” Only synthetic data was used. The reviewed replacement now selects approved Markdown recursively, preserves relative restore paths, checks all owned changes and verifies a synthetic round trip. Private live restore remains untested.

**P2 — Flow evidence is stale and its template disagrees with its reader.** Exact #206 `838d025…` accepts year-2000 evidence without a current code/deployment binding. The documented screenshot path fails at its documented record location (exit2); changing only to a record-relative path passes (exit0).

**P2 — Preview detection happens too late.** #209 `check-deploy-target.js` can report the provider's production target after deployment; this does not prevent the first accidental production deploy, and does not bind the result to the intended URL. Pre-action command/target validation and post-action artifact/live checks are both needed.

**P2 — Away state has broader scope than its mandate.** Actual panel-hook fixtures hold both managed and unmanaged repositories (exit2), while the no-away control allows (exit0). This proves loss of the scoped question path, not unauthorized execution.

Other recovery debt includes attempts/backoff/exhaustion across wakes, reconciliation with a moving shared backlog, orphan-lock ownership, authoritative required-job policy, and semantic product acceptance. The machine-readable [backlog.json](backlog.json) gives executable acceptance criteria and overlap disposition.

## Overnight continuation

The user requested overnight improvement. A thread heartbeat named **autodev-overnight-hardening** is active, hourly until **08:00 Europe/Athens, 9 September 2026**. It resumes this same task/worktree, prioritizes the backlog, preserves evidence, runs exact-candidate gates, and stays quiet when nothing actionable changes. Meaningful improvements, failures, required external actions and the morning assessment are reportable. This is a scheduled continuation, not a guarantee of dispatch/deployment capability in autodev itself.

## Run journal

These entries preserve the state when each round was written. Later milestones supersede earlier “running”, “pending” and “under review” statements; the current candidate and verdict are at the top of this report and its linked gate receipt.

- Initial implementation committed as `d88586b944339299c24809984835d8845cee88dc`.
- Upstream role recovery integrated as `c32a54ecfd596b19272efa67408247f7a1b99a22`. Integration checks: Stop-report **49/49**, guard **102/102**, role **26/26**.
- `npm run gate > .claude/reports/brain-live-audit/gate-candidate.log 2>&1` started on clean committed c32a54ec. Tracked edits remain frozen until completion; test-owned temporary files may appear during the suite.


### Library-wide corrective pass

All 68 shipped skill procedures received a full semantic read by at least one reviewer. Four were corrected in the first source candidate; 64 more and 12 reference files were adopted with source/draft hashes, four independently checked overlays and a per-file rationale. The initial breadth manifest was only an inventory/pattern scan; the later manifests and review reports establish the deeper coverage. This is not proof of model adherence or all provider workflows running successfully.

Independent reviews found defects in our drafts as well as the original library. Corrections included freezing the deployment baseline before promotion (the wrong baseline actually emits 0 routes and verifies with exit 0), preserving nested memory paths, immutable evidence URLs, tracked-secret inspection, archive preservation, actual script roots, and avoiding a command that loses working-tree changes. A C layout probe measured four types: baseline 24 bytes, reordered 24, sparse 32, compact 24; the original reordering example saved nothing. Go/Rust/Windows contract corrections used official documentation where the local toolchain was absent; no live execution on those absent platforms is claimed.

The skill-command check now varies six independently pinned states in both flat and earlier-sprint layouts. Its strengthened baseline found 4/5 runnable classifiers blind to older sprint work. Two additional controls showed flat-input errors and partial unverified execution returning success; after repair the same suite passes 10/10 (before 8/10). These are execution/error-propagation checks, not a semantic judgment of every instruction.

- Skill candidate committed as `e1b6aacde570ac4ab9ee44c8e1f3d86733410fab`:82 explicitly staged files. All 68 active skill procedures changed across the full audit branch; prior Brain/Auto/Spec changes are in the earlier commit.
- Applied skill checks: `node tooling/test-skill-prd-commands.js` =>68 skills,2 inline commands,1 PRD command, six states in both layouts pass; `node tooling/test-skill-prd-commands-selftest.js` =>10/10; collision suite=>11/11; tool declarations=>68/68,0flags; triggers=>68/68 with conditions,0overlong,0missing when_to_use.
- `npm run validate` =>19PASS,0FAIL,1WARN. The warning means the installed host did not scan the hooks module; it does not establish those module calls worked.
- `npm run gate > .claude/reports/brain-live-audit/gate-skills-candidate.log 2>&1` started with clean status on e1b6aac. Tracked source is frozen during execution. Runtime follow-up proposals remain in ignored drafts.
- Latest read-only PR snapshot:16open PRs. Previously audited #208/#214/#218 heads remain identical. Their existence still does not close the reproduced defects. Snapshot saved in `pr-snapshot-after-skills.json`.

The 68 active SKILL.md files, including frontmatter, total 543,364 bytes at e1b6aac versus 629,738 at the audit baseline. The earlier 543,368 claim was four bytes high; exact Git-object inspection corrected it. Brain plus Auto Brain total13,190bytes versus124,092. Historical bodies remain available as references. These figures measure instruction size, not success, latency or model cost. Final per-skill dispositions: [skill-coverage-final.md](skill-coverage-final.md); source/application hashes: [skill-adoption-manifest.json](skill-adoption-manifest.json).

- e1b6aac gate milestone: `npm test` completed122/122 suites, exit0. `check:suites` is now running; the full eight-stage gate is still pending. Source status remains clean. One Windows-specific missing-verdict case is explicitly unverified on this macOS host; the native hooks-module scan warning remains.

### Next autonomy boundary

[mission-runtime-plan.md](mission-runtime-plan.md) specifies the missing supervisor, transactional mission/attempt state, adapter start readback, durable results/acknowledgements and persistent retry budgets. [mission-acceptance-matrix.md](mission-acceptance-matrix.md) defines the real operating boundaries. These plans are not implemented capability.

Parent review corrected a planning error that would have counted deferred stories as unresolved work. Explicit deferral excludes an item from current remaining work; a needs-setup fixture supplies the blocked control. The existing unsafe checkpoint PR is also not a prerequisite for every runtime primitive. This illustrates why even an apparently careful autonomy plan needs an independent check against the actual state contract.

- Full skills gate completed with exit 0 on clean `e1b6aac`: all eight stages passed; 122/122 suites, 121/122 directly verified able to fail, one separately canaried and zero unverified. Source refs remained unchanged and status clean. Exact receipt and log hash: [gate-skills-receipt.json](gate-skills-receipt.json).

### Deployment runtime follow-up

Committed `a806b7c4632c2374eed683a861523e9628c0151a` fixes WIDE config discovery, deleted/duplicate/partial expected rows and stale base/candidate checks. The same actual CLI suite gives baseline 19/48, candidate 48/48, and always-reset alternative 43/48. Three targeted mutations fail their claimed assertions (46/48, 43/48 and 39/48). Applied suite: `node tooling/test-deploy-ledger.js` => 48/48, exit 0. A frozen explicit candidate remains verifiable after a later tracked-ledger commit and regenerates without a diff; default HEAD and an explicitly newer source candidate remain stale. The ledger validates recorded assertions, not browser or deployment truth. Its full integration gate is pending the privacy follow-up.

### Privacy review found an upstream extraction boundary

The reviewed database/prompt-capture draft passes 244/244 assertions in six suites, with four targeted mutation controls. An independent real PostToolUse probe still leaked all three protected filename fixtures: `path.basename` had removed the opening tag before the writer received a title. Six independent direct writer/carrier cases and three serializer-error/recovery controls passed. Evidence: [orchestration/privacy-independent-results.json](orchestration/privacy-independent-results.json). Fixing only the final writer would leave extraction unprotected; the minimal pre-extraction overlay is under review. No real memory store was used.

### Main guidance cross-check

The main repo guidance incorrectly described Linux pipes and Windows terminals as synchronous and output truncation as macOS-only. [Node’s documented I/O contract](https://nodejs.org/api/process.html#a-note-on-process-io) contradicts those platform claims. The controlled macOS/Node 24.19.0 probe wrote 1,048,576 bytes through each of three variants: immediate exit returned 0 but delivered only 65,536 bytes through the pipe; natural completion and a write callback delivered the complete payload. All three file controls were complete and all six processes exited 0. Commands/results are in [stdio-platform-control.json](stdio-platform-control.json). CLAUDE.md and rule-gate-integrity now state the actual limit; generated AGENTS and the existing 69-assertion guidance selftest pass. No Linux/Windows execution is claimed.

- Validation caught an audit packaging error: I copied two machine-specific home paths into the portable deployment evidence metadata. The validator correctly returned 17 PASS / 2 FAIL / 1 WARN. The paths are corrected to repository-relative references; commands and results are unchanged. No candidate with this failure is reported as gated green.

### Independent report review

[report-review.md](report-review.md) independently checked the gate digest, 76/76 skill adoption hashes, all 68 changed skills, the 16-PR readiness population and evidence links. It caught an acceptance sentence that would have reintroduced the ledger archival loop; B01 now distinguishes historical candidate verification from current release proof. It also caught an ambiguity between source/control maturity and actual mission performance; both rating documents now name their scope. Exact size/reference populations by commit are in [instruction-size-snapshots.json](instruction-size-snapshots.json). The current 68-file total is 546,488 bytes, measured as file size rather than model cost.

- Full runtime gate on `16dfe1e` stopped at 119/122 suites: knowledge-injection failed to load the new redactor from its hand-built plugin, and this same failed candidate caused hook-execution evidence to refuse and the validator suite to fail. This was a fixture packaging omission introduced by the dependency change, not a proven production hook failure. The fixture now copies the real script directory, excluding only its deliberately disabled classifier in seeded-only cases; `node tooling/test-knowledge-injection.js` passes 30/30. A fresh committed candidate is required before rerunning the full gate.

### Bounded mission-store prototype review

An ignored two-file metadata-store draft adds explicit private admission, exclusive worktree reservations, events, fenced settlement, persisted attempts/backoff and received-versus-envelope-accepted state. It has no actual worker, supervisor, external transport, verification or release transition. Its initial 19 process scenarios and five targeted mutations cover concurrent claims and two killed transactions. Independent review additionally passed same-worktree racing, post-commit/pre-output crash recovery and historical receipt/stale-owner controls. Root then reproduced a new input defect: splitting the UTF-8 bytes of Café caused Caf�� to be persisted with exit 0; the full-byte control preserved the input. Evidence: [mission-store-utf8-results.json](mission-store-utf8-results.json). The draft is being corrected before adoption; its checks are not part of the current source gate.

- Fresh runtime gate: `npm run gate > .claude/reports/brain-live-audit/gate-runtime-final.log 2>&1` on clean `c1fa1c68b146a15b6a8af706aed4da37f7fc0a2c`. Tracked source remains frozen; all further prototypes and conformance evidence stay ignored.

### Final consumer-contract pass

A fresh real-CLI consumer probe found a quiet fallback in fleet-overlap: two sessions in its known envelope produce one overlap, but placing the same two records under an unsupported envelope yields exit 0 with zero sessions and zero overlaps. An invalid `sessions: 0` container gives the same false empty output; the valid empty-array control also returns 0. This is a controlled compatibility/failure-path gap, not evidence that the live producer currently emits that format. The existing suite explicitly blesses an unrecognized envelope as empty. Commands and all four populations: [fleet-envelope-results.json](fleet-envelope-results.json). B25 records the repair contract.

### Actual worker-adapter admission trial

One owned Codex CLI 0.153.4 run generated a single fixture file and passed six independent HTTP checks; the baseline failed and a known-positive control passed. The native run exited 0 after 38.294 seconds. It also emitted a native rejection of the installed core hook manifest because `modules` was unsupported, plus a memory SessionEnd timeout clamp. This establishes code execution but does not admit Brain/Auto hook compatibility. No second model call or resume trial was made. B26 now precedes autonomous worker activation; a host-specific manifest and real hook canaries are required. The source candidate remains separate from the installed version. Exact evidence: [cli-conformance/README.md](cli-conformance/README.md), including native errors, acceptance controls, context/usage readback and cleanup. The one run reported 91,376 input tokens, 67,072 cached input, 853 output and 86 reasoning output; these are native usage fields, not a cost or success-rate estimate. The expected deployed artifact was not involved.

- Mission-store UTF-8 repair is now independently verified: 22/22 scenarios, strict malformed-byte rejection, exact 256 KiB byte budget, and an acknowledged input-chunk boundary. The original root probe now preserves Café and identical contract hashes. Final runtime SHA256 `07ebc59fafde342ac8bd853eaa02e2014f62b85cf30ccaefef1e37929f3e341a`; this remains an ignored, reviewed prototype outside the current source gate.

### Host compatibility planning and final skill population

The [host-specific admission plan](host-compatibility-plan.md) preserves Claude function hooks and requires native parser, runner, payload, blocking and timeout canaries for each intended host, including Claude. Preserving Claude source is not evidence that its installed hooks execute; the installed Claude module-scan warning remains unresolved. Removing an unsupported manifest field is not a complete repair: the pinned native handler schema has no `args` field, the runner executes a command string, and the existing memory package supplies `command: node` plus separate `args`. This source trace requires native execution confirmation before reporting which installed scripts ran. No installed setting or package was changed.

Final Git-object inventory on `c1fa1c68b146a15b6a8af706aed4da37f7fc0a2c` confirms **68/68 active skills changed**, totaling **546,488 bytes**, with a clean tracked tree at capture. Exact per-file hashes, baseline and commands: [skill-final-candidate-inventory.json](skill-final-candidate-inventory.json). B26 now explicitly precedes B06 dispatch and B18 activation. The backlog contains 26 scoped items; item count is not a claim that 26 defects remain unfixed.

### Final runtime gate — complete

`npm run gate > .claude/reports/brain-live-audit/gate-runtime-final.log 2>&1` completed with **exit 0** on clean `c1fa1c68b146a15b6a8af706aed4da37f7fc0a2c`. All eight chained stages ran. `npm test`: **122/122 suites passed**. Failure-control sweep: **122 suites, 121 directly verified able to fail, one separately canaried, zero unverified**, clean private worktree and unchanged source refs. Final `git status --short` printed no changes. [Receipt and log SHA256](gate-runtime-receipt.json). The macOS/Windows coverage distinction, Claude module-scan warning and separately measured Codex manifest rejection remain explicit. Neither prototype is part of this source candidate.

The next pass is ordered in [backlog.json](backlog.json): native host packaging/admission first, then mission state, actual dispatch, result delivery and recovery. [Native discovery plan](host-compatibility-native-plan.md) records the exact protocol, the absent default daemon endpoint, and 304 schemas generated by the installed binary; it does not claim a hook ran. Complete the isolated native parser/runner checks without treating that missing default endpoint as a reason to wait for operator permission.

### Final independent review corrections

The final review matched the exact gate log hash, all eight stage headers in order, 122/122 suites, 121 direct failure controls plus one separate canary and zero unverified, and all 68 skill Git objects/546,488 bytes. It also found a missing B11 prerequisite in the suggested execution order; target validation now precedes the B10 mission evaluation. Native canary requirements now explicitly cover each intended host, including Claude, and the journal labels earlier pending states as historical. [Independent review](final-report-review.md).

### Fleet envelope follow-up draft

A four-file ignored draft repairs the container boundary in fleet-overlap and watch-panels, preserving array/sessions/rows forms and valid emptiness while refusing unsupported, malformed and competing containers. Actual CLI comparisons pass 29/29 per consumer on the draft, versus 8/29 baseline and 25/29 for a type-only fallback alternative. Expanded suites failed before (155/233 and 97/144) and pass after (233/233 and 144/144). Root reviewed the runtime/test diff; adoption and final candidate gate remain pending. Five of seven malformed-row controls still silently clear on both baseline and draft, so B25 is explicitly partial and row validation remains open. [Draft evidence](fleet-envelope-draft/README.md).

- Final fleet draft freeze: root verified all four original/draft pairs and all ten evidence hashes against the manifest; manifest SHA256 `ef2823e360f1196d6da6642623f81eaf09e52be285aba2bbd42df288ee684041`. Author reports disposable fixtures cleaned and no retained test processes. Source remains clean on the fully gated c1fa1c6 candidate.

## Overnight pass: native host contracts, 2026-09-09 01:07 UTC

This pass continues the source audit at c1fa1c6. Its full gate remains the last completed source gate; the new source edits below are pending a new committed-candidate gate. B26 is confirmed at the native boundary, not only inferred from source types.

- Codex 0.153.4 owned runtime: native initialization works with child-only documented CODEX_HOME, sqlite/log roots and OS containment. The earlier real-home startup failure is resolved by isolation, without granting any write exception to the actual installation ID. Parent settings and installed plugins are untouched.
- Four actual native cases reconcile catalog/trust/status with receipts: top-level modules yields zero hooks plus warning even with errors empty; separate args fails; a quoted eagerly substituted root containing a dollar token fails; host-specific manifest plus static argv wrapper works. Positive startup and wrong-matcher controls accompany these observations. In all three completed turns, the required prompt hook is blocked but turn status is completed/error null/CLI exit 0. itemsView:notLoaded prevents treating serialized items=[] as absence evidence.
- Claude 2.1.233: eight no-model native invocations prove startup exec-form args, root preservation, matcher and timeout controls. Invalid executable failure can still leave CLI exit 0. Function-module initialization remains unverified on --init-only (valid and invalid probes produced no module receipt/parse error beside working command controls). Root independently checked 54/54 evidence hashes.
- Durable execution design: independent actual-store characterization passed 8/8 and preserved 22/22 original store scenarios. These reveal missing adapter boundaries: one reservation does not serialize launches, timeout does not prove stopped worker, late first result is lost, accepted envelopes have no rejection/release lifecycle, historical receipt is not current authority. A contained next runtime slice is underway; no real worker scheduler was connected.
- Applied the previously frozen B25 container repair (4/4 exact source/draft hashes matched). Unknown/malformed/dual-key envelopes now produce unavailable-evidence errors before a clearance or watcher dedup update. The measured actual CLI comparison was 29/29 for the proposal, 8/29 baseline and 25/29 simpler array-type alternative, per consumer. Row-shape validation remains open and no live fleet completeness is claimed.

Evidence: codex-host-canary/README.md, verified-receipts.json and manifest.json (25 artifacts; manifest a7280ff9f73442a233c9ee92eba82e6432566aa97c5fd78e19c571f307a80fee; zero remaining owned native/hook processes), claude-host-canary/README.md and manifest.json, mission-adapter-draft/README.md and acceptance-cases.json, fleet-envelope-draft/manifest.json. Native tool-pipeline allow/block evidence is being frozen separately; it is not included in the four startup observation cases. Ratings remain unchanged until the new integrated candidate and required boundaries are verified.

Own probe corrections: thread/start alone did not trigger SessionStart; a first-turn driver unsubscribed before the guard settled. Definitive cases wait for native turn/completed before unsubscribe. Receipt reconciliation initially read the wrong JSON-RPC nesting and failed; corrected to result.data before recording 4/4. These failed probes remain in the evidence directory.

Timestamp correction: the pass heading was first typed as01:25UTC from an estimate; the current-time tool returned01:07UTC. The heading now carries the observed time. Execution timestamps in native receipts are unchanged.

## First overnight source candidate: 08cd93c3e02f622adc613f0cd683e88641afe3ab

Committed23files locally: fleet envelope/consumed-row validation, generated Codex host packages, single-version-writer/drift integration and current host-admission skill guidance. Targeted actual suites: fleet295/295, watcher216/216, generated packages40/40; validator20PASS/0FAIL/2WARN (native admission and Claude module scanner remain warnings). Full npm run gate is running on the clean committed tree; see gate-host-package-receipt.json/log.

The row repair was measured against actual original consumer CLIs: candidate22/22 fleet and20/20 watcher, container-only baseline3/22 and3/20, object-only alternative8/22 and8/20. Independent review caught one consumed field I had missed: unknown state suppressed the blocked-row count while reporting success. Producer-state validation and three rejection cases now cover it; final295-assertion suite passed. No live-fleet discovery-completeness claim is made.

Root independently native-tested the exact frozen package generator: actual projected plugin catalog17core/4memory/0stack hooks, no catalog warnings/errors; generated wrapper positive/guard/end receipts preserve root and cwd. Required guard blocked, turn still completed. This proves discovery and transport only. Full details/limits: codex-generated-native-receipt.json. Native tool-pipeline evidence separately confirms actual patch-filter and shell-cwd gaps; fixes/containment checks continue in ignored drafts while source remains frozen.


### Overnight native boundaries and mission challenge — 01:47 UTC

- `npm run gate` completed with exit 0 on clean unchanged `08cd93c`: all eight stages ran, and the first stage passed 123/123 suites. Duration 1,436.653 seconds. The log SHA256 is `b20c592f9b44a86a508b5871411145105de7ed8bb4c8263381e30a40c7c80d35`; see `gate-host-package-receipt.json` for actual start/end times.
- Native Codex workspace-write controls covered eight decisive cases: inside exec/patch writes succeeded; foreign workdir, absolute and symlink exec writes, foreign Git commit, absolute and traversal patch writes failed without those effects. Nine first-level turns include one explicitly inconclusive short Git receipt, followed by a terminal refusal. The earlier six-turn nested sandbox cohort failed its allowed control and proves no containment. Scope is Codex 0.153.4 on this macOS host, workspaceWrite with no extra writable roots, networkAccess false and approvalPolicy never; default writable temporary directories remain. This does not repair the missing workdir hook payload in danger-full-access.
- The native patch proposal passed 59/59 actual hook CLI assertions and 44/44 unchanged Claude assertions. Original source passes 26/59; the first proposal passes 53/59. Independent review added 26/26 controls, while ten native turns bind final runtime `16247f94…` to actual effects. Root found and fixed a first-draft false denial of ordinary Update context that resembled patch headers. A suspected symlink-parent bypass was disproved by native effects; lexical normalization matches the host. Generated-manifest activation controls are still pending.
- Root verified 113/113 containment artifacts, 210/210 round-two patch artifacts and 18/18 independent-review artifacts against their manifests. The first verifier stopped on heterogeneous manifest shape before producing a receipt; the corrected reader and explanation are in `native-round2-artifact-readback.json`.
- Independent mission-v2 testing found draft-only blockers: writes under a read-only contract, followed dangling/hard links outside the checkout, dirty files hidden by Git index flags, lost close evidence while SQLite is locked, and unmetered preregistration helper launches. None of that prototype was integrated. Root's five-case write-boundary regression fails against frozen v2 and passes against the v3 worker. Operations' ten-case hardening regression reports 3/10 before and 10/10 after; independent final review is pending. The mission state deliberately remains `verified: false`, including review-ready artifacts.


### Mission v3 review and matcher correction — 01:53 UTC

The mission prototype is frozen under `mission-runtime-v3-draft/`; it is not integrated into the shipped plugin. Root verified 7/7 operations-owned source/test files, 14/14 evidence artifacts and the root-owned worker against the operations manifest. Its new hardening suite reports 10/10 after, 3/10 before; inherited store/CLI/adapter/crash suites report 22/22, 4/4, 20/20 and 4/4. Five new and five inherited mutations each fail beside passing controls. Root's actual write-boundary suite passes 5/5 on final schema3. Independent final review passes 6/6 with six owned children closed and no model calls, covering stale registration, historical claim replay, late result quarantine, blocked completion and artifact changes. See `mission-v3-architecture-independent/README.md` and `mission-runtime-v3-draft/OPERATIONS-NOTES.md`.

The remaining integration is explicit: bind immutable story criteria and admitted host identity to the mission; implement a real contained host adapter; verify its exact immutable candidate independently; compare the original story before recording completion; then promote under existing authority and verify the actual live target. Local metadata ownership is not authentication against same-user malicious code; fixed synthetic child handling proves no arbitrary descendant containment. No source rating is raised for an unintegrated prototype.

Generated-manifest native testing **disproved our earlier matcher inference**. Both the existing Read/Write/Edit registration and an explicit apply_patch alternative selected the final guard, allowed ordinary changes and blocked protected changes. The host aliases matching internally; tool names alone did not establish missing registration. The repaired payload handler is necessary; the additional matcher is an evaluated equivalent alternative and is not being adopted. Earlier raw receipts and mistaken notes remain historical evidence; current guidance and generated capability descriptions are corrected.

At 01:49 UTC the account readback reported 90% of the weekly Codex allowance used, 10% remaining. No reset was consumed. Additional broad passes were stopped to reserve capacity for concrete integration, the full gate and a recoverable handoff. Overnight scheduling remains active until its already configured 08:00 Athens limit; account capacity constrains further execution.


### Applied native patch candidate — 01:56 UTC

Commit `c948221b2ce797e0da1a227a2c531689ab291bb2` contains11 explicitly staged paths: the native patch handler and59-case suite, reviewed generator metadata and49-case package suite, three regenerated capability records, host guidance and generated AGENTS. Root hash-checked 80 integration artifacts and the required runtime before adoption; all 10 proposed source/generated deliverables then matched the selected proposal. Existing Claude suite44/44 also passes. `npm run gate` is now running on the clean committed source; tracked edits are frozen.

All 68 shipped skill files differ from baseline:629,738 → 548,473 bytes. This is a byte count over SKILL.md files, not a reliability measurement. `skill-native-candidate-inventory.json` binds each current file to this commit. All agents have finished their bounded work; resume details are in `OVERNIGHT-HANDOFF.md`.


### Final gate and current assessment — 02:20 UTC

`npm run gate` completed all eight stages on clean unchanged `c948221b2ce797e0da1a227a2c531689ab291bb2` with exit 0. First stage:124/124 suites. Failure verification:123 directly verified,1 separately canaried,0 unverified. Elapsed1,432.335seconds. Log SHA256:`eae196a9d19329bff866727fbb20c066a20e647bb88e475d30e230ad00625c7e`. macOS-only limits and Claude function-module scan warnings remain in the log; no Windows or entire installed-plugin admission is implied.

The 17 current ratings are published above and in `ratings-native-candidate.json`. `summary.md` is the compact readout. The reviewed mission prototype remains unintegrated, and its successful fixture tests do not raise source dispatch/recovery scores. At02:18UTC the account reported94%weekly used,6%remaining. No reset was consumed. The existing hourly continuation remains scheduled until08:00Athens; capacity is a real limit on further work.

Final-report count correction: a publication assertion expected 10 commits after baseline and stopped before writing the compact summary. Actual `git rev-list --count 9f9746f..HEAD` printed **12**: the ten audit commits plus two upstream ancestors integrated by the role-recovery merge. The corrected summary avoids attributing every ancestor to this audit. The gate and source verdict are unaffected.


### Memory CLI health repair — 2026-09-09T02:32:27.675845+00:00

Committed `e90547968c0c41252a4a8d3829e27cd30a89f484`: explicit query commands now open an existing database read-only, validate its schema and return exit 2 with a structured error on stderr and no stdout on failure. Configured CLAUDE_CONFIG_DIR selects the shared store; legacy fallback remains when absent. Imported API degradation and read-time initialization remain outside this bounded fix. No private/live store was accessed; a subject-scoped preload redirects baseline legacy lookup into owned fixtures.

Actual final CLI corpus: candidate 117/117, baseline 54/117, simpler existence-only check 74/117. A read-write constructor mutation passes 115/117 and fails exactly the actual SQL denial and unchanged database assertions; the same SQL injection succeeds on the writer connection. Existing CLI, knowledge and injection suites pass 34/34, 30/30 and 30/30. Independent review of unchanged runtime passed its initial 114-case corpus and two 40-failure mutations; final tests incorporate its exact-diagnostic suggestion and root's stronger populated-store and SQL denial controls. Three memory skills were reconciled. Full clean candidate gate is next; ratings are not yet raised.


### Final memory conflict proposal — 2026-09-09T02:43:06.698115+00:00

The ignored `memory-conflict-draft` preserves distinct concepts/source contexts, groups only identical public payloads, retains contributing observation IDs and uses insertion order for timestamp ties. A further actual API probe confirmed that the writer suppressed an identical decision in another project within30seconds; its distinct-content positive control succeeded. The proposal scopes duplicate suppression to normalized project and redacted source-file payload, reusing the exact representation inserted into SQLite.

Final actual API corpus:18/18 candidate versus8/18 baseline and13/18 concept-only grouping. Removing the tie-break gives14/18. Independent review passed a5-case area/privacy/provenance fixture and18/18 final controls; a valid SQL mutation removing the project constraint fails exactly the cross-project preservation assertion,17/18. API provenance is retained; the existing Markdown renderer does not display those identifiers. Legacy project normalization, imported API health and legacy data remain outside scope. The current e905479 full gate is still running; no tracked source was edited during that gate. Three-file proposal hashes are frozen in memory-conflict-draft/manifest.json.


## Memory health gate completed; conflict repair adopted

`npm run gate` on clean `e90547968c0c41252a4a8d3829e27cd30a89f484` completed at 2026-09-09T02:56:28.355435+00:00 with exit 0, 125/125 suites and zero unverified suites. Both refs stayed unchanged. Receipt: `gate-memory-health-receipt.json`; log SHA256 `5e423dbde79f3465dab60574cd507ac0041bb349ce11565d9f4f744c5b057f90`.

The reviewed three-file conflict/writer proposal was adopted only after validating that receipt and all source hashes. Applied checks passed: conflict18/18, read-health117/117, legacy knowledge30/30, CLI34/34 and generated Codex projection8/8. Commit `95f3737c21a6ee324d73116ec1a745beacd9f041` is now frozen under the full gate. Its pending receipt is `gate-memory-conflicts-receipt.json`. The runner session is 47919; see `finish-memory-round.log`. Do not modify tracked files until this gate ends.


## Final memory round — 2026-09-09T03:22:42.827142+00:00

The actual command `npm run gate` returned exit 0 on clean `95f3737c21a6ee324d73116ec1a745beacd9f041`: 8/8 stages, 126/126 suites, 125 directly verified able to fail, one separately canaried, zero unverified. Both refs remained unchanged. Log SHA256: `d5afff6ea50b60195df08a9aa2ed3108df64c44dea3a9bb412d46ed6638ec5f0`. The complete runner exited 0; `finish-memory-round.log` preserves adoption and commit events. No push, install or production change was performed.

Memory and privacy moves from 5/10 to 6/10 for executable negative paths and independently tested preservation. The other 16 scores remain unchanged. These ratings measure source/control maturity, not task success rates. `skill-memory-candidate-inventory.json` records all 68 Git objects: 68/68 changed from baseline, 629,738 baseline bytes and 549,165 candidate bytes. Reduced bytes do not prove improved model behavior. `git rev-list --count 9f9746f..HEAD` returned 14 commits, including two upstream ancestors already documented; do not describe all 14 as new audit commits.

At 03:11:50 UTC the account readback was 99% weekly usage, with two available reset credits; no credit was consumed. The existing overnight heartbeat remains scheduled through 08:00 Athens. Preserve capacity and the reviewed evidence; do not claim the fixture-only mission prototype is integrated or production verified.


## Morning supplemental syntax coverage — 2026-09-09T04:26:18.945056+00:00

CLAUDE.md identifies a CI-only hook parse loop outside the eight-stage local gate. The equivalent `node --check` invocation was run against every current `plugins/*/hooks/*.js`: 23/23 files passed. An independently malformed JavaScript fixture returned nonzero with SyntaxError, confirming the parser rejection control. Exact source hashes and streams are in morning-hook-parse.json. The worktree stayed clean at 95f3737c21a6ee324d73116ec1a745beacd9f041. This adds syntax coverage only; ratings stay unchanged and no host/OS execution claim follows.


## Overnight window closed — 2026-09-09T05:01:46.541142+00:00

The final heartbeat arrived at05:00:45.795UTC, so the corrected deadline wake was actually observed. Candidate `95f3737c21a6ee324d73116ec1a745beacd9f041` remains clean and identical to the successful full-gate receipt; its log hash and all23 supplemental hook source hashes were checked again. Ratings remain as recorded in ratings-memory-candidate.json:17 aspects, no new score increase for syntax-only evidence. Final morning-report.md contains before/after scores, verified improvements, unresolved gaps and next priorities. No additional implementation was started after the deadline. No usage reset was consumed.
