# The session-limit reset is an observable event, and nothing used it

`[measured 2026-09-08]` on one operator's `~/.claude/projects`.

## What happened

A five-hour session limit stopped part of a 39-session fleet overnight. Ten
sessions resumed within the same minute when the window reset — so the reset is
real, fleet-wide, and simultaneous. Every one of them resumed **not knowing the
tree had moved under it**: PRs had merged, branches had been superseded,
premises were dead. A coordinator repaired each one by hand.

The reset is the moment to decide what to re-dispatch. Nothing read it.

## The reset time is written down, not guessed

A walled turn lands in the session transcript as an assistant row:

```json
{
  "type": "assistant",
  "message": { "model": "<synthetic>", "content": [
      { "type": "text", "text": "You've hit your session limit · resets 1:10am (Europe/Athens)" } ] },
  "quotaLimits": {
    "status": "rejected",
    "resetsAt": 1788819000,
    "rateLimitType": "five_hour",
    "unifiedRateLimitFallbackAvailable": false
  },
  "error": "rate_limit",
  "isApiErrorMessage": true,
  "apiErrorStatus": 429,
  "cwd": "<the worktree the session was running in>",
  "sessionId": "<transcript session id>",
  "gitBranch": "<the branch it was on>"
}
```

`resetsAt` is unix **seconds**. The prose in `content[0].text` is a local-time
string in the *account's* timezone, which is not necessarily the machine's — the
rows on this disk say `Europe/Athens` and `Europe/Bucharest` on different days
while the machine reports `EEST`. **Parse `resetsAt`; never parse the sentence.**

### The population

| measure | value |
|---|---|
| transcripts scanned (all of `~/.claude/projects`) | 127 |
| rows carrying `quotaLimits.resetsAt` | **47** |
| distinct `resetsAt` values | **1** — `1788819000` = 2026-09-07T22:10:00Z |
| distinct `rateLimitType` values | **1** — `five_hour` |
| worktrees the rows span | **23** |
| repos the rows span | **3** — this marketplace and two product repos |

One moment, written down 47 times by the sessions it stopped, across three
repositories. That is the event, and it is exact to the second.

`rateLimitType` matters: the weekly window and the five-hour session window are
different boundaries, and only the five-hour one is what stops a fleet
mid-evening. `fleet-redispatch.js` acts on `five_hour` and reports how many rows
of another type it saw, so a weekly wall cannot silently trigger a re-dispatch.

## Why the schedule does not carry the precision

A re-dispatcher that fires at the wrong time is worse than none, because it
restarts work in flight. Two ways to get the time right:

1. **Pin the cron to the reset.** Wrong, and not merely fragile: the reset moves
   with usage, the account timezone is not the machine timezone, and a task
   pinned to yesterday's boundary fires mid-work today.
2. **Put the gate in the data.** The script reads the boundaries recorded since
   its own last run and no-ops unless one was crossed. The cron then only has to
   be *often enough*, and being too often costs a no-op.

The tool does (2). Run it **hourly**. A no-op run cannot restart anything, and
the tool proposes rather than spawns in any case, so the cadence has no sharp
edge — unlike a guessed clock, which has nothing else.

If the boundary cannot be read at all, the run says so on a COULD-NOT-CHECK line
and classifies anyway. It never reports an unreadable disk as "no reset
happened".

## The four rules, and the order they run in

The two wrong answers are not symmetric. Proposing an unnecessary restart wastes
a session; restarting work that is already done, or that a live session holds,
**loses** work. So every unreadable signal falls to COULD-NOT-CHECK, never to
RESTART, and the checks run in cost order:

1. **Never restart a live session's work.** Checked first. Two sessions on one
   branch in a shared clone is the dominant defect on this fleet — six same-file
   collisions in one night, four from a coordinator dispatching off a stale
   picture. Unknown liveness is *not* "gone".
2. **Run `verify` before proposing anything.** A record saying "waiting on CI" is
   worthless hours later, and the most expensive failure here is restarting work
   already done — twice in one week a session was dispatched onto already-merged
   branches, once for twelve commits. `state` is never trusted alone: `verify`
   is re-executed and the branch is asked whether it LANDED, through
   `check-branch-landed.js` rather than a second implementation of that question.
3. **Propose, do not spawn.** Sessions propose; the coordinator dispatches,
   because a session cannot see the headcount or what another repo is doing.
4. **A record you cannot verify is not a zero.** COULD-NOT-CHECK is counted,
   listed and exit-coded separately from "nothing to do", and every count is
   printed beside its population.

### Liveness has two sources because each one alone has been wrong

| source | what it is | how it fails |
|---|---|---|
| `lastActivityAt` in the desktop session store | a ping the app refreshes only while it holds the session; it **freezes** when one stops | the store path is platform-specific and a wrong one has made three separate scripts each report a confident zero fleet |
| the last row of the session's own transcript | a session whose last recorded event **is** the wall is by definition not running | says nothing when the transcript cannot be found |

They combine asymmetrically on purpose: either saying LIVE makes it live; only
both readable and neither saying live makes it gone; neither readable is `null`.

`[measured 2026-09-08]` over the 47 non-archived store records on this disk, the
four running sessions read 2–97 s since their last ping and the next reading was
1514 s. The 30-minute default floor sits well clear of the ping cadence on the
generous side, which is the safe side here.

### One directory, two spellings

`git worktree list` returns a resolved path while the app records the cwd it was
given, and on macOS `/var` and `/private/var` are the same directory. A slug
built from the wrong spelling finds no transcript at all, and liveness then
reads as unreadable for every record — the safe direction, but useless.
`realpathSync` only resolves one way, so the `/private` prefix is added and
removed explicitly and both spellings are tried. This suite's **first**
end-to-end run hit exactly that, which is the argument for driving the real
binary over real directories rather than testing the classifier alone.

## Exit codes

| code | meaning |
|---|---|
| 0 | ran; nothing to restart and nothing unreadable |
| 2 | at least one RESTART candidate |
| 3 | at least one COULD-NOT-CHECK — **outranks 2 on purpose** |

3 outranking 2 is the point of the tool: a silent unreadable is the failure it
exists to stop, and an exit code is a single channel.

**An absent intent directory exits 3, not 0.** It is not zero records to
re-dispatch; it means no record has been written yet. An empty directory *is* a
measured zero and exits 0. The two are distinguishable in the exit status and in
the wording, and the suite asserts that they differ.

## Installing the schedule

The script ships in the plugin. The schedule is machine configuration and is not
in this repo. To install it, create
`~/.claude/scheduled-tasks/fleet-reset-redispatch/SKILL.md` with the body below
and a cron of `0 * * * *`:

````markdown
---
name: fleet-reset-redispatch
description: At each session-limit reset boundary, rank the fleet work that is genuinely incomplete.
---

Resolve the plugin path once. `sort -V` is load-bearing: `ls | tail -1` sorts
lexically and picks 8.8.0 over 8.10.0, so it would run an old script forever
while reporting success.

```bash
CORE=$(ls -d "$HOME"/.claude/plugins/cache/autodev/autodev-core/*/scripts 2>/dev/null | sort -V | tail -1)
```

If that is empty, report that autodev-core is not installed and stop. Do not
attempt the check by hand.

Run the re-dispatcher and capture its exit status without a pipe — `$?` after a
pipe is the pipe's status, and this tool's whole contract is in its exit code:

```bash
node "$CORE/fleet-redispatch.js" --stamp > /tmp/fleet-redispatch.out 2>&1; echo "exit=$?"
```

Then, by exit status:

- **0** — either no boundary was crossed or nothing needs restarting. Write
  nothing further.
- **2** — there are restart candidates. **Do not start any of them.** Report the
  ranked list to the operator exactly as printed, including each item's `why
  now` and `rank` lines, and say plainly that nothing has been dispatched.
- **3** — something could not be checked. Report the COULD NOT CHECK section
  verbatim and separately from any restart list. Absence is not health.

Never spawn a session, never message another session, never commit, and never
edit a worktree. This task reports; the coordinator dispatches.

Write the heartbeat on **every** run — clean, dirty or failed partway. Without
it a healthy task and a dead one look the same, and `drift-audit.js` has to
guess from file mtimes:

```bash
date -u +%Y-%m-%dT%H:%M:%SZ > "$HOME/.claude/scheduled-tasks/fleet-reset-redispatch/.last-run"
```
````

Hourly, not daily: a daily task would miss most five-hour boundaries. An
existing nightly fleet survey is the wrong instrument for this — it is a survey,
and a boundary crossed at 22:10 has had seven hours to go stale by the time a
05:00 task runs.

## What this does not do

It does not spawn, message, commit, or touch a worktree. It reads records, runs
the `verify` each record supplies, asks git and GitHub whether a branch landed,
and prints a ranked proposal. Every dispatch decision stays with a person.
