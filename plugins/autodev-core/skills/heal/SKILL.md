---
name: heal
description: Sweep every repo you are working on for vulnerabilities an attacker can actually reach, prove each one is reachable, and fix the ones that survive. One word starts the whole operation.
when_to_use: "Invoked when the user says \"heal\", \"sweep\", \"fix all the bugs\", \"check every app\", \"are we exposed\", or asks for a periodic security pass across projects."
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, Workflow, Task
model: opus
user-invocable: true
argument-hint: "[repo names, or nothing for the active ones]"
---

# Heal

One word, a whole operation. A bug found in one app is a bug suspected in every
app, so this runs the shared registry across all of them at once rather than one
repo at a time.

**The default filter is REACHABLE FROM OUTSIDE.** That is deliberate and it is the
thing that makes the output worth reading. A sweep with no filter returns two
hundred items, most of them style, and gets ignored. A sweep that only reports what
an unauthenticated stranger on the internet can trigger returns a handful, and every
one of them is worth a commit. Widen the filter only if the user asks.

## Run it

```
Workflow({
  scriptPath: "${CLAUDE_PLUGIN_ROOT}/scripts/heal-sweep.workflow.js",
  args: [ /* one entry per repo — see below */ ]
})
```

Three stages per repo, pipelined so one repo can be fixing while another is still
looking: **find → adversarially verify → fix in an isolated worktree.** Roughly
three agents per repo, so keep it to three or four repos unless the user raises the
cap.

## Building `args` — this is the whole job

```js
{
  name: 'myapp',
  path: '/absolute/path/to/repo',
  gate: 'npm run preflight',      // the repo's own verification command
  surface: '...'                  // REQUIRED — see below
}
```

**`surface` is the quality lever and the script refuses to run without it.** It
tells the agent what "reachable from outside" *means* for this particular repo.
Get it wrong and you get a confident report about an attack surface that does not
exist — a published CLI has no HTTP routes, and an agent sent looking for them will
either find nothing or invent something.

Write two or three sentences naming the real entry points. A web app: its serverless
routes, its edge functions, the database surface an anon key can touch, its webhook
receivers, its OAuth callbacks. A published package or plugin: what a stranger can
read in the tree, what a consumer executes on install, and any CI workflow that runs
untrusted code from a fork. A CLI: its argument parsing and anything it fetches.

Say which one is revenue-bearing or handles personal data. Severity is not a property
of the code alone.

## Picking the repos

Ask what is actually being worked on, or read it off the fleet:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/fleet-status.js" --days 2
```

Sweep those. A repo nobody has touched in a month is not where a newly-introduced
class will be, and the whole premise here is that a defect propagates through
recent work.

**Never sweep a client repo into a shared report.** Check `git remote get-url origin`
first and exclude anything that is not the user's own.

## What comes back

Per repo: the enumerated attack surface with counts, the findings that survived
adversarial verification, the ones that were **refuted** and why, what was fixed with
its mutation test, what was skipped as needing a human call, and the gate result.

**Read the refuted list.** It is not filler — it is how you tell a real sweep from a
generator. A report that refuted nothing did not verify anything, and a detector that
cries wolf gets muted, which is how the real one gets missed.

**Read `couldNotCheck` before you believe any zero.** A static read cannot see
runtime, live RLS policies, or deployed configuration. Silence must never be reported
as clean.

## The worktree trap — read this before the fix stage

`isolation: 'worktree'` on an agent creates the worktree from **the session's own
repo**, not from the repo the agent is being pointed at. If the session's cwd is not
a git repository, every fix agent dies with *"Cannot create agent worktree: not in a
git repository"* — after the find and verify stages have already been paid for.

That is exactly what happened on the first real run, 2026-08-22: two fix agents
errored on a session rooted in a directory that held only `.claude/` state and no
`.git`. The findings survived in the journal, but the fix stage was lost.

So the fix agent creates its own worktree explicitly, inside the target repo:

```bash
cd "<target repo>"
git status --short    # a dirty tree you did not dirty means another session is here
git worktree add .claude/worktrees/<topic> -b fix/<topic>
```

Add `.claude/worktrees/` to that repo's `.gitignore` first if it is not there — a
nested git directory sitting untracked in a repo where sessions run `git add -A` is
one careless stage from being committed.

## Fixes commit, they do not push

Each fix agent works in its own git worktree, because other sessions have
uncommitted work in the main clone. It commits and stops. Pushing needs the user's
explicit yes in the turn — these repos deploy on push, so a push is a production
deploy wearing different clothes.

## Feeding the registry

Anything found in two or more repos is a **class**, not an incident, and belongs in
the shared registry with a runnable detection and a known positive:

```bash
cat ~/claude-memory/BUG-CLASSES.md
```

A described bug does not travel between sessions. A grep does. If you cannot write a
detection for it, record that limitation in the entry rather than omitting the class.
