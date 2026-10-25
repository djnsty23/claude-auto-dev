# The auto-active flag

Loaded from the `auto` entry flow.

On start, create the flag file using the **Write tool** (not Bash echo, which
triggers a sensitive-file permission prompt):

```
Write tool → .claude/auto-active
Content: {"started":"<current ISO timestamp>","sprint":"<current sprint>"}
```

This flag tells the Stop hook to block Claude from stopping. Claude keeps
working as long as this flag exists.

The hooks rename it at once to `.claude/auto-active.<session id>`, so it holds
only THIS session. A peer session in the same directory is never held by it,
and a peer's `auto-exit` never ends it. Do not look for the plain name
afterwards: it is gone by design.

On exit (user says "done", or nothing left), **do not `rm` the flag**: Bash ops
on `.claude/` trigger a sensitive-file permission prompt even under bypass.
Simply stop working. The Stop hook owns the flag lifecycle:

- Stale flags (>2h old) are auto-cleaned
- Sprint-complete → hook runs IDLE detection once, then approves stop and removes the flag on the next attempt
- No prd.json → hook approves stop and removes the flag immediately

If the user explicitly says "deactivate auto" mid-sprint, use the **Write tool**
to create `.claude/auto-exit` (empty file). The Stop hook treats that as an
unconditional exit signal and cleans up both files.
