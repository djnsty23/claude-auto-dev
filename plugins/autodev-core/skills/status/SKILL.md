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
!`node -e "try{const p=require('./prd.json');const sp=p.sprints?p.sprints[p.sprints.length-1]:p;const s=Object.values(sp.stories||p.stories||{});const name=sp.id||sp.name||p.sprint||'unknown';const n=f=>s.filter(f).length;const done=n(x=>x.passes===true);const pending=n(x=>x.passes===null||x.passes===undefined);const failed=n(x=>x.passes===false);const deferred=n(x=>x.passes==='deferred');const setup=n(x=>x.passes==='needs-setup');const other=s.length-done-pending-failed-deferred-setup;const arch=p.archived?(Number.isFinite(p.archived.totalCompleted)?' (+'+p.archived.totalCompleted+' archived)':' (archive present, count unreadable)'):'';console.log('Project:',p.project||p.projectName||'unknown','| Sprint:',name);console.log('Done:',done+arch,'| Pending:',pending,'| FAILED:',failed,'| Deferred:',deferred,'| Needs-setup:',setup,'| Total:',s.length,other?'| OTHER: '+other+' (unrecognised passes value)':'')}catch(e){console.log('No prd.json found')}"`

## Process

1. Call `TaskList` to get all native tasks
2. Read `prd.json` header (first 20 lines) if exists
3. Display:

```
[projectName] | Sprint: [sprint]
═══════════════════════════════
Progress: [N]/[N] complete
In Progress: [N] | Ready: [N] | Blocked: [N]

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

**Observable:** the four `passes` states counted, and their sum equal to the
total number of stories.

If done + pending + failed + deferred does not equal the total, something is
being miscounted — usually `"deferred"` treated as pending, which is the exact
confusion the field exists to prevent and the one that makes `auto` block
forever. Print the four numbers and the total, not a summary sentence.
