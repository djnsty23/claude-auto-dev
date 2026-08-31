# Claude Auto-Dev

[![Claude Code](https://img.shields.io/badge/Claude%20Code-Plugin-blueviolet)](https://claude.ai/code)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-8.2-blue.svg)](https://github.com/djnsty23/claude-auto-dev/releases)

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
| **autodev-memory** | Cross-session project memory + nightly `memory-maintenance` — automatic observation capture, semantic search, domain-knowledge briefs, repo-backed backup | You want Claude to remember earlier sessions in a project |
| **autodev-stack** | Supabase, Doppler, Stripe, and Remotion integrations | You use that stack |

`autodev-core` stands alone. The other two are additive and can be removed
without touching it.

---

## Commands

| Say | Does |
|-----|------|
| `autodev-init` | Read this codebase and write its real conventions to `.claude/project-rules.md` |
| `learn-from-fixes` | Rank what this project keeps shipping broken, from its own fix history |
| `preflight` | Scaffold the executable gate file that fails the build on those classes |
| — | `scripts/find-orphan-checks.js` finds verification code nothing runs |
| `brainstorm` | Scan codebase + live site, propose improvements |
| `brainstorm apply` | Create stories from the last brainstorm |
| `framework radar` | Research recent Claude Code, Codex and agent-workflow changes, then propose measured experiments |
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

**Framework Radar.** `framework radar` collects recent official Claude Code and
Codex changes, discovers relevant captioned YouTube videos, keeps raw transcripts
outside the repository, and checks each claim against the current code before
proposing an experiment. Scheduled runs are report-only: they write a sourced
review under `.claude/reports/` and never change code, stories, gates or git state.
The deterministic collector is also available as `npm run radar` in this repo.

**Visual verification.** Claude opens your app in the built-in Browser pane,
reads the page, checks the console, and screenshots desktop and mobile after each
UI change. There is no skill to invoke — the browser tools are used directly.

> The separate `browser` skill and the `agent-browser` CLI steps were dropped in
> 8.79/8.80. The binary itself is unrelated and may still be installed for other
> tools, which is why `agent-browser-cleanup.js` still runs: it clears zombie
> Chromium processes and a stolen Win+Shift+S hotkey on Windows.

**Phone screenshots and other out-of-band files.** Save anything into
`~/Library/Mobile Documents/com~apple~CloudDocs/claude-inbox` — iCloud, so an iOS
Shortcut can drop a screenshot there in one tap — and the next prompt announces
it with filename, path, and arrival age. Measured at ~30ms per prompt and **zero
context when the inbox is empty**, which is almost every turn; the cost is flat
whether one file is waiting or twenty-five, because the hook stats the directory
and never opens a file. Each arrival is announced exactly once. Claude reads the
image only when the arrival time makes it plausibly relevant — auto-injecting
every screenshot would cost roughly a thousand tokens each.

Set `AUTODEV_INBOX` to use a different folder, `AUTODEV_INBOX_DISABLED=1` to turn
it off, and `/inbox` to list what is waiting.

**Image auto-scan.** Attach a screenshot to any turn and Claude surfaces every
distinct issue it sees, not only the one you asked about. Add `[focus]` in your
message to opt out.

---

## Verifying the framework itself

This repo ships checks and is therefore held to its own standard: **coverage measures
execution, mutation measures verification.** A function can be entered on every run
while nothing asserts anything about it.

```bash
npm test                  # every suite, then validate. The gate.
npm run check:hooks       # wired hooks no suite drives — a hard gate in validate
npm run check:functions   # functions never entered (~20s)
npm run check:vacuity <subject.js> <suite.js>   # code no assertion depends on
npm run check:suites      # suites that cannot fail
npm run check:superseded  # guidance a later decision has overtaken
npm run check:versions    # the six files that must agree on a version
npm run check:runtime     # asserts the version EXECUTING is the one you edited
npm run check:agent-cost  # what a subagent really costs, from real transcripts
npm run check:agent-budget --lenses 4 --verify adversarial   # how many agents to spawn now
npm run actions:cost      # CI spend, from GitHub's own usage CSV
```

Four of those answer different questions and none substitutes for another: scripts
nobody runs, hooks no suite drives, functions never entered, and code no assertion
depends on.

`check:vacuity` **rewrites its subject with mutants**. It refuses a dirty subject, and
`validate` fails while a `*.vacuity-backup` exists. If you kill a run, `pkill -9` then
`pgrep` to confirm — a survivor rewrites the file underneath you.

## Running a fleet

When several sessions run at once, they cannot see each other. These read the
same transcripts the app writes and answer the questions that causes.

| Script | Answers |
|---|---|
| `fleet-status.js` | Which sessions are live, and which are blocked on an unanswered question |
| `fleet-overlap.js` | Which two sessions are working the same ground, scored on three separate signals |
| `watch-panels.js` | Emits one line per NEWLY blocked session, for the Monitor tool |
| `brain-brief.js` | Regenerates the volatile half of a handoff: fleet, ownership, open PRs, uncommitted work |
| `steer-log.js` | Whether cross-session advice arrived before or after the work it described |
| `quota-tripwire.js` | One alert when weekly usage is 30-50 minutes from exhaustion |

They live in `plugins/autodev-core/scripts/`. Two design rules they all follow,
learned by getting them wrong first:

**Print the population, not a verdict.** "212 of 212 files read, 9 names, clean"
can be judged. "clean" cannot be told apart from a check that ran on nothing.

**Distinguish "checked, none found" from "could not check".** Silence must never
read as clean. Each script reports a missing dependency or an unreadable input in
place rather than returning an empty result.

`fleet-overlap.js` scores three signals separately rather than blending them,
because they mean different things: two sessions on one branch will collide, two
in one repo might, and two sharing a word in their titles probably will not.

`watch-panels.js` takes `--self <sessionId>` or `AUTODEV_SELF_SESSION` so it does
not report your own questions back to you, and persists its dedup state to disk so
restarting it does not re-raise what you already answered.

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
