# Evidence: what 52 real workflow runs on disk actually did

`[measured 2026-08-25]` on one machine. Every number below comes from
`<claude-home>/projects/*/*/subagents/workflows/wf_*/`, read directly.
Product repos are anonymised as **Project A / B / C** per this repo's public-name
gate; the numbers and the run shapes are unchanged.

## Population scanned

| thing | count |
|---|---|
| `.jsonl` transcripts on disk (control — the probe can see plenty) | 895 |
| project directories under `projects/` | 90 |
| project directories that hold ANY workflow run | 8 |
| main sessions that ran a workflow | 10 |
| **workflow run directories (`wf_*`)** | **52** |
| runs carrying a `journal.jsonl` | 52 (100%) |
| `agent-*.jsonl` transcript files | 280 |
| agent-transcript bytes | 107,654,774 (102 MB) |
| tool-use blocks inside those transcripts | 9,454 |
| window, earliest → latest agent | 2026-08-18T21:27Z → 2026-08-25T09:15Z |

The 8 project dirs are `autodev` (3 sessions), Project A main plus three of its
worktrees, Project B (one worktree), Project C (one worktree).

## Completion — 280 agents started, 238 results recorded

| | count |
|---|---|
| agents started (journal `type:"started"`) | 280 |
| results journaled (`type:"result"`) | 238 |
| **agents that ran and left no journal result** | **42 (15%)** |
| runs where every started agent journaled | 37 of 52 |
| runs that lost at least one agent | 15 of 52 |
| runs that journaled **zero** results | 7 of 52 |

What the 42 lost agents cost, measured from their own transcripts:
**20,680 agent-seconds (5h 45m), 1,119 tool calls, 12,008,232 bytes of transcript.**
None of it reached a main thread.

### The 7 zero-result runs, in full

| run | shape | agents started | agent-seconds | tool calls | transcript bytes |
|---|---|---|---|---|---|
| `wf_8419f91d` | parallel | 6 | 4,580 | 289 | 2,675,088 |
| `wf_ee1fd95b` | single | 1 | 2,300 | 92 | 849,357 |
| `wf_ed820e06` | parallel | 8 | 1,013 | 100 | 1,286,787 |
| `wf_facfb39a` | parallel | 3 | 436 | 53 | 588,697 |
| `wf_e2bfbe2f` | parallel | 2 | 265 | 17 | 258,178 |
| `wf_94b07fd8` | parallel | 2 | 177 | 25 | 276,848 |
| `wf_b5f43f78` | single | 1 | 8 | 0 | 73,243 |

Five of the seven are parallel fan-outs.

## THE QUOTA WALL IS THE DOMINANT LOSS CAUSE, NOT A MANUAL KILL

A `<synthetic>` row appears in `message.model` in 20 agent transcripts. Its content is:

```
You've hit your session limit · resets 5:50am (Europe/Bucharest)
```

Correlation with journal outcome is perfect and one-directional:

| agents carrying a `<synthetic>` row | 20 |
|---|---|
| …that journaled a result | **0** |
| …that were lost | **20** |

So 20 of the 42 lost agents (48%) died to the session quota wall, not to anyone
pressing stop. This is a **detectable marker**: grep an agent transcript for
`"model":"<synthetic>"` and you know the run hit a wall rather than a bug.

Where the 20 landed:

| run | shape | agents in run | synthetic | lost |
|---|---|---|---|---|
| `wf_d295d703` | mixed (maxConc 7) | 23 | 8 | 8 |
| `wf_8419f91d` | parallel | 6 | 6 | 6 |
| `wf_19d9a152` | parallel | 8 | 4 | 4 |
| `wf_018e74f4` | mixed (maxConc 10) | 13 | 2 | 2 |

The wall does not choose. It lands on whatever is in flight, so **the width of the
phase running when it lands is exactly how much work is destroyed.** A 6-wide
parallel wave lost 6 agents to one wall. A serial chain would have lost 1 and the
journal would have kept the rest.

## Loss by phase shape

Shape derived from real agent start/end timestamps: max concurrency 1 → serial,
max concurrency == agent count → parallel, anything between → mixed.

| shape | runs | fully complete | agents started | results kept | **loss** | chars returned | lost agent-sec | lost tool calls |
|---|---|---|---|---|---|---|---|---|
| serial | 14 | 11 (79%) | 59 | 56 | **5%** | 627,629 | 4,875 | 106 |
| mixed | 23 | 20 (87%) | 164 | 153 | **7%** | 2,305,130 | 3,298 | 173 |
| parallel | 12 | 5 (42%) | 54 | 28 | **48%** | 591,313 | 10,199 | 748 |
| single | 3 | 1 (33%) | 3 | 1 | 67% | 5 | 2,308 | 92 |

Parallel runs are 23% of the population and carry **62% of all lost agents** and
**49% of all lost agent-seconds**. A serial phase loses 5% of what it starts;
a pure parallel phase loses 48%.

The causation is not "parallel is buggy". A barrier holds N agents in flight
simultaneously, so any interruption — quota, kill, crash — takes all N. The journal
writes on completion only, so nothing partial survives.

## Return payload sizes — what agents pushed back into main context

238 results, measured as the character length of `journal.result`.

| statistic | chars |
|---|---|
| min | 5 |
| p25 | 4,309 |
| **median** | **12,933** |
| p75 | 22,028 |
| p90 | 30,873 |
| max | **65,399** |
| **total across all 238** | **3,524,077** |

| threshold | returns above it |
|---|---|
| > 2,000 chars | 218 (92%) |
| > 5,000 | 176 (74%) |
| > 10,000 | 143 (60%) |
| > 20,000 | 67 (28%) |
| > 40,000 | 8 (3%) |

3,524,077 chars is roughly **880k tokens** permanently added to main-thread
contexts — enough to rebuild two full 405k main contexts from returns alone.

### Ten biggest single returns

| chars | run | payload opens with |
|---|---|---|
| 65,399 | `wf_0a2cd20e` | `{"handling_verdict":"THE CAR SATURATES ITS TYRES…` |
| 48,813 | `wf_948c6e69` | `{"paths":[{"id":"coupon-redeem",…` |
| 47,949 | `wf_948c6e69` | `{"paths":[{"id":"sub-checkout",…` |
| 45,246 | `wf_948c6e69` | `{"paths":[{"id":"reconcile-coin-purchases",…` |
| 44,700 | `wf_1b4aecc9` | `{"population":"14 files read…` |
| 44,567 | `wf_ab1e10ad` | `{"task":"Three mechanical CLOSEs…` |
| 43,639 | `wf_1b4aecc9` | `{"population":"13 files read in full…` |
| 40,131 | `wf_948c6e69` | `{"paths":[{"id":"pro-gen-coin-spend",…` |
| 38,563 | `wf_d295d703` | `{"surface":"db-fn-body","reviewed":7,…` |
| 37,697 | `wf_1b4aecc9` | `{"population":"19 files read or scanned…` |

Every one is a StructuredOutput JSON object. So the 2048-character cap is
**per schema string field**, not per payload — a 65k return is possible and
happened. The cap is a trap for one long field, never a budget for the whole result.

### Per main session

| chars returned | returns | runs | session |
|---|---|---|---|
| 863,801 | 44 | 5 | Project A / worktree 1 |
| 754,364 | 42 | 14 | Project B / worktree |
| 467,123 | 54 | 12 | autodev (session 1) |
| 459,504 | 21 | 2 | Project A / worktree 2 |
| 386,280 | 18 | 8 | autodev (session 2) |
| 229,285 | 7 | 2 | Project A / worktree 3 |
| 206,111 | 17 | 2 | Project A / main |
| 65,116 | 19 | 1 | Project A / worktree 4 |
| 63,101 | 4 | 1 | Project C / worktree |
| 29,392 | 12 | 5 | autodev (session 3) |

The top session took **863,801 chars (~216k tokens)** back from its subagents.
Against a 405k main context that is more than half the context rebuilt out of agent
returns, and every subsequent turn re-reads it at cache-read rates. This is the
mechanism by which "the second half of a session costs 1.44× the first half" gets
produced from inside a workflow.

### The worst single run

`wf_1b4aecc9` — 30 agents, max concurrency **16**, all 30 journaled.

- 13,385,999 bytes of agent transcript, 925 tool calls.
- **658,588 chars returned in one workflow** (~165k tokens into one main thread).
- Individual returns: 44,700 / 43,639 / 37,697 / 36,632 / 35,746 / 34,588 / 32,806 /
  32,713 / 29,079 / 27,613 / 24,147 / 23,762 / 22,191 / 18,502 / 17,053 / 16,653 /
  16,031 / 15,067 / 14,855 / 13,903 / 13,624 / 13,333 / 13,093 / 13,060 / 12,792 /
  12,747 / 12,097 / 11,412 / 10,592 / 8,461.

It violated both the 2–3 concurrency ceiling and the 6-agent cap by a wide margin
and still completed 30/30, so width did not break it. What it cost was the 165k
tokens it deposited in the main thread — a cost the workflow's own success metric
never showed.

## THE MEASURABLE EXPENSIVE MISTAKE: agents that write nothing return 2.6× more

Split the 238 results by whether that agent ever called `Write` or `Edit`.

| | n | median return | total chars |
|---|---|---|---|
| agent WROTE a file | 49 | **5,217** | 503,316 |
| agent wrote NOTHING | 189 | **13,389** | 3,020,761 |

Only **56 of 280 agents (20%)** used `Write`/`Edit` at all. The 79% of returns that
came from write-less agents account for **86% of everything pushed back into main
contexts**. An agent with no file artifact has nowhere to put its findings except
the return value, so it puts all of them there.

Corroborating shape census over the 238 returns:

| | count |
|---|---|
| contain ≥3 markdown headings (a document, not a summary) | 28 |
| contain a fenced code block pair | 13 |
| name a file path | 129 |
| **name a file path AND exceed 10,000 chars** | **88 (37%)** |

88 returns wrote a file *and* pasted the content back anyway — paying for the
artifact twice.

## Duplicated content: it is in SERIAL chains, not parallel fan-outs

Pairwise 4-gram Jaccard similarity between returns inside the same run.

| shape | runs compared | pairs | mean similarity | top per-run maxima |
|---|---|---|---|---|
| parallel | 6 | 51 | **0.008** | 0.060, 0.032, 0.020, 0.008, 0.007 |
| mixed | 23 | 895 | **0.008** | 0.185, 0.105, 0.055, 0.046, 0.043 |
| serial | 13 | 182 | **0.072** | **0.710, 0.672, 0.546**, 0.104, 0.042 |

**Parallel agents in these 52 runs did not duplicate each other.** The highest
similarity any parallel pair reached was 0.060. The theory that N parallel agents on
one brief converge is not visible in this data, because these fan-outs were briefed
on disjoint surfaces — the coverage pattern working as intended.

All 19 pairs above 0.25 sit in exactly three serial runs:

| run | model | agents | pairs > 0.25 | total chars returned | peak sim |
|---|---|---|---|---|---|
| `wf_a7f1b5c8` | fable | 15 serial | 11 | 113,915 | 0.710 |
| `wf_28bd80d9` | fable | 11 serial | 5 | — | 0.546 |
| `wf_a1d1dd80` | fable | 5 serial | 1 | — | 0.672 |

These are refine / adversarial chains: each stage re-emits the whole document with
edits. `wf_a7f1b5c8` returned 113,915 chars across 15 stages of one artifact,
roughly 8k chars of near-identical prose re-crossing the boundary per stage.

All three are Fable runs, which is where model choice actually bites: the
duplication is on the *output* side, and Fable output is 2× Opus.

## `__unparsedToolInput` — the 2048 truncation

Only **2 agents** across all 280 carry `__unparsedToolInput`.

| run | agent | rejected payload lengths | tail of payload |
|---|---|---|---|
| `wf_11b9bc9e` | `a0c45a36…` | `[96]` | `…/tune.ps1", "offset": 1, 30, "limit": 30}` |
| `wf_ee1fd95b` | `ab4f3c7b…` | `[2048, 2048, 2048, 2048, 2048]` | ``…even though it works when a key is held. It returns `Raw`` |

Confirms the reported cap exactly. Five attempts, five payloads of **exactly 2048
characters**, every one severed mid-token. The 96-char one is a genuine schema error
(`"offset": 1, 30` is invalid JSON), which is the triage split: **length 2048 means
finished work is sitting in the transcript; a short length means the agent got the
schema wrong and should be re-run.**

`wf_ee1fd95b` is also one of the seven zero-result runs — 2,300 agent-seconds,
92 tool calls, 849,357 bytes of transcript, nothing journaled. That is what a
truncation failure looks like from outside: identical to an empty run.

## Executed models — read from `message.model`, not from the request

| executed model | agent transcripts |
|---|---|
| `claude-opus-5` | 241 |
| `claude-fable-5` | 30 |
| `<synthetic>` (quota wall, not a model) | 20 |
| `claude-sonnet-5` | 3 |
| `claude-opus-4-8` | 2 |
| `claude-haiku-4-5-20251001` | 1 |

Per-agent `.meta.json` declares `model` on only 94 of 280 files (opus 63, fable 27,
sonnet 3, haiku 1); the remaining 186 have no `model` key at all — they inherited.
Fable is confined to three runs, the same three that produced every duplicate pair.

Effectively **the entire workflow fleet ran on Opus**, mechanical stages included.
Sonnet ran 3 times and Haiku once, across 280 agents.

## Tool usage inside agents

9,454 tool-use blocks across 280 agents; median 29 per agent, max 165.

| tool | calls |
|---|---|
| Bash | 7,448 (79%) |
| Read | 771 |
| Edit | 455 |
| Write | 245 |
| StructuredOutput | 200 |
| Grep | 95 |
| WebSearch / WebFetch | 87 |
| everything else | ~153 |

200 `StructuredOutput` calls produced 238 results, so retry pressure is low overall.
The 5-attempt burn in `wf_ee1fd95b` is the outlier, not the norm.

## Amplification: the subagent already does the compression

102 MB of agent transcript produced 3.52 MB of returns — a **30.5:1 reduction**.
That ratio is the actual product of dispatching to a subagent. A 44,700-char return
throws most of that gain away at the last step, and the p90 returns (>30k chars) are
where it goes.

## What is NOT in this data — stated rather than reported as zero

- **COULD NOT CHECK: per-request token counts.** `journal.jsonl` records only
  `{type, key, agentId, result}` — no usage block, no timestamps. Every cost figure
  here is a proxy (characters, transcript bytes, agent-seconds), not billed tokens.
- **COULD NOT CHECK: whether a lost agent was killed by a human or crashed.** Only
  the 20 `<synthetic>` rows are attributable, to the quota wall. The other 22 lost
  agents have no cause recorded on disk.
- **COULD NOT CHECK: main-thread context size at the moment a result landed.** The
  return burden per session is a sum, not a measured context-growth curve.
- **Machine-local.** 52 runs, one machine, 10 sessions, one week. Work on another
  machine is invisible here.
