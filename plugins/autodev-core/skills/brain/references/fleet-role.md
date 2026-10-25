# Claiming the fleet role

Loaded from `brain` step 1, before claiming an existing fleet role or binding
the first PR to this session.

## Registries and addresses

Before claiming an existing fleet role, read its live registries. `session_id`
is the CLI UUID; `peer_name` and `desktop_session_id` are separate addresses,
joined through the desktop record's `cliSessionId`. Never derive one by editing
another's spelling. Preserve the prior `brain-role.json` record and scope
`home_repos` to the coordinator's own writable repos. Run `check-brain-role.js
--json`; require an `ok` record naming this session. Exit 0 also covers an absent
role. Where this runtime has no compatible registry, use its native agent return
channel and state that Claude's fleet hooks do not cover it. Notify existing
workers of an address change only within the user's authorized coordination.

When the record is `degraded`, use its positively verified reachable address
for existing work and re-stamp the stale field before broadcasting the record.
A decayed peer name does not mean the coordinator disappeared. A `fault` or
unchecked address requires diagnosis; a missing check is not proof of death.

## Keep this session alive past a merge

Before the first PR is bound to this session, call `mcp__ccd_pr__set_monitor`
with `auto_archive_on_close: false`, then read `ccd_pr get_status self` and
require that switch to read false. The app archives an idle session once a bound
PR merges or closes, and binding an open PR clears the exemption an unarchive
gives. Only the session itself can set this override. `[measured 2026-10-17]`
Brain 40 held release PR #409, merged a day earlier, and the app archived it the
moment its last turn ended.

Before merging, read `ccd_pr get_status self`. When `auto_archive_on_close` is
true and a PR is bound, the merge archives this session and removes its
worktree. Move the worktree off the PR branch, `unbind_pr`, confirm `bound:
false`, then merge with `--match-head-commit` pinned to the head CI ran on. The
switch is readable; do not infer it from archived session records. Before that,
run `session-sweep.js --self`: a `local-only(...)` blocker names the gitignored
files (an `.env.local`, for one) that go with the worktree when it is removed,
and they have to be copied out first. `[measured 2026-09-16]` a merge with the
switch on took a worktree whose `.env.local` held a key no other checkout had.
