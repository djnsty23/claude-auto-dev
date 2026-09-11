# Independent memory privacy review — B21 portion

Reviewed frozen `memory-runtime-draft/README.md`, `manifest.json`, `review.diff`, all three source deliverables, their actual PostToolUse/classifier/carrier callers and the relevant skill overlay. All eight declared draft hashes matched; the five tested JS files in its `after/` tree matched their declared draft hashes. This is B21 privacy work. B20 is unhealthy-store behavior, and B21's conflicting-title loss remains a separate unresolved issue; the original draft README misnumbered these.

## Confirmed P1: extraction removes boundaries before the writer can redact

At base `e1b6aacde570ac4ab9ee44c8e1f3d86733410fab`, unchanged by the frozen privacy draft:

- `plugins/autodev-memory/scripts/observation-classifier.js:35–42,47–56` derives `path.basename(filePath)` before the final database redaction. A supported unclosed opening in a directory can therefore disappear from the title while the protected filename survives.
- `plugins/autodev-memory/hooks/memory-capture.js:29,103–127,153,179` separately derives an area from raw `tool_input.file_path` and persists it in `.claude/knowledge-surfaced`; database filtering never guards that file. The same area can enter diagnostics when knowledge exists. Persistence was reproduced; that conditional diagnostic consequence is source-supported and was not independently triggered here.
- `memory-capture.js:50–53` serializes/clips results before the classifier, and `observation-classifier.js:30–31,50–51,71,81,101,111–112,139,185` normalizes, classifies or truncates input before redaction. On the bounded fixtures, this loses public suffixes or lets protected words influence classification even where the final writer prevents the protected string itself from leaking.

Reproduction, from `<audit-worktree>`:

```sh
node .claude/reports/brain-live-audit/orchestration/privacy-independent.cjs
```

Actual result in `privacy-independent-results.json`: three protected PostToolUse path cases / three persisted a secret basename, while their `source_files` were redacted. A representative row was `title="Created UNCLOSED_BASENAME_SECRET.ts"`, `source_files="[\"…/project/[REDACTED]\"]"`. Every hook exited 0 and inserted a real row. The fourth path case was the known-positive public control and stored `Created public-control.ts`. These are legal synthetic POSIX path strings passed to the actual memory hook; no Write/Edit/Read tool or production file operation represented by the payload was executed. This is a marked-input boundary failure, not a claim about unmarked secrets or universal real-world prevalence.

Six independent direct database + prompt-carrier cases all preserved literal expected boundaries and valid JSON, including stray closing tags before nested tags, mixed-case unclosed regions, quotes/backslashes/newlines/supplementary Unicode, lookalikes, empty regions and 16 nested regions. Three real database serialization failures (cycle, BigInt, throwing `toJSON`) all rejected without a partial row or protected diagnostic, and each subsequent public recovery write succeeded. No defect in the bounded shared scanner contract was found; writer/carrier-only checks nevertheless did not cover extraction.

## Exact overlap and correction

Read-only `gh pr view 221 --json number,state,headRefOid,baseRefName,title,files` returned OPEN, head `e058ad9e9f3775822247ef70a6c42052032bc7d8`, title “docs(gate-integrity): redact before you transform, and search for the transformed value”. Its only files are `AGENTS.md` and `plugins/autodev-core/skills/rule-gate-integrity/SKILL.md`. Exact-head source section 11 was read. It supplies the applicable ordering/test lesson but no runtime patch to duplicate.

The separate `memory-extraction-overlay/` applies that lesson using the frozen draft's shared helper. The classifier filters inputs, prompt and result before basename/type detection/case conversion/clipping. PostToolUse filters structured input/results before extraction and serialization/clipping. A file path changed by filtering skips domain knowledge lookup and its area marker; it is not replaced with an invented filesystem identity. A normal public area remains functional. The database remains the final write guard, and one knowledge skill paragraph records the actual new boundaries.

The test was added before the overlay source changes. Commands and complete stdout/stderr:

| Candidate / command | Actual outcome |
|---|---|
| `memory-extraction-overlay/before`: `node tooling/test-session-carrier.js` | **57 passed, 11 failed**; specific failures cover basename privacy, area persistence, classification, result/command/grep clipping and direct-classifier inputs. |
| `memory-extraction-overlay/after`: same command, same final tests | **68 passed, 0 failed**. |
| `node …/orchestration/privacy-independent-overlay.cjs` | Protected PostToolUse leaks **0/3**, public path control passed; direct DB/carrier **6/6** and serializer/recovery **3/3** retained. |
| Six existing memory suites against the overlay | **272/272 assertions**, no SQLite skip: semantic 68, carrier/extraction 68, CLI 34, session end 31, knowledge 30, dashboard 41. |
| Hook-only alternative: restore old classifier | **66 passed, 2 failed**; direct-classifier prompt and edit fallback assertions fail. |
| Classifier-only alternative: restore old hook | **65 passed, 3 failed**; two result-preservation checks and the area marker assertion fail. |

Both partial alternatives retained all three public-row assertions. Thus the red results are attributable to the removed safeguard, not an empty population or broken fixture. Outputs are `before.json`, `after.json`, `targeted.json`, `variants.json`; the `before/`, `after/`, `hook-only/` and `classifier-only/` trees preserve exact runnable inputs. The test executes actual hooks in child processes, queries actual SQLite rows and checks decoded fields plus a positive `[REDACTED]` marker.

Falsifier: any supported protected marker survives in a new row or area marker, the actual public row/area control disappears, the exact public suffix expected after redaction is lost, or removing the responsible boundary stays green. These tests do not prove historical cleanup, unmarked-secret detection, cross-entry tag state, every unsupported tag spelling, generic store health or production activation.

## Recovery and limits

No tracked source, real memory database, installed runtime, HOME setting, or fleet state was changed. The independent probe now runs its database work in an isolated child; `memory-db` exposes no close API, so child exit closes SQLite handles before the parent removes its explicitly owned fixture in `finally`. Both repeated probes reported `fixture_exists False`. The earlier owned `privacy-fixture-TRmg6C` was removed explicitly. Existing test suites removed their own temporary stores; no long-lived process was started. Scripts and full outputs remain reproducible.

One drafting error was corrected before validation: the first skill-copy attempt used the runtime `after/` tree, which did not contain the separate frozen skill overlay, and an assertion stopped that write. The delivered skill correctly starts from `memory-runtime-draft/plugins/autodev-memory/skills/knowledge-agent/SKILL.md`; its predecessor hash is explicit in the overlay manifest.

This review covers the ignored overlay, not an applied or installed release. The repository gate must run after integration. Do not claim privacy completion from the original 244 assertions alone, nor from this bounded 272-assertion result beyond the supported new memory paths.
