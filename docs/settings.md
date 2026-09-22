# Recommended settings

Plugins cannot set permissions or pick your model — those are yours. This is an
**optional** starting point, not something any install applies for you.

Merge [`recommended-settings.json`](recommended-settings.json) into
`~/.claude/settings.json` (global) or `.claude/settings.json` (per project). Do
not paste it over an existing file; merge the `allow` and `deny` arrays into
what you already have.
## `git push` asks, even though `git` is allowed

The allow list carries `Bash(git *)`, which covers around forty git operations
and is worth having. It also covered `git push`, so a push ran with no prompt.

`[measured 2026-08-30]` that gap has a cost attached rather than being
theoretical. A skill in this repo told a coordinating session to push another
session's branch, and nothing stopped it: the instruction said push and the
permission layer approved silently. The skill is fixed, and this is the second
half, because a wrong instruction should not be the only thing standing between
an agent and a publish.

`ask` takes precedence over a broader `allow`, which was tested rather than
assumed. Same command and same permission mode, one rule different: with only
`Bash(git *)` the push ran unprompted; adding `Bash(git push*)` to `ask`
produced "Permission needed to run Bash."

Drop the rule if you push constantly and the prompt becomes noise. Keep in mind
what it is protecting: publishing is the one action in that list that is visible
to other people and cannot be taken back by editing a file.

## `fallbackModel`

The file also sets `"fallbackModel": ["sonnet"]`. That is a top-level key rather
than part of those two arrays, so merge it separately. Claude Code tries the
listed models in order, up to three, when the primary is overloaded or
unavailable.

It is here because the failure it prevents is specific to unattended work. An
`auto` sprint that meets an overloaded primary model does not degrade, it stops,
and on a Stop-hook-driven loop that reads as the sprint having finished. One
fallback turns a halt into slower progress. Drop the key if you would rather a
sprint stop than continue on a different model, which is a reasonable preference
when the work is cost-sensitive rather than time-sensitive.

## `autoCompactWindow`

The file sets `"autoCompactWindow": 320000`, another top-level key to merge on
its own. It moves the auto-compaction window to 320k tokens, and compaction
fires near the top of it. `CLAUDE_CODE_AUTO_COMPACT_WINDOW` does the same from
the environment (see the [env var reference](https://code.claude.com/docs/en/env-vars.md)).

The number is chosen against `autodev-core`'s context-depth Stop hook, whose
soft line defaults to 250k (`AUTODEV_CONTEXT_SOFT_LINE`). At the soft line the
hook holds the Stop once and tells the session to finish its unit of work and
write its handoff with `session-exit.js`. Compaction cannot choose its moment,
so without that line it can land mid-edit with nothing saved. The 70k between
the two is room to finish the unit, and the session start after compaction
points the session back at the handoff. With no window set, the hook orders a
continuation chip instead, which needs a person to click it.

Keep the window above the soft line, or compaction arrives before the handoff
is written. Drop the key to keep the harness default.

`[inferred 2026-09-22]` compaction at the configured window is documented but was
not observed in a headless `-p` probe. Measure the Desktop app before relying on
the exact point: sum `input_tokens`, `cache_read_input_tokens` and
`cache_creation_input_tokens` per assistant row in the session transcript and
find the drop.

## What changed from the pre-8.0 template

The old `--full` install wrote a permission block straight into your global
settings. Several of its `allow` rules made the `deny` list below them
decorative:

| Removed rule | Why |
|---|---|
| `Bash(bash *)`, `Bash(sh *)` | Runs any command at all, including every denied one. `bash -c 'rm -rf /'` was allowed. |
| `Bash(source *)` | Same, via a sourced script. |
| `Bash(curl *)`, `Bash(wget *)` | Fetch-and-execute, and a clean exfiltration path for anything readable. |
| `Bash(export *)`, `Bash(env *)` | Lets a turn rewrite `PATH` and friends for later commands. |
| `Bash(chmod *)` | Turns any written file into an executable one. |
| `Bash(rm -f *)` | Sat directly above a `deny` list built to stop deletions. |
| `Bash(start *)` | Windows-only launcher for arbitrary executables. |
| `WebFetch(domain:*)` | Blanket approval for fetching any domain. Approve domains as they come up. |

A deny rule only helps if no allow rule can express the same thing more
generally. Every entry above could.

`Bash(node *)` and `Bash(npx *)` are still allowed, because ordinary development
is unworkable without them. They are genuine escape hatches — `node -e` runs
arbitrary code — so `autodev-core`'s `PreToolUse` hook blocks `node -e` at the
start of a command and restricts `npx` to a known set of tools. **If you install
the recommended permissions without `autodev-core`, drop these two lines.**

## Model

The old template pinned `"model": "opus"` globally and forced
`CLAUDE_CODE_SUBAGENT_MODEL=opus`. That is a preference, not a requirement, and
it overrode whatever you had picked. Set your own model with `/model`; the
skills that genuinely need a specific tier declare it in their own frontmatter.

## Hooks

Do **not** copy hook entries into your settings. Each plugin ships its own
`hooks/hooks.json` and Claude Code registers them on install, so a hooks block in
your settings would run them a second time.
