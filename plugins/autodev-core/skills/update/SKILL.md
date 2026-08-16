---
name: update
description: Update the installed autodev plugins to the latest published version, and report what changed.
when_to_use: "Invoked when the user says \"update dev\", \"update auto-dev\", \"update skills\", \"update autodev\", \"sync skills\"."
allowed-tools: Bash, Read
model: haiku
user-invocable: true
---

# Update Autodev

Autodev is distributed as Claude Code plugins, so Claude Code owns the update.
There is no repo to pull and no files to copy into `~/.claude`.

## Process

Tell the user to run these two commands, in this order:

```
/plugin marketplace update autodev
```

```
/plugin update autodev-core
```

…repeating the second for whichever of `autodev-memory` and `autodev-stack`
they have installed. `/plugin` is an interactive command — you cannot run it
with Bash, so hand the commands to the user rather than attempting them.

To confirm what is installed and at which version, you MAY run:

```bash
ls ~/.claude/plugins/marketplaces/ 2>/dev/null
```

## After updating

Hook and skill changes take effect in a **new session**. If the update summary
says `Run /reload-plugins to activate.`, pass that instruction along verbatim.

## Migrating from the pre-8.0 installer

If `~/.claude/repo-path.txt` or `~/.claude/.auto-dev-installed.json` exists, the
user still has the old copy-based install on disk. Point them at `MIGRATION.md`
in the repo — it removes the old files, the `update-dev` shell function, and the
stale global settings block before the plugin install takes over.
