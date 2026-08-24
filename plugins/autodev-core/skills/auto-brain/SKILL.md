---
name: auto-brain
description: Coordinate the fleet across a stretch when the user is away — survey every repo from git, propose per-repo work grounded in that survey, get one approval, dispatch, then let sessions self-report. Use when the user asks to run the team overnight or unattended.
when_to_use: "Invoked when the user says \"auto brain\", \"coordinate the team while I sleep\", \"run the fleet overnight\", \"give each project work\", or otherwise asks for unattended multi-session coordination."
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, Task, Workflow
model: opus
user-invocable: true
argument-hint: "[hours per project, default 3]"
---

# Auto-brain

Coordinate the fleet across a stretch when nobody is awake to arbitrate.

**Read `brain` first if you have not.** This is that role extended over an
unattended window, and every constraint there still applies. What changes is
that the escalation path is gone: normally an ambiguous call goes to the user
and waits, which is correct. Overnight there is nobody to wait for, so the
answer is not "decide it yourself" — it is **stop that item and keep the rest
moving**.

## The one thing this must not become

`[measured 2026-08-24]` Two peer sessions evaluated an overseer independently,
without seeing each other's answers, and both scored the coordinating half at
zero. One put it plainly: *"Every piece of work I did came from the user's
panels; you never assigned anything I acted on."*

Every wrong steer was a claim about a session's own tree, branch, queue or
intent. Every useful one was a fact about code, git or platform metadata.

So this skill coordinates by **distributing measured facts and asking**, never
by asserting state. If a brief contains a sentence about what a session has
done, is doing, or has decided, that sentence is wrong by construction — you
cannot read any of it — and it should be a question instead.

## The sequence

Do not skip to dispatch. The user's instruction that produced this skill was
*"don't start it blindly, we need to build a workflow that works."*

### 1. Survey — facts only

```powershell
$B = "$env:USERPROFILE\.claude\plugins\marketplaces\autodev\plugins\autodev-core\scripts"
node "$B\auto-brain-survey.js"
```

Reads every git repo under the code root: branch, trunk, ahead/behind, dirty
count, worktrees, gate script names from `package.json`, open PRs, and the
presence and age of `RESUME.md` / `PUBLISH-QUEUE.md` / `prd.json` / `TASKS.md`.

It prints `COULD NOT CHECK` rather than a zero wherever a probe cannot answer,
and it flags three things that change how a repo may be worked:

- **CLIENT** — a bitbucket remote. Never push it to a personal remote, and `gh`
  cannot answer anything about it.
- **trunk is not main/master** — one repo here has a `main` two months behind
  its real trunk, and comparing against the wrong one **inverts** verdicts
  rather than merely dating them.
- **a large `RESUME.md`** — probably hand-written. One is 458KB. A generator
  that overwrites it destroys work no snapshot reconstructs.

### 2. Join sessions to repos — on cwd AND branch

`mcp__ccd_session_mgmt__list_sessions`. Match by working directory and branch,
**never by id**: pipe names and session-list ids are separate identifier spaces
and nothing joins them, so one session reads as two. `[measured]` that happened
twice in one night, and both times a session was briefed with its own findings.

**But cwd is where a session STARTED, not where its work is.** `[measured
2026-08-25]` a session listed under a worktree of one repo reported twelve
commits in a DIFFERENT repo, plus an open PR there and a merged one. Filing it
by cwd would have briefed it on the wrong project and left the other — which had
an open mergeable PR — looking ownerless.

So cwd is the first guess, not the answer. The load-bearing field is what the
session SAYS it is doing, and only it can tell you. When cwd and reported work
disagree, or when a repo with real queued work appears to have no session, ask
before filing. Put the guess in the message and invite the correction: naming
what you assumed costs one sentence, and a mis-filed session says so at once.

A repo with genuinely no session is not a session to brief. Note it, say it has
queued work if it does, and leave starting one to the user — that is a
concurrency decision rather than a coordination one.

### 3. Propose — from the survey, never from imagination

One brief per session, each grounded in a line the survey printed. Good
material, because it is all readable: a repo far behind its trunk, an open PR
with no session on it, a gate that exists and can be run, a stale
`PUBLISH-QUEUE.md`, a `prd.json` with pending stories.

**Size it to the window the user named** (default 3 hours). Prefer work that is
bounded, verifiable, and safe to leave half-done — a survey, a suite, a fix with
a test — over anything open-ended.

### 4. Confirm — ONE approval, before anything is sent

Show the user the whole manifest: repo, session, the work, and why the survey
supports it. Then send. This is the gate that keeps it from being blind, and it
is one interruption rather than one per session.

### 5. Dispatch

`mcp__ccd_session_mgmt__send_message`, one per session.

**Messages queue.** `[measured 2026-08-24]` the tool returns "Message sent" for
an idle session and "Message queued ... it will be processed after the in-flight
turn finishes" for a busy one. It never interrupts a turn, so there is no reason
to time dispatch around what a session is doing. It still costs that session a
full turn, so do not send twice for the same reason.

**Include your own session id so they can reply.** `[measured 2026-08-25]` four
peers were dispatched; **every one that answered said the sender id did not
resolve.** They had reached for `ListAgents`, which lists in-process subagents
rather than sessions, and nothing joins those two identifier spaces. Each had to
guess the sender by title and one nearly gave up. A request with no return
address is a request that arrives and cannot be answered.

    Reply to: mcp__ccd_session_mgmt__send_message, session_id <yours>

**Ask for SHORT rolling summaries, not only a report at the end.** `[stated
2026-08-25]` — *"to send you short summaries with what they did so that you're
aware at all times."* One message per **completed unit of work**: not per
commit, not on a timer. Three to five lines — what changed, what was verified
with the command and what it printed, what is next or blocked.

Define "short" when you ask, or it will not be. The long four-part report is for
going idle; a rolling update that grows into one costs both sides a full turn
each time and awareness stops being cheap. At a deep context that is the
dominant cost of coordinating at all.

### 6. Collect — do not poll

Peers self-report when they go idle. If a session has been quiet and it matters,
send **one** message and move on. Polling costs a wake-up per session per
interval and is wrong the moment one wakes between polls.

Reading `list_sessions` for `lastActivityAt` and `isRunning` is free and is not
polling — it touches nobody. Use that to see who has woken.

## What every brief must carry

These are not boilerplate. Each one is the answer to a specific way an
unattended window goes wrong.

- **Commits stay local. No push, no PR, no merge, no deploy.** A push needs the
  user's yes in that turn, and overnight there is no turn to give it in.
- **No production mutation, no billing action, no credential rotation.** Propose
  it with the evidence attached and stop.
- **Run the repo's own gate before claiming anything is green**, and name it —
  the survey prints the script names, so put the real one in the brief rather
  than "the gate".
- **Escalate rather than resolve.** On a conflict, an ambiguity, or anything
  turning on taste, stop that item, write down the question, and carry on with
  the rest. Do not guess because nobody is awake.
- **Write `RESUME.md` at the end** with `session-exit.js`, and report the four:
  what you finished with commits named, what you verified naming the command and
  what it printed, what is blocked and on whom, and whether you are idle.
- **Say plainly if the brief is wrong for that repo.** A brief written from
  outside will sometimes prescribe something that does not apply. Contradicting
  it is the correct response, not insubordination.

## Client repos

A bitbucket remote means client work. Analysis, diagnosis and local commits are
fine. Never push to a personal remote, never open a PR, and never archive those
sessions. If a brief for a client repo cannot be done without pushing, it is not
a brief for tonight.

## Before you finish

Write your own `RESUME.md`, refresh the volatile facts, and put anything
non-obvious into a registry rather than into the conversation. A decision that
lives only in chat is invisible to every session that did not have it.
