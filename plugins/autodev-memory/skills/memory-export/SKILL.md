---
name: memory-export
description: Export every stored Claude Code memory file as one paste-ready block in five fixed categories, oldest first, with PII withheld by default and a closing line that says whether the export is complete or partial.
when_to_use: "Invoked when the user says \"memory export\", \"export my memories\", \"export all stored memories\", \"dump memory\", or wants to carry what Claude knows about them to a different assistant or account."
allowed-tools: Bash
model: haiku
user-invocable: true
argument-hint: "[--with-pii] [--format json]"
---

# Memory export

Prints the file-based memories (Markdown with `name`, `description` and
`metadata.type` frontmatter) from the active profile: `<config>/memory/` and
every `<config>/projects/<project>/memory/`, where `<config>` is
`CLAUDE_CONFIG_DIR` or `~/.claude`. It does not read the SQLite observation
store; `mem-search` covers that.

## Run it

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/memory-export.js"
```

Show the output exactly as printed: one code block, then the `Export:` line.
Do not summarise, reorder or reword the entries. The format is fixed:

- Categories in this order: Instructions, Identity, Career, Projects, Preferences.
- One entry per line, `[YYYY-MM-DD] - text`, oldest first, `[unknown]` when undated, undated last.
- The last line says `complete` or `partial`, with what was withheld and why.

## Options

| Flag | Effect |
|---|---|
| `--with-pii` | Keep entries holding an email, phone number, IBAN or company registration id. Only when the user asks for them. |
| `--format json` | Structured output: entries with date, text and source file name. |
| `--counts` | Entry count per category and the status line, no content. Use for reports. |
| `--root <dir>` | Read this directory instead of the defaults. Repeatable. |

## How entries are chosen

- `feedback` memories become Instructions, from their description.
- `user` memories go to Career when they name a role, company or employer, otherwise Identity.
- `project` memories become one Projects entry each, `<name>: <description>`.
- `reference` and other memories appear under Preferences only when they state a taste or working style; the rest are left out and counted on the status line.
- Any body line that reads as a standing rule (`always` / `never`, or a `[stated YYYY-MM-DD]` line with an instruction) is added to Instructions.
- A date is the earliest `[stated|measured|inferred YYYY-MM-DD]` tag in the file, else the earliest MM-DD in its `MEMORY.md` index line, else the frontmatter `modified` date.

## Before sharing the export

The default run withholds entries with contact details or registration ids,
and the status line says how many. Memories can still name people, clients or
internal systems. Tell the user to read the block before pasting it anywhere.
