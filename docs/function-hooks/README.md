# Function hooks: autodev-core's hooks module

Claude Code carries an early-access feature its docs do not describe yet:
**hooks modules**, a JavaScript module inside a plugin that intercepts the
engine's events in-process. Anthropic calls it "function hooks"
([issue #91870](https://github.com/anthropics/claude-code/issues/91870)).
`[measured 2026-09-04]` on Claude Code 2.1.259 the runtime is in the binary
behind a rollout flag (`tengu_plugin_hooks_modules`, default off), and
`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in the environment turns it on for a
session. Without it the `modules` entry in `hooks.json` is skipped and every
shell hook beside it runs unchanged, so shipping the module is inert for a
user who has not opted in.

autodev-core's module is [`plugins/autodev-core/hooks/fn/autodev-fn.mjs`](../../plugins/autodev-core/hooks/fn/autodev-fn.mjs).
It does four things a shell hook structurally cannot:

| Hook | What it does | Why |
|---|---|---|
| `prompt.submit` | A pasted credential becomes `[REDACTED:kind#n]` before the prompt enters the transcript. The value is held in worker memory only. | Four transcript leaks in one month came from values that were already in the session before anything could scan for them. |
| `tool.call {tool: Bash}` | Puts a placeholder's real value back into the command that runs; applies the rules in `bash-rules.mjs`; scrubs known values and credential-shaped text out of stdout and stderr before the model or the transcript sees them. | A `doppler secrets delete` printing the whole store, a masking `sed` that missed a spacing variant, a `select=*` on a credential table: all output-side. |
| `attribution.text {kind: commit}` | Returns empty text, so the model is never told to write a co-author trailer. | The standing rule here is no trailer; a per-session instruction keeps re-adding one. |
| `session.start`, `turn.complete` | Pins one status line under the prompt: what the module did this session, and the sprint's five `passes` states from `prd.json`. | Costs no context tokens, and its absence is the tell that the module is not running. |

## Enabling it

Set the variable in the environment Claude Code starts with, for example the
`env` block of `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" } }
```

It is read at process start. A session already running keeps whatever it
started with, the same way `CLAUDE_CODE_SUBAGENT_MODEL` behaved.

## The contract, in this repo's words

The authoritative text is `claude-code.d.ts`, which a session writes with
`/plugin-types` and `node tooling/extract-plugin-types.js` recovers from the
binary without a session. It lands in `.claude/types/` and is not committed:
it is the vendor's file and marked as changing without notice.

- A plugin names **one** module: `hooks.json` `"modules": ["./path.mjs"]`,
  relative to `hooks.json`. The module exports `register(on, options)`.
- A hook is `on("<event>", hook)` or `on("<event>", { key: value }, hook)`.
  The hook receives `($, e, next)`: the engine interface, the event, and the
  continuation. `next(e)` runs the hooks beneath and then core.
- Events: `PreToolUse`, `tool.call`, `prompt.submit`, `prompt.section`,
  `prompt.context`, `tool.describe`, `skill.prompt`, `attribution.text`,
  `agent.offer`, `agent.spawn`, `session.start`, `turn.start`, `turn.step`,
  `turn.complete`, `ui.render`, `ui.resolve`, `ui.press`, `engine.create`,
  every `$` operation as an event, and `*`.
- `$` is only ever written `$.noun.event(...)` at a call site. The host reads
  the module's source before loading it and refuses `$` passed, bound,
  returned or read; an operation the scan did not list is refused at run
  time. `claude plugin validate <plugin-dir>` prints the scan.
- `$.store` persists to a JSON file under `~/.claude/plugins/store/`. Nothing
  secret goes in it.
- Limits: 1 MB per file, 512 linked files, 8 MB in total, imports of the
  plugin's own files only. No Node, no npm, no DOM.
- A hook that throws, overruns its budget or answers the wrong shape is
  skipped and `next`'s result stands. A crashing hooks worker turns function
  hooks off for the session with only a debug-log line.

## What the gate does with it

`tooling/validate.js` checks the `modules` entry: one path, the file exists,
and when `claude` is on PATH it runs `claude plugin validate` with the flag on
and fails on the host's own scan errors. Without the CLI it warns that the
module was not scanned rather than passing it. `tooling/find-untested-hooks.js`
lists the module as a wired hook, so it needs a suite that loads it;
`tooling/test-hooks-module.js` drives `register` with a fake `on` and `$`.

## Two interactions worth knowing before changing the rules

- **A rewrite changes the permission prefix.** `[measured 2026-09-04]` with
  `--allowedTools "Bash(git show:*)"`, the `msys-pathconv` rule turned
  `git show HEAD:.gitignore` into `MSYS_NO_PATHCONV=1 git show ...`, and the
  permission layer, which runs inside `next(e)`, asked for approval it would
  not have asked for. In bypass mode nothing changes; under an allowlist a
  rewritten command can prompt. The rule stays because the unrewritten read
  fails as "not a valid object name" and a `|| echo` fallback then reports a
  present file as missing, which is worse than a prompt.
- **The restored command runs with the real value.** A permission dialog for
  it shows that value on screen. The transcript records the model's tool use,
  which carries the placeholder.
- **"Before the model sees it" is the exact claim; "before the transcript" is
  not.** `[measured 2026-09-04]` in a `-p` run, the transcript's `user` row
  and every tool row carried the placeholder, and the stream never carried the
  value, but a `queue-operation` row (the harness's record of the prompt being
  queued, written before `prompt.submit` fires) held the typed text once. The
  model's context is clean; a scan of the transcript file can still find the
  value in that row, which is what the SessionEnd secret scan is for.

## How to verify it yourself

1. In a session started with the flag, watch for the pinned line
   `fn: redacted 0 · denied 0 · rewrote 0 │ ...` under the prompt. No line
   means the module did not load: run `claude plugin validate plugins/autodev-core`.
2. Paste a synthetic key shaped like `ghp_` followed by 36 letters into a
   prompt. Your message on screen should show `[REDACTED:github-token#1]`,
   and the transcript file should not contain the letters.
3. Ask for `echo` of that placeholder. The output should come back as the
   placeholder, not the letters.
4. In this repository, ask for `git commit -m "x"`. The call should be denied
   with the CLAUDE.md reason; the same command in another repository runs.
