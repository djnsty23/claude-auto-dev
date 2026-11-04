# Qwen evaluation baseline

Measures how well a local Qwen does small, real coding tasks, alone and with Claude as the
reviewer, against Claude alone. "Best results" for Qwen tuning means a higher first-attempt pass
rate in arm a, and fewer Claude fix rounds and tokens in arm b, on a fixed task set.

## Files

| File | What it holds |
|---|---|
| `manifest.json` | the public tasks: fix commits from this repo |
| `run.js` | the harness: `verify`, `run --arm a/b/c`, `probe`, `taxonomy`, `summary` |
| `results.jsonl` | one row per run: first-attempt pass, fix rounds, wall time, Qwen and Claude tokens |
| `fixes.md` | the taxonomy of Claude's corrections to Qwen drafts (arm b), coded Q1, Q2 ... |
| `system-prompt.md` | Qwen's system prompt; recurring fix codes become rules here |

This repo is public, so tasks mined from private product repos live in a private data dir with
the same three files. Point the harness at it with `--data <dir>` or `QWEN_EVAL_DATA`.

## A task

Each task is one fix commit. The parent commit is the start state. The fix commit's test files are
the hidden acceptance test: the model never sees them, and the harness copies them in only to grade.
`brief` is the task statement, `files` the files the model is shown (arm a) or pointed at (arms b, c).
`accept` runs from `pkgDir`, and a pass is exit 0 plus a match of `passLine`.

`--brief subject` replaces the brief with the fix commit's subject line alone: a terse ticket,
closer to how work is really delegated. The written briefs name the cause and often the fix, so
on them Qwen alone passes almost everything and the arms barely separate.

Tasks touching secrets, payments or production data are left out. `run.js verify` proves every
acceptance test fails on the parent and passes on the fix, with no model call.

## Arms

- **a, Qwen alone.** Qwen gets the brief and the files and answers with SEARCH/REPLACE edit
  blocks. The harness applies them and grades. A failure feeds the test output back, up to
  `--rounds` (default 2).
- **b, Qwen drafts, Claude fixes.** One Qwen draft, graded silently. Then headless
  `claude -p --model claude-opus-5-5 --effort medium` reviews the diff, fixes it and emits one
  `FIX: code | rule | example` line per correction. Failures go back to the same Claude session.
- **c, Claude alone.** Claude gets the brief and the file hints, edits the tree, and is graded.

Claude runs with Read, Edit, Write, Glob and Grep only: no Bash, no web, no MCP servers, no user
settings or plugins. The harness makes no network call except the Qwen endpoint and `claude -p`.
Each run uses a scratch git worktree under the OS temp dir, linked to the source checkout's
`node_modules` by a junction, and removes it afterwards.

## Running

```bash
node evals/qwen/run.js probe
node evals/qwen/run.js verify
node evals/qwen/run.js run --arm a --task all
node evals/qwen/run.js taxonomy
node evals/qwen/run.js summary
```

Product repos resolve under `$QWEN_EVAL_REPOS`, by default `Downloads/code/<repo>` in the home
directory. Arm a costs no Claude quota. Arms b and c do, so estimate before a full run.
