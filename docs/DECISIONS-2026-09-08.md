# Decisions — 2026-09-08, memory capture fixed at source

Reversible calls made without asking, per the operator's away window (scope
qr and autodev only; "take the recommended option on anything reversible and
log it"). Session worktree `unruffled-faraday-86e0c3`, branch
`claude/unruffled-faraday-86e0c3`, base `origin/main` b8eae1f.

## D1. The measurement shipped first, on its own, as #190

The brief was to measure before changing. The evidence record and the
`decisions.md` entry went up as PR #190 with no code change, so the decision
"no new hook" stands on its own commit and can be read without the fix that
followed it.

## D2. Capture fixed at source, on the same branch, as a second commit

The evidence doc's proposal 1 to 5. At the closing decision panel the away
protocol held the panel and named the recommended option, "fix capture at
source", which is a code change on a branch in this repo and reversible by
revert. Taken.

What changed, each against the count that motivated it:

| change | count on 2026-09-08 |
|---|---|
| Bash, Read, Grep and Glob no longer produce observations | 5,493 of 6,072 rows were their echoes |
| a Write or Edit outside the project, or under `/scratchpad/`, `/.claude/probe/` or `/.claude/projects/`, is not recorded | 911 rows pointed at scratch paths; 66 recorded a memory file being written; 60 filed a file under another repo |
| type is `change` for every captured row; the prompt keyword regex is gone | 88 of 143 "bugfix" rows were plain file creations; 5 of 17 "decision" rows were writes to README and .gitignore |
| concept is the edit (`old → new`, or the new file's path), never the prompt | 383 rows carried another session's message as their concept; one carried a production hostname |
| one row per (session, type, title) in `saveObservation` | 1,785 rows were exact-title repeats |

Not changed, deliberately: the `UserPromptSubmit` hook and the prompt carrier
still run. Nothing reads the prompt now that the classifier does not, so that
hook is 35 ms per prompt for a file nobody opens. Removing it touches
`hooks.json`, `session-carrier.js` and two suites, and is a separate
reversible call for whoever picks this up next. The existing rows are also
untouched: the one-time prune by shape stays a proposal with its count, because
deleting shared state the operator has not read is branch 3 of the protocol.

## D3. The prompt argument is ignored, not removed

`classifyObservation`'s fourth parameter used to be the prompt. It now takes
`{ cwd }`, and a string there is ignored rather than rejected, so an older
caller keeps working and records a row rather than throwing inside a hook that
must exit 0. The suite asserts both forms and that the prompt's words reach
neither type nor concept.

## D4. The dedupe rule is keyed on the harness-independent memory session id

`saveObservation` skips a title already stored under the same `session_id` and
type; the same title under two types is two facts, which `test-knowledge.js`
asserts. A null session id is guarded out of the rule, but it never stored
anyway: node:sqlite enforces the `FOREIGN KEY` to `sessions`, so a caller with
no carrier is refused one step later by the database and the circuit breaker
returns null. The suite asserts that cause, so nobody reads the guard as "a
session-less save is recorded".
