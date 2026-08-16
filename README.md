# Claude Auto-Dev

[![Claude Code](https://img.shields.io/badge/Claude%20Code-Plugin-blueviolet)](https://claude.ai/code)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-8.0-blue.svg)](https://github.com/djnsty23/claude-auto-dev/releases)

**Autonomous development workflow for Claude Code.** Say what you want to build — Claude handles the rest.

Distributed as a plugin marketplace. Claude Code installs, updates, and removes
it; there is no install script and nothing is copied into `~/.claude`.

---

## Install

In Claude Code — the desktop app, the CLI, or an IDE session:

```
/plugin marketplace add djnsty23/claude-auto-dev
```

```
/plugin install autodev-core@autodev
```

That is the whole install. Then say `brainstorm`.

Two optional add-ons:

```
/plugin install autodev-memory@autodev
```

```
/plugin install autodev-stack@autodev
```

If the install summary says `Run /reload-plugins to activate.`, run that.

**Upgrading from 7.x?** The old installer copied files into `~/.claude` and
appended a function to your shell profile. Read [MIGRATION.md](MIGRATION.md)
before installing — it clears those out.

---

## What's in each plugin

| Plugin | Contains | Install it if |
|--------|----------|---------------|
| **autodev-core** | The workflow — `brainstorm`, `auto`, `iterate`, `audit`, `review`, `ship`, `scan`, plus the `prd.json` sprint system, 4 subagents, and the sprint/typecheck/safety hooks | Always. This is the tool. |
| **autodev-memory** | Cross-session project memory — automatic observation capture, semantic search, domain-knowledge briefs, repo-backed backup | You want Claude to remember earlier sessions in a project |
| **autodev-stack** | Supabase, Doppler, Stripe, and Remotion integrations | You use that stack |

`autodev-core` stands alone. The other two are additive and can be removed
without touching it.

---

## Commands

| Say | Does |
|-----|------|
| `autodev-init` | Read this codebase and write its real conventions to `.claude/project-rules.md` |
| `learn-from-fixes` | Rank what this project keeps shipping broken, from its own fix history |
| `brainstorm` | Scan codebase + live site, propose improvements |
| `brainstorm apply` | Create stories from the last brainstorm |
| `auto` | Work through all pending stories autonomously |
| `iterate` | Convergence loop: brainstorm → fix → re-scan until clean |
| `audit` | 7-agent parallel quality audit |
| `review` | Runs `/code-review`, then this project's own checks |
| `ship` | Build, test, review, deploy, verify |
| `scan` / `qa` | Live site QA (visual + a11y + console) |
| `fix` | Runs `/debug`, then verifies the fix the way this project requires |
| `commit` | Conventional commit + push + PR |
| `test` | Unit + browser tests |
| `security` | Runs `/security-review`, then Supabase/RLS and cloud-key checks |
| `perf` | Core Web Vitals audit |
| `a11y` | WCAG 2.1 AA audit |
| `design` / `ui` | UI design with anti-slop checklist |
| `progress` | Show sprint progress |
| `sprint` | Create/advance sprint |

Plugin skills are namespaced, so `/autodev-core:audit` always works even if you
have another `audit` skill installed. See [`docs/commands.md`](docs/commands.md)
for the full list.

**Start with `/autodev-init`.** It measures how your codebase is actually
written — component style, data fetching, where auth is enforced, tokens vs raw
colors — and writes `.claude/project-rules.md`. `review`, `audit`, and
`standards` all defer to that file, so the tool enforces your conventions
rather than the defaults this plugin happens to ship. Every rule it writes cites
a count from your code; anything genuinely split is recorded as undecided and
never flagged.

**These build on Claude Code, they do not replace it.** `review`, `security`, and
`fix` each run the matching built-in command first (`/code-review`,
`/security-review`, `/debug`) and then add only what is specific to this
project — its design tokens, its RLS rules, its definition of "verified".

**Quick fixes — skip the ceremony.** For small tasks, just describe what you
want. No `auto`, no sprints, no `prd.json`:

```
fix the button overflow on mobile
add loading state to the dashboard
```

---

## Workflow

```
brainstorm → scans codebase + live site, proposes improvements
auto       → implements all pending stories + visual verification
ship       → review + security + deploy + post-deploy scan
iterate    → brainstorm → fix → re-scan loop until clean
```

**Visual verification.** In the desktop app the built-in Browser pane drives
this — Claude opens your app, reads the page, checks the console, and screenshots
desktop and mobile after each UI change. In a plain terminal session the same
steps run through the `agent-browser` CLI if you have it installed. The `browser`
skill picks between them; you don't have to.

**Image auto-scan.** Attach a screenshot to any turn and Claude surfaces every
distinct issue it sees, not only the one you asked about. Add `[focus]` in your
message to opt out.

---

## Updates

```
/plugin marketplace update autodev
```

```
/plugin update autodev-core
```

There is no `update-dev` command any more — Claude Code owns the update.

---

## Settings

Plugins cannot change your permissions or your model, by design. If you want the
permission set this workflow assumes, merge
[`docs/recommended-settings.json`](docs/recommended-settings.json) into your own
settings — see [`docs/settings.md`](docs/settings.md), which also explains which
rules from the old 7.x template were removed and why.

---

## Files

**Per project** (created as needed):

```
prd.json                    # Tasks and sprint history
.claude/archives/           # Archived prd snapshots
.claude/reports/            # Scan and audit reports
.claude/screenshots/        # Visual verification output
```

Tasks use `passes: null` (pending), `true` (done), or `"deferred"`.

**Global:** `~/.claude/auto-dev-memory.db` — the `autodev-memory` SQLite store.
It deliberately lives outside the plugin so uninstalling does not delete your
project memory.

---

## Uninstall

```
/plugin uninstall autodev-core@autodev
```

Repeat for any add-ons. Claude Code removes exactly what it installed. To drop
the marketplace too:

```
/plugin marketplace remove autodev
```

Your `prd.json` files, memory database, and settings are untouched.

---

## Repository layout

```
.claude-plugin/marketplace.json   # The catalog
plugins/autodev-core/             # Plugin: skills, agents, hooks, templates
plugins/autodev-memory/           # Plugin: skills, hooks, runtime scripts
plugins/autodev-stack/            # Plugin: skills
docs/                             # Docs, settings + CLAUDE.md templates
tooling/                          # Repo tooling — validate, tests, bump. Never shipped.
VERSION                           # Single source of truth; tooling/bump.js propagates it
```

Contributions: see [CONTRIBUTING.md](CONTRIBUTING.md). Run `npm test` before
opening a PR — it runs every suite plus `tooling/validate.js`.

---

## Troubleshooting

**Skills not showing up.** Run `/plugin` and confirm `autodev-core` is listed and
enabled. If the install said so, run `/reload-plugins`. Hook changes need a new
session.

**Hook errors.** Hooks need Node 18+ (`node -v`). They fail quietly by design;
`node tooling/validate.js` checks that every hook in every `hooks.json` points at
a file that exists.

**Memory commands do nothing.** `autodev-memory` needs `node:sqlite`, which is
built in on Node 22+. On older Node the memory skills no-op rather than error.

**Still have `update-dev` in your shell.** That is from the 7.x installer.
[MIGRATION.md](MIGRATION.md) removes it.

---

## License

MIT
