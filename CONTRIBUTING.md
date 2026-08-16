# Contributing to Claude Auto-Dev

The repo is a plugin marketplace. Everything shipped to users lives under
`plugins/`; everything else is repo tooling and docs.

```
.claude-plugin/marketplace.json   # Catalog — every plugin must be listed here
plugins/<plugin>/
├── .claude-plugin/plugin.json    # ONLY plugin.json goes in this directory
├── skills/<name>/SKILL.md        # One directory per skill
├── agents/<name>.md              # Subagents
├── hooks/hooks.json              # Hook registration
├── hooks/*.js                    # Hook implementations
├── scripts/*.js                  # Runtime code hooks and skills call
└── templates/                    # Files skills scaffold into user projects
docs/                             # Docs and templates
tooling/                          # validate.js, test-*.js, bump.js — never shipped
```

Component directories go at the **plugin root**, never inside `.claude-plugin/`.

## Before you open a PR

```bash
npm test
```

This runs every `tooling/test-*.js` suite and then `tooling/validate.js`. Both
must pass. The validator checks version sync, marketplace/plugin manifests,
skill frontmatter, hook wiring, and that every `${CLAUDE_PLUGIN_ROOT}` path in a
skill resolves to a real file.

## Adding a skill

Create `plugins/<plugin>/skills/<name>/SKILL.md`. The directory name becomes the
command name.

```markdown
---
name: skill-name
description: What it does and when to use it. Claude reads this to decide whether to load the skill, so lead with the use case.
when_to_use: "Invoked when the user says \"foo\", \"bar\"."
allowed-tools: Read, Grep, Glob
user-invocable: true
---

# Skill Name

Instructions Claude follows when the skill runs.
```

Frontmatter rules that the validator enforces:

- `name` must match the directory name.
- `description` is required.
- **`triggers:` is not a real field.** It was invented by this repo pre-8.0 and
  no runtime ever read it. Use `when_to_use`, which Claude Code appends to the
  description when deciding whether to load the skill.
- Never set `user-invocable: false` **and** `disable-model-invocation: true` on
  the same skill — that makes it unreachable by both you and Claude.

Other fields worth knowing: `paths` (auto-load only when working on matching
files — this is how the `rule-*` skills apply), `model`, `effort`,
`context: fork` (run in a subagent), `argument-hint`, `disallowed-tools`.

### Keep SKILL.md short

Put long reference material in `references/` next to the skill and link to it,
so it loads only when needed. `skills/browser/` is the pattern: a short
selection rule in `SKILL.md`, the 300-line CLI reference in
`references/agent-browser-cli.md`.

## Adding a hook

Implement it in `plugins/<plugin>/hooks/`, then register it in that plugin's
`hooks/hooks.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          { "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/my-hook.js\"", "timeout": 10 }
        ]
      }
    ]
  }
}
```

- Always resolve paths through `${CLAUDE_PLUGIN_ROOT}`. Never `~/.claude` and
  never a relative path — the validator rejects both.
- A hook must never crash the session. Wrap the body in try/catch and
  `process.exit(0)` unless the hook's whole purpose is to block.
- Add a suite under `tooling/` that drives it as a subprocess. Follow
  `tooling/test-pre-tool-filter.js`.
- On macOS, `realpathSync` any path you compare against `process.cwd()` —
  `/var/folders` and `/private/var/folders` are the same directory and a raw
  comparison silently fails.

## Which plugin does it belong in?

| Plugin | Scope |
|--------|-------|
| `autodev-core` | The workflow. Must work standalone with no other plugin installed. |
| `autodev-memory` | Anything touching the memory database. |
| `autodev-stack` | Vendor-specific integrations (Supabase, Doppler, Stripe, Remotion). |

A core skill may not depend on a file in another plugin — `${CLAUDE_PLUGIN_ROOT}`
resolves per plugin, so a cross-plugin path cannot work. If core needs it, core
ships it.

## Releasing

```bash
node tooling/bump.js 8.1.0
```

That writes `VERSION`, `package.json`, `marketplace.json`, and every
`plugin.json`. Then add a `CHANGELOG.md` section, run `npm test`, and tag
`v8.1.0`.
