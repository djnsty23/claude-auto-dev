# Skill reachability survey

Scanned: 58 SKILL.md files across autodev-core, autodev-memory, autodev-stack (all plugins in this repo).

| Skill | Plugin | user-invocable | paths glob | when_to_use | UNREACHABLE |
|---|---|---|---|---|---|
| a11y | autodev-core | true | - | true |  |
| archive-prd | autodev-core | true | - | true |  |
| audit | autodev-core | true | - | true |  |
| auto-brain | autodev-core | true | - | true |  |
| auto | autodev-core | true | - | true |  |
| autodev-init | autodev-core | true | - | true |  |
| brain | autodev-core | true | - | true |  |
| brainstorm | autodev-core | true | - | true |  |
| commit | autodev-core | true | - | true |  |
| core | autodev-core | false |  - prd.json - "**/prd.json" | true |  |
| design | autodev-core | true | - | true |  |
| fleet | autodev-core | true | - | true |  |
| grilling | autodev-core | true | - | true |  |
| heal | autodev-core | true | - | true |  |
| iterate | autodev-core | true | - | true |  |
| learn-from-fixes | autodev-core | true | - | true |  |
| migrate | autodev-core | true | - | true |  |
| perf | autodev-core | true | - | true |  |
| phase | autodev-core | true | - | true |  |
| preflight | autodev-core | true | - | true |  |
| refactor | autodev-core | true | - | true |  |
| review | autodev-core | true | - | true |  |
| rule-ab-testing | autodev-core | false | - | true | **YES** |
| rule-agent-concurrency | autodev-core | false |  - "**/*.workflow.js" | true |  |
| rule-design-system | autodev-core | false |  - "**/*.tsx" - "**/*.jsx" - "**/*.css" - "**/tailwind.config.*" | true |  |
| rule-diagnosis | autodev-core | false | - | true | **YES** |
| rule-file-organization | autodev-core | false | - | true | **YES** |
| rule-gate-integrity | autodev-core | false | - | true | **YES** |
| rule-local-first | autodev-core | false | - | true | **YES** |
| rule-options-protocol | autodev-core | false | - | true | **YES** |
| rule-ramifications | autodev-core | false | - | true | **YES** |
| rule-security | autodev-core | false |  - "**/*.ts" - "**/*.tsx" - "**/*.js" - "**/*.jsx" - "**/*.sql" - "**/*.env*" | true |  |
| rule-thumb-first | autodev-core | false |  - "**/*.tsx" - "**/*.jsx" - "**/*.vue" - "**/*.svelte" - "**/*.css" - "**/tailwind.config.*" | true |  |
| rule-verification | autodev-core | false | - | true | **YES** |
| rule-windows | autodev-core | false | - | true | **YES** |
| scan | autodev-core | true | - | true |  |
| security | autodev-core | true | - | true |  |
| seo | autodev-core | true | - | true |  |
| sessions | autodev-core | true | - | true |  |
| setup-project | autodev-core | true | - | true |  |
| ship | autodev-core | true | - | true |  |
| show-your-work | autodev-core | true | - | true |  |
| spec | autodev-core | true | - | true |  |
| sprint | autodev-core | true | - | true |  |
| standards | autodev-core | false |  - "**/*.ts" - "**/*.tsx" - "**/*.js" - "**/*.jsx" | true |  |
| status | autodev-core | true | - | true |  |
| telemetry | autodev-core | true | - | true |  |
| test | autodev-core | true | - | true |  |
| wizard | autodev-core | true | - | true |  |
| writing-for-agents | autodev-core | true | - | true |  |
| knowledge-agent | autodev-memory | true | - | true |  |
| mem-search | autodev-memory | true | - | true |  |
| memory-backup | autodev-memory | true | - | true |  |
| memory-maintenance | autodev-memory | true | - | true |  |
| doppler | autodev-stack | true | - | true |  |
| remotion | autodev-stack | true | - | true |  |
| stripe | autodev-stack | true | - | true |  |
| supabase | autodev-stack | true | - | true |  |

## Unreachable skills (user-invocable:false AND no paths glob): 9

- **rule-ab-testing** (plugins/autodev-core/skills/rule-ab-testing/SKILL.md) — desc: "Every proposal gets measured against the current approach and at least one variant before it is adopted, and the measurement is reported. L
- **rule-diagnosis** (plugins/autodev-core/skills/rule-diagnosis/SKILL.md) — desc: "Diagnosis is the load-bearing step, not the fix. A wrong fix costs one cycle; a wrong diagnosis costs every cycle until someone questions t
- **rule-file-organization** (plugins/autodev-core/skills/rule-file-organization/SKILL.md) — desc: Where generated files belong. Archives, backups, handoffs, reports, and screenshots go under .claude/, never the project root. Load before w
- **rule-gate-integrity** (plugins/autodev-core/skills/rule-gate-integrity/SKILL.md) — desc: "Four ways a gate, test, or generator check passes while proving nothing: grading a copy of itself, passing on emptiness, a canary firing fo
- **rule-local-first** (plugins/autodev-core/skills/rule-local-first/SKILL.md) — desc: "Verification happens on this machine, in a browser you drive, before anything is pushed. Covers the local gate, the batched publish cadence
- **rule-options-protocol** (plugins/autodev-core/skills/rule-options-protocol/SKILL.md) — desc: "How to end a turn: a clickable AskUserQuestion panel of vetted, complementary options with a recommendation in every block."
- **rule-ramifications** (plugins/autodev-core/skills/rule-ramifications/SKILL.md) — desc: "The eight ways a change passes typecheck, build, and a clean console and is still wrong. Derived from 3,127 fix commits across three produc
- **rule-verification** (plugins/autodev-core/skills/rule-verification/SKILL.md) — desc: "What counts as done for each kind of change: the required verification per task type, and the six cross-cutting checks that apply to every 
- **rule-windows** (plugins/autodev-core/skills/rule-windows/SKILL.md) — desc: "Windows-specific development rules: cmd /c wrappers for MCP, dev servers in an external terminal, path conventions, and the Supabase CLI fi

## Hooks (hooks.json, both plugins)

Population scanned: 2 `hooks.json` files (autodev-core, autodev-memory), 14 wired
hook command entries total.

**autodev-core** (`plugins/autodev-core/hooks/hooks.json`) — 10 commands:
- SessionStart: `session-start.js`, `agent-browser-cleanup.js`
- UserPromptSubmit: `user-prompt-image-scan.js`, `inbox-notify.js`
- PreToolUse (matcher `Read|Write|Edit`): `pre-tool-filter.js`
- PostToolUse (matcher `Write|Edit`): `post-tool-typecheck.js`
- PostToolUse (matcher `.*`): `telemetry.js`
- Stop: `stop-auto-check.js`
- PreCompact: `pre-compact.js`
- PostCompact: `post-compact.js`

**autodev-memory** (`plugins/autodev-memory/hooks/hooks.json`) — 4 commands:
- SessionStart: `memory-session-start.js`
- UserPromptSubmit: `memory-prompt-capture.js`
- PostToolUse: `memory-capture.js`
- SessionEnd: `memory-session-end.js`

Ran `npm run check:hooks` (`tooling/find-untested-hooks.js`) against this tree:

```
14 wired hook(s) · 14 driven by a suite · 0 with NO suite
Every wired hook is the subject of at least one suite.
```

All 14 wired hooks have execution coverage. No unreachable-hook defect found —
this axis is clean.

## Workflow scripts (`*.workflow.js`)

Population scanned: 1 file — `plugins/autodev-core/scripts/heal-sweep.workflow.js`
(the only `*.workflow.js` in the repo).

It has 3 `agent()` calls (stages: find, verify, fix). All 3 currently pin
`model: 'opus'` explicitly (`git log` shows this was fixed in commit `1f1d7cd`,
"fix(workflow): pin models in heal-sweep, and make the concurrency rule
reachable" — the same commit that added the `paths:` glob to
`rule-agent-concurrency`). **This defect class is already resolved for the one
workflow file that exists.** No other `*.workflow.js` files were found to check.

## Cross-check against this session's own skill listing

This session's system-reminder skill listing shows the elision behaviour live:
of the 9 unreachable `rule-*` skills below, only `rule-diagnosis` currently
carries a full description in the listing (it has been invoked recently per
the control pattern already identified); the other 8 — `rule-ab-testing`,
`rule-file-organization`, `rule-gate-integrity`, `rule-local-first`,
`rule-options-protocol`, `rule-ramifications`, `rule-verification`,
`rule-windows` — appear as bare `autodev-core:<name>` with zero description,
exactly matching the reported defect. `rule-thumb-first` and
`rule-agent-concurrency` also show full descriptions, but both of those carry a
`paths:` glob (reachable by mechanism (b)) so their bare-name risk is already
mitigated independent of listing elision.

## Summary counts

- **58** SKILL.md files scanned across autodev-core (50), autodev-memory (4),
  autodev-stack (4).
- **9** skills in the UNREACHABLE shape (`user-invocable: false` AND no `paths:`
  glob), all in autodev-core, all `rule-*`:
  rule-ab-testing, rule-diagnosis, rule-file-organization, rule-gate-integrity,
  rule-local-first, rule-options-protocol, rule-ramifications,
  rule-verification, rule-windows.
- **14** wired hooks, **14/14** covered by a test suite — clean.
- **1** `*.workflow.js` file, **3/3** `agent()` calls pin a model — clean
  (already fixed).
