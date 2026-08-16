# Recommended settings

Plugins cannot set permissions or pick your model — those are yours. This is an
**optional** starting point, not something any install applies for you.

Merge [`recommended-settings.json`](recommended-settings.json) into
`~/.claude/settings.json` (global) or `.claude/settings.json` (per project). Do
not paste it over an existing file; merge the `allow` and `deny` arrays into
what you already have.

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
