# Three add-ons against autodev: measured evidence

`[measured 2026-09-13]` on one Windows 11 Pro machine (10.0.26200), Node
v24.15.0, Git Bash, Claude Code 2.1.261, against this repo at `b9d0d56`
(8.168.0). Candidates, cloned and read at these commits:

| candidate | commit | version | stars (gh api, same day) | license |
|---|---|---|---|---|
| Graphify-Labs/graphify | `fe66389` (branch `v8`) | 0.9.61 | 116,229 | Apache-2.0 |
| DietrichGebert/ponytail | `356918e` | 4.9.0 | 136,556 | MIT |
| mattpocock/skills | `3cca18b` | 1.2.3 | 260,432 | MIT |

Nothing was installed into the user config, the plugin config or
`~/.claude.json`. graphify went into a scratch `uv` venv; ponytail's hooks ran
from its clone with HOME, `CLAUDE_CONFIG_DIR` and `APPDATA` pointed at a
sandbox; skills were copied into scratch directory layouts. The precedent for
the method is `evidence-ecc-hook-latency.md` and
`evidence-ecc-comparison-2026-09-07.md`.

## Verdicts

| candidate | verdict | what decided it |
|---|---|---|
| graphify | **reject** | A Python process on every Bash, Grep, Read and Glob call: 223 to 256 ms per call against our 65 to 72 ms, which composes to +31 to +34 s of blocking and +44 to +47 s of hook time per session at this repo's tool mix (two passes). Once a graph exists it injects a 190 B "MANDATORY" nudge on 37% of Bash calls, about 14 KB per session. `--strict` denies the first Read of an indexed file, which is the call Edit requires. |
| ponytail | **reject** | Hooks are cheap and never run per tool call (+0.8 to +0.9 s blocking per session). It costs 5,252 B of context at every session start, resume, clear, compact and subagent spawn, and 2,581 B of skill listing. In the A/B it cut the diff from 36 to 15 lines by dropping, in 3 of 3 runs, the empty-directory floor that the baseline kept in 3 of 3 and that `rule-gate-integrity` section 2 requires. A one-line YAGNI prompt cut further and dropped more. |
| mattpocock/skills | **port one idea** | Already reviewed on 2026-08-19 (8.87.0 and 8.88.0 adapted `wizard`, `grilling` and `writing-for-agents`). Since that review: 12 files under `skills/` changed, +104/-7 lines, and every promoted skill name already existed at the reviewed commit. Installing it adds 3,813 B of listing and ships three skill names identical to ours plus `code-review`, the built-in's name. The one idea with no equivalent here and an incident behind it is `resolving-merge-conflicts`, extended with a shape assertion. |

## Method

- **Hook cost.** One harness (`addon-hook-ab.js`, reproduced at the end)
  loads the REAL command strings: our two `hooks.json` files in their
  `command` + `args` form, ponytail's `hooks/claude-codex-hooks.json`, and
  graphify's hooks as its installer generates them, by calling
  `graphify.install._claude_pretooluse_hooks(strict=False|True)` in the venv.
  Payloads are shaped like Claude Code's. String commands run through Git
  Bash, which is how Claude Code on Windows runs them; ours run as argv, as
  shipped. One discarded cold run, then N=10 per hook, medians, two full
  passes a few minutes apart on a machine with no agents running.
- **Child environment is a whitelist**, not `process.env`: PATH and system
  variables plus sandboxed HOME, USERPROFILE, APPDATA, LOCALAPPDATA,
  `CLAUDE_CONFIG_DIR` and `CLAUDE_PLUGIN_DATA`. The session running the
  harness carries messaging-socket and plugin-data variables that a benchmark
  hook must not reach.
- **Per-session composition.** Blocking per event is the slowest hook, since
  matching hooks run in parallel; summed hook time adds them. Event counts are
  means over a transcript census (below). Only events an add-on hooks are
  composed: PostToolUse and Stop are unchanged by all three.
- **Transcript census.** The 40 newest main-thread transcripts over 20 KB
  across this repo's 14 project directories (60 transcripts in total), 0 parse
  failures, including the session that wrote this document. Means per session:
  19.5 prompts, 188.8 Bash, 2.1 Read, 0.42 Grep, 0.03 Glob, 14.2 Edit, 12.3
  Write, 0.42 Agent. Of 7,554 Bash commands, 2,812 (37.2%) invoke a search
  tool by graphify's own `_bash_invokes_search`, controls `grep -rn foo .` true,
  `git status` false, `git commit -m "add flag support"` false. Only counts
  were printed; commands went through a pipe, never to disk.
- **Context cost.** `tooling/check-skill-triggers.js` and
  `tooling/check-skill-collisions.js`, unmodified, copied into scratch layouts
  so their `plugins/` root holds ours plus one candidate. Hook-injected bytes
  are the `additionalContext` each hook actually printed in the harness.
- **Tokens** are bytes / 4, the estimator `check-skill-triggers.js` prints.

## 1. Hook cost

### Per event, median ms (pass 1 / pass 2)

| event | autodev (core + memory) | ponytail | graphify, no graph | graphify, graph built |
|---|---|---|---|---|
| SessionStart | session-start 295/293, agent-browser-cleanup **1,516/1,514**, memory 77/76 | activate 118/121 | - | - |
| UserPromptSubmit | image-scan 74/68, inbox-notify 77/77, memory 70/67 | mode-tracker 117/116 | - | - |
| SubagentStart | - | subagent 114/117 | - | - |
| PreToolUse Read | pre-tool-filter 69/67 | - | 237/230 | 256/223 |
| PreToolUse Grep | - | - | 234/227 | 246/226 |
| PreToolUse Glob | - | - | 230/228 | 246/246 |
| PreToolUse Bash, search command | coordinator-write-guard 68/65 | - | 235/226 | 256/227 |
| PreToolUse Bash, other command | coordinator-write-guard 69/66 | - | 239/228 | 242/229 |
| PreToolUse Edit/Write | pre-tool-filter 72/69 | - | - | - |

Every hook exited 0 on every run in both passes. `--strict` on the nudge path
measured 216 to 242 ms. The deny path, timed separately with a fresh session
id per sample and `GRAPHIFY_HOOK_STRICT_TTL=0`: median 239 ms (235 to 242),
10 of 10 samples denied; control, the same session id twice, gave a deny and
then the 402 B nudge.

With no graph to consult, graphify's hooks still cost 226 to 239 ms and print
nothing, so the cost is paid on every matching call once the hooks are
installed, whether or not the repo was ever indexed. `[inferred]` most of it is
interpreter start-up; no profiler was run.

### Composed per session

| arm | blocking s/session (p1 / p2) | summed hook time s/session (p1 / p2) | hook-injected context per session |
|---|---|---|---|
| autodev | 18.0 / 17.4 | 21.2 / 20.4 | 0 B |
| autodev + ponytail | 18.9 / 18.2 | 23.7 / 22.8 | 7,484 B |
| autodev + graphify, no graph | 50.4 / 48.3 | 66.7 / 63.9 | 0 B |
| autodev + graphify, graph built | 52.2 / 48.5 | 68.5 / 64.0 | 14,288 B |
| autodev + graphify `--strict` | 50.1 / 49.3 | 66.4 / 64.9 | 14,288 B plus one 423 B deny |

Blocking assumes every Bash call is its own round trip; parallel tool batches
in a real session would lower both columns for every arm alike. This repo's
sessions are Bash-heavy (189 Bash calls against 2 Reads per session), which is
the worst case for graphify's `Bash|Grep` matcher and the best case for
ponytail, which hooks no tool call at all.

**A finding about our own hook, out of scope here:** `agent-browser-cleanup.js`
costs 1.5 s per SessionStart on Windows (82 ms on macOS in the 2026-09-07
record), and its Windows branch still kills by image name machine-wide:
`wmic`/`Stop-Process` on `agent-browser.*eval`, `taskkill /F /T` on the
agent-browser binary, `taskkill /F` on `crashpad_handler.exe`,
`SnippingTool.exe` and `ScreenClippingHost.exe`. PR #217 narrowed only the
POSIX branch. The harness ran it 22 times with those machine-wide effects,
which is also what every real session start on this machine does. Filed as a
separate task.

## 2. Context cost

### Skill listing

| set | skills | bytes of description + when_to_use | tokens | delta |
|---|---|---|---|---|
| autodev at `b9d0d56`, three plugins | 68 | 20,365 | ~5,091 | - |
| + graphify | 69 | 20,718 | ~5,180 | +353 |
| + ponytail | 74 | 22,946 | ~5,737 | +2,581 |
| + mattpocock/skills, all 25 in its `plugin.json` | 93 | 24,178 | ~6,045 | +3,813 |
| mattpocock/skills, the 11 without `disable-model-invocation` | 11 | 2,194 | ~549 | |

The listing already overflows. Read from the 2.1.261 binary: the budget is
context-window tokens (200,000 when unknown) x 4 x `skillListingBudgetFraction`
(default 0.01), so 8,000 characters on a 200k window and 40,000 on a 1M window,
overridable with `SLASH_COMMAND_TOOL_CHAR_BUDGET`; each description is capped at
`skillListingMaxDescChars` (1,536), and past the budget entries are announced by
name only. Our own 20,365 B is 2.5x the 200k-window budget before any other
plugin. `[observed]` in the session that wrote this document, most autodev-core
skills (`audit`, `brainstorm`, `commit`, `rule-diagnosis` among them) were
listed by name only. Which entries keep a description was not read further.
Every added skill competes for those slots with ours.

Pairwise collisions by `check-skill-collisions.js` (shared corpus-rare words):
4 pairs at baseline, all triaged; +ponytail 8 (4 new: three inside ponytail,
one `framework-radar` / `ponytail`); +mattpocock 5 (1 new, both skills its
own); +graphify 4 (0 new). The checker compares words, not names, so it cannot
see that mattpocock-skills ships `wizard`, `grilling` and `writing-for-agents`,
the names of three autodev-core skills adapted from it, and `code-review`, the
name of a built-in skill.

### Everything else each add-on puts in context

| candidate | when | bytes |
|---|---|---|
| ponytail | SessionStart on `startup\|resume\|clear\|compact`, and every SubagentStart | 5,252 B each (the full SKILL.md body filtered to the active level) |
| ponytail | first session ever | 6,033 B: the above plus a statusline nudge telling the model to offer to edit `settings.json` |
| ponytail | UserPromptSubmit | 0 B unless the prompt is a `/ponytail` command |
| graphify | global install | appends 229 B to `~/.claude/CLAUDE.md`, loaded every session in every repo; copies a 41,276 B SKILL.md (43,789 B Windows variant) whose body loads on invocation |
| graphify | per Bash search or Grep, while `graphify-out/graph.json` exists in cwd | 190 B |
| graphify | per Read or Glob of a source extension, same condition | 402 B (239 B when the file is newer than the graph) |
| graphify | `--strict`, first indexed Read per session, no query in the last 30 min | 423 B deny, and the Read must be retried |
| graphify | each `graphify query` the nudge demands | one run: 0.9 s, 6,543 B, truncated at its 2,000-token default |
| mattpocock/skills | none beyond the listing | 0 B |

Composed with the census, ponytail adds 7,484 B per session (one start plus 0.42
subagents) and graphify 14,288 B per session once a graph exists, before any of
the `graphify query` calls its nudges ask for.

## 3. Overlap

### graphify

| capability | what we already have | gap? |
|---|---|---|
| AST graph of a repo: 13.3 s, 614 files, 8,134 nodes, 10,571 edges, 11 MB, no API key, on a clone of this repo | nothing structural | yes, but see below |
| `graphify query/path/explain` for orientation | the built-in `Explore` agent, this machine's `scout` agent, and the main thread's own Grep | partial |
| `affected` reverse traversal | `rule-ramifications`, and "a bug is a family: grep the value, the inverse, the neighbour" | partial |
| memory of past decisions | `memory-kb`, `mem-search`, `knowledge-agent` | not what graphify does |
| hooks that redirect reads to the graph | none, deliberately: our rules say read the file before editing it | conflicts |

One observation on answer quality, n=1: the question "which script prices skill
descriptions" returned 61 of 82 nodes and none of them was
`check-skill-triggers.js`, although the graph holds that file (41 mentions in
`graph.json`) and a query naming the file surfaced it. A Grep for "standing
context cost" finds it in one call. The CLI works without the skill or the
hooks (`uvx --from graphifyy graphify update .`), so a structural question in a
large unfamiliar repo can use it ad hoc with nothing installed.

### ponytail

| ponytail rule | ours |
|---|---|
| YAGNI, stdlib and installed deps first, no unrequested abstractions | agent-quality rule 13 (YAGNI, defer is a feature) and 7b (surgical by default) |
| bug fix = root cause, grep every caller | rule 10d and 10d-i (a bug is a family; fix the event) |
| non-trivial logic leaves ONE runnable check | rule 10e and the verification matrix, which ask for more |
| code first, at most three lines of prose | writing-style rules and the concise output style |
| `ponytail:` comments naming a deliberate ceiling, harvested by `/ponytail-debt` | no equivalent; no measured incident motivates one |
| `/ponytail-review`, `/ponytail-audit` for over-engineering | `review`, `brainstorm` (dead code, unused deps, splitting) |

It also contradicts the quality bar, which treats "mid" as a failure state and
asks for a new standard on anything larger than a one-liner.

### mattpocock/skills: only the skills with no equivalent here

| skill | size | what it does |
|---|---|---|
| `resolving-merge-conflicts` | 918 B | find the primary source of each hunk's intent, resolve without inventing behaviour, run the project's checks, finish the merge |
| `prototype` | 2,931 B | throwaway prototype: a single-file state-machine demo, or switchable UI variants on one route |
| `domain-modeling` | 3,331 B | maintain a `CONTEXT.md` glossary and ADRs while designing |
| `to-questionnaire` | 2,904 B | turn an unanswerable decision into a questionnaire for someone else |
| `teach` | 9,506 B | teach a concept inside the workspace with mission, glossary and learning-record files |
| `triage` | 6,557 B | move GitHub issues and external PRs through a triage state machine |

The other 19 map to something here: `grilling`, `grill-me`, `grill-with-docs`
to `grilling`; `wizard`, `writing-for-agents` to their adaptations; `code-review`
to the built-in and `review`; `diagnosing-bugs` to `rule-diagnosis`; `research`
to the `researcher` agent; `to-spec`, `to-tickets`, `implement` to `spec`,
`sprint`, `auto`; `wait-what` to the operator's `eli`/`scr` aliases; `tdd` partly to
`adversarial-loop`; `codebase-design`, `improve-codebase-architecture` partly to
`architect` and `refactor`; `wayfinder` partly to `brain`; `handoff` partly to
RESUME.md; `ask-matt` and `setup-matt-pocock-skills` are about the pack itself.

**The idea to port.** `resolving-merge-conflicts` names the step our record
shows being skipped: `[reported 2026-08-26]` a resolution that kept both sides took a 3,877-line
document to 7,805 lines, duplicating seven sections, and every gate passed
because absence of conflict markers is the only thing checked. The portable
plugin has probes for detecting a conflict (`rule-gate-integrity` section 8) and
nothing for resolving one. A port would be its five steps plus one: after a
keep-both resolution, assert the shape (section count, id uniqueness, file
length against both parents) before committing.

## 4. Ponytail A/B

### Design

- **Task, real and small:** make `tooling/check-skill-triggers.js` accept an
  optional directory, `[dir] [--all]`, unchanged with no argument. This
  evaluation needed exactly that and worked around it by copying the script.
- **Arms**, one ticket text, identical except for a prefix:
  A, the ticket alone; B, prefixed with ponytail's exact SubagentStart output
  (the 5,252 B the hook printed, labelled as hook context); C, prefixed with the
  seven-word prompt from ponytail's own benchmark, "Follow YAGNI principles, and
  prefer one-liner solutions."
- **Runner:** general-purpose subagents pinned to Opus 5, each in its own
  scratch clone of this repo at `b9d0d56`, launched interleaved across arms with
  at most three running at once. Headless `claude -p` was the first choice and
  could not authenticate here: all three probes returned `api_error`, "OAuth
  session expired and could not be refreshed", with and without a scratch
  `CLAUDE_CONFIG_DIR`. `[inferred]` the desktop host refreshes the token for its
  own session and a child process cannot.
- **Scorer, frozen before any run** (`score.js`, at the end): acceptance A1 to
  A5 (no arg unchanged at 68 skills and 20,365 bytes; absolute and relative
  fixture paths give 2 skills and 50 bytes, counted by hand; `--all` alone
  still audits the repo; `<dir> --all` works), and two guards the ticket did not
  state: G1 a missing directory exits non-zero, G2 a directory with no SKILL.md
  exits non-zero. Diff size is `git diff --numstat` plus every line of new
  files. Controls: the unmodified clone fails A2, A3, A5, G1 and G2; a 3-line
  reference fix with the floor passes all eight checks (parse, A1 to A5, G1,
  G2).

### Results

| run | lines added / deleted | acceptance | G1 missing dir | G2 empty dir | tool calls | wall s |
|---|---|---|---|---|---|---|
| A1 | 36 / 3 | pass | yes | yes | 14 | 114.8 |
| A2 | 36 / 3 | pass | yes | yes | 9 | 84.6 |
| A3 | 37 / 3 | pass | yes | yes | 7 | 63.4 |
| B1 | 13 / 4 | pass | yes | no | 7 | 53.4 |
| B2 | 15 / 4 | pass | yes | no | 10 | 53.8 |
| B3 | 16 / 3 | pass | yes | no | 8 | 56.1 |
| C1 | 3 / 2 | pass | no | no | 5 | 45.8 |
| C2 | 3 / 2 | pass | yes | no | 4 | 30.8 |
| C3 | 5 / 2 | pass | yes | no | 5 | 43.9 |

Medians: A 36 lines, B 15 (-58%), C 3 (-92%). Guards kept: A 6 of 6, B 3 of 6,
C 2 of 6. No run wrote a test file; every run changed only the one script; no
run committed. The subagent token totals were 197,189 to 207,088 across all
arms; `[inferred]` they are dominated by the context every subagent on this
machine starts with, not by the task.

The ordering matches ponytail's own claim: fewer lines than baseline, more
guards kept than the one-line prompt. What it does not match is the claim that
nothing safe is lost. The 21 lines between the medians were the empty-directory
floor, a second-directory refusal, a line naming what was scanned, and the
comments explaining them. A1's comment gives the reason: a zero from a mistyped
path "reads exactly like a plugin that costs nothing". `[inferred]` the baseline
agents took the floor from the rules every session here carries
(`rule-gate-integrity` section 2 states it); on this machine the baseline's
extra code was those rules working.

### What n=3 per arm can and cannot support

- **Can:** a direction on this one task. The arms do not overlap (A 36 to 37, B
  13 to 16, C 3 to 5), and for complete separation of two groups of three the
  exact one-sided permutation p is 1/20 = 0.05, the smallest value n=3 can
  produce. The G2 split, 3 of 3 against 0 of 3, has the same exact p.
- **Cannot:** an effect size with any precision, a claim about other tasks
  (ponytail's 54% is a mean over 12 tasks at n=4 on Haiku 4.5, and its own table
  runs from -94% to 0%), a claim about other models, or a claim about the plugin
  as installed: arm B delivered the hook's text in the prompt, not through the
  hook, and without the skill listing or per-subagent injection.
- **Cannot either:** ponytail's own safety claim is thinner than its headline.
  "A bare prompt drops a guard" rests on 19 of 20 safe runs against 20 of 20,
  one run.

## Side effects of the measurement

- `agent-browser-cleanup.js` ran 22 times in the harness with the machine-wide
  kills listed in section 1.
- Subagents stayed inside their clones for edits, and wrote scratch baselines
  outside them: A1, B1 and C1 saved before-output next to the clones, and A2 wrote
  two files under the user's local application-data directory, then deleted
  them and checked. This worktree's `git status` was empty after all nine runs.
- Windows Defender, real-time protection on: 0 detections and 0 threats after
  installing graphify's 132 MB venv (30 tree-sitter grammars) and running every
  hook in both passes.

## What this does not measure

- What the add-ons are worth in a session that uses them for real: whether
  graphify's graph saves more reading than its nudges and queries cost, or
  whether ponytail prevents over-building on tasks where our rules do not.
- Real-session tool batching, PostToolUse and Stop costs, and macOS or Linux,
  where Python and process start-up are cheaper and graphify's ratio would be
  smaller.
- Network traffic from graphify's build; no API key was set and no LLM step
  printed, but nothing was monitored.
- Why one early strict-mode probe, on a graph whose query stamp was not yet
  fresh, returned the nudge instead of the deny. It was not reproduced: a clean
  clone denied on the first read and nudged on the second.

## Appendix: the scorer

```js
// Usage: node score.js <clone-dir> [label]; fixtures/two holds two SKILL.md, fixtures/empty none.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const clone = path.resolve(process.argv[2]);
const label = process.argv[3] || path.basename(clone);
const FIX = path.join(__dirname, 'fixtures');
const script = path.join(clone, 'tooling', 'check-skill-triggers.js');
function run(args) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd: clone, encoding: 'utf8', timeout: 30000 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const relTwo = path.relative(clone, path.join(FIX, 'two'));
const checks = {};
checks.parse = spawnSync(process.execPath, ['--check', script]).status === 0;
let r;
r = run([]); checks.A1 = r.code === 0 && /68 skills/.test(r.out) && /20365 bytes/.test(r.out);
r = run([path.join(FIX, 'two')]); checks.A2 = r.code === 0 && /\b2 skills/.test(r.out) && /\b50 bytes/.test(r.out);
r = run([relTwo]); checks.A3 = r.code === 0 && /\b2 skills/.test(r.out) && /\b50 bytes/.test(r.out);
r = run(['--all']); checks.A4 = r.code === 0 && /68 skills/.test(r.out) && /all descriptions:/.test(r.out);
r = run([path.join(FIX, 'two'), '--all']); checks.A5 = r.code === 0 && /\b2 skills/.test(r.out) && /all descriptions:/.test(r.out);
r = run([path.join(FIX, 'does-not-exist')]); checks.G1 = r.code !== 0 && r.code !== null;
r = run([path.join(FIX, 'empty')]); checks.G2 = r.code !== 0 && r.code !== null;
const git = (a) => execFileSync('git', ['-C', clone, ...a], { encoding: 'utf8' });
let add = 0, del = 0;
for (const line of git(['diff', '--numstat']).split('\n').filter(Boolean)) { const [a, d] = line.split('\t'); add += +a; del += +d; }
for (const line of git(['status', '--porcelain', '--untracked-files=all']).split('\n').filter((l) => l.startsWith('??'))) {
  add += fs.readFileSync(path.join(clone, line.slice(3)), 'utf8').split('\n').filter((x, i, arr) => !(i === arr.length - 1 && x === '')).length;
}
const acceptance = ['parse', 'A1', 'A2', 'A3', 'A4', 'A5'].every((k) => checks[k]);
console.log(JSON.stringify({ label, acceptance, guards: `${+checks.G1 + +checks.G2}/2`, checks, added: add, deleted: del }));
```

## Appendix: the hook harness

Set `AUTODEV_REPO` to a checkout of this repo, create `gvenv` with
`uv venv gvenv && uv pip install --python gvenv/Scripts/python.exe graphifyy`,
clone ponytail to `addons/ponytail`, and make `ab/nograph` and `ab/graphproj`
clones of this repo, running `gvenv/Scripts/graphify.exe update .` in the
second. Then `node addon-hook-ab.js 10`. Read the `st` column before any total.
This copy is trimmed of the reporting columns (min, max, stdout and stderr
bytes) the measured run also printed; the timing and payload code is unchanged.

```js
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const S = __dirname;
const REPO = process.env.AUTODEV_REPO;
const N = parseInt(process.argv[2] || '10', 10);
const PY = path.join(S, 'gvenv', 'Scripts', 'python.exe');
const PROJ = { nograph: path.join(S, 'ab', 'nograph'), graph: path.join(S, 'ab', 'graphproj') };
const BASH = process.env.CLAUDE_CODE_GIT_BASH_PATH || 'bash';
const SANDBOX = path.join(S, `hook-sandbox-${Date.now()}`);
const HOME = path.join(SANDBOX, 'home');
for (const d of [path.join(HOME, '.claude', 'projects', 'x'), path.join(SANDBOX, 'appdata'), path.join(SANDBOX, 'localappdata'), path.join(SANDBOX, 'plugin-data')]) fs.mkdirSync(d, { recursive: true });
const TRANSCRIPT = path.join(HOME, '.claude', 'projects', 'x', 'session.jsonl');
fs.writeFileSync(TRANSCRIPT, JSON.stringify({ type: 'user', message: { role: 'user', content: 'fix the thing' } }) + '\n');

const fwd = (p) => p.replace(/\\/g, '/');
const PASS = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'ProgramFiles', 'ProgramData', 'CommonProgramFiles', 'SystemDrive'];
function envFor(root, proj) {
  const e = {};
  for (const k of PASS) if (process.env[k] !== undefined) e[k] = process.env[k];
  return Object.assign(e, {
    HOME, USERPROFILE: HOME, APPDATA: path.join(SANDBOX, 'appdata'), LOCALAPPDATA: path.join(SANDBOX, 'localappdata'),
    CLAUDE_CONFIG_DIR: path.join(HOME, '.claude'), CLAUDE_PLUGIN_DATA: path.join(SANDBOX, 'plugin-data'),
    CLAUDE_PLUGIN_ROOT: root, CLAUDE_PROJECT_DIR: proj,
  });
}

function fromHooksJson(file, root, label) {
  const out = [];
  for (const [ev, groups] of Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')).hooks)) {
    for (const g of groups) for (const hk of g.hooks) {
      if (hk.type !== 'command') continue;
      const sub = (c) => c.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, fwd(root));
      const argv = Array.isArray(hk.args) ? [hk.command, ...hk.args.map(sub)] : null;
      const id = argv ? path.basename(argv[argv.length - 1]) : (sub(hk.command).match(/([\w.-]+\.js)/) || [, hk.command])[1];
      out.push({ set: label, ev, matcher: g.matcher, id, argv, command: argv ? null : sub(hk.command), async: !!hk.async, root });
    }
  }
  return out;
}
const AUTODEV = [
  ...fromHooksJson(path.join(REPO, 'plugins/autodev-core/hooks/hooks.json'), path.join(REPO, 'plugins/autodev-core'), 'autodev'),
  ...fromHooksJson(path.join(REPO, 'plugins/autodev-memory/hooks/hooks.json'), path.join(REPO, 'plugins/autodev-memory'), 'autodev'),
];
const PONYTAIL = fromHooksJson(path.join(S, 'addons/ponytail/hooks/claude-codex-hooks.json'), path.join(S, 'addons/ponytail'), 'ponytail');
const gen = JSON.parse(execFileSync(PY, ['-c', 'import json; from graphify.install import _claude_pretooluse_hooks as f; print(json.dumps({"n": f(strict=False), "s": f(strict=True)}))'], { encoding: 'utf8' }));
const graphifySet = (groups, label) => groups.flatMap((g) => g.hooks.map((hk) => ({ set: label, ev: 'PreToolUse', matcher: g.matcher, id: hk.command.split(' ').slice(1).join(' '), argv: null, command: hk.command, async: false, root: S })));
const GRAPHIFY = graphifySet(gen.n, 'graphify');
const GRAPHIFY_STRICT = graphifySet(gen.s, 'graphify-strict');

function payloads(proj) {
  const base = { session_id: 'ab-session', transcript_path: TRANSCRIPT, cwd: proj };
  const src = fwd(path.join(proj, 'tooling', 'check-skill-triggers.js'));
  return {
    'SessionStart': { match: 'startup', p: { ...base, hook_event_name: 'SessionStart', source: 'startup' } },
    'UserPromptSubmit': { match: '', p: { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'fix the failing check in tooling' } },
    'SubagentStart': { match: 'general-purpose', p: { ...base, hook_event_name: 'SubagentStart', agent_type: 'general-purpose', agent_id: 'a1' } },
    'PreToolUse/Read': { match: 'Read', p: { ...base, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: src } } },
    'PreToolUse/Grep': { match: 'Grep', p: { ...base, hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'ROOT', path: fwd(path.join(proj, 'tooling')) } } },
    'PreToolUse/Glob': { match: 'Glob', p: { ...base, hook_event_name: 'PreToolUse', tool_name: 'Glob', tool_input: { pattern: '**/*.js' } } },
    'PreToolUse/Bash:search': { match: 'Bash', p: { ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'grep -rn "ROOT" tooling | head' } } },
    'PreToolUse/Bash:other': { match: 'Bash', p: { ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git status --short' } } },
    'PreToolUse/Edit': { match: 'Edit', p: { ...base, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: src, old_string: 'a', new_string: 'b' } } },
  };
}
function matches(matcher, subject) {
  if (matcher === undefined || matcher === null || matcher === '' || matcher === '*' || matcher === '.*') return true;
  try { return new RegExp('^(' + matcher + ')$').test(subject); } catch { return false; }
}
function runOne(h, payload, proj) {
  const opts = { input: JSON.stringify(payload), encoding: 'utf8', env: envFor(h.root, proj), cwd: proj, timeout: 60000, windowsHide: true };
  const t0 = process.hrtime.bigint();
  const r = h.argv ? spawnSync(h.argv[0], h.argv.slice(1), opts) : spawnSync(BASH, ['-c', h.command], opts);
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, status: r.status, out: r.stdout || '', err: r.stderr || '' };
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
function classify(out) {
  if (!out) return 'silent';
  if (/"permissionDecision"\s*:\s*"deny"/.test(out)) return 'DENY';
  let ctx = '';
  try { const j = JSON.parse(out); ctx = (j.hookSpecificOutput && j.hookSpecificOutput.additionalContext) || ''; } catch { ctx = out; }
  return `context ${Buffer.byteLength(ctx)}B`;
}
const results = [];
function bench(set, projName) {
  const proj = PROJ[projName];
  for (const [event, { match, p }] of Object.entries(payloads(proj))) {
    for (const h of set.filter((x) => x.ev === event.split('/')[0] && matches(x.matcher, match))) {
      const cold = runOne(h, { ...p, session_id: 'cold-' + Date.now() }, proj);
      const samples = []; const statuses = new Set(); let last;
      for (let i = 0; i < N; i++) { last = runOne(h, p, proj); samples.push(last.ms); statuses.add(last.status); }
      results.push({ set: h.set, proj: projName, event, id: h.id, cold_ms: Math.round(cold.ms), median_ms: Math.round(median(samples)), status: [...statuses].join('/'), output: classify(last.out) });
    }
  }
}
for (const [set, proj] of [[AUTODEV, 'nograph'], [PONYTAIL, 'nograph'], [GRAPHIFY, 'nograph'], [GRAPHIFY, 'graph'], [GRAPHIFY_STRICT, 'graph']]) bench(set, proj);
for (const r of results) console.log(`${r.set.padEnd(16)} ${r.proj.padEnd(8)} ${r.event.padEnd(23)} ${String(r.id).slice(0, 38).padEnd(38)} cold ${r.cold_ms} med ${r.median_ms} st ${r.status} ${r.output}`);
fs.writeFileSync(path.join(S, `hook-ab-results-${Date.now()}.json`), JSON.stringify({ N, results }, null, 1));
```

The harness runs every SessionStart hook this repo ships, including
`agent-browser-cleanup.js`, whose Windows branch is not sandboxed by HOME.
