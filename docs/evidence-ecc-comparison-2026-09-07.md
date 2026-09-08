# ECC against autodev, every axis rated: measured evidence

`[measured 2026-09-07]` on one macOS machine (Darwin 27.0.0, Node on PATH,
Claude Code 2.1.233 on PATH), against `affaan-m/ecc` at commit `e04ea0b`
(v2.2.1, pushed 2026-09-03) and this repo at `5ed39fb` (8.164.0). This is a
second, independent measurement of the question `decisions.md` answered on
2026-09-05 from a Windows machine: is ECC a better harness than this plugin.
It reaches the same answer by a different route, and adds the axes the first
record did not rate (content substance, context cost, hygiene, tests,
memory, portability, community, docs). The three ports that came out of it
are in the last section, each against the thing it replaced.

## Method

- Both repos' real `hooks.json` command strings, run through `sh -c` for
  ECC (its inline `node -e` bootstrap needs a shell) and directly for
  autodev's `command` + `args` form. Fixed payloads on stdin shaped like the
  host's (`tool_name`, `tool_input`, `session_id`, `cwd`, `transcript_path`,
  `stop_hook_active`), an empty scratch cwd, HOME pointed at that cwd so
  nothing wrote into the live `~/.claude`. N=3 per hook, medians reported;
  the port measurements at the end are N=7.
- Byte counts are stdout and stderr on the no-op path, separately.
- Tests: `node tests/run-all.js` for ECC (twice: once from a bare clone,
  once after `npm ci --ignore-scripts`), `npm test` here on a clean tree.
- Content: 10 ECC skills and 11 autodev skills read in full and scored on
  whether they contain falsifiable procedure, cite a dated measurement or
  incident, and reference files that exist. Every path an ECC skill named
  was checked against its tree.
- Community numbers from the GitHub API on the day; git numbers from the
  clones.

## Inventory

| | ECC | autodev |
|---|---|---|
| skills / agents / commands / rules | 286 / 68 / 94 / 122 | 67 (16 always-on `rule-*`) / 5 / – / – |
| skill-index bytes every session pays for | 74,215 (+10,128 commands, +14,247 agents) | 12,388 |
| hook entries (events) | 23 (7) | 22 (12), 23 after the port |
| runtime dependencies | 4 (+8 dev) | 0 |
| commits / distinct authors / first commit | 2,631 / 100+ / 2026-01-17 | 877 / 1 human under 4 identities / 2026-01-12 |
| commits in the last 30 days / tags | 260 / 17 | 620 / 134 |
| stars / forks / open PRs / open issues | 252,257 / 37,862 / 124 / 52 | private |
| harness adapters present in tree | Claude, Codex, OpenCode, Cursor, Gemini, Kiro, Kimi, Hermes, OpenClaw, Trae, Zed, Qwen, Pi | Claude Code only |

## Hook cost, no-op path

Per tool call, summed over the hooks whose matcher fires, this machine:

| event | ECC sync ms | ECC async ms on top | autodev ms |
|---|---|---|---|
| Bash call | 368 | 643 | 179 |
| Edit call | 575 | 643 | 247 |
| Stop | 312 | 642 | 323 |

Zero-byte discipline: 0 of 23 ECC hooks are silent on the no-op path. Every
PreToolUse hook writes 65–94 bytes to stderr (`[Hook] bootstrap: hook
returned raw input as stdout; emitting empty to avoid transcript bloat`),
and every Stop and PostToolUse hook echoes the input payload back on stdout
(266–339 bytes each, 7 × 266 per Stop). 19 of 22 autodev hooks emit nothing
on either stream; the three that speak are session-start (39 B system
message), stop-auto-check (23 B decision), post-compact (145 B).

Side effects of one `ls` in an empty cwd: ECC wrote 10 files, five of them
into the project's `.claude/` (`bash-commands.log`, `cost-tracker.log`,
`metrics/costs.jsonl`, `session-data/*`), plus `~/.gateguard/state-*.json`
and `~/.local/share/ecc-homunculus/observations.jsonl`, which records every
tool input. autodev wrote two, both under `.claude/reports/`.

## Tests and gates

ECC: 3,992 tests from a bare clone, 146 failing, all on `Cannot find module`
for `ajv`, `js-yaml`, `sql.js`. After `npm ci --ignore-scripts`: 4,159 of
4,159 in 7 m 53 s. Eight CI validators all exit 0. 42 of 52 hook suites drive
the hook as a subprocess. `validate-hooks.js` checks matchers only: nothing
in the repo proves a wired hook is executed by any suite. c8 threshold 80 %
lines.

autodev: 109 of 112 suites in 5 m 49 s, 3 red on this machine and green in
CI. Both reds were local: the hooks-module scan read Claude Code 2.1.233's
silence as an unread entry, and the layout gate's 84,752-byte JSON report
was truncated at 65,536 by `process.exit()` after an asynchronous pipe
write. Both had a measured explanation and neither was the code under test.
This session's fix for them (`5fa045b`, PR #182) was closed in review and
superseded: its validate half skipped the scan on any host below 2.1.259,
which would have reported a module that genuinely fails validation on this
Mac's 2.1.233 as a WARN. #184 reads the host's output instead of its version
and is the fix that landed; #191 landed the layout-gate half. Both are on
main and this PR is rebased on them.

## Content substance

ECC, 10 skills read: `tdd-workflow` (21 KB) carries one dated reference;
eight of ten carry none. `rules/common/coding-style.md` is KISS, DRY, YAGNI
and "ALWAYS handle errors comprehensively". `continuous-learning-v2` names
six paths that do not exist (`agents/refactor-specialist.md`,
`commands/new-feature.md`, `scripts/migrate-homunculus.sh`,
`skills/learned/`, and two more); `autonomous-loops` names
`commands/infinite.md`, also absent. `WORKING-CONTEXT.md` says "Last
updated: 2026-04-08" and states 47 agents, 79 commands, 181 skills against
68, 94, 286 on disk. Two things ECC does record well: the README's history
of the hooks-autoload regression (#29, #52, #103, with a regression test),
and the comment in `gateguard-fact-force.js` at line 894 admitting its deny
blocks caused "a degenerate repetition loop" before a budget was added.

ECC's rules never reach a plugin install: `.claude-plugin/plugin.json` lists
`skills/` and `commands/` only, and the 122 rules ship through
`install.sh` profiles into `~/.claude/rules`.

`gateguard-fact-force.js` (42 KB) denies the FIRST Edit or Write on every
file and allows any retry (lines 1244–1252); the "facts" it demands are
never read by the hook. One wasted denied call per file per session.

autodev, 11 skills read: `rule-gate-integrity` carries 9 dated references,
`rule-diagnosis` 5, `heal` 4, `brain` 115. Every referenced script exists.
The weakness is the other direction: `brain/SKILL.md` is 91 KB.

By skill name, roughly: ECC has ~80 software-workflow skills, ~90
language/framework pattern skills, ~65 business-domain skills (logistics,
healthcare, finance, homelab, investor, trading, energy), ~20
sponsor-or-vendor skills (`ito-*`, `exa-search`, `fal-ai-media`, `videodb`,
`nutrient-*`, `mailtrap-*`, `x-api`), ~20 about ECC itself. The sponsor
skills are not marked as such in their frontmatter.

## Ratings, 1 to 10

| dimension | ECC | autodev | what decided it |
|---|---|---|---|
| Breadth of content | 9 | 4 | 286 skills, 68 agents, 13 harness adapters |
| Substance of workflow content | 5 | 8 | dated incidents and existing references, above |
| Per-session context cost | 4 | 8 | 74 KB vs 12 KB of skill index |
| Hook runtime per tool call | 5 | 8 | 575 ms vs 247 ms per Edit |
| Hook hygiene (silence, side effects) | 3 | 8 | 0 of 23 silent, 10 files per `ls` |
| Enforcement design | 5 | 7 | GateGuard's blind first-deny vs stop-auto-check's five escape hatches |
| Test and gate rigor | 6 | 7 | ECC needs deps and proves no hook execution; autodev's main was red locally |
| Memory and learning | 6 | 6 | ECC logs every tool input and injects up to 8 KB at start; autodev injects one line |
| Cross-harness portability | 9 | 2 | 13 adapters vs one host |
| Community and bus factor | 8 | 3 | 100+ contributors, 59 % of commits by one person vs one author |
| Supply chain and security | 6 | 8 | 4 deps and a 1 KB inline bootstrap per hook vs 0 deps; neither phones home |
| Maintainer docs | 5 | 8 | a five-month-stale working-context file vs dated claims that get corrected |
| Fit for this operator | 4 | 9 | no prd.json sprint loop, no Brain, no coordinator guard |
| **As a replacement** | **5** | **7** | |

Not adopted, again. The 2026-09-05 record measured latency on Windows and
reached "no on every axis measured"; this one adds nine axes and finds two
where ECC is ahead (breadth, portability) and one where it is level
(memory). Neither is a reason to change base.

## The three ports, each against what it replaced

Rule from `rule-ab-testing`: baseline, proposal, one variant, numbers.

### Typecheck once at Stop

| variant | per Edit no-op | when it runs | does the model see failures |
|---|---|---|---|
| A, before: run typecheck + lint in PostToolUse, 10 s debounce | 34.4 ms | every edit ≥10 s apart, up to 50 s blocking | no: exit-0 PostToolUse stdout is transcript-only |
| B, shipped: accumulate in PostToolUse, check once at Stop, `decision: block` | 32.8 ms (+35.5 ms per Stop) | once per response | yes, as the block reason |
| C, ECC: accumulate, format + typecheck at Stop, report on stderr | – | once per response | no: Stop stderr on exit 0 is not context |

B, with one retry (under `stop_hook_active` a still-failing check becomes a
`systemMessage`), and without ECC's reformatting of the user's files.

### Lint/format config protection

| variant | per Edit no-op | escape for the legitimate edit |
|---|---|---|
| A, before: nothing | 40.8 ms (pre-tool-filter alone) | – |
| B, ECC: a separate PreToolUse hook, `deny` | +58 ms (a second subprocess) | an env var in the session, unsettable from the desktop app |
| C, shipped: a Set lookup inside pre-tool-filter, `ask` | 40.8 ms (39.7 on the ask path) | the human answers the prompt; a headless session is denied |

### Hook profile

| variant | cost | what it can switch off |
|---|---|---|
| A, before: nothing (uninstall, or `disableAllHooks`) | – | every plugin's hooks, or the skills too |
| B, ECC: minimal / standard / strict via `run-with-flags.js` | one wrapper subprocess per hook | anything, including its own GateGuard |
| C, shipped: `hooks_profile=minimal` via userConfig, one env read per advisory hook | 32.2 ms vs 33.3 ms (telemetry, minimal vs full) | the seven advisory hooks only; the eleven guarding hooks are tested NOT to honour it |

## Raw hook table, ECC, no-op path (ms median of 3 · stdout B · stderr B)

```
PreToolUse  Bash                 pre:bash:dispatcher                   90 ·   0 · 65
PreToolUse  Write                pre:write:doc-file-warning            81 ·   0 · 94
PreToolUse  Edit|Write           pre:edit-write:suggest-compact       127 ·   0 · 94
PreToolUse  .*                   pre:observe:continuous-learning      340 ·   0 · 94  (async)
PreToolUse  Bash|Write|Edit|ME   pre:governance-capture                86 ·   0 · 94
PreToolUse  Write|Edit|ME        pre:config-protection                 83 ·   0 · 94
PreToolUse  .*                   pre:mcp-health-check                 136 ·   0 · 94
PreToolUse  Edit|Write|ME        pre:edit-write:gateguard-fact-force   87 ·   0 · 94
PreCompact  .*                   pre:compact                          123 ·   0 · 136
SessionStart .*                  session:start                        184 ·  78 · 727
SessionStart .*                  session-start:plan-canvas-sessions    82 ·   0 · 94
PostToolUse .*                   post:dispatcher:sync                  56 · 339 · 0
PostToolUse .*                   post:dispatcher:async                303 · 339 · 0  (async)
PostToolUseFailure .*            post:mcp-health-check                133 ·   0 · 94
PostToolUseFailure Skill         post:skill:track                      87 ·   0 · 94
Stop        .*                   stop:plan-canvas-pending              83 · 266 · 0
Stop        .*                   stop:format-typecheck                 85 · 266 · 0
Stop        .*                   stop:check-console-log               144 · 266 · 0
Stop        .*                   stop:session-end                     174 · 266 · 247 (async)
Stop        .*                   stop:evaluate-session                125 · 266 · 62  (async)
Stop        .*                   stop:cost-tracker                    124 · 266 · 0   (async)
Stop        .*                   stop:desktop-notify                  219 · 266 · 0   (async)
SessionEnd  .*                   session:end:marker                    84 · 232 · 71  (async)
```

## Raw hook table, autodev at 5ed39fb, no-op path

```
SessionStart      session-start.js             107 ·  39 · 0
SessionStart      agent-browser-cleanup.js      82 ·   0 · 0
UserPromptSubmit  user-prompt-image-scan.js     51 ·   0 · 0
UserPromptSubmit  inbox-notify.js               54 ·   0 · 0
PreToolUse        pre-tool-filter.js            59 ·   0 · 0
PreToolUse        panel-recommendation.js       66 ·   0 · 0
PreToolUse        peer-message-budget.js        71 ·   0 · 0
PreToolUse        coordinator-write-guard.js    76 ·   0 · 0
PostToolUse       post-tool-typecheck.js        85 ·   0 · 0
PostToolUse       telemetry.js                  68 ·   0 · 0
PostToolUseFailure telemetry.js                 68 ·   0 · 0
Stop              stop-auto-check.js           113 ·  23 · 0
Stop              stop-brain-report.js         147 ·   0 · 0
Stop              context-depth-nudge.js        63 ·   0 · 0
StopFailure       stop-failure-note.js          49 ·   0 · 0
PreCompact        pre-compact.js                46 ·   0 · 0
PostCompact       post-compact.js               47 · 145 · 0
InstructionsLoaded instructions-loaded.js       47 ·   0 · 0
memory SessionStart  memory-session-start.js    61 ·   0 · 0
memory UserPromptSubmit memory-prompt-capture.js 35 ·  0 · 0
memory PostToolUse   memory-capture.js          36 ·   0 · 0
memory SessionEnd    memory-session-end.js      42 ·   0 · 0
```

The two tables were taken in different minutes of the same session; the
port measurements at N=7 came out 20–40 % lower across the board for the
same hooks, so compare within a table, not across them.
