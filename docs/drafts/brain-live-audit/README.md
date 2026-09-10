# Overnight Brain audit, 2026-09-08/09: preserved reports and prototype

Codex ran an overnight audit of this harness on the branch `codex/brain-live-audit`
(head 95f3737). Its reports and the mission-store v3 prototype lived under
`.claude/reports/brain-live-audit/`, which is gitignored, so they existed in exactly
one worktree. This directory preserves the text other sessions need to read and the
prototype the backlog's first open item (B05) builds on. Logs, canary databases and
vendored source snapshots stayed behind (77 MB, mostly SQLite WAL files).

Machine-specific prefixes were replaced: `<audit-worktree>` stands for the audit
worktree path and `<home>` for the home directory. Nothing else was edited.

Start with `summary.md`, then `backlog.json` (acceptance criteria per item and a
`nextExecutionOrder`), then `OVERNIGHT-HANDOFF.md`. `report.md` is the full audit;
`proof/`, `operations/` and `orchestration/` hold the three reviewers' findings.
`mission-runtime-plan.md` is the B05 to B08 design; `mission-runtime-v3-draft/` is
the fixture-only prototype it describes: not shipped, not gated, not wired into
Brain. Its `tooling/test-*.js` files live here rather than under the repo's
`tooling/`, so `test-all.js` does not discover them and `check:suites` does not
grade them.
