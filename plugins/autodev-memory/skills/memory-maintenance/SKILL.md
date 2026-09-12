---
name: memory-maintenance
description: Audit and repair authorized project memory and instruction drift with verified project mapping, recoverable edits, and explicit unresolved contradictions.
when_to_use: "Invoked when the user says \"memory maintenance\", \"defrag memory\", \"dedup memory\", \"tidy memory\", \"clean up CLAUDE.md\", or by a configured maintenance routine."
allowed-tools: Bash, Read, Write, Edit, Grep, Glob
model: opus
user-invocable: true
argument-hint: "[project path | --all | --dry-run]"
---

# Memory Maintenance

Repair retrieval and stale factual claims while preserving unique knowledge,
the user's instructions and current authorization. A similarity score is a
lead to inspect, not permission to merge or delete.

## Establish scope and read the audit

Use the supplied project path, otherwise the current project. `--all` expands
to the projects covered by the user's request or still-valid maintenance
mandate. Unattended execution does not enlarge that scope.

Resolve the active configuration directory from `CLAUDE_CONFIG_DIR` or the
current user's `.claude` directory. Verify that it is present and readable
before interpreting an empty report. The audit can return `projects: []` with
exit 0 even when the configuration directory is missing.

The shipped audit reads multiple projects and has no project filter. For a
request whose read scope is limited to one project, inspect its verified memory
directory directly using the repair checks below; do not pass a project argument
and assume the command becomes scoped. When cross-project inventory is within
the existing scope, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory-audit.js" --json
```

It audits recently active stores; `--all` includes inactive stores and
`--stale-days=N` changes the activity window. A positional project argument does
**not** restrict it. Filter the results to the authorized edit set. Confirm the
storage-id-to-project mapping from a known project path or host metadata; the
audit's decoded path is only a guess. Existence of the guessed directory alone
does not establish identity. An inactive store omitted by the default scan is
not an audited-clean store.

The current mechanical audit reads only top-level Markdown files and compares
index targets by basename. It can miss a malformed nested note and flag an
existing nested target as dead. Enumerate approved nested Markdown records
separately and resolve each index target by its exact relative path before
editing; report that population separately from the tool's top-level count.

Report stores and files examined, excluded projects, detector errors and the
findings. For an absence claim, confirm a known stored file is in the audited
population. Missing/unreadable roots and failed commands are incomplete audits,
not clean memory.

`--dry-run` performs read-only scope checks and audits and reports proposed
repairs. Do not create recovery copies, change memory, refresh instructions or
write a heartbeat from a dry run.

## Make recoverable, owned repairs

Before editing, record the selected file paths and hashes and save private
recovery copies outside the automatically loaded memory directory. Include an
index copy and a mapping from originals to replacements. Use the configured
private recovery location; never put memory content in a public repository.
Re-read a file before replacing it; if another session changed it, reconcile
against that new content rather than overwriting the peer's work.

Apply only repairs supported by the underlying files:

1. Add missing frontmatter from the file's actual meaning. Do not invent a
   decision or authority while supplying metadata.
2. Repair index links by resolving their exact relative targets, including
   subdirectories. Remove a pointer only after establishing it is obsolete;
   restore a renamed target's link when that is the actual cause.
3. Add concise pointers for unindexed memories. A dangling `[[link]]` may mark
   knowledge still to be written; do not remove it solely because it is absent.
4. For overlapping memories, preserve unique conditions, evidence, dates and
   superseded context in the survivor. Conflicting claims remain explicit until
   current source evidence resolves them. Recency, filename and shared words
   do not settle a contradiction.
5. Only remove a redundant file after reading back the survivor and proving its
   unique content and references are preserved. Keep its recovery copy and
   recorded replacement until the approved retention period expires.
6. Compress an oversized `MEMORY.md` by shortening index entries and linking to
   details. The checker uses 200 lines / 25KB as thresholds; those are not evidence
   that the memories themselves should be combined. Preserve unrelated domains.

A missing or ambiguously mapped repository remains pending; do not delete its
memory or edit the directory that happened to match a lossy decoded path.

## Refresh factual instruction drift

For verified in-scope repositories:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/claudemd-audit.js" <repo> [<repo>...]
```

Treat its findings as candidates. Check the named path or command and the
surrounding sentence against the current checkout. A deleted-file anecdote,
generated file or command used on another documented platform may still be
correct. Fix claims whose current meaning is disproved; preserve user policies
and explicit exceptions. Do not rewrite preferences as “outdated” or move
instructions into `.claude/project-rules.md` without verifying that the new
location is both loaded and durable in this project.

## Verify the repair and report

Re-run the relevant audit and resolve the exact index/link targets. Compare the
original and resulting memory population, naming each intentional merge and
any unresolved contradiction. Detector counts alone cannot prove preservation.
Record what changed, the evidence, validation and the recovery location. If
nothing needed repair, report the checked scope once; do not manufacture work.

For a requested nightly routine, use the scheduler available on this host and
update the existing matching task. Verify its project scope, cadence,
invocation and durable result. Record attempt and outcome separately so a
failed run cannot look successful merely because it touched a timestamp. Use
the scheduler's actual state location and schema, not a guessed `<task-id>` or
an unrelated host's scheduled-tasks directory. Keep unchanged successful runs
quiet; report failures and actionable unresolved work according to the user's
notification preference.
