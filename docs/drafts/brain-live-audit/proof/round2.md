# Independent delta review — round 2

Reviewed current working diff against baseline `9f9746f`, 2026-09-09 local date. Scope was compact Brain/auto-brain, preserved historical bodies, coordinator quoted-space guard, Stop notification cooldown, and spec checker. No tracked edits by this review. Root owns the final gate; I did not run it.

## Verdict: one remaining blocker in spec lifecycle handling

1. **P1 — Schema moves/drops reuse discarded RLS evidence.** In `plugins/autodev-core/scripts/check-spec-output.js:189-238`, `enabled` and `policies` are keyed by table name and survive unsupported lifecycle statements. `DROP TABLE` is explicitly refused at 229, but `DROP SCHEMA` is ignored; `ALTER TABLE ... SET SCHEMA` passes the branch without changing evidence. A later `CREATE TABLE` with the same qualified name overwrites `created` and inherits the earlier object's security declarations.

   Real CLI fixtures (complete SQL input and argv/output in `round2-results.json`):

   - Protected `public.notes`, then `DROP SCHEMA public CASCADE; CREATE SCHEMA public; CREATE TABLE public.notes(id integer);` → **exit0**, `1 tables ... (1 with RLS)` and structural-pass text. The surviving replacement table has no RLS/policy declarations for its lifetime.
   - Protected `public.notes`, then `CREATE SCHEMA archive; ALTER TABLE public.notes SET SCHEMA archive; CREATE TABLE public.notes(id integer);` → **exit0**, same false pass. Security belongs to `archive.notes`, not the newly created `public.notes`.
   - Positive controls: protected table alone exits0; unprotected table alone exits1 naming missing RLS and policy; same lifecycle using `DROP TABLE public.notes` exits1 naming the intentional lifecycle refusal.

   Falsifier: both unsupported lifecycle fixtures exit nonzero (or execute against a database and validate final state), while the protected-table control stays green. A narrow extension of the existing unsupported-lifecycle refusal is enough; no general SQL interpreter is needed. PostgreSQL documents [DROP SCHEMA CASCADE](https://www.postgresql.org/docs/current/sql-dropschema.html) removing contained tables and [ALTER TABLE SET SCHEMA](https://www.postgresql.org/docs/current/sql-altertable.html) moving them. No SQL was executed against any product database.

## Compact Brain/auto-brain contract: no actionable regression found

Commands read: `cat` both active SKILL.md files; indexed historical headings and critical instructions with `rg`; read the retained role claim, release, permissions, exit and dispatch passages. The active text preserves scope/source distinctions, role UUID versus message-address separation, installed-source distinction, bounded dispatch plus real start acknowledgment, dependency-ready work, independent review, real UI/API acceptance, exact-candidate gate, production preconditions before push/merge, recovery and durable handoff. It correctly states that Stop hooks cannot guarantee delivery or revive a dead process. The new idea→spec→setup→core→auto path continues the mission instead of stopping after planning.

Historical-body preservation was mechanically checked against `git show 9f9746f:<skill path>` after removing frontmatter: both history files contain the **exact prior body**. Active file bytes: Brain **10835** versus **96590** baseline; auto-brain **2045** versus **27502**. Combined **12880** versus **124092**. Both histories explicitly disclaim being active procedure or authorization, so their contradicted policies do not silently become current permission.

Named helper contracts were checked in their actual CLI implementations: `check-brain-role.js --json` returns `state` and role identity (exit0 includes absent, as the new skill warns); `brain-brief.js` exit2 is mandate refusal; `workflow-run-triage.js` requires a run/selector, discovered through its documented `--help`; `session-exit.js` writes this cwd's RESUME and `--help` exits before writes. The procedure tells the agent to inspect schemas/help before use rather than inventing fixed arguments.

## Operations changes: no actionable regression found

The quoted-space change preserves argument boundaries through the existing placeholder/unwrap mechanism and leaves command segmentation intact. Existing real-subprocess controls cover foreign/home paths, quoted `-C`, `cd`, `--git-dir`, `--work-tree`, quoted mentions and inert commands. The Stop change only avoids advancing delivered HEAD during suppression, and exact same-HEAD post-expiry + duplicate-suppression controls pass. Its lack of a future Stop remains a known limit; the compact contract explicitly records it rather than claiming guaranteed delivery.

Independent executions via `node .claude/reports/brain-live-audit/proof/round2-probes.cjs`:

| Actual suite | Result |
|---|---|
| `node tooling/test-check-spec-output.js` | exit0, 45/45 |
| `node tooling/test-coordinator-write-guard.js` | exit0, 102/102 |
| `node tooling/test-stop-brain-report.js` | exit0, 37/37 |

The spec suite's green result does not negate blocker 1; the newly supplied independent lifecycle fixtures distinguish the gap.

## Final disposition after root's lifecycle fix: VERDICT CLEAN

Re-ran the **same** independent `round2-probes.cjs` fixtures against the updated checker. `DROP SCHEMA` changes from exit0 to exit1 with `DROP lifecycle needs database verification`; `SET SCHEMA` changes from exit0 to exit1 with `ALTER TABLE transformation needs database verification`. The protected-table control stays exit0, unprotected control stays exit1 naming missing RLS/policy, and DROP TABLE stays exit1. Blocker 1 is resolved.

The latest detailed output is saved in `round2-after.txt` and `round2-results.json` (the reproduction script overwrites its results JSON; the earlier observations remain in this append-only report and the original tool output). Independent suite results now: spec **48/48**, coordinator guard **102/102**, Stop Brain report **37/37**, all exit0. `git diff --check` exits0. The spec's active guidance now explicitly names the limited initial-schema subset and requires database execution for access behavior.

Brain/auto-brain files remain the reviewed **10835/2045 bytes**, and both historical bodies still compare exact to baseline. No new actionable regression found inside the frozen contract. No tracked edits by this reviewer; ready for root's full gate.
