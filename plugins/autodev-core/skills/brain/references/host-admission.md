# Admit the host before relying on its controls

Read this before unattended dispatch on a new host, after a host/plugin update,
or when accepting work whose safety depends on hooks. Admission is scoped to
the tested host version, installed artifact, event and operation. A compatible
tool name or source manifest is not execution evidence.

1. Record the actual binary/version and plugin root/hash. Enumerate the native
   hook catalog and compare it with the expected population. Inspect warnings,
   errors and trust/enablement; an empty catalog with exit 0 is not admission.
2. Use an owned fixture with the host's documented child configuration path.
   Keep the parent configuration unchanged. Verify containment with both an
   allowed write and an outside write that must fail; disable external services
   when the test needs none. A fresh process may still write installation or
   database state before any model call, so a status query is not necessarily
   filesystem read-only.
3. Trigger the event through the native host. Check the actual hook input,
   receipt and intended side effect. Pair denial with the same operation allowed
   in a control. Directly piping invented JSON into a hook tests that script,
   not native event dispatch or tool matching.
4. Include paths with spaces and shell metacharacters. Keep plugin roots out of
   shell source when the host expands placeholders before invoking the shell.
   Preserve argv, stdin, exit codes and output drainage. Prove each supported
   operating system's command form separately.
5. Record capability gaps explicitly. Command-hook admission does not establish
   function-module loading, prompt rewriting, output scrubbing, another event,
   or a complete SessionEnd timeout budget. A missing optional control need not
   halt unrelated work; a missing required control leaves that operation
   unadmitted until an equivalent control is demonstrated.

For shell tools, establish whether the hook sees the actual requested execution
directory or only the thread's directory. If that field is absent, a path-based
hook cannot enforce the worker's write boundary from its cwd alone. Require an
independently tested filesystem sandbox for that assignment. Do not silently
rewrite the requested directory or rename a patch tool to Write while ignoring
its additional update/delete/move paths.

Read back the effective sandbox and approval policy, including extra writable
roots and temporary-directory exceptions. Test the native sandbox at the same
execution level as the intended worker: nesting a host sandbox inside another
OS sandbox can break the allowed control. A failed allowed control makes that
cohort inconclusive. A tool returning a running session is not a terminal
refusal; collect its final result and inspect effects before accepting denial.

## Completion has several independent meanings

Reconcile the worker identity and attempt generation, lifecycle status, required
hook outcomes, operation results and acceptance artifacts. A native turn may
finish normally after a hook denies its prompt or tool. Preserve the denial as
an observed failure/blocker; never mark the mission verified from a completed
turn or process exit 0. Retry only after the cause or relevant input changes.

An event containing `items: []` with `itemsView: "notLoaded"` says the items were
not materialized in that event. Read the corresponding item events or supported
history endpoint before claiming no work occurred. An absent result, timeout or
lost connection does not prove the worker stopped. Retain its reservation until
its actual disposition is reconciled; replayed historical acknowledgements do
not renew execution authority.

## Measured host differences, 2026-09-09

Owned native canaries on macOS, Claude Code 2.1.233 and Codex 0.153.4:

| Boundary | Observation | Operational consequence |
|---|---|---|
| Claude startup commands | Both executable-plus-args and shell command forms ran; an invalid executable still left CLI exit 0 | Preserve its supported exec form; inspect effects and diagnostics |
| Claude function modules through `--init-only` | Command control ran; valid and invalid module probes yielded no module receipt/parse error | Module loading on that route remains unverified; do not infer universal absence |
| Codex manifest | Top-level `modules` caused zero hooks and a warning while `errors` stayed empty | Use a host-specific manifest and require the expected catalog population |
| Codex command args | Separate `args` did not reach the command; reading the plugin root in a static Node wrapper preserved it | Generate a tested native command form; do not silently drop arguments |
| Codex placeholder shell expansion | A root containing a literal dollar token broke a quoted placeholder command; the wrapper control ran | Quoting after eager substitution is insufficient |
| Codex prompt denial | Hook status `blocked`, turn status `completed`, error null, process exit 0 | Required hook verdicts participate in mission acceptance |
| Codex shell input | `exec_command` appears as `Bash`, but the requested workdir is absent and hook cwd remains the thread cwd | The hook cannot establish the actual shell write boundary; require independently admitted containment |
| Codex patch input | `apply_patch` retains its name and carries the patch in `command`; the native host also selects the existing Read/Write/Edit registration | Verify actual matching and operation-path handling separately; a different tool name does not prove a matcher gap |
| Codex workspace-write containment | Two allowed controls succeeded; six foreign-path exec/Git/patch controls refused with no tested effects | Admit only the measured policy and paths; extra roots, temp exceptions and other modes remain separate |

These measurements describe synthetic native dispatch, not an installed autodev
release, real model quality or end-to-end product delivery. Keep full commands,
payloads, positive/negative controls and artifact hashes in the mission's local
evidence record. Refresh the relevant canary when either artifact changes.
