# AGENTS.md

**Read `CLAUDE.md` first. It is the single source of guidance for this repo.**
Codex looks for `AGENTS.md`, so this file exists to point you at the real
document and to carry two things it does not: the few facts that are true only
for you, in the hand-maintained section here, and below the `GENERATED` marker
an index of the always-on `rule-*` conventions that Claude Code sessions load
by path glob and you would otherwise never see.

<!-- HAND-MAINTAINED. Everything above the GENERATED marker is copied through
     verbatim by tooling/generate-agents-md.js; edit it freely. Everything below
     the marker is regenerated from plugins/autodev-core/skills/rule-*/SKILL.md
     and any hand edit there is overwritten on the next --write. -->

## Why the top half is a pointer and the bottom half is generated

A copy of `CLAUDE.md` was tried. It was produced by find-replacing "Claude" with
"Codex" across it, and the replace inverted repo facts: it described this as a
Codex plugin marketplace, which it is not, and told the reader the validator
rejects `~/.Codex`, a string that appears nowhere in `tooling/`. An agent
following that briefing writes the one path the validator refuses.

Two documents saying the same thing means one of them is wrong and nothing
reports which. So `CLAUDE.md` is not repeated here. The rules ARE repeated,
under one condition that the copy lacked: they are emitted by a generator from
the rule files themselves, and `npm run check:agents-md` (a step of `npm run
gate` and of CI) regenerates to a temp path and fails when the two differ. When
a rule changes, the gate says which document is stale and how to fix it. The
`Full text` path under each entry is the authority; the entry is the index.

## What is true for you and not written there

- **You start cold.** Every CLI and MCP invocation is a fresh session. You do
  not inherit the caller's context window, its conversation, its memory, or the
  operator's machine-level rules. Only a threaded reply carries context, and
  only within that one thread. If a brief assumes you know something, it is
  wrong; say so rather than inferring.
- **The repo is the only shared channel.** Anything you find that matters must
  be written to a file. A conclusion that exists only in your reply reaches one
  caller once and is then gone.
- **Write incrementally.** Append findings to your output file as you go rather
  than composing one answer at the end, and use a format that survives being cut
  in half. A run that ends early then still leaves work behind.
- **Give your deliverable a recovery path.** An untracked file has none, so an
  overwrite is total loss rather than a diff. Repo content: commit it to the
  working branch as it grows, locally, and leave pushing to the caller. An
  audit report belongs under `.claude/reports/`, which is gitignored here on
  purpose; there the recovery path is appending every round, not a commit.
- **A caller's timeout may not stop you.** Its handle dies whether or not you
  do. Assume the caller may dispatch again without realising you are still
  writing, so never leave a file in a half-written state you would not want
  read, and clean up anything you planted.
- **Every claim carries the command that produced it and what it printed.**
  Print the population beside any count. Before reporting that something is
  absent, run a known-positive control and say what it found.
- **Starting cold is not starting empty, and the difference is whose context.**
  `[measured 2026-09-01]` `codex debug prompt-input` renders 44,220 bytes of
  model-visible input on the operator's machine, carrying `AGENTS.md`, skills
  and plugin instructions. So you arrive with your own briefing and none of the
  caller's. Do not report that you received no instructions; report which ones
  you received, since the caller usually cannot see them.
- **Your sandbox may be wider than the brief implies.** A call that omits a
  sandbox setting inherits `~/.codex/config.toml`, where the operator's default
  may be `danger-full-access`. Read your session header rather than assuming the
  brief's tone constrains you, and hold to the cleanup obligation above: write
  only where the brief says, and remove anything you planted.

## Working on the Codex integration itself

`docs/codex-channels.md` holds what has been measured about the three channels
that reach you, and it is where a new measurement belongs. It is written for the
caller choosing a channel rather than for you, so most of it will not change how
you work. Two parts do, and both are above.

Read it before changing `tooling/review-diff.js` or anything else that shells
out to the CLI: it records constraints that cost real time to find, including
that `codex exec review` rejects the prompt argument its own usage string
advertises.

## Scope

Change only what the brief names. This repo ships into other people's sessions:
a hook that throws kills their turn and a hook that prints costs them context on
every prompt, so the blast radius of a careless edit here is other users, not
this machine. `CLAUDE.md` has the specifics.

<!-- GENERATED BELOW — DO NOT EDIT BY HAND.
     Generator: tooling/generate-agents-md.js
     Source:    plugins/autodev-core/skills/rule-*/SKILL.md (16 rules)
     Version:   autodev 8.165.0
     Variant:   B
     Regenerate with: node tooling/generate-agents-md.js --write
     Drift gate:      node tooling/generate-agents-md.js --check   (npm run check:agents-md) -->

## Conventions this repo enforces (generated)

Distilled from the always-on `rule-*` skills that every Claude Code session in
this repo loads by path glob. Each entry names the globs that trigger the rule,
its description, its opening paragraph, and every dated measurement in it, so a
reader outside Claude Code sees the same conventions and the incidents that
produced them. The `Full text` path is the authority; this is the index.

Why this shape and not the full text or the descriptions alone, measured at
generation time over the rules on disk:

| variant | bytes | dated claims kept |
|---|---|---|
| A  full body | 133,422 | 27 of 27 |
| B  description + first paragraph + dated PARAGRAPHS + Never/Always ← emitted | 22,231 | 27 of 27 |
| B′ same, but dated LINES instead of paragraphs | 14,827 | 2 of 27 |
| C  description only | 7,044 | 0 of 27 |

### rule-ab-testing

**paths:** `**/*.tsx`, `**/*.jsx`, `**/experiment*.ts`, `**/ab-*.ts`

Every proposal gets measured against the current approach and at least one variant before it is adopted, and the measurement is reported. Load before recommending a change, writing a detector, or claiming something is cheap, fast, or better.

A proposal is not a finding. Before recommending a change, measure it against
**what happens today** and against **at least one alternative**, then report the
numbers alongside the recommendation.

Full text: `plugins/autodev-core/skills/rule-ab-testing/SKILL.md`

### rule-agent-concurrency

**paths:** `**/*.workflow.js`

How many agents to spawn, at which model and effort, so a fan-out does not burn the session's limits. Load before spawning subagents, running a workflow, or dispatching background sessions.

Claude Code's own ceilings are far higher than what is useful here: subagents
default to **20 concurrent** (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`), nesting
runs **3 deep** (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`), the per-session spawn
cap was removed entirely in 2.1.224, and a workflow runs
`min(16, CPUs − 2)` agents at once. Nothing stops a fan-out from exhausting a
usage window in one turn.

**Verify the model that actually ran before a model-specific claim or handoff.**
`model:` frontmatter, `--model`, a saved preference, and a requested fallback
chain are intent, not execution evidence. `[measured 2026-09-01]` the
`PreModelSwitch`/`PostModelSwitch` hooks observed all six explicit interactive
switches but none of three successful unavailable-primary fallbacks. In an
interactive session read `/status` after the switch. In an unattended run use
the command or SDK result's actual model field. If neither readback exists, say
the model is unverified instead of naming the requested one as fact.

`[measured 2026-08-25]` over **280 agents across 52 workflow runs**: returns
totalled 3,524,077 characters, roughly **880k tokens fed back into main
threads**. Median return **12,933 chars**, p90 30,873, max 65,399. **60% exceed
10k.** One run of 30 agents returned 658,588 chars — about 165k tokens — into a
single thread, which then re-reads them on every subsequent turn.

The intuition is backwards, and this corrects point 3 above rather than
replacing it. `[measured]` mean pairwise similarity between parallel agents'
returns was **0.008** (max 0.060 across 51 pairs). Serial chains averaged
**0.072**, with peaks of 0.710, 0.672 and 0.546 — and every pair above 0.25 sat
in a serial refine chain. One chain returned 113,915 characters re-emitting
substantially the same document **fifteen times**.

`[measured 2026-08-25]` 42 of 280 agents (15%) were lost — 20,680 agent-seconds and 1,119
tool calls, journaled as nothing, because the journal records a result only on
completion. **20 of them carry a `<synthetic>` row reading "You've hit your
session limit", and 0 of those 20 journaled.** That is 48% of all lost work from
one cause, and it is greppable after the fact.

`[measured 2026-09-08]` (`docs/evidence-quota-wall-2026-09-08.md`) the wall
lands on every agent in flight at once and on the main thread two seconds
later, so nothing can act at that moment. The recovery already exists:
`Workflow({scriptPath, resumeFromRunId})` re-runs only the `agent()` calls whose
key has no `result` row in `journal.jsonl` and returns the rest from cache. On
the one real resume on this machine it re-started exactly the walled calls and
nothing else. **Nothing calls it automatically, and the notification that names
it arrives while the thread is walled.** Two things now close that gap:

**Never nest fan-outs.** A depth of 3 means six agents each spawning six is

Full text: `plugins/autodev-core/skills/rule-agent-concurrency/SKILL.md`

### rule-design-system

**paths:** `**/*.tsx`, `**/*.jsx`, `**/*.css`, `**/tailwind.config.*`

Design-token rules: semantic tokens over inline colors, where tokens are defined, and the one case hardcoded colors are allowed. Load before writing or editing component styles.

**Exception:** Hardcoded colors (`text-white`, `bg-black`) are valid on dynamic gradient backgrounds or explicitly themed surfaces where the background is not a standard theme token.

`[measured 2026-09-03]` `magicuidesign/magicui`: MIT, a shadcn registry named `magicui`
carrying 247 items typed `registry:ui`. It installs the way the rest of the components do,
the code lands in the tree, so it is OURS to gate rather than a dependency to trust.

Full text: `plugins/autodev-core/skills/rule-design-system/SKILL.md`

### rule-diagnosis

**paths:** none — applies to any work; load it by name (user-invocable)

A wrong fix costs one cycle; a wrong diagnosis costs every cycle until someone questions the premise. Reproduce before explaining, suspect the frame before inventing a mechanism, and attribute a failure before repairing it. Load before proposing any cause, fix, or explanation.

**A wrong fix costs one cycle. A wrong diagnosis costs every cycle until someone
questions the premise.** That asymmetry is the whole reason this is a first-class
rule and not a footnote: repeated QA rounds are almost never caused by sloppy
edits, they are caused by a confident explanation nobody re-examined.

**The incident.** `[measured 2026-08-27]` A session read the header of a migration
dated six weeks earlier, which described a data-in-git problem in the present
tense **as of that date**, and concluded the problem was present now. It wrote a
brief, a repo document and a memory file all asserting a stalled migration, then
handed an agent a backfill to run.

Full text: `plugins/autodev-core/skills/rule-diagnosis/SKILL.md`

### rule-file-organization

**paths:** `**/prd.json`, `**/.claude/**/*.md`, `**/.claude/**/*.json`

Where generated files belong. Archives, backups, handoffs, reports, and screenshots go under .claude/, never the project root. Load before writing any generated artifact.

| Type | Path | Retention |
|------|------|-----------|
| Archives | `.claude/archives/prd-archive-*.json` | 30 days |
| Backups | `.claude/archives/prd-backup-*.json` | 7 days |
| Handoffs | `.claude/handoffs/handoff-*.md` | 7 days |
| Reports | `.claude/reports/*.md` | 7 days |
| Screenshots | `.claude/screenshots/*.png` | Cleaned each run |
| Sprint History | `.claude/sprint-history.md` | Persistent |
| Agent Memory | `.claude/agent-memory/*.md` | Persistent (audit-patterns.md, brainstorm-history.md) |
| Session carriers | `.claude/memory-sessions/*` | Deleted at SessionEnd. Holds **verbatim user prompts** — the directory writes its own `.gitignore` so it can never be committed. Never move these files elsewhere. |
| Compaction snapshot | `.claude/pre-compact-state.json` | Overwritten each compaction |

Full text: `plugins/autodev-core/skills/rule-file-organization/SKILL.md`

### rule-gate-integrity

**paths:** `**/check-*.js`, `**/find-*.js`, `**/test-*.js`, `**/preflight*.js`

Ways a gate or test proves nothing while looking decisive: grading a copy of itself, passing on emptiness, a canary firing for the wrong reason, a summary read as a verdict, a probe pointed at the wrong invocation. Load before writing a gate, a mutation harness, or any check guarding generated output.

These four failure modes were hit independently by two sessions on the same day,
working on unrelated problems — a mutation harness for a token generator, and a
test-vacuity sweep across a plugin marketplace. Both arrived here the hard way.
Each one produces a **green result that means nothing**, and each is invisible
from the summary line.

`[measured 2026-09-01]` A new feature collapsed anonymous rows out of a report,
and its safety property was that a row which can be acted on is never collapsed.
Two filters implement that: one selects the rows to hide, one selects the rows to
keep. The mutation emptied the FIRST filter, the suite went red, and that looked
like confirmation. It was not. The failure was the count assertion noticing 5
where it expected 4. **The safety assertion passed**, because the filter that
actually protects those rows had not been touched. Mutating the second filter
instead failed the safety assertion and its control together, which is the real
check.

`[measured 2026-09-07]` A staleness detector grew a veto so that
`NO prod tag is pending` -- a sentence asserting the ABSENCE of open work, in
the exact grammar of asserting its presence -- would not be reported. The veto
allowed one token between `no` and the verb. The subject is a noun phrase, so
it never matched the sentence it was written for, and it vetoed nothing.

`[measured 2026-09-02]` git 2.54.0.windows.1, two throwaway repos, both forms of
`git merge-tree` against a real conflict and against a clean merge of the same
file in non-overlapping regions:

`[measured 2026-09-03]` A pricing page shipped a grid declaring 5 items in
`coinPacks.ts` against 4 columns in a Tailwind class in `Pricing.tsx`, so the
last row held one stranded cell at every breakpoint. Its layout suite at the
time asserted only a per-element floor (every control at least 44px) and a
page-level absence (no horizontal scroll). Both passed, correctly. `/pricing`
was in the route list and carried two dedicated tests, so coverage was never
the gap.

Full text: `plugins/autodev-core/skills/rule-gate-integrity/SKILL.md`

### rule-local-first

**paths:** `**/*.workflow.js`, `**/.claude/launch.json`, `**/PUBLISH-QUEUE.md`

Verification happens on this machine, in a browser you drive, before anything is pushed. Covers the local gate, the batched publish cadence, why GitHub Actions is not the gate, and why a restored browser session fakes a pass. Load before verifying, before pushing, and before any visual check.

Portable copy of `~/.claude/rules/local-first.md`, which is `@`-imported on the Windows
box and therefore invisible to any other machine. Keep the two in sync. Two passages are
host-specific and named as such where they appear: the `ClaudeMemorySync` scheduled task
and the per-repo gate names.

Added 2026-08-21, on Andy's instruction: *"always test locally and run visual checks in
Claude's browser… no more pushes, no more GitHub Actions."*

**`the music product` does NOT have a `gate` script — `[measured]` 2026-08-22.** This line used to
claim it did, as of 2026-08-21. It is absent from the working branch and from `origin/main`:
`git show origin/main:package.json` lists 40 scripts and `gate` is not one of them. Until it
is written, the gate on that repo is the chain by hand:

```bash
npm run typecheck && npm run test && npm run build
```

**Carve-out:** the config mirror to `~/claude-memory` (`rules/backup-protocol.md`) is a
backup of this machine, not shipping code, and it is why a reinstall is survivable. The
`ClaudeMemorySync` task that pushed it every 4h was **disabled 2026-08-21**, so the mirror
is a manual, same-session obligation again. That is how it rotted to 49-of-157 files last
time — so mirror when you edit, do not trust a timer that is no longer running.

**Disabling that task did NOT stop the mirror being pushed, and it never could.**
`[measured 2026-08-22]` `~/claude-memory` is still committed and pushed every few minutes,
authored `Dispatch <dispatch@local>` — which is only the repo's local git identity, not an
actor. Resolving the process tree of a live `sync-claude-memory.ps1` gave
`claude.exe -> bash -> powershell`: **other Claude sessions**, obeying
`rules/backup-protocol.md` obligation 1, which says in as many words to commit *and push*
the mirror in the same session as the edit.

Andy, 2026-08-21: *"what if we commit once per day as a daily publish or when we queue
2-5 items that need prod validation."* Commits stay local and accumulate. A **publish** is
the deliberate push of that batch.

**Root, NOT `.claude/publish-queue.md`** — this rule said `.claude/` until 2026-08-22 and
that path defeats the rule's own reason for existing. `[measured]` `.claude/` is gitignored
in every repo checked (the music product, the fitness product, the wagering product, analytics), and
`rules/file-organization.md` explicitly instructs adding it, because that directory is
ephemeral tooling state. A queue there is never committed, so it is invisible to a session
on another machine — the precise failure the paragraph above warns about, reintroduced by
its own filename. The queue is durable shared state, not tooling scratch; it belongs where
git can carry it.

`[measured]` 2026-08-21 in the in-app Browser pane:

`[measured]` the same day: a foreground tab and a background tab both reported
`innerWidth: 0, innerHeight: 0`. One `resize_window` call fixed it — 375x812, dpr 2.

Kept HERE, not in the `rule-local-first` plugin skill. That skill ships in a
PUBLIC repo, and these facts name private and client repos. Three separate
redactions were needed on 2026-08-22 before the split; the tension is structural,
not carelessness — the guidance is genuinely *about* specific repos, so writing it
accurately and publishing it pull in opposite directions.

**Which repo has which gate script** `[measured 2026-08-22]`
- `the fitness product` — `preflight`
- `the music product` — **no `gate` script**, despite this rule claiming one on 2026-08-21.
  Absent from the working branch and from `origin/main`; `git show
  origin/main:package.json` lists 40 scripts and `gate` is not among them. Until it
  is written, its gate is `npm run typecheck && npm run test && npm run build`.

**The config mirror** to `~/claude-memory` is the reinstall survival kit and is
exempt from the no-push rule. The `ClaudeMemorySync` task that pushed it every 4h
was **disabled 2026-08-21**, so mirroring is a manual, same-session obligation
again — that is how it rotted to 49-of-157 files last time. Do not trust a timer
that is no longer running.

`[measured]` 2026-08-22, the music product. A rect-based sweep flagged four controls on `/generate`
as under the 44px minimum. All four were fine. The project defines a `.tap-target::after`
utility that expands the hit area to 44x44 under `@media (pointer: coarse)`, and **84
controls carry it** — `getBoundingClientRect()` returns the element's own box and cannot see
a pseudo-element, so every one of them reads as undersized.

`[measured]` 2026-08-22. I checked out five branches in the music product's main clone over one
session. It was not idle: uncommitted work on `clientIp.ts`, `rateLimiter.ts` and a test
vector file appeared in that tree while I worked, from another session. Uncommitted changes
travel across a checkout, so nothing was lost — but the branch moved under someone else's
feet, repeatedly, with no signal to them.

Full text: `plugins/autodev-core/skills/rule-local-first/SKILL.md`

### rule-options-protocol

**paths:** none — applies to any work; load it by name (user-invocable)

How to end a turn: a clickable AskUserQuestion panel of vetted, complementary options with a recommendation in every block.

End every substantive turn with a **clickable panel** — the `AskUserQuestion` tool —
carrying **four vetted paths**, each genuinely detailed, **multi-select wherever the
options are not mutually exclusive**. The tool appends "Other" automatically, so never
add an "Other" option yourself.

Full text: `plugins/autodev-core/skills/rule-options-protocol/SKILL.md`

### rule-ramifications

**paths:** `**/*.tsx`, `**/*.jsx`, `**/*.vue`, `**/*.svelte`

The eight ways a change passes typecheck, build, and a clean console and is still wrong. Derived from 3,127 fix commits across three production repos. Load before implementing a feature and again before calling it done.

These are not general best practices. They are the eight failure classes that
actually shipped, measured across 3,127 `fix` commits in three production repos
(see [`docs/failure-evidence.md`](../../../../docs/failure-evidence.md)).

Full text: `plugins/autodev-core/skills/rule-ramifications/SKILL.md`

### rule-record-size

**paths:** `**/*.rs`, `**/*.go`, `**/*.c`, `**/*.h`, `**/*.cc`, `**/*.cpp`, `**/*.hpp`, `**/*.zig`, `**/*.swift`

A record's size is not its payload's size. An enum is as large as its biggest variant, a growable container carries capacity it will never use, and padding is invisible in the source. Multiplied by a million rows that is real memory. Load before defining a struct, enum or cache entry that will exist in bulk.

Per-record waste is the only kind that multiplies by a number nobody chose. The
row count is set by traffic, not by a design decision, so a byte you did not
notice is billed once per row forever.

Full text: `plugins/autodev-core/skills/rule-record-size/SKILL.md`

### rule-report-shell

**paths:** `**/*.html`

The house shell for any HTML report, audit, or findings page an agent publishes: summary-first cards that expand on click with staggered detail, themed scrollbars, and a token system that survives both themes. Load before writing or editing an HTML page a person will read.

Copy `references/report-shell.html` and replace the content. Do not rebuild the
CSS from memory — four of the rules below were found by measuring a live page,
and each one looks correct in source right up until it is rendered.

`[measured 2026-08-25]` A report built without it scored **5/10** on review, and
the two complaints were the two things this file fixes: *"text is too stacked,
not clean enough"* and *"scroll is another color"*.

Full text: `plugins/autodev-core/skills/rule-report-shell/SKILL.md`

### rule-security

**paths:** `**/*.ts`, `**/*.tsx`, `**/*.js`, `**/*.jsx`, `**/*.sql`, `**/*.env*`

Security rules this project always applies: secret handling, input validation, parameterized queries, and Supabase RLS. Load before writing code that touches credentials, user input, queries, or auth.

- Never commit .env, API keys, credentials
- Validate user input with Zod
- Use parameterized queries
- Supabase: RLS policies required, secrets in Edge Functions only
- Test edge functions after deploy (curl with real params, verify response)
- Verify bulk changes eliminated the old pattern completely (grep for remnants)

Full text: `plugins/autodev-core/skills/rule-security/SKILL.md`

### rule-thumb-first

**paths:** `**/*.tsx`, `**/*.jsx`, `**/*.vue`, `**/*.svelte`, `**/*.css`, `**/tailwind.config.*`

Interface design starts from where the hand is and what each element MEANS, not from a palette. Reach zones, progressive density, and the rule that unearned signal destroys real signal. Load before designing a screen, choosing a theme, or adding colour, motion, or output.

A theme is not a palette. **It is a claim about where the user's hand is and what
their eye does first.** Colour is downstream of that. Pick colours first and you
get something that looks designed; pick geometry and meaning first and you get
something that *feels* designed — which is the part people never articulate and
always notice.

Full text: `plugins/autodev-core/skills/rule-thumb-first/SKILL.md`

### rule-verification

**paths:** `**/prd.json`

What counts as done for each kind of change: the required verification per task type, and the six cross-cutting checks that apply to every task. Load before marking any task complete.

A task is not done because the code was written. It is done when the check for
its type has passed.

Full text: `plugins/autodev-core/skills/rule-verification/SKILL.md`

### rule-windows

**paths:** `**/*.ps1`

Windows-specific development rules: cmd /c wrappers for MCP, dev servers in an external terminal, path conventions, and the Supabase CLI firewall workaround. Load only when working on Windows.

Superseded 2026-08-17. This section used to forbid `npm run dev` outright on the
grounds that it "gets killed on session end". That premise is now false twice
over: `run_in_background` detaches the process, and `preview_start` supervises it
outright. The rule was compensating for a limitation the harness no longer has.

**One trap that is not about fences at all.** When a script shells out with a git
ref, use `execFileSync` with an argv array, never `execSync` with a string.
`execSync` routes through `cmd.exe /d /s /c`, where `^` is the escape character, so
`git rev-parse HEAD^` returns HEAD's own sha — silently, with exit 0. Measured
2026-08-17: `execSync` gave `af3bd7b` where `execFileSync` gave `faa3c21`. Any
caret-bearing ref (`HEAD^`, `HEAD^^`, `main^`, `HEAD^2`) is affected.

- **Always write `curl.exe`, never bare `curl`.** In Windows PowerShell 5.1

Full text: `plugins/autodev-core/skills/rule-windows/SKILL.md`

### rule-workflow-spine

**paths:** none — applies to any work; load it by name (user-invocable)

The order the other skills run in. Four steps: isolate, build, prove, ship. Each carries the condition that ends it. Load before starting any feature, fix or task, and whenever you are about to pick a skill and cannot tell which one comes first.

A skill library has two failure modes and only one of them is discussed. The
discussed one is a missing skill. The other is **fifty skills and no order**,
where the model picks by description similarity and the pick is a lottery. This
file is the order. It adds no capability; it decides what fires when.

**Never terminate on a score.** A number that a loop optimises toward stops

Full text: `plugins/autodev-core/skills/rule-workflow-spine/SKILL.md`
