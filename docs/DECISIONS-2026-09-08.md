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

Not changed in this commit: the `UserPromptSubmit` hook and the prompt carrier
(removed in D5, the next commit) and the existing rows. The one-time prune by
shape stays a proposal with its count, because deleting shared state the
operator has not read is branch 3 of the protocol.

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

## D5. The prompt-capture hook removed, third commit

The second decision panel was held by the same away window and its
recommended option was this. After D2 nothing reads the carried prompt, so the
`UserPromptSubmit` hook was 35 ms per prompt spent writing verbatim user text
to `.claude/memory-sessions/<id>.prompt` for no reader. Removed together:
the hook's `hooks.json` entry, `hooks/memory-prompt-capture.js`, and the
carrier's `writePrompt`/`readPrompt`/`clearPrompt`. `clear()` now also unlinks
a `.prompt` sibling, so a project that ran the older build does not keep a
prompt on disk past the session that wrote it; both suites plant one and
assert it is gone. CLAUDE.md's plugin line goes from four hook events to
three. Reversible by revert; the carrier directory keeps its self-ignore
because a stale `.prompt` is still a prompt.

## D6. The CLI refuses swapped `<projectPath> <query>`, fourth commit

Third panel, same window, same protocol. The evidence doc's proposal 6: the
one genuine query in the transcripts put the query in the project slot and
the project in the query slot, got `[]` twice, and read that as an absence.
The rule is narrow on purpose: it fires only when the second argument is an
ABSOLUTE existing directory and the first is not, for `search`, `semantic`,
`timeline` and `knowledge`. A relative name in the query slot is left alone
because a query can legitimately match a directory in the cwd, and a project
path that no longer exists is left alone because asking about a deleted
project is legitimate. The suite pins all three edges as controls. Exit 1 with
the usage on stderr and nothing on stdout, so a caller parsing JSON gets a
non-zero status rather than an empty array.

## D7. The one-time prune, on the operator's confirmation, not the protocol's

Branch 3 all along: a deletion of shared state. It was not taken under the
away window. After the window ended the operator selected the prune on a
panel and then confirmed the count on a second one, so it ran: backup first
(`~/.claude/backups/auto-dev-memory-2026-09-08-pre-prune.db`, 7,444 rows,
integrity ok), then one DELETE with the predicate in the evidence doc,
6,972 of 7,480 rows removed, 508 kept, WAL checkpointed. The 36 rows that
arrived between backup and delete are the reversibility gap, stated in the
evidence doc rather than smoothed over. Sessions rows were left alone; 71 of
them now have no observations, which `cleanup()` will fold in after 90 days
as it always would have.
