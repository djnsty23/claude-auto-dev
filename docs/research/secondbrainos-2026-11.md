# Second Brain OS: what autodev should take from it

Studied 2026-11-04 by Andrei (djnsty23), at commit `53aea82` of
`github.com/undefined-ui/second-brain-os` (MIT), the source of secondbrainos.dev.

Second Brain OS is a free, markdown-only guide for running an agent-maintained
Obsidian vault, plus an agents course, five handbooks, 18 skills, 72 slash
commands and 6 subagents. Autodev already covers most of it, often more
strictly, so the useful part is small: three auditor fixes (PRs #496, #497
and #499) and four guidance lines (PR #500) shipped with this study, and four
harness ideas worth a measured trial. The surprise was that the biggest gain
came from our own tool, not theirs: reading their two-level index page showed
that `memory-audit.js` misreported 404 of its 785 "unindexed" findings.

Every claim is tagged `[measured]` (with its probe), `[stated]` (who said it)
or `[inferred]` (what it rests on). Their text is summarised here, never copied.

## Ranked adoption list

| # | Idea (their source) | What we have | Gap | Cost | Verdict |
|---|---|---|---|---|---|
| S1 | Two-level index: a master index linking topic or archive index pages (`docs/07-retrieval/context-budget.md`, "summary layers") | We already split `MEMORY.md` into `MEMORY-archive.md` in three stores `[measured: ls MEMORY*.md per store]` | `memory-audit.js` read only `MEMORY.md`, so 785 memories read "unindexed", 404 of them falsely, and the archive page matched most bodies as a near-duplicate `[measured: memory-audit.js --json, before and after]` | 41 lines plus 5 test cases | **Adapt. Done**, PR #496 |
| S2 | A "Gaps" list: linked pages that do not exist yet, ranked, as the plan for what to write next (`docs/04-structuring/index-and-log.md`) | Our memory instructions already say an unmatched `[[name]]` marks something worth writing later `[stated: harness memory instructions]`, and `maintenance.md` step 3 says not to remove one for that reason `[measured: read]` | The audit prints 269 `dangling-link` lines in file order with no ranking, and 7 of them resolve in the global store `~/.claude/memory`, which it never reads `[measured: names cross-checked against ~/.claude/memory]` | ~40 lines plus tests | **Adapt. Done**, PR #497 |
| S3 | Behavioural assertions over transcripts: each past failure becomes a case of "X happened", "X before Y", "no X" rules checked against logged tool calls (`plugins/agents-course/skills/evals-bootstrap`, `docs/course-5-evals/evals-practice.md`) | `analyze-session-patterns.js` ranks failure classes, `skill-trigger-eval.js` checks first-turn skill loads `[stated: research agent, grep of plugins/ and tooling/]` | Nothing asserts worker rules such as "gate ran before commit" or "`gh pr view` before saying merged" over real transcripts `[inferred: no such suite found by grep]` | A new `check:` suite plus seed cases, a few hundred lines | **Adopt. Done**, PR #502 (`check:transcripts`) |
| S4 | Weekly random re-check of passed work, each disagreement becoming a new case (`docs/course-5-evals/judges-and-golden-sets.md`) | `drift-audit.js` looks only at untouched stories `[stated: research agent]` | A story at `passes: true` is never sampled again. The judge-zero-accepts incident (memory, 2026-10-30) stayed invisible for that reason `[inferred]` | One Brain routine step, 3 to 5 records a week | **Adopt. Done**, PR #503 (`recheck-passed.js`, a daily brain-clock observer). On the first draw, 422 of 763 passed stories (55%) recorded no evidence field `[measured: recheck-passed.js over 21 repos]` |
| S5 | A narrow critic: fresh context, a handful of checkable rules, PASS or numbered defects, hunting claimed-but-missing work, hardcoded values, swallowed errors and edits to tests (`plugins/agents-course/agents/loop-critic.md`) | `code-reviewer` agent, `adversarial-loop`, `check-pr-ready.js` catching deleted tests and `.only` `[stated: research agent]` | The reviewer has no "check the claim against the disk" rule, and its suggestion tier can send retries after style `[inferred: read of the agent file by the research agent]` | A loop-mode section in one agent file | **Rejected with data.** Both arms ran the real `code-reviewer` on 5 planted shortcuts and 1 clean change. Both caught 5 of 5 and passed the control. The variant only cut non-goal items (0 against 4 on the clean change), and no shipped caller feeds reviewer items back into a loop `[measured: 13 runs, grep of plugins/]` |
| S6 | Supersede, never overwrite: a contradicted fact stays, dated and marked superseded (`docs/04-structuring/contradictions-and-supersession.md`, `skills/second-brain-changed-my-mind`) | Markdown memory: `maintenance.md` step 4 keeps superseded context and conflicting claims explicit `[measured: read]`, and `decision-rejections.md` records overruled calls `[measured: file exists]`. SQLite memory: `memory-db.js` dedups by hash only `[stated: research agent]` | None that matters. The SQLite `observations` table holds tool events (session, type, source files, token cost, content hash), not claims a later fact could contradict `[measured: read memory-db.js schema]` | n/a | **Skip.** Markdown, where the claims live, is covered |
| S7 | Every harness piece names the model weakness it exists for, and is retested after each model upgrade (`docs/course-4-harness/harness-practice.md`) | `skill-dispositions.js` retains, merges or retires skills by fire count `[stated: research agent]` | Hooks and `~/.claude/rules` only grow | A `because` field in the dispositions manifest for hooks | **Adapt, deferred** |
| S8 | Four graph-health numbers in a dated log: orphan rate, average degree, component count, stale rate (`skills/second-brain-metrics`, `docs/05-graphs/metrics.md`) | `memory-audit.js` snapshots, memory-kb's 90-day staleness marker `[measured: read SKILL.md]` | Our stores read as "barely connected" by their thresholds: average outbound links 1.2 to 2.1, 35 to 57% of memories with no inbound link `[measured: link count over 3 stores]`. But our retrieval is the index plus semantic search, not link walking, so these numbers do not predict recall here `[inferred]` | Small | **Skip** until a scheduled routine runs the audit. A history needs a producer, and none exists: no scheduled task or routine calls `memory-audit` `[measured: grep over the scheduled-task and routine folders, only archived copies matched]` |
| S9 | Restate the goal near the end of the context every few steps (`plugins/agents-course/skills/context-audit`) | `context-depth-nudge.js` handles depth only `[stated: research agent]` | Long worker briefs sink into the middle of the window `[inferred]` | One hook | **Rejected with data.** The premise did not hold: 2 of 66 judged worker runs departed from their brief, at 44 and 138 turns, and judge reasons naming unmet work fell from 18% to 6% across turn quartiles `[measured: brain-judge ledger joined to worker.log num_turns]` |
| S10 | Typed links (supports, contradicts, extends, part-of, applies) | None | We do not query by relation `[inferred]` | Discipline on every write | **Skip** |
| S11 | An append-only `log.md` of every agent operation | `~/claude-memory` mirrors every memory change into git `[stated: backup-protocol rule]` | None that the git history does not answer | n/a | **Skip** |
| S12 | Answers cite the pages they read and name what is not covered (`skills/second-brain-query`) | memory-kb's provenance header and its "evidence to check, not an answer" rule `[measured: read SKILL.md]` | None | n/a | **Skip**, covered |
| S13 | Read-only by default: four of six agents cannot write (`agents/README.md`) | `researcher`, `plan-reviewer`, `code-reviewer` and `scout` all lack Write and Edit `[measured: agent type list in this session]` | None | n/a | **Skip**, covered |
| S14 | Hooks fast, silent on success, blocking only for the reason they exist (`docs/06-agents/hooks.md`) | Repo `CLAUDE.md`: nothing to say means zero output, and `check:hooks` is a hard gate `[measured: read]` | None | n/a | **Skip**, covered |
| S15 | "Keys, not prompts": restrict by permission, not instruction (`docs/06-agents/safety-and-guardrails.md`) | `pre-tool-filter.js`, workers carrying no secrets since 8.198 `[stated: memory 2026-10-30]` | None | n/a | **Skip**, covered |
| S16 | Privacy audit before sharing (`skills/second-brain-privacy`) | `check-no-private-names.js` and the commit-msg hook, which refused a commit message in this very session for naming a private project `[measured: hook output]` | None | n/a | **Skip**, covered |
| S17 | Fingerprint repeated attempts, score ratchets, a done check that must fail first, fresh context per retry (`docs/track-loop`, `skills/goal-test`) | Smart Retry cap of 2, `judge-panel.js`, `prove`, `check-suites-can-fail.js`, worker rule T5 `[stated: research agent]` | Marginal. Their overnight loop also uses `git add -A` and `git reset --hard`, which we ban | n/a | **Skip** |
| S18 | 72 thin slash commands, each pointing at a skill | Skills are our unit, with trigger phrases | Commands add surface and loaded tokens for no new behaviour `[inferred]` | n/a | **Skip** |
| S19 | Ingest contract: one to three concept pages per source, nothing ingested until linked both ways (`skills/second-brain-ingest`) | Our memory format comes from the harness instructions `[stated]`, which already say to link liberally | We cannot change the harness text. The auditor is where we act (S1, S2) | n/a | **Skip** |

## Second pass: the other 150 files

The first pass read the docs, agents and course pages that the ranked list
cites. A second pass read the remaining 150 text files in scope (3 top-level
files, 69 docs pages, 9 skills, 72 commands) `[measured: agent file count]`.
It ran nothing and fetched nothing. The Python helpers in `scripts/` were
deliberately not read. It found 19 techniques, F1 to F19.

| Code | Technique | Our gap | Verdict |
|---|---|---|---|
| F1 | Finished outputs are indexed again as dated sources | The memory-kb corpus has no lessons or research entries `[measured: grep of ingest.py]` | **Adopt. Done** in the kb repo (PR 1), 398 rows ingested |
| F2 | Semantic hit first, then follow its links one hop | memory-kb search never reads `[[links]]` `[measured: grep of search.py]` | **Adapt. Done** in the kb repo (PR 2) |
| F3 | Re-embed in the same run as the write | Re-ingest is a manual step `[measured: read memory-kb SKILL.md]` | **Adapt. Built** as an async PostToolUse hook script in the user config. Wiring it into settings.json is the owner's step |
| F4 | Search for the case against an idea before arguing for it | No skill reads past rejections first `[measured: grep]` | **Done**, PR #500, `rule-ab-testing` rule 10 |
| F5 | Lint each page for stub or oversize length | The audit checks only index size | **Skip.** 1 of 1459 memories is under 40 words, and 98 over 1000 words are long references, not failed writes `[measured: body word counts over 124 stores]` |
| F6 | Read the whole first batch before scaling a fan-out | No first-wave step `[measured: grep]` | **Done**, PR #500, `rule-agent-concurrency` |
| F7 | Stale means untouched while newer material on the topic arrived | memory-kb staleness is age only | **Adapt. Done** in the kb repo (PR 3). On 800 chunks, a newer memory at 0.85 similarity flagged 5% with about half real updates, against 11% and about 2 in 10 for age alone `[measured: one rater, 10 judged per arm]` |
| F8 | Topic sub-indexes instead of a date-ordered archive | `MEMORY-archive.md` is ordered by age | **Adapt. Done** for this repo's store: 285 entries in 13 topics, every link kept |
| F9 | Many items repeating one source are one piece of evidence | Not stated in either radar | **Done**, PR #500, both radar skills |
| F10 | Add one example before adding another rule | Not in `writing-for-agents` `[measured: grep]` | **Done**, PR #500 |
| F11 | Keep the old name as an alias on rename | 0 memories carry aliases | **Adapt. Done**, PR #504 (`aliases:` frontmatter resolves in `memory-audit.js`) |
| F12 | Counts in each automated commit message | The memory mirror commits a timestamp only | **Adapt. Done** in the user config: each mirror commit names added, changed and deleted counts by folder |
| F13 to F19 | Opt-in publishing, cited answers, report sections, verbatim transcripts, locked human pages, parent-merged indexes, README-as-command | Covered, mostly more strictly | **Skip** |

## The five questions

**1. What is it for?** A course and reference for engineers building agents
and an agent-kept personal wiki, repositioned on 2026-11-02 from "second brain"
to "guides and resources for AI engineers" `[measured: gh api commits]`. The
audience is individuals with an Obsidian vault and Claude Code.

**2. What is there?** 406 tree entries, 288 of them markdown or JSON
`[measured: gh api git/trees?recursive=1]`. 50 commits since 2026-09-07, all by
one author under two names, last push 2026-11-03, 1,311 stars, MIT
`[measured: gh api repos and commits]`. Most of the volume is prose: the skills
are 1.7 to 3.5 KB each, the commands a single line pointing at a skill
`[measured: tree sizes]`.

**3. How does it run?** It does not, as a system. It is copy-in material:
skills, agents and commands you place under `.claude/`, a vault template, and
Python helpers (`vault_stats.py`, `link_check.py`, `graph_export.py`) that were
not run here. The site is a static 3D graph generated from the repo.

**4. Where is the risk?** In adopting, not in running. Several course pages
restate public material from other vendors and authors, and its reading list
cites papers whose identifiers we could not verify without fetching them
`[stated: research agent]`. Their overnight loop resets the tree hard, which
would destroy concurrent work here.

**5. What would I tell someone tomorrow?** Their memory doctrine is the same as
ours, in simpler words: keep contradictions, link at write time, index
first, never trust a count that only grows. The value was a mirror held up to
our tooling, which turned out not to read the index layout we already use.

## What was not established

- Anything about the site's 3D graph beyond its existence. It needs JavaScript
  and was not rendered.
- The arXiv papers and tools in their `resources/` pages. None was fetched.
- The Python helpers in their `scripts/` folder, which were not read by design.

## What would change this

- A scheduled memory-maintenance routine appearing: S8's history becomes cheap
  and worth having.
- Retrieval moving from index plus semantic search to link walking: orphan rate
  and degree start predicting recall.
- A worker-rule regression slipping past review twice: S3 moves to the top.

## Appendix: probes

```bash
gh api repos/undefined-ui/second-brain-os --jq '{license:.license.spdx_id,stars:.stargazers_count,pushed:.pushed_at}'
gh api 'repos/undefined-ui/second-brain-os/git/trees/main?recursive=1' --jq '.tree|length'
node plugins/autodev-memory/scripts/memory-audit.js --json   # tally .projects[].findings[].kind
```
