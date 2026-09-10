# Independent report and ratings review

Reviewed report.md, backlog.json, gate-skills-receipt.json and relevant saved evidence at source HEAD a806b7c4632c2374eed683a861523e9628c0151a. This is a bounded truthfulness review, not a new live-fleet or installed-state audit. No private live state was queried and no source was changed. The parent is already updating the transitional opening candidate/ratings after privacy integration; that old opening alone is not a finding.

## Substantive corrections

1. **P2 — B01 acceptance contradicts the adopted historical-candidate contract.** `backlog.json:14` says “Changed HEAD/base/content/gate invalidates evidence.” Actual a806b7c intentionally allows a checked frozen candidate to remain verifiable after a later tracked-ledger commit and later source commits, provided the old candidate is explicit and the verdict identifies it. The unconditional acceptance sentence would direct a later agent to reintroduce the archival liveness defect. This is more than a stale candidate header: it is the future executable acceptance contract.

   Evidence: `deploy-ledger-draft/tracked-workflow-results.json`, produced by `python3 .claude/reports/brain-live-audit/deploy-ledger-draft/tracked-workflow-probe.py`, records explicit candidate verification exit0 after archival/new source, while defaultHEAD verification remains exit1; the new candidate requested explicitly also fails in the 48-case suite. Positive control before archival is exit0. Suggested wording: “DefaultHEAD verification rejects stale candidate evidence; an explicitly frozen historical candidate remains verifiable after archival but never certifies a newer checkout/deployment. Changing the selected candidate or base requires fresh checks. Release evidence must additionally bind current gate/setup/environment; deleted required rows fail and WIDE runtime config is included.” Retain dirty-tree/authority work as explicitly outstanding. Falsifier: if B01 is intentionally asking to remove historical-candidate verification, that incompatible design change must be explicit rather than implied by the old sentence.

2. **P2 — Two documents prescribe different standards for advancing ratings.** `report.md:25` defines engineering judgments on a control-maturity rubric and raises several source scores using fixture/procedure evidence. `mission-acceptance-matrix.md:28` says to advance ratings only after repeated independent missions. No such mission is claimed or recorded. Both policies can be useful, but their current unqualified wording conflicts.

   Recommendation: label the table as **local source/control maturity**, and scope the matrix sentence to **end-to-end mission-performance ratings**. Keep installed/runtime success explicitly unchanged or unmeasured until installed-candidate and mission evidence exists. In particular, the UX/live-journey increase3→4 is attributed only to corrected guidance; say its live effectiveness was not measured rather than letting the number imply that journeys now work better. No objective lower replacement score is inferred from a subjective rubric. Falsifier: a pre-existing documented distinction already assigns these two statements to different rating series; none is named in the reviewed documents.

## Small population/wording corrections

3. **Skill byte count is four bytes high for its named candidate.** `report.md:120` prints543,368 active skill bytes. Reading exact Git objects gives543,364 at e1b6aac, across68 SKILL.md files. Baseline9f9746f is629,738 and Brain+AutoBrain is124,092→13,190, exactly as stated. Current a806b7c is544,381 because ship subsequently changed. At the planned report update, name the snapshot for each size rather than silently mixing them. These totals include frontmatter as well as the body; “active SKILL.md files” is the precise population name.

4. **The four+64 phase count is supported after checking the actual first commit.** Initial comparison against c32a54ec showed5 changed skills because the integration added rule-gate-integrity. That was the wrong comparator for the report's “first source candidate.” The known-positive control `git diff --name-only 9f9746f d88586b944339299c24809984835d8845cee88dc` returns exactly auto, auto-brain, brain and spec:4. The later library commit changes64, and the final union is68. No correction to four+64 is required; this further check refuted my initial suspicion rather than turning an upstream integration change into a report defect. The82-file e1b6aac commit count is correct. Its12 supporting files comprise11 under references/ and one Supabase rules/multi-account.md; calling them12 supporting references is reasonable.

5. **Reference population needs its snapshot.** The68+27 inventory matches c32a54ec. The same immediate-reference path population is25 at9f9746f and28 at e1b6aac. The report distinguishes inventory from semantic reading correctly; add the inventory SHA/date so27 is not interpreted as the final library denominator.

6. **Opening grouping count is ambiguous.** `report.md:7` says seven corrected failure groups; the “Fixed in the first source candidate” table contains8 substantive rows. If the procedural consolidation is intentionally excluded from “failure groups,” state seven runtime groups plus that consolidation, or remove the brittle group count. This is a minor categorization issue rather than evidence that a fix was invented.

## Verified claims and controls

- `gate-skills-receipt.json` names e1b6aac and log SHA256542bae038fffc37a8d9fe26de68fad2af6cb7fa54b1a30fce3f18d58edec5307. Independently hashing the actual saved log matches exactly. The log prints `122/122 suites passed` and `122 suite(s) · 121 verified able to fail · 0 NOT verified · 1 canaried elsewhere, not stubbable here · sweep worktree clean, source tree refs unmoved`. The complete eight-stage green claim is supported. The Windows-only unverified case and hooks-module scan warning are retained; they are not silently counted as executed checks.
- The16-entry readiness replay has baseline, strict and sameName each at1 READY/15 NOT_READY;0 PR verdicts differ. Its lack of a discriminating live mixed-skip case is honestly stated, with fixtures providing that coverage.
- All68 source SKILL.md files differ from baseline by e1b6aac. All76 application-manifest entries, including64 skills and12 supporting files, match the exact applied SHA256 in e1b6aac. This validates adoption/provenance; it does not independently prove that every sentence was understood or every host workflow executed.
- The privacy independent-results population is4 hook cases:1 public control and3 protected cases, all3 leaking in the reviewed upstream draft. Six direct cases and3 serializer/recovery controls pass, matching the report. This is properly distinguished from a finished runtime fix while the parent integrates the extraction correction.
- All12 Markdown evidence links in report.md resolve to existing local files. Existence is not taken as proof of their contents; the relevant gate, adoption, readiness and privacy artifacts were separately inspected.
- Installed source parity is explicitly limited to5 sampled executables plus a manifest. Local changes are explicitly not an installed release. Arbitrary product construction, repeated unattended mission success, live user journeys and real provider/platform correctness remain unproven. The report does not claim that a green local harness gate establishes them.

## Reproduction details

Read-only checks used Python hashlib/JSON parsing and Git object inspection. Exact commands:

```text
git archive 9f9746f7907721921ce3d15fa5ae5020c0ebd227 plugins
git archive c32a54ecfd596b19272efa67408247f7a1b99a22 plugins
git archive e1b6aacde570ac4ab9ee44c8e1f3d86733410fab plugins
git archive HEAD plugins
git diff --name-only c32a54ecfd596b19272efa67408247f7a1b99a22 e1b6aacde570ac4ab9ee44c8e1f3d86733410fab
git ls-tree -r --name-only <same-ref> plugins
```

Archives were read in memory, not extracted. Skill selection used exact path shape `plugins/<plugin>/skills/<skill>/SKILL.md`; immediate references used `plugins/<plugin>/skills/<skill>/references/<file>`. Populations printed:68 skills for all4 refs; byte totals629738,524578,543364,544381 respectively. Skill union68, later touched64, source commit82 files, application hashes76/76. Known-positive controls include the matching gate digest,1 READY replay entry,1 public privacy hook case, and present evidence links. No numerical claim is based on an empty search alone.

**Disposition:** no fabricated gate success, wholesale rating inflation or installed-release misrepresentation was found in this bounded pass. Correct the future B01 acceptance and distinguish the two rating series; the remaining corrections are small snapshot/population clarifications. The planned privacy/state-store integration needs its own updated candidate receipt and full gate, as the parent already states.
