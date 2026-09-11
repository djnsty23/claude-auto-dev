# Brain operations audit — first pass

Baseline: `9f9746f` in isolated worktree `codex-brain-live-audit`. Read only outside ignored probe fixtures. Runtime metadata is sanitized in `runtime-metadata.json`.

Read guidance: CLAUDE.md; diagnosis, A/B testing, gate integrity and file organization. Existing PR bodies and full diffs captured for #190, #194, #199, #214, #215, #218, #222, #224; heads recorded in each `pr-N.json`.

## Hypotheses awaiting falsification

- Stop report advances HEAD during cooldown, so an unreported final delivery can be suppressed forever. Falsifier: unchanged HEAD emits after expiry; control: fresh commit emits.
- Stop report initializes baseline only at Stop, so a task completing in one turn never triggers the only wake signal. Falsifier: first completed task emits, or another durable report path is actually active.
- Legacy panel restoration deletes newly added settings when no settings file existed before deny. Falsifier: subsequent non-panel settings survive restoration.

## Confirmed O1 — final report is consumed while suppressed (P1; corrected locally)

Baseline `9f9746f`, `plugins/autodev-core/hooks/stop-brain-report.js:211`: cooldown writes the current SHA into the same `sha` compared at line 206, although no notice was emitted. A later Stop with unchanged HEAD exits before checking expiry. This is durable loss of the final delivery, not a delayed notice.

Reproduction command: `node tooling/test-stop-brain-report.js`, after adding the six regression assertions, run under a private TMPDIR beneath this report directory; wrapper stores full stdout/stderr and actual child exit. `stop-suite-before.txt` printed **35 passed, 2 failed; EXIT=1**, specifically:

```
FAIL throttle: suppressed work does not advance the notified HEAD
  stored=957d7405 notified=d59aa9cb pending=957d7405
FAIL throttle: the same final commit is reported after cooldown expires
  out=0B err=0B exit=0
```

The same suite's positive control creates another commit with cooldown 0 and emits, proving the real hook ran. The regression ages only `reportedAt`, preserving HEAD and all other state. Falsifier was a notice after expiry without another commit; baseline failed it.

Root authorized implementation in these two files only. The correction retains `prior.sha` during suppression. After: **37/37 Stop assertions, 22/22 role assertions, both EXIT=0 and stderr 0B**. Expiry case emits **1403B** and then stays quiet on duplicate Stop. Full outputs: `test-stop-brain-report.js.after.txt`, `test-check-brain-role.js.after.txt`. No commit made; root owns integration.

Measured alternatives: baseline suppression discards final HEAD; preserved checkpoint delivers on a later Stop after expiry; cooldown 0 admits the next commit immediately (existing suite control), trading away the rate bound. The preservation variant keeps the rate bound and passes the missing outcome.

**Bound:** this accounting correction neither schedules a future Stop nor acknowledges actual message delivery. A worker that never gets another turn still cannot emit the deferred notice. Baseline's first-ever Stop intentionally only records a baseline (`:197–204`); a single-turn completed task is therefore not notified. The existing first-sighting test confirms 0B with a real committed repo. `auto-brain/SKILL.md:184` claims “The only wake signal is a Stop-hook report” and every idle session sends one; those claims exceed the hook's contract. Hooks manifest only wires this at Stop, not SessionStart. Completion needs durable task status/outbox plus coalesced notification/ack and a recovery reader; a hook nudge is advisory evidence, not delivery. No such larger implementation claimed here.

Existing #222 (`13873e58`) and #224 (`3c42938a`) modify role/address rendering below line 265 and leave SHA accounting untouched. #215 supplies durable intent observations but no message delivery; #218 explicitly only proposes restart. These are complementary, not fixes for O1.

## Confirmed O2 — quoted paths containing spaces disarm coordinator guard (P1; not changed)

Baseline `9f9746f`, `plugins/autodev-core/hooks/coordinator-write-guard.js:167` preserves ordinary whitespace inside quotes, then `:289` splits it as argument boundaries. The second fragment becomes the supposed git verb, so a normal `git -C ".../foreign with spaces" commit` is not recognized as a commit and silently allowed.

Command: `python3 .claude/reports/brain-live-audit/operations/probe-operations.py`. Exact subprocess outputs, saved incrementally to `operations-probe-results.json`:

| Foreign path spelling | Hook exit | stdout | stderr | Blocked |
|---|---:|---:|---:|---|
| no space, unquoted control | 2 | 0B | 1044B | yes |
| no space, quoted control | 2 | 0B | 1044B | yes |
| space, quoted | 0 | 0B | 0B | **no** |
| same space path, escaped | 2 | 0B | 1056B | yes |

Population 4 commands, all sent as real Bash hook payloads for the claimed coordinator; no git write was performed. Falsifier: the quoted-space case blocks like its escaped-path control. Three independent positive controls establish the matcher/role are active. The quoted variant is commonplace valid shell syntax, not a hostile bypass. Preserve token boundaries through quote removal; a supported-shell tokenizer is the broader alternative. Implementation cost/coverage of those alternatives remains unmeasured.

#199 (`5c803260`) changes heredoc handling and adds bypass permission logic, but not the quoted-space branch/tokenization. #222 changes dead-session status handling only. The inspected PRs do not close this case.

## Confirmed O3 — checkpoint rescue bypasses both ownership and permission rails (P1 integration blocker for OPEN #214; not baseline code)

Examined exact 596-line new hook from PR #214 at `271fed05f78ada7af28b8127f5bbe55368878c67`; extracted without modification as `pr214-usage-checkpoint.js`. Relevant original path `plugins/autodev-core/hooks/usage-checkpoint.js:260` enumerates **all** dirty/untracked paths; `:492` stages that entire list; `:547` directly invokes `git push --no-verify`. The “explicit paths, never add -A” rationale does not establish ownership: enumerating every dirty file preserves the same cross-session capture. The hook's child git calls never pass through Bash PreToolUse, so the coordinator guard and #199's ask-before-bypass cannot constrain them.

Command: same `probe-operations.py`. Isolated feature repo, local bare origin (zero network), functioning pre-push refusal, own and peer edits aged two hours, fixture role naming this session as Brain but allowing another home directory. No checkpoint opt-in or push opt-in was set. Actual result:

```json
{"exit":0,"changed_head":true,"committed_paths":["own-change.txt","peer-change.txt"],"pushed_to_local_origin":true,"pre_push_fired":false,"stderr_bytes":0}
```

Control: a normal push to the same local origin invokes the same pre-push hook, writes its sentinel and exits **1**. The manifest wires #214 at Stop, independent of the Bash hooks. Falsifier: absent an owned-work authorization, the checkpoint refuses the foreign/shared tree or preserves only demonstrably owned state without publishing it; actual hook did neither.

Do not integrate #214 as a safe fleet recovery fix in its current form. Give a rescue operation explicit mandate/session ownership, and make its default a local snapshot in an isolated worktree or a dedicated rescue ref. A later authorized publish should run a shared authorization path and relevant verification. These alternatives are design proposals; only current behavior and the local-only/normal-push controls have been executed. Existing #199 does not solve hook-internal operations; merging both can create a false impression that --no-verify is now always mediated.

## Confirmed O4 — declared away state is global while management mandate is scoped (operational gap; not changed)

`panel-recommendation.js:98–111` reads one AWAY file, never the tool payload's cwd/session or a repo mandate. The same probe feeds a scoped instruction (“Coordinate the explicitly managed fixture only”) and panels from managed and unmanaged cwd: **both exit 2, both held, both stdout 0B**. Absent-away control exits **0, stdout/stderr 0B**. The hook still tells the model to respect standing rules and distinguish irreversible choices, so this is not proof of unauthorized writes. It is proof the mechanical hold/self-resolution applies outside the managed set; even out-of-scope client sessions can lose their live question path during a fleet window. `auto-brain/SKILL.md` explicitly says to filter client sessions before coordination.

Falsifier: an active scoped-away fixture lets an unmanaged panel through while holding its managed control. The current hook cannot express that distinction. Bind active away authority to repo/session scope, and keep raw operator prose as context rather than using a machine-wide timestamp as authority for every session. This was not touched by the eight inspected PRs.

## Recovery completion and false confidence

- #218 at `18d31161` is candid in its implementation but its title overstates the outcome: `fleet-redispatch.js` **proposes, never spawns**. Its accompanying scheduled-task template says exit 2 reports candidates to the operator and “Do not start any of them” (`docs/evidence-reset-boundary-2026-09-08.md:182–195`). #215 adds intent persistence; #214 adds a checkpoint. None closes dispatch/claim/ack/verification after recovery. Do not count three merges as autonomous resumption. Falsifier is an executable scheduler that consumes candidates and starts an authorized worker; the new PR's only executable path prints ranked proposals. Root is designing the missing delivery contract.
- `auto-brain/SKILL.md:212–214` uses `spawn_task` chips that need a user click. That can help bootstrap work while the user is present, but does not fulfill new-worker dispatch while the user is away. The existing-session send path is the positive executable counterpart. This is a capability/contract gap, not something retries resolve.
- Legacy `brain-panels.js:216` deletes the settings file when its prior `existed` was false, even if later settings were added. This is a source-level lead only: **not reproduced**, because the current CLI has no fixture override for its home-scoped marker and live settings were out of scope. Do not report it as a measured live defect.

## Live activation and evidence limits

The sanitized metadata probe read plugin registry, enablement and selected source bytes. Claude has autodev-core, memory and stack **8.166.0**, all enabled, `disableAllHooks=false`, no user-level hook override. **5/5 core hook/script paths** checked match baseline bytes, and the memory hooks manifest also matches. This establishes configured activation and source parity; it does not independently establish a particular host hook invocation happened.

A read-only call to actual `checkBrainRole()` returned **state ok, 0 fault codes, 3/3 session files with live pids, readable desktop store, 126 records**. `readAwayState()` returned **active, canAsk=false**. No role addresses, project names, prompts or AWAY words are included. Claims about absence have been checked beside known-positive input controls. All probe worktrees, local remotes and suite TMPDIRs were removed by their owning wrappers.

Only the root-authorized Stop hook and its existing suite have tracked edits. No runtime/settings changes, no product edits, no external messages, no live commits or pushes.

## Follow-up correction — O2 fixed after root authorization

Root extended edit ownership to `coordinator-write-guard.js` and its existing suite. First patch application failed because an escaped backslash in its context line did not match; **no source edit occurred**, and the patch was reapplied against an unambiguous comment anchor.

Added eight cases covering quoted-space -C/cd, both quote forms, full destination in block text, legitimate home-directory entry, git-dir and work-tree. Before changing the subject: `node tooling/test-coordinator-write-guard.js` printed **95 passed, 7 failed, EXIT=1**. Failures name the actual property: 4 silent foreign allows, 2 blocks naming truncated destinations, 1 false block inside home. `guard-suite-before.txt` is the full record.

The correction protects ordinary spaces inside either quote form with the existing escaped-space token until path resolution. This is a four-line source change shared by -C, cd, git-dir and work-tree, not a new shell parser. After: **102/102 coordinator guard cases, 44/44 pre-tool-filter cases**, both exit 0 and stderr 0B. Existing mention, heredoc, Windows-only guard, unquoted/escaped path and role-file mutation controls remain. Full outputs: `test-coordinator-write-guard.js.after.txt`, `test-pre-tool-filter.js.after.txt`. No generalized shell-grammar coverage is claimed.

The earlier source baseline findings remain historical evidence; O2 is now corrected in the local audit branch, not installed or shipped. Final owned tracked edits are **four files**: the Stop-report hook/suite and coordinator guard/suite. Root controls commits and independent review. O3 remains an explicit open-PR integration blocker, O4 remains a scoped-authority design gap.
