# Decisions

Non-obvious choices, and where the work that implements them actually landed.
One entry per decision, newest first.

## 2026-09-08: the deploy ledger becomes the check that enforces Form B

Closes the "still open" of the Form B decision below — the ledger row format and
the check over it — and deliberately does not restate that decision, whose entry
owns the sentence, the provenance and why B beat A and C. One owner per claim:
that entry is the policy, this one is the mechanism.

`deploy-ledger.js --verify` is now the authorisation, and its exit code is the
whole of it. **0** promote, printing zero bytes on both streams, because it runs
as `--verify && <promote>` and text on a pass path gets skimmed rather than read.
**1** a precondition is unmet and is named: a surface unchecked, a metric missing,
a promotion field empty, or the commit not on the default branch (`merge-base
--is-ancestor` against `origin/HEAD`, then conventional names). **2** blind — no
ledger, no deploy ref, no resolvable default branch, or a project that has not
marked its deploy-sensitive paths, which gets the instruction to add a section
rather than a pass. **3** ineligible, which no field fixes. The seven-field
promotion record carries the commit, the gate with its exit and last lines, the
`prove` evidence pair, the rollback command and the standing rule by date;
`--record` files it per promotion and `--audit` lists what was filed.

Three choices worth keeping. Eligibility is checked before any field, because an
ineligible window is not fixed by filling a form. An unmarked project is refused
rather than passed, on the same reasoning as a missing deploy ref: an unasked
question and a clean answer must not print the same. And the gate's output is
recorded rather than queried from a forge — `[measured 2026-09-08]` a count of
non-success check-runs returned 1 on a commit whose green round was complete,
because two re-runs were still in progress, so any future CI reader must group by
job name and never read the run rollup.

**A measured decision was reversed on the operator's ineligible list, and that is
the useful part.** An earlier draft measured that all 12 `DROP POLICY` statements
in a product repo's 33 migrations are recreated in the same file, concluded a
policy drop is a recreate pattern rather than a risk, and pinned it as ELIGIBLE
in its own selftest. The list says an RLS change escalates regardless. The
measurement was right about the syntax and wrong about the question: "does this
file put the policy back" is not "is the policy it puts back the same policy",
and a recreate is where an RLS mistake hides. Under the six rules that corpus
scores 195 ineligible lines where the narrow rule scored 0 — grant 98, rls 37,
security-definer 35, live-rows 25 — so nearly every migration escalates, which is
the intended reading rather than a defect.

Implementation record, the corpus measurement and the refusals the suite was
watched making: `docs/evidence-deploy-implementation-2026-09-08.md`. The baseline
evidence is `docs/evidence-deploy-authorisation-2026-09-08.md`, which this cites
rather than duplicates.

## 2026-09-08: production signals become candidate stories, never direct writes on a live repo

The stage between "production knows" and "the backlog knows" did not exist:
`[measured 2026-09-08]` 22 of the 121 stories the live product filed in 90 days
cite a production observation, 0 from Sentry, 0 from a monitor alert, every one
typed by a person reading a table. `production-signals.js` plus the
`production-radar` skill are the collector and the reader for that stage. Full
evidence in `docs/evidence-production-signals-2026-09-08.md`.

**Candidates, not stories.** The collector writes
`.claude/reports/production-candidates-<date>.md` in prd.json story shape with
`passes: null` and the evidence query attached. `--apply` writes into prd.json
only when the origin `owner/repo` sha256 is on a one-entry allowlist inside the
script (the repo with no users); everything else is refused with the reason and
the proposal file is still written. Digests, not names, for the same reason the
private-name denylist is stored that way.

**The unit is the issue, never the event.** Sentry issue, `(function_name,
error_code)` group, heartbeat key, deployment. A ledger keyed `source:id` stops
re-proposal; a signal returns only after 30 quiet days (a regression) or a
tenfold count (an escalation).

**Thresholds were changed by reading the first real run, not by reasoning.**
13 candidates came out; reading them found a weekly job flagged dead at 86 h and
two bursts (60 rows in 9 minutes, 5 in 45) proposed as chronic defects. Two knobs
now exist for those: a per-key `intervals` map for heartbeats and `min_span_hours`
for error groups. The second run produced 7, of which 4 are real and 2 are
regressions of stories the live backlog had closed.

**No hook.** It reads live systems; it runs on demand. The suite asserts
`hooks.json` never names it.

**Sentry and Search Console are handbacks, not adapters nobody can run.** The
read token is in no store on this machine and no GSC credential exists in any
repo; both are numbered in the evidence doc with what done looks like.

**The suite caught a leak the design had missed.** A canary planted in a fixture
error message reached the applied prd.json: the rendered report and the ledger
were scrubbed, the candidate objects were not. Candidates are now scrubbed before
anything consumes them. This is the reason the no-secrets assertion covers every
byte written, not only the streams.

## 2026-09-08: deploy pre-authorisation is Form B, a green gate with a ledger

The question was the sixth item in the Brain capability analysis: a production
deploy was autonomous by tooling (`ship` deploys, `auto` pushes and deploys edge
functions) and escalated by policy (the Brain's never-list), and nobody had
written the reconciliation in one sentence. `[stated 2026-09-08]` the operator,
in a panel in the session that measured it: *"Yes, Form B is my decision"*.

**The sentence**, now in `plugins/autodev-core/skills/brain/SKILL.md` under
"Escalate rather than resolve" with its ineligible list, and as the four
pre-promotion conditions at the top of `ship/SKILL.md` Step 4: a session may
promote when the repo's named gate exits 0 on the exact commit, that commit is on
the default branch, the ledger records commit, gate output and verification, and
the rollback command is in the ledger before promotion; migrations touching
grants, RLS or `SECURITY DEFINER`, billing, webhooks, entitlement, auth and live
rows escalate regardless.

**Why B**, measured in `docs/evidence-deploy-authorisation-2026-09-08.md`
against the last 20 production deployments and every incident in 60 days across
the three product repos: on the live product a merge to main is the deploy, and
20 of 20 sampled builds were git-integration builds off a PR merge with 0 human
commands and 0 CLI; five deploy-caused incidents, four via a hand-run CLI path
with no record of tree, branch, lock or gate, one an under-deploy. A (escalate
always) would have made 13 of 13 sampled deploys wait a mean 7.4 h and reversed
his 2026-07-15 batching rule and his 2026-09-05 merge grant; C (canary plus
autonomous rollback) adds ~800 lines and the mechanism that caused the
2026-08-19 outage. B is what already happens plus the record the four incidents
lacked, ~300 lines for a ledger row and its check, neither built yet.

**Provenance, because it took three tries.** The session's own panel was held
and self-resolved to B by the away hook, logged as BLOCKED and not acted on. The
coordinator then relayed his B answer from another session, refused as a relay.
He then answered the session directly with the away state absent. Only the third
is authority, and `docs/DECISIONS-2026-09-08-deploy-authorisation.md` carries
all three.

**Still open:** the ledger row format and the check over it against the
platform's deployment list, which is what makes the rule enforceable rather than
prose. Another session reports building the ledger script on an unpushed branch
(`claude/bold-haibt-31b4d6`); it should cite the evidence doc and land against
this sentence, not a second one.

## 2026-09-08: AGENTS.md is generated from the rule-* skills, gated, and kept under a hand-written half

The 16 always-on `rule-*` skills (128,794 bytes) load into every Claude Code
session by path glob; a Codex session in the same repo read a 4,200-byte
hand-written `AGENTS.md` and never saw them, which mattered because Codex is the
adversarial auditor here. The reference harness we compared against in the entry
below scores 9 on portability with a hand-maintained `AGENTS.md` that was five
months stale, so "hand-maintain a copy" was the failure to design against.

Decision: `tooling/generate-agents-md.js` distils each rule into its description,
its `paths:` globs, its first paragraph, and every paragraph carrying a dated
claim; `npm run check:agents-md` regenerates to a temp path and fails the gate
when the committed file drifts. Everything above the GENERATED marker stays
hand-written and is copied through verbatim, so the Codex-only facts keep their
home. Measured over the real rules (`--measure`): full bodies 128,384 bytes,
this shape 21,233 keeping 25 of 25 dated claims, the brief's literal "dated
lines" shape 14,673 keeping 2 of 25 because no marker begins a line, descriptions
alone 7,044 keeping 0. The effect on Codex's answers is COULD NOT CHECK: the CLI
is not installed on this machine. Evidence and the exact question to ask once it
is: `docs/evidence-agents-md-2026-09-08.md`.

Two choices made while landing it. **The step is last in the chain**, not
first: it takes milliseconds and its only failure is a stale document, so last
it can never hide an expensive step behind it, and the brief's instruction to
put it in the chain is met without adding a place for a red to conceal the
steps that catch real defects. **The first gate run was three reds that were
not this change.** `validate` (`hooks module ./fn/autodev-fn.mjs failed the
host's scan`), `test-validate`, and `test-rendered-layout-gate` (`2 of 282`)
reproduced identically on an untouched HEAD worktree and serially, with CI on
main green; the `claude` CLI itself exits with a Bun ENOENT on this machine.
Both roots landed on main the same evening (#184 and #191), the branch was
rebased onto them, and `validate` went to 19 PASS 0 FAIL, so the push went
through the pre-push hook without `--no-verify`. Written down because the
alternative that night was to push around the hook and leave the reason
implicit.

## 2026-09-08: memory recall measured at zero; ranked injection built and not shipped

The question was whether the autodev-memory store is ever read back, and
whether injecting a ranked slice of it at session start (the ECC design, up
to 8 KB) would beat the current 91-byte line. Both were measured before any
change; the record is `docs/evidence-memory-recall-2026-09-08.md`.

**Recall.** Six evidence shapes were written down first, then searched for
across 281 transcripts (2026-08-15 to 2026-09-07), `history.jsonl` and
`bash-commands.log`. Skill invocations of `mem-search`: 0. The injected line
quoted by any assistant: 0. Genuine queries of the store: 1, made with the
CLI's `<project> <query>` arguments swapped, returning `[]` twice and read as
"nothing there". Every other hit was a session developing or measuring the
plugin itself.

**Content.** A stratified 40-row sample, read row by row: 0 rows hold a fact
a later session needs and could not get from git in a minute, 21 are
derivable, 19 are noise. Weighted by the store's type mix that is about 92 %
noise, because 90 % of the 6,072 rows are `Ran:`/`Tests`/`Read`/`Git:` echoes
of a command line. The `type` comes from a keyword in the user's prompt, so
scratch files are filed as bugfixes; the `concept` column IS the prompt, and
383 rows carry another session's message as theirs.

**Injection.** A ranked variant (recency × type weight × FTS match on branch
and last five subjects, stale-file rows excluded, byte-capped) was built and
run against the four real project paths at 2 KB and 8 KB. It injected 40 and
154 observation lines respectively; 0 were actionable, 28 and 118 were
misleading (wrong labels, repeats, scratch files, prompts describing a state
the row's own session changed, and at 8 KB a production hostname and
production secret-manager commands). Cost was about 300 ms over the current
hook, which does not matter given the content.

**Decision.** Keep the one-liner. No new hook. The store is left untouched;
the evidence record carries a pruning proposal by shape (about 5,900 of 6,072
rows) with the counts, for a person to act on after re-taking them. The ECC
"memory 6 v 6" row is level at zero on both sides, not at six.

Landed as this entry and the evidence document, no version bump.

**Follow-on, same day.** The closing panel was held by the operator's away
window, whose protocol takes the recommended reversible option and logs it.
That option was the evidence doc's proposals 1 to 6: capture records only
Write and Edit inside the project, typed by the tool, with the edit as the
concept and one row per (session, type, title); the prompt-capture hook and
its carrier are removed; the CLI refuses a swapped `<projectPath> <query>`.
Those change four hook files under `plugins/`, which is the review class in
the merge policy, so they are PR #190 with a reviewer, not this entry. Their
per-change counts are in that PR's `docs/DECISIONS-2026-09-08-memory-recall.md`.
The existing rows were left alone under the protocol; after the window ended
the operator confirmed the count on a panel and the prune ran, 6,972 of
7,480 rows removed with a verified backup first.

## 2026-09-08: the quota wall — detect it, name the resume, do not add a cap

The brief was to make workflow runs survive the session quota wall, on the
2026-08-25 measurement (42 of 280 agents lost, 20 of them to a `<synthetic>`
"session limit" row). Re-measuring first changed the shape of the work:
**12 of the 52 run directories still exist and no workflow has run on this
machine since 2026-08-25**, so the loss rate could not be re-sampled and the
work stands on the 12 that remain. Full numbers in
[`evidence-quota-wall-2026-09-08.md`](evidence-quota-wall-2026-09-08.md).

**The resume already exists and is correct; what is missing is anyone calling
it.** `Workflow({scriptPath, resumeFromRunId})` re-runs only the `agent()`
calls with no journal result. On the one real resume on this disk it
re-started exactly the four walled calls with identical key hashes. The
harness names that call in the failure notification — two seconds before the
main thread receives the same wall — and again in a later "stopped"
notification that went unread. `grep resumeFromRunId` over plugins, tooling
and docs found nothing. So this work builds on it rather than beside it:

- `scripts/workflow-run-triage.js` reads a run directory and prints per agent
  journaled / lost-quota-wall / lost-interrupted / lost-api-error /
  lost-other, the agent-seconds and tool calls each cost, and the exact resume
  call; COULD NOT CHECK on anything unreadable, never a zero. Over the real
  population: 100 agents, 94 journaled, 6 lost (5 wall, 1 interrupt), one
  resumable run keeping 6,497 journaled agent-seconds that nobody resumed.
- `hooks/stop-workflow-wall-note.js` (Stop) says once, at the end of the first
  turn that ends normally after the reset, that this session's latest run has
  walled agents, and puts the resume call in the model's context. Never a
  `decision` key: a Stop hook that blocks on a wall is a session that cannot
  end at the wall. 64 ms on an ordinary turn against a 54 ms process floor;
  a run already noted costs a stamp of mtimes, not a transcript read.
- The phase rule, with its price: serial costs **2.0×** the wall-clock of a
  3–4-wide phase and **4.1×** that of 8–12-wide, measured over the 12 runs;
  a wall costs width × elapsed-at-wall (the real one: 5 agents at 40–59 s).
  So a must-keep phase runs serial or in waves no wider than what you can
  afford to redo, states width and re-run cost in `meta.phases[].detail`, and
  a wide parallel phase is only for cheap-to-redo work. Prose in
  `rule-agent-concurrency` and `WORKFLOW-STRUCTURE.md` D6/D7; no hook and no
  cap, because a cap charges every workflow the 2–4× whether or not a wall is
  plausible.

Not done, and why: the built-in `workflow-authoring` skill is part of Claude
Code, not this repo, so the convention lives in the rule that auto-loads on
`**/*.workflow.js`. Auto-resume itself was not wired: the moment the wall is
detectable is the moment nothing can run, and the first turn after the reset
already has the note in context.

## 2026-09-08: one greenfield run through spec → setup-project → auto → ship, measured

The question was whether the Brain can take a one-line idea to
production-grade software by itself. Until this run no product on this machine
had entered through `spec` and `setup-project` (0 of 4, measured 2026-09-07), so
the answer rested on nothing. One session ran the four skills on *"a page where
a small team logs who is on call this week and gets a Slack-style message
preview when it changes; Supabase for the table, Vercel for the page"* with no
human in the loop. Full evidence in `docs/evidence-greenfield-run-2026-09-08.md`
and the log beside it; line numbers below are that log's.

**What the answer is now.** *It can take an idea to a deployed page in 23
minutes, and it cannot take that page to a working product without a person,
and the first place it needs one is story 1.* The idea named Supabase, so the
sign-in story needed a project that only a dashboard can create (L26–L36). The
harness did the right thing with that: one handback, no retry, no invented
value, `needs-setup` written into a product `prd.json` for the first time ever
(8 by the end, L78), and every line of code written anyway. But 6 of 7 stories
ended the run at realness 20, the migration was never executed, and the
primary flow was never driven in a browser (L70). "Production-grade" was not
reached and could not have been; the measurement is that the harness knows
when to stop and says so in a form a person can act on in six minutes.

**What it changes about the harness, in order of what the log showed.**

1. **The ship skill's "preview" command deploys to production on a new
   project** (L57). `npx vercel --yes` on a project's first deployment is
   assigned to production by Vercel, with a hint saying exactly that. The
   skill must read `target` from the deploy JSON and stop when it says
   `production` and the intent was preview; on a first deployment it should
   say beforehand that no preview is possible until a production deployment
   exists. This broke the run's hardest rule, on a throwaway, in 32 s.
2. **`spec` and `setup-project` cannot run in one directory in the documented
   order** (L11), and setup-project's step 4 cannot pass on its own output
   (L18, L19): `create-next-app .` refuses the files spec wrote; `tsc` fails on
   the untouched scaffold because Next 16 needs `next typegen` first; the
   Biome template uses `files.ignore`, removed in Biome 2. Three pin sources
   disagree on TypeScript and Biome (L13). Setup-project should scaffold into
   a scratch directory and merge, ship a `typecheck` script of
   `next typegen && tsc --noEmit`, and carry ONE pin table.
3. **Skills and hooks are bound to the session cwd** (L24, L50). `/auto` printed
   *"No prd.json"* against a `prd.json` that existed one directory over, and
   `stop-auto-check.js` never saw the `auto-active` flag. Every fleet session
   here drives a product from another cwd. Either the auto skill refuses when
   its argument names a directory other than cwd, or the flag file carries the
   project path and the hook follows it.

**What the browser found that the gates called green** (L42, L44): a
self-referential `--font-sans` from `shadcn init` that put every page in the
browser serif, a 32 px input against the 44 px rule the constraints file
states in prose, and a raw *"fetch failed"* shown to the user. Three fixes on
four features, 0.75 raw and 0.5 by the three-day definition (L79). All three
came from looking; none from typecheck, lint, build or the ten tests. The two
that are assertable, computed font family and control height, belong in the
a11y pass as code, which is the same conclusion `failure-evidence.md` reached
about prose rules on 2026-08-16.

**Not done.** No harness code changed in this entry; it is the measurement.
The three changes above are each one skill edit and one suite, and each has a
log line to test against.

## 2026-09-07: ECC re-measured on every axis, still not adopted, three ideas ported

A second, independent measurement of the 2026-09-05 question, from a macOS
machine and rating thirteen axes instead of latency alone. Full record in
`evidence-ecc-comparison-2026-09-07.md`. Same answer: ECC is ahead on breadth
(286 skills, 13 harness adapters) and community (252k stars, 100+
contributors), level on memory, and behind on everything that costs a
session something: 74 KB of skill index against 12 KB, 575 ms of hooks per
Edit against 247 ms, 0 of 23 hooks silent on the no-op path against 19 of
22, ten files written by one `ls` against two. Its content cites almost no
measurements, two of its skills reference seven files that do not exist,
and its own working-context file has been five months stale.

Three of its ideas were cheaper than what we had, and each shipped in the
shape the measurement chose rather than ECC's:

- **Typecheck once at Stop.** The old PostToolUse hook ran typecheck and
  lint after every edit and printed failures where the model never reads
  them. Now an accumulator plus a Stop hook that blocks once with the errors
  as the reason. Not ECC's stderr report, and not its reformatting of the
  user's files.
- **Lint-config protection as a branch in pre-tool-filter.js**, `ask` not
  `deny`: a second subprocess is 58 ms per Edit, and ECC's env-var escape
  cannot be set from the desktop app.
- **A hook profile through plugin userConfig**, one value (`minimal`), and
  a suite whose point is that the eleven guarding hooks do NOT honour it.

Not ported, and why: GateGuard (denies the first edit of every file blind,
then allows any retry), the continuous-learning observer (appends every tool
input to a jsonl at 340 ms per call), the inline `node -e` bootstrap in every
hook command (the thing the 2026-09-05 record found tripping Windows
Defender), Stop-time reformatting of a user's tree.

The two local-only gate reds found on the way, the hooks-module scan on a
host older than 2.1.259 and a 64 KiB pipe truncation in the layout gate that
only macOS can see, were fixed by this session as `5fa045b` (PR #182) and
that PR was closed in review: a version threshold would have turned a
genuinely failing module into a WARN on an old host. #184 (a control that
reads the host's output, not its version) and #191 are the fixes that
landed, and this branch dropped its own half and rebased onto them.

## 2026-09-05: ECC (affaan-m/ecc) measured and not adopted

The question was whether a 249k-star harness is better than this one, and if
so whether to port its logic here or fork it and put auto-brain on top. The
answer is no to all three, and every reason below is a number from this
machine rather than a reading of its README.

**What it is**, at commit `e04ea0b`: 3,520 tracked files, 2,520 of them
markdown. 286 skills, 94 command shims, 68 agents, adapters for 12 harnesses,
a Rust TUI alpha, a Python LLM layer, an installer with its own doctor and
repair. MIT. 370 authors all time and 276 commits in the last 31 days, with
one maintainer and one collaborator carrying most of the triage.

**Hook cost per tool call.** Both repos' real `hooks.json` command strings
were run against the same five payloads, N=8, medians, HOME sandboxed so
neither wrote into the live `~/.claude`. ECC through `bash -c`, which its
inline `node -e` bootstrap needs; ours through the shell-free `command` +
`args` form it ships in, and through `bash -c` as a control.

| event | ECC blocking | ECC cpu | autodev blocking | autodev cpu |
|---|---|---|---|---|
| PreToolUse/Read | 166 ms | 2,173 ms | 43 ms | 43 ms |
| PreToolUse/Bash | 183 ms | 2,297 ms | 42 ms | 42 ms |
| PreToolUse/Edit | 173 ms | 2,621 ms | 45 ms | 45 ms |
| PostToolUse/Edit | 91 ms | 2,141 ms | 48 ms | 138 ms |
| Stop | 263 ms | 1,101 ms | 47 ms | 90 ms |

Blocking is the slowest synchronous hook, since the harness runs a matcher
group in parallel. CPU is the sum, including async hooks. ECC's async observe
hook spawns bash and three python processes on every tool call including
Read and Grep, which is where the two seconds go. The control run of ours
through `bash -c` read 60-84 ms blocking, so the runner is not the gap.

**Skill listing.** 286 skills carry 73,076 description characters, about
19.5k tokens, plus 94 commands. Ours carry 12,285 across 67, about 3.2k.
ECC's own open issue #2694 reports that the listing truncates and skills
from other plugins become invisible to routing. Installed beside this plugin
it would hide ours. That closes the "use both" option without a fork.

**Windows.** Open issue #2687: the inline `node -e` bootstrap in every hook
matches Defender's VirTool:JS/Anomelesz.A heuristic on the session
transcript, and it quarantined a live one from 6.88 MB to 0.08 MB. The
continuous-learning observer is skipped on Windows outright, is disabled by
default on every platform, and carries an open P0 (#2673) where a 1,519-row
batch was archived unanalysed. Orchestration is tmux worktrees, a SQLite
store and GitHub-issue epics; there is no tmux here and nothing resembling
prd.json's five states, stop-auto-check, desktop session messaging or the
auto-brain survey.

**Gate integrity.** Its suite is 4,049 tests in 472 s here, 14 failing and
all 14 Windows-only (11 symlink EPERM, 3 tar). One test file per hook script
with three exceptions. No mutation or can-fail gate exists, so there is no
equivalent of `check:suites` or `check:vacuity`. A fork would carry 3,520
files this operator never uses and either lose those gates or port roughly
64k lines of scripts, hooks and tooling onto them.

**Rules and skills** are generic where ours are incident-derived: KISS, DRY,
YAGNI, 80% coverage, immutability marked CRITICAL, and a camelCase rule its
own issue #2830 notes contradicts the Python and Rust packs. The skill
catalogue is a breadth play (Laravel, Kotlin, homelab, DeFi, a music-video
taste layer); nothing in it targets this stack better than what is here.

**AgentShield**, its config scanner, run against this repo: grade A with two
findings, both wrong on this machine. CLAUDE.md "world-writable 0o666" is
what every file reports through node on NTFS, and "no PreToolUse hooks" comes
from reading settings files only, so it cannot see plugin hooks at all.

**What survives the pass.** One idea maps to a measured gap in this repo's
own record: rule 14c says 77% of cost is cache reads and a session should
restart past about 300k, and nothing in our hooks enforces it. ECC's
`ecc-context-monitor.js` nudges from transcript size; transcript rows here
carry `usage.cache_read_input_tokens`, so a hook can read the true figure.
`config-protection`, which blocks edits to linter configs, is 176 lines and
cheap, but no incident in the record motivates it, so it waits for one.

**Built the same day: `hooks/context-depth-nudge.js`.** A Stop hook that
reads the latest assistant row's usage from the tail of `transcript_path`
(input + cache_read + cache_creation, the figure that call was billed for),
and once per 100k step past 300k emits `additionalContext` telling the model
to finish the step and write RESUME.md, plus a `systemMessage` telling the
operator to start fresh. No `decision` key, so it cannot hold a turn or fight
stop-auto-check; silence is zero bytes on both streams. Suite:
`tooling/test-context-depth-nudge.js`, 30 cases, including a usage row behind
a 700KB attachment row, a truncated final line, and a corrupt ledger. The
first run of that suite failed two of its own cases on arithmetic (402,578 is
one whole step past the line, bucket 1, not 0); the hook was right and the
expectation was wrong, which is what a first run is for.

**Away-window decision, branch 2.** The closing panel for this evaluation was
held by the operator's standing AWAY order (`~/claude-memory/AWAY.md`, until
2026-09-06T20:00Z, "no panels, decide it yourself and log why"). The order's
branch 2 covers work that is reversible and not otherwise decided: this hook
is one file, one suite and one `hooks.json` line, reverted by removing them.
It was the recommended option and it was the one measured gap the evaluation
found, so it was built rather than queued. Not taken from the same panel: an
artifact page (arms a live-watch chip the operator would have to close, low
value while away) and, at the time, the push.

**Corrected the same afternoon: the push, the PR and the merge are covered by
a standing rule, branch 1.** `~/claude-memory/MANDATE.md`, "PUSHES AND MERGES
ARE THE FLEET'S, IN HIS OWN REPOS", carries the operator's words of
2026-09-05 verbatim: "not even merges need me, but everything that costs
minutes should be either batched or optimized." Read directly from disk, not
taken from the peer relay that pointed at it. Beside it, this repo's CLAUDE.md
line "commit and push autodev freely", and the same day's D9a precedent that
an autodev push reaches a git remote and nothing else. So: one push of the
whole branch, one PR whose title is the squash subject, every ci.yml check
read by name to a terminal state (unknown is not finished), squash-merge, then
both new files verified on `origin/main` by path. The gate ran green at
`75c0429` (exit 0, 2,208 s, 110 of 110 suites, 109 verified able to fail);
this correction is docs-only and ran validate and the private-names gate. Not
cut here: a release, because a version number is a plugin-cache key and a
sibling branch was landing at the same time, so one release covering both is
one run instead of two.

**What would reverse this.** A measured per-call cost within 2x of ours, a
skill listing that fits the budget beside another plugin, the Defender issue
closed with a non-inline bootstrap, and a hook can-fail gate. Any one of
those is a new evaluation; none of them is a reason to re-read the README.

## 2026-08-19 — the mutation gap is 5 of 112, and one was a vacuous assertion

Both suites re-swept against the same subject, because the figures in
`test-drift-audit.js` described a file that had since grown:

| measured against | mutants | caught | survived |
|---|---|---|---|
| prd suite (`test-drift-audit.js`) | 112 | 59 | 53 |
| config suite (`test-drift-audit-config.js`) | 112 | 63 | 49 |
| **either suite** | 112 | **107** | **5** |

**Neither 53 nor 49 is the gap.** The tool takes one suite at a time, so every
mutant the other suite catches is reported as a survivor. Only the intersection
means anything, and it is 5.

The parser that computed it undercounted on the first attempt — 32 of 53 — and
that was caught by making it assert its own total against the sweep's headline
before printing. A count that cannot check itself is a guess.

The five, read individually rather than reported as a number:

- `HOME || USERPROFILE` — both branches hold the same value in any environment
  this runs in. Closable only by an environment no test would otherwise create.
- `if (!lastPrd || !lastPrdTs) return;` and the `|| {}` in the age-cache write —
  guards for states no fixture reaches, one of them inside a `catch`.
- The `&&` in the worktree dedupe's precedence rule — genuinely equivalent here:
  with either operator the main checkout still wins, because both branches agree
  whenever one of the two repos is the main one.
- `if (!market || !market.installLocation)` — **not equivalent, and it exposed a
  vacuous test.** Mutated to `&&`, the audit dereferences an undefined market,
  throws a TypeError and prints nothing. The assertion above it read
  `!/thing@ghost/.test(out)`, which is true of a process that died on line 1 —
  so a test whose own comment said "skipped, not crashed on" only ever checked
  the first half.

That last one is fixed: both negative assertions now also require the report
header `Drift audit —`, which only prints once a run reaches the reporting
stage. Verified by re-injecting the mutant — the suite goes red on the new
assertion specifically. Four remain, and they are the boring kind.

The lesson generalises past this file: **a negative assertion needs a positive
control in the same breath.** "X did not appear" is satisfied by X not appearing
and equally by nothing appearing at all.

## 2026-08-19 — a large catalog is summarised, not enumerated

"Published in a marketplace you use but not installed" had already been scoped
once, from every known catalog down to adopted ones. That was still the wrong
cut. Measured: `claude-plugins-official` carries 286 plugins with 27 installed
and produced **259 of the audit's 277 findings** — 95% of the output, burying
the 14 warnings underneath it.

The scoping conflated two things. Adopting most of a marketplace and missing a
few *is* drift. Cherry-picking from a large general catalog is what a catalog is
for. They are separated by count, not by adoption, so past five uninstalled the
finding collapses to one line naming the ratio.

The case the check exists for survives — a 3-plugin marketplace missing one
still names it. Both sides are pinned, plus a fully-installed marketplace, so
the summary cannot fire on zero.

## 2026-08-19 — each test case gets its own config directory

`test-drift-audit.js` re-audited every repo it had ever created on every `run()`
— fifteen by the end — so cost grew with the square of the file. 112s to 46s by
giving each case its own config, and the CI job went 3m23s to 1m54s.

Profiled first, and the profile killed two plausible theories: memoising `run()`
saved 8s, replacing filler's write-add-commit with a single empty commit saved
about 1s. The real cost was 64.3s inside sixteen audit runs re-walking unchanged
repos against 41.5s of fixture git calls. **This suite is spawn-bound on
Windows**, so the fix is to spawn less, not to spawn faster. Adding fixtures to a
shared config is what would make it slow again.

One trap in the refactor, worth stating because it would have been invisible:
the read-only case asserted "the audit does not modify the repo it inspects"
using *another case's* repo. Under isolation that repo is no longer registered,
and an unregistered repo is trivially unmodified — the assertion would have
passed forever for the wrong reason. It now builds its own fixture and carries a
control asserting the repo **is** audited.

Verified the faster suite did not go blind: deleting the drive branch from
`pathFromSlug` still turns 18 assertions red.

## 2026-08-19 — a permission rule's fix line has to be runnable

The settings check told the reader to "narrow it to the specific command you
need" while matching on the command NAME. So `Bash(export SP=*)` was reported
identically to `Bash(export *)`, and deletion was the only action that ever
cleared a finding. The detection was right; the prescribed cure had never been
run against the detector.

Rules now split in two. Commands whose purpose *is* arbitrary execution — `sh`,
`bash`, `source`, `eval`, and `WebFetch(domain:*)` — stay flagged whatever
argument they carry, and their fix line says delete rather than narrow. Everything
else is flagged only when the argument is a bare wildcard, which is where the
escalation actually lives: a prefix match on `export *` also admits
`export X=1; <anything>`. Flags are not constraints, so `rm -f *` and
`chmod +x *` still fire.

Found by trying to follow the advice on a real settings.json — three
fail-severity findings, none of which narrowing could clear.

## 2026-08-19 — settings.json was never in the backup mirror

The backup protocol says `~/.claude` changes are mirrored to `claude-memory`.
`settings.json` was not in the allowlist, so the single file holding the
permission allow/deny lists was the one file a reinstall would not restore. It
surfaced only because the permission tightening was mirrored and then checked —
the sync reported success and carried none of it.

It cannot be copied verbatim: two hook commands hold an absolute
`C:\Users\<name>\…` path, and committed files must not carry local home paths.
The mirror now rewrites them to `%USERPROFILE%` in the copy only, leaving the
live file untouched.

Two failures on the way in, both caught by verifying rather than trusting the
"pushed" line:

- PowerShell's `-replace '\\', '\\\\'` emits **four** backslashes, not two, so
  the substitution missed and the guard correctly refused to mirror. Use
  `.NET String.Replace` for literal work; `-replace` treats the replacement as a
  pattern.
- `Set-Content -Encoding UTF8` writes a **BOM**, and a BOM makes the file invalid
  JSON. The mirror parsed as garbage — a backup that cannot be restored, which is
  the one thing a backup may not be. Now written with `WriteAllText` and a
  BOM-less encoder.

## 2026-08-19 — CLAUDE_CODE_SUBAGENT_MODEL is set to opus

Recorded here because a session keeps re-deriving it. `~/.claude/settings.json`
sets `env.CLAUDE_CODE_SUBAGENT_MODEL = "opus"`, and the variable is **live in the
running process** — not merely present in a config file.

This is the shape of override that would explain the standing note that subagent
model pinning has no effect: every subagent forced to one model regardless of its
frontmatter or the Agent tool's `model` parameter, which is exactly what 37,795
subagent calls on disk show.

**Not yet proven to be the cause.** Settings-supplied env is applied at session
start, so the discriminating test — unset it, launch a pinned agent, grep that
subagent's transcript for `"model"` — needs a fresh session. Until that runs this
is an active override with the right name and value, which is more than the
previous "cause undetermined" and less than a demonstrated cause.

## 2026-08-19 — a remote's HEAD is filtered by shape, not by name

`prdCarrierBranches` filtered remote refs with `!/\/HEAD$/.test(b)` alongside
`b !== 'origin'`. Both clauses were wrong, and they hid each other.

`for-each-ref --format='%(refname:short)'` renders `refs/remotes/origin/HEAD` as
**`origin`** and `refs/remotes/upstream/HEAD` as **`upstream`**. A short name
therefore never ends in `/HEAD`, so the first clause could not fire at any time.
The second caught origin's HEAD only because of what that remote happens to be
called — **any second remote's HEAD passed through and was scanned as a
branch**, costing a slot against `PRD_BRANCH_SCAN` and skewing the skipped
count.

Now `b.includes('/') && b !== base`: a real remote branch shortens to
`<remote>/<branch>`, a remote HEAD shortens to a bare remote name. One rule
covers every remote instead of one hard-coded name.

**Found by mutation-testing, not by reading.** Deleting the `/HEAD$` clause left
the suite green — the mutant the header had listed as surviving. The first
fixture written to catch it used `origin/HEAD` and also stayed green, because
`b !== 'origin'` was quietly doing the work. Only a *second* remote separated
them. That is [22c] exactly: when a filter looks redundant, ask what it is
compensating for before deleting it — and make the planted negative something
the surviving clause cannot catch by accident.

## 2026-08-19 — slug reversal restores the drive letter

**The CI failure.** `test-drift-audit` failed on `windows-latest` on every run
for a stretch of releases, while `ubuntu-latest` passed. 12 of its 26 assertions
failed and the other 14 passed.

**Root cause, and it is not Windows.** `drift-audit.js` rebuilt a project path
from its slug as `'/' + slug`. On Windows a rooted path with no drive letter is
drive-*relative*: it resolves against whichever drive the process is on. A
developer machine has cwd and `%TEMP%` on the same drive, so it worked. A
GitHub runner checks out to `D:\a\…` while `%TEMP%` is on `C:`, so every fixture
resolved to a nonexistent `D:\Users\…`.

Discovery therefore returned **zero projects** and the audit emitted no findings
at all. That is why the split was 12/14 rather than a clean failure: every
assertion expecting a finding failed, and every assertion expecting *no* finding
passed vacuously. Half the suite was structurally incapable of firing.

**Fix.** `pathFromSlug` in `plugins/autodev-core/scripts/drift-audit.js` now
restores the drive letter — `C--Users-x` becomes `C:/Users/x` — and leaves the
POSIX branch untouched. The leading `-` is the discriminator and needs no
platform check: a POSIX slug always has one, a Windows slug never does.

`decodeProjectDir` in `plugins/autodev-memory/scripts/memory-audit.js` carried
the identical defect and got the identical fix. Keep the two in step.

**This also fixed production, not just CI.** The old code's own comment recorded
that Windows project discovery "discovered zero projects and said nothing, for
as long as it has existed". The drive letter was being discarded, not merely
misrouted, so no Windows install had working project discovery.

**Regression gate.** `checkSlugReversalRestoresDrive` in `tooling/validate.js`
scans every plugin script for the slug reversal and fails if one omits the drive
restore. It prints its population (`4 site(s) across 2 file(s)`) so an empty
scan cannot read as clean, and it was mutation-tested: deleting the drive branch
turns it red and names the file.

Scoped to the reversal rather than to bare-slash concatenation on purpose —
measured against this tree, a `'/' + x` scan returned 4 hits and all 4 were
legitimate.

**Where the code actually is.** Two sessions were working in the same clone, and
`git add -A` from the other one swept these changes into its commits. The work
is therefore under messages that do not mention it:

| Commit | Message it shipped under | What it actually carries |
|---|---|---|
| `1cd5e03` | `fix(tooling): the miner says which machine it can see` | the `pathFromSlug` fix, the `memory-audit` fix, the test fixture rebuilt to the real production slug |
| `2192918` | `feat(tooling): rank failure classes by wall-clock cost, and cap the advisory` | `checkSlugReversalRestoresDrive`, the fixture-shape assertion |
| `cb0e12c` | `chore(release): 8.89.0` | the `actions/checkout` and `actions/setup-node` bump to `v7` |

The history is public and already pushed, so it was not rewritten to relabel it.
This entry exists so the fix is findable by something other than the commit log.

**Verification.** Reproduced before fixing, by pointing a substituted drive at
the checkout so cwd and `%TEMP%` differed: 14 passed / 12 failed, the same twelve
as CI. After the fix, 26/26 under that same cross-drive condition and 27/27 for
the full suite. Then confirmed live — CI run `32261659867`, both `windows-latest`
and `ubuntu-latest` green.

**Related.** The runners force `actions/checkout@v4` and `actions/setup-node@v4`
onto Node 24 and annotate every run about it. Both are pinned to `v7` now. This
job uses neither action's optional surface, so the intervening majors do not
apply to it.

## 2026-08-30 — agent frontmatter `model:` and `effort:` both take effect

`[measured 2026-08-30]` and stated as a correction, because the first version of
this entry concluded the opposite and was committed before the controls were run.

**What the retracted version claimed.** That `effort:` is not reliably applied,
on the evidence that `autodev-core:code-reviewer` pins `effort: high` and ran
`xhigh` in 108 of 108 assistant rows, while two other agents pinning `high` ran
`high`. That divergence is real and the reading of it was wrong.

**What was missing: a live control.** Two agents were then spawned with NO model
and NO effort argument, and their own transcripts read back:

| spawned | frontmatter | ran |
|---|---|---|
| `test-runner` | `model: haiku` | `claude-haiku-4-5`, 4 of 4 rows |
| `autodev-core:code-reviewer` | `model: opus`, `effort: high` | `claude-opus-5`, `effort=high`, 3 of 3 |

Both pins held exactly. So `effort:` in agent frontmatter is no longer merely
documented; a transcript now shows it applied on an agent spawned without an
effort argument.

**Why the historical rows disagreed, at DAY granularity:**

| agent | day | observed |
|---|---|---|
| `test-runner` | 2026-08-16 / 18 / 19 | `opus-5 / xhigh`, 128 + 77 + 333 |
| `test-runner` | 2026-08-21 onward | `haiku`, 62 |
| `autodev-core:code-reviewer` | 2026-08-17 | `opus-5 / xhigh`, 108 |
| both | 2026-08-30 probe | pins honoured |

Every contradicting row predates 2026-08-22, which is the day the
subagent-model environment override was disabled on this machine. That override
forced every subagent to opus regardless of its definition, which is exactly what
these rows show. Nothing about pinning was broken; the rows are an artifact of a
configuration that no longer exists.

**Two method notes, because this went wrong in a specific and repeatable way.**

A month-granularity split was run precisely to avoid reporting a window average
as current state, and it was still too coarse: every row fell inside 2026-08, so
the split looked clean while hiding a change on the 22nd. Match the granularity
to the suspected change, not to the convenient bucket.

And an override refutation is not a pin confirmation. Counting Agent spawns
showed `test-runner` had 20 spawns and zero explicit `model` arguments, which
correctly killed the per-spawn-override explanation and said nothing about
whether the pin worked. Only spawning one and reading its transcript did that.

**Reproduction.** Spawn the agent with no model or effort argument, then read
`effort` and `message.model` off the assistant rows of its own
`subagents/agent-<id>.jsonl`. Reading frontmatter back only tells you what was
requested.

## 2026-08-30 — architect keeps `effort: xhigh`, now that the pin is known to work

The five agents in `plugins/autodev-core/agents/` were given `effort:` at a time
when the field was believed inert. `[measured 2026-08-30]` it is not: an agent
spawned with no effort argument ran at the effort its frontmatter names. So every
one of those pins became a live cost choice retroactively, and `architect` is the
only one set to `xhigh`.

**Kept, deliberately.** Two facts decide it.

`architect` is rare. Across 792 subagent transcripts and 62,278 assistant rows it
appears **zero** times, while `general-purpose` accounts for 31,147 rows and
`workflow-subagent` for 20,038. An effort pin on an agent that does not run is
close to free, and the pins that actually move spend are the ones on the agents in
that second group, none of which this repo owns.

And its job is the one where effort pays. It plans features, maps dependencies and
records architecture decisions, so its output is read by other agents and turned
into work. A cheap wrong plan is more expensive than an expensive right one,
because the cost of a bad plan is paid by every session that builds on it rather
than once at generation.

**What would reverse this.** If `architect` starts appearing in transcripts at a
volume comparable to `code-reviewer` (108 rows) or `security-scanner` (361), the
arithmetic changes and the pin should be re-argued rather than inherited. The
check is the same one that produced these numbers: group assistant rows in
`subagents/**/agent-*.jsonl` by `attributionAgent`.

**What this entry is NOT.** It is not a claim that `xhigh` produces better plans.
Nothing here measured output quality, only that the pin is applied and that the
agent is rare. The case rests on the cost of the pin being near zero, not on a
demonstrated benefit, and it should not be cited as evidence for effort levels
anywhere else.

## 2026-09-04 — one hooks module, in plain .mjs, that keeps its secrets in memory and its denies at home

Claude Code 2.1.259 carries "function hooks" (hooks modules) behind a rollout
flag; `docs/function-hooks/README.md` has the contract. Five choices in
`plugins/autodev-core/hooks/fn/` are not derivable from the code:

**One module carries four concerns** (redaction, Bash rules, the commit trailer,
the status line) because the loader takes one module per plugin and refuses a
second. The entry file holds every `on(...)` and every `$` call; the helpers are
pure, because the host's static scan refuses `$` passed, bound or read, so a
helper cannot take it as an argument.

**`.mjs`, not `.ts`.** The loader compiles either. Plain ES modules let
`tooling/test-hooks-module.js` load the real files with `import()` under Node
alone, and let V8 coverage prove the load to `find-untested-hooks.js`. A `.ts`
module would have needed a toolchain in the gate for no gain.

**The vault is worker memory, never `$.store`.** `$.store` persists to a JSON
file under `~/.claude/plugins/store/`, a worse home for a credential than the
transcript the module exists to protect. A hot reload empties the vault; the
model then meets a placeholder it cannot resolve, and the failure names itself.

**Denies are scoped to this repository** through `$.session.repo()`, and there
are three: the commands CLAUDE.md forbids by name. The 2026-08-17 measurement
that a text denylist over Bash blocked 807 legitimate calls and nothing
dangerous stands; a fourth deny needs its own numbers. Rewrites are not scoped,
because a rewrite cannot block work. **Corrected the same evening:** the MSYS
rule began as a rewrite that prefixed `MSYS_NO_PATHCONV=1`, and that changed
the command's first token, which is what the permission layer matches an
allowlist on, so `git show` under `Bash(git *)` started prompting. A prompt
for a command the model never wrote reads as the plugin breaking permissions.
It is now a Windows-only deny whose reason carries the exact command to run;
its measurement is the two-of-two mangled dot-leading reads in the
verification-traps table. The rule that fell out: a rewrite may append a
flag and may never change the first token, and the suite asserts it.

**The vendor's `claude-code.d.ts` is extracted, not vendored.** It is marked
early access and ships inside every binary; `tooling/extract-plugin-types.js`
recovers it into gitignored `.claude/types/` per install, and the README states
the contract in this repo's own words.

**The branch stayed local.** The closing panel was held by the away branch and
resolved to "push and open the PR". Not taken: this machine's own decision log
for the day classes a push as the operator's, `rules/local-first.md` says a push
needs his yes in the turn, and a branch push fires `ci.yml`. HEAD `6d10188`,
gate green. The push is queued on his word.

**What would reverse the design choices.** A `$.store` that the host scoped to
memory would make the vault a store. A loader that lifts the one-module rule
would split the four concerns. A measured count of denies refusing legitimate
work in this repo would remove the denies before it added a fourth.

**Pushed the same night, and here is what the authorisation was read from.**
The operator typed, in his own turn to another session and read from that
session's transcript as a `[user]` row rather than through a relay: *"work
over night on what you can. don't stop for me, no questions."* Beside it: this
file's own CLAUDE.md line ("commit and push autodev freely; ask before
touching a product repo"), the mandate recording autodev's merges as delegated
because it has no users, and the away declaration delegating reversible
decisions. A branch push here deploys nothing and is one `git push --delete`
from undone. The Brain took the decision in its own name and said so; the
version bump to 8.160.0 is not part of it and waits for a green PR.

## 2026-09-05 — a snapshot that cannot date itself

**The trunk's own `RESUME.md` was three days stale and nothing in it said so.**
`[measured 2026-09-05]` at `origin/main`, all three state sections were wrong:
`## Open PRs` listed [#127](https://github.com/djnsty23/claude-auto-dev/pull/127),
merged `2026-09-02T19:07:18Z` — six minutes after the snapshot's own HEAD time,
so it was accurate for about six minutes. `## Unpushed commits` listed `8b79aa2`
and `0d0d6cb`, both ancestors of `origin/main`. `## Worktrees` listed six, of
which three no longer exist, against eight that do.

**The fix is a `| generated |` row, first in the table, and that is all it is.**
A reader could not date the snapshot: the only timestamp was `HEAD committed`,
which is a fact about a commit, not about when the file was written. So a
snapshot taken a minute ago and one taken last week rendered identically. That
is the suite's own founding thesis — null must not render as empty, because
"no unpushed commits" and "git was never asked" are opposite facts — arriving
one level up, where *recent* and *ancient* were the pair that looked alike.

Three assertions, each mutation-tested and each caught by the assertion under
test rather than a neighbour: removing the row (2 red), moving it below
`directory` (1 red), and emitting a plausible non-instant `'recently'` (1 red).
The third is the one that earns its place — `has('| generated |')` would have
passed it. The expected value is parsed from the subject's own output and
checked for being a real instant near now, never compared against a date
written into the fixture, because a fixture that names a date is a second clock
and goes red on its own when the two disagree.

**Not done, and deliberately left for the operator.** `RESUME.md` is a
per-session artifact committed to a shared trunk: it names one worktree's
directory and branch, so it is wrong for the other seven readers by
construction, and regenerating it only moves which tree it is right about.
The history already shows this being hand-patched — `chore(resume): regenerate
— it described a different worktree` — and 23 commits touched the file in 30
days. A stamp makes the decay legible; it does not make a per-session file into
a shared one. Whether the trunk should carry it at all is a convention change,
not a bug fix, so it is recorded here rather than decided while he is away.

**Where this came from.** A sweep for stale "still open / unproven / blocked"
claims across five repos, written up in `~/claude-memory/STALE-CLAIMS-2026-09-05.md`.
Worth noting against that report's own method: its detector found only 12
checkable lines in this repo and **none of them were this file**. The sweep
matched on vocabulary — "still open", "unproven", "blocked on" — and a table row
reading `| #127 | fix/... |` under a `## Open PRs` heading asserts openness
structurally, with no such word anywhere. A state document can be stale without
using any stale-claim language, and a lexical detector is blind to exactly the
most machine-generated, most trusted kind.
