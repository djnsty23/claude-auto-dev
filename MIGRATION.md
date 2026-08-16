# Migrating from 7.x to 8.0

7.x copied files into `~/.claude/`, merged a permission block into your global
settings, and appended a shell function to your profile. 8.0 is a plugin
marketplace: Claude Code owns install, update, and uninstall, and nothing is
written to `~/.claude/skills`, `~/.claude/hooks`, or `~/.claude/agents`.

Do the cleanup **before** installing the plugins, so the old copies can't shadow
the new ones.

## 1. Remove the old install

If your 7.x clone is still around, its uninstaller knows exactly what it wrote:

```bash
cd ~/claude-auto-dev && ./uninstall.sh
```

Gone in 8.0, so if you already pulled this version, remove the artifacts by hand:

```bash
rm -f ~/.claude/repo-path.txt ~/.claude/.auto-dev-installed.json
rm -f ~/.claude/skills/manifest.json ~/.claude/skills/commands.md
rm -f ~/.claude/scripts/memory-db.js ~/.claude/scripts/observation-classifier.js
```

Then delete the skill, hook, and agent files 7.x installed. `.auto-dev-installed.json`
listed them; if you deleted it already, the shipped names are the directories
under `plugins/*/skills/` in this repo plus the files in `plugins/*/hooks/` and
`plugins/autodev-core/agents/`. **Leave anything you wrote yourself alone.**

## 2. Remove the shell function

7.x appended an `update-dev()` function to `~/.zshrc`, `~/.bashrc`, or
`~/.profile`. Open the file and delete that block — it points at a repo layout
that no longer exists. In 8.0, updating is `/plugin marketplace update autodev`.

## 3. Clean up your settings

Open `~/.claude/settings.json` and remove the auto-dev hook entries — every
`hooks` entry whose command contains `~/.claude/hooks/`. **Leave your own hook
entries in place.** The plugins register their own hooks; if you keep the old
entries, both fire and every hook runs twice.

While you are in there, review the permission block 7.x wrote. It allowed
`Bash(bash *)`, `Bash(sh *)`, `Bash(source *)`, and `Bash(curl *)`, each of which
makes the `deny` list under it unenforceable. [`docs/settings.md`](docs/settings.md)
explains the change and [`docs/recommended-settings.json`](docs/recommended-settings.json)
is the replacement.

If you copied `config/CLAUDE.md` into `~/.claude/CLAUDE.md`, delete its
`@skills/commands.md` and `@rules/*.md` include lines. Those paths no longer
exist — the rules ship as auto-loading skills now.

## 4. Install the plugins

```
/plugin marketplace add djnsty23/claude-auto-dev
```

```
/plugin install autodev-core@autodev
```

Add `autodev-memory` and `autodev-stack` if you used those features.

## What carries over

- **`prd.json`** — unchanged schema. Existing sprints keep working.
- **Project memory** — the SQLite store stays at `~/.claude/auto-dev-memory.db`.
  `autodev-memory` picks up your existing history; uninstalling never deletes it.
- **`.claude/` project directories** — archives, reports, screenshots, and sprint
  history are untouched.

## What changed behaviorally

- **Skills are namespaced.** `/audit` still works; `/autodev-core:audit` is the
  unambiguous form when another plugin ships the same name.
- **`agent-browser` is now a fallback.** The built-in Browser pane is the default
  driver wherever it exists. The CLI is still fully supported for terminal-only
  sessions; nothing needs reinstalling.
- **`core` and `standards` load again.** Both previously set `user-invocable: false`
  *and* `disable-model-invocation: true`, which made them unreachable by anyone.
- **Memory sessions span a whole session.** Session close moved from `Stop` (which
  fires after every assistant turn) to `SessionEnd`. Under 7.x the memory session
  closed after your first turn and every later observation was silently dropped.
- **`PostCompact` fires.** 7.x registered `post-compact.js` under `PostToolUse`
  with a `"compact"` matcher, which never matched.
- **`agent-browser-cleanup.js` runs.** It shipped orphaned in 7.x — its own header
  claimed `session-start.js` invoked it, and nothing did.
- **The test suite runs.** `tooling/test-all.js` spawned a bare `node` with no
  script for every suite, so CI passed without executing a single test.
