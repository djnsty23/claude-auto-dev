---
name: status
description: Shows sprint progress and task status. Use 'progress' (not 'status' - that's a built-in).
when_to_use: "Invoked when the user says \"progress\"."
allowed-tools: Read
model: haiku
user-invocable: true
---

# Status

Show current progress with minimal token usage.

## Sprint Data
!`node -e "try{const p=require('./prd.json');const sp=p.sprints?p.sprints[p.sprints.length-1]:p;const e=Object.entries(sp.stories||p.stories||{});const s=e.map(x=>x[1]);const name=sp.id||sp.name||p.sprint||'unknown';const n=f=>s.filter(f).length;const done=n(x=>x.passes===true);const pending=n(x=>x.passes===null||x.passes===undefined);const failed=n(x=>x.passes===false);const deferred=n(x=>x.passes==='deferred');const setupIds=e.filter(([,x])=>x.passes==='needs-setup').map(([id])=>id);const setup=setupIds.length;const other=s.length-done-pending-failed-deferred-setup;const arch=p.archived?(Number.isFinite(p.archived.totalCompleted)?' (+'+p.archived.totalCompleted+' archived)':' (archive present, count unreadable)'):'';console.log('Project:',p.project||p.projectName||'unknown','| Sprint:',name);console.log('Done:',done+arch,'| Pending:',pending,'| FAILED:',failed,'| Deferred:',deferred,'| Needs-setup:',setup,'| Total:',s.length,other?'| OTHER: '+other+' (unrecognised passes value)':'');console.log('Blocked on you:',setup,setup?'('+setupIds.join(', ')+') — waiting on a person; see each story\\'s blockedReason. Not counted as pending.':'— nothing is waiting on you.')}catch(e){console.log('No prd.json found')}"`

## Process

1. Call `TaskList` to get all native tasks
2. Read `prd.json` header (first 20 lines) if exists
3. Display:

```
[projectName] | Sprint: [sprint]
═══════════════════════════════
Progress: [N]/[N] complete
In Progress: [N] | Ready: [N] | Blocked: [N]
Blocked on you: [N] ([ids]) — one line per story: id, what it waits for (blockedReason), since when (blockedAt)

Active:
  → [id] [subject] (in_progress)

Next:
  [id] [subject] (pending)
  [id] [subject] (pending)
```

## Rules
- Use TaskList for native tasks (primary)
- Read only prd.json header for context (not full file)

- If no prd.json, just show TaskList results

## Proving the run

**Observable:** the five `passes` states counted, their sum equal to the total
number of stories, and "Blocked on you" printed as its own line with ids.

If done + pending + failed + deferred + needs-setup does not equal the total,
something is being miscounted — usually `"deferred"` treated as pending, which
is the exact confusion the field exists to prevent and the one that makes
`auto` block forever. Print the five numbers and the total, not a summary
sentence.

"Blocked on you" is a separate line from Pending on purpose. `[measured
2026-09-08]` six of the ten pending stories in one client repo were waiting on
a person — a pipeline variable, a partner's API, a decision — and had sat as
`passes: null` for up to 122 days, because the count that said "10 pending"
told nobody that an agent could advance only four of them. A needs-setup story
is remaining work for the operator and not for the agent; the line says who.
