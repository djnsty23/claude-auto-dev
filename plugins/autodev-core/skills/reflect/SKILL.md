---
name: reflect
description: "Review the current session for user corrections, retries, wrong assumptions and slow paths, and turn each lasting lesson into a concrete edit to an existing skill, rule or check. Use at the end of a session or when asked to reflect."
when_to_use: "Invoked when the user says \"reflect\", \"what did we learn\", \"retro this session\" or \"lessons from this session\", at the end of a long session that needed corrections or retries, and before a handoff when the same mistake happened twice."
allowed-tools: Read, Grep, Glob, Bash, Edit, Write, Agent, Task
model: opus
user-invocable: true
argument-hint: "[transcript path] [--dry-run]"
---

# Reflect

A lesson written as a note is read once and then lost in the pile. A lesson
written as an edit to the file that loads at the moment of the mistake changes
the next session. A lesson written as a check changes every session. This skill
turns a session's costly moments into the second and third kind.

The output is a short list of edits, each with a destination and evidence. "No
findings passed the bar" is a valid, complete outcome (Step 4).

## Step 1: locate the transcript

The reviewers run as subagents and do not share this conversation. They need
the transcript file.

- An argument path wins.
- Otherwise the host stores the session as JSONL under its config directory:
  `<config dir>/projects/<cwd slug>/<session id>.jsonl`. The config directory
  is `CLAUDE_CONFIG_DIR` when set, else `.claude` in the home directory. Take
  the most recently modified file in this working directory's slug folder.
- Confirm it is this session: grep it for a distinctive phrase from the last
  few turns. A file that does not contain it is another session.

```bash
ls -t "<config dir>/projects/<cwd slug>/"*.jsonl | head -3
grep -c "<distinctive phrase from a recent turn>" "<candidate file>"
```

If no file matches, write a condensed timeline of this session to the
scratchpad: each user correction, each failed tool call with its error, each
repeated command. Paraphrase it and leave out any secret. Give the reviewers
that path instead.

**Done when** you hold one path that the grep confirmed belongs to this session.

## Step 2: three reviewers in parallel

Send all three in ONE message so they run at the same time. Use the
`autodev-core:researcher` subagent type, which is read-only, and pin
`model: opus`, because each lens is a judgement call. Each brief carries the
transcript path, its lens, the keep-bar from Step 4 and the return format.

| Reviewer | Lens | Looks for |
|---|---|---|
| A | Corrections and preferences | The user overruling, rejecting or redirecting the work. Preferences stated in passing. Anything the user had to say twice. |
| B | Failures and retries | Tool errors, failed commands, red checks, reverted edits. For each, the root cause, not the symptom. A retry that worked by luck is still a finding. |
| C | Process waste | The same command run repeatedly, a wrong tool for the job, a long path where a short one existed, a check that was missing and found the problem late. |

The return format, one block per finding:

```
lens: A | B | C
what happened: one sentence
evidence: a quote from the transcript, under 15 words, with its approximate turn
root cause: one sentence
would recur: where, in one sentence (another repo, another task, next week)
suggested home: detector | skill or rule edit | incident entry
```

Tell each reviewer to return nothing for its lens rather than pad the list.
Reviewers never write files.

**Done when** all three returned. Read a failed reviewer's output before
running it again.

## Step 3: deduplicate

Merge findings with the same root cause across lenses. A user correction (A)
that followed a failed command (B) is usually one finding with two pieces of
evidence. Keep the strongest quote.

Then grep the existing skills, rules and checks for each surviving finding:

```bash
grep -rniE "<two or three key words of the lesson>" <skills dir> <rules dir> <checks dir>
```

A lesson that is already written down and was not followed is a different
finding. The text exists, so the gap is loading or enforcement. Route it to a
detector or to a sharper trigger on the file that holds it, never to a second
copy of the text.

## Step 4: the keep-bar

Each finding must pass all three tests, or it is dropped:

1. **Specific.** It is about this codebase, this toolchain or this user. A
   stranger's session would not have produced it.
2. **Surprising.** The obvious default was wrong. A careful session following
   normal practice would have made the same mistake.
3. **Behaviour-changing.** A future session would act differently after reading
   or running the result.

Drop without discussion:

- routine work that went as expected,
- generic best practice any competent session already follows,
- a fix already captured in a test or check that would catch it again,
- anything only this conversation needs: a one-off path, a temporary state, a
  task that will not repeat.

If nothing passes, write nothing. Say "No findings passed the bar" with a
one-line reason per dropped finding, and stop. That is a complete run, not a
failure to find something.

## Step 5: route each finding to exactly one home

Prefer the highest rung that can carry the lesson:

1. **Detector or check.** Whenever a program could see the mistake: a pattern
   in a command, a file, a diff or an output. That means a lint rule, a script,
   a test case or a hook. It fires on every session without anyone reading it.
2. **Edit to an existing skill or rule.** One or two lines, in the file that
   loads at the moment the mistake happens. A sharper trigger on a skill's
   `description` counts.
3. **Dated incident entry.** In the lessons or reference file that holds long
   form, when the story is needed to apply the rule correctly.

A new skill or a new note file is a last resort. Propose one only when no
existing home fits, and say why none does.

**Size budgets.** Always-loaded rule text is capped. Measure the destination
before and after with `wc -c`. The one-line rule goes in the always-loaded rule
file, and the incident, cost and detection recipe go in the lessons or
reference file it points to. An edit that pushes a capped file over its budget
compresses something else or moves down a rung.

## Step 6: show the edits before writing

Present every proposal as a diff-style list:

```
F1  detector    tooling/check-<name>.js (new test case)
    + case: <input that reproduces the mistake> -> expect fail
    why: <root cause>. evidence: "<quote under 15 words>" (turn ~N)

F2  rule edit   <rules dir>/<file>.md   (+38 bytes, 2,410 of 3,000)
    - <old line>
    + <new line>
    why: ...
```

Codes F1, F2 and so on stay stable for the rest of the conversation.

- Edits **outside the current repo** (the user's own rules, memory or lessons
  files) wait for an explicit yes. Apply only the approved codes.
- Edits **inside the current repo** may be applied on the current branch, left
  uncommitted, and shown as `git diff` for review.
- `--dry-run` writes nothing anywhere.

## Step 7: scrub, then write

Plugin repos and many rule mirrors are public. Before writing, check every
added line for:

- secret values, tokens or anything key-shaped,
- chat text copied verbatim (paraphrase it, the quotes stay in the proposal only),
- private names, surnames and email addresses,
- absolute home paths (`C:\Users\...`, `/Users/...`, `/home/...`).

```bash
git diff -U0 | grep -nE '^\+.*([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}|[A-Za-z]:\\Users\\|/Users/|/home/|(sk|pk|ghp|xox)[-_][A-Za-z0-9]{8,})'
```

Zero matches is the bar. Also run the repo's own privacy gate if it has one,
for example `tooling/check-no-private-names.js` in this marketplace.

## Step 8: verify each landed edit

| Destination | Verified by |
|---|---|
| Detector | Load `rule-gate-integrity`. Plant the real mistake, watch the check fail, remove the plant with an inverse edit, watch it pass |
| Skill edit | The repo's skill checks, for example `npm run check:skill-tools` and `node tooling/validate.js` here |
| Rule edit | `wc -c` under its budget, and the line reads on its own without the incident |
| Incident entry | The rule file's pointer resolves to it |

End with a table: code, destination, status (applied, awaiting approval,
dropped), and the check that ran with its result.
