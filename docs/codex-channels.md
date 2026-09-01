# Reaching Codex from Claude Code

Three channels reach GPT from a Claude session. The channel decides token cost,
whether you can thread, and whether the run survives the machine being locked.
It is not a style preference.

Measured 2026-08-30 to 2026-09-01 against `codex-cli 0.151.0` and plugin
`codex@openai-codex` 1.0.6, authenticated against a ChatGPT subscription. Every
figure below came out of a run, not a docs page. Re-check anything load-bearing
before quoting it; a fact about tooling goes stale without announcing it.

## The verdict

| Channel | Use it for |
|---|---|
| **MCP server** (`codex mcp-server`) | Everything agent-to-agent. Structured request and reply, threads that continue, concurrent calls. |
| **CLI** (`codex exec`) | Repo-rooted runs, long jobs, sandbox and approval flags, `exec review`, session logs you can grep. |
| **Desktop app** | The human's own threads. Not an automation target. |

## What the head-to-head measured

Same prompts, same harness, after a restart, 2026-08-31.

| | MCP | CLI |
|---|---|---|
| Median latency | 8,245 ms | 8,993 ms |
| Process startup | 207 ms, paid once | a full process per call |
| Input tokens per call | 22,800 | 29,343 |
| Multi-turn | returns `threadId`; `codex-reply` continues it | a thread another writer holds refuses resume |
| Concurrency | two calls replied at +7.3 s and +7.9 s | one process per call |
| Output shape | structured `{threadId, content}` | stdout to scrape |

Latency is a tie. About 8 s of both is inference, so speed is not the argument.
The token gap is: the CLI loads a 40,239-character memory preamble that the MCP
path does not.

The desktop app lost on a different axis. Driving it by computer-use cost about
15 click batches to focus changes, two stale clipboard re-pastes that burned two
entire review cycles, and stalls waiting for the machine to be unlocked. None of
that failure class exists over MCP.

## Setup

Register the MCP server. On Windows the `cmd /c` wrapper is required or the
server never starts.

```bash
claude mcp add codex -- cmd /c codex mcp-server
```

Confirm auth with `codex login status`, which prints `Logged in using ChatGPT`.
Do not test for the presence of `~/.codex/auth.json` instead: that file is
absent when `CODEX_HOME` is set or credentials live in the OS keyring, so the
check reports "not signed in" for a signed-in user.

Auth is the subscription, not the API. `auth_mode` is `chatgpt` and
`OPENAI_API_KEY` is null, so calls draw plan quota rather than dollars. That
still matters, because a review loop is the thing most likely to hit a
mid-week rate limit.

**Read your own `~/.codex/config.toml` before trusting a default.** MCP calls
inherit it unless the call overrides. A `sandbox_mode` of `danger-full-access`
there means a call that omits `sandbox` is not read-only, whatever the caller
intended. Pass `sandbox` explicitly on anything that should only look.

## Calling it

Over MCP the parameters that decide the run are `sandbox`
(`read-only` / `workspace-write` / `danger-full-access`), `approval-policy`
(`on-request` / `never`), `cwd` and `model`. Use `never` for anything
unattended, or the run blocks on a prompt nobody sees. Set `cwd`: a run rooted
in the wrong directory reads the wrong `AGENTS.md`, which is its only briefing.
Keep the `threadId` from the reply and continue with `codex-reply` rather than
restating context.

Over the CLI, the redirect is not optional in an automated caller:

```bash
codex exec --sandbox workspace-write -m gpt-5.6-sol "..." < /dev/null
```

## Models and effort, from the catalog rather than from guesses

`codex debug models` renders the raw model catalog as JSON. Use it. An earlier
pass concluded no enumeration command existed, invented four plausible model
names, and reported "valid models are exactly 3" off three 400s. The command was
there the whole time.

Catalog as of 2026-09-01, 9 slugs, 7 listed and 2 hidden:

| slug | visibility | in API | default effort | supported efforts |
|---|---|---|---|---|
| `gpt-5.6-sol` | list | yes | low | low, medium, high, xhigh, max, ultra |
| `gpt-5.6-terra` | list | yes | medium | low, medium, high, xhigh, max, ultra |
| `gpt-5.6-luna` | list | yes | medium | low, medium, high, xhigh, max |
| `gpt-5.5` | list | yes | medium | low, medium, high, xhigh |
| `gpt-5.4` | list | yes | medium | low, medium, high, xhigh |
| `gpt-5.4-mini` | list | yes | medium | low, medium, high, xhigh |
| `gpt-5.3-codex-spark` | list | **no** | high | low, medium, high, xhigh |
| `gpt-reserve` | hide | yes | medium | low, medium, high, xhigh, max |
| `codex-auto-review` | hide | yes | medium | low, medium, high, xhigh, max |

Three things that table settles and a flat list of names cannot:

- **Effort is per model, not global.** `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini` and
  `gpt-5.3-codex-spark` top out at `xhigh` and do not carry `max` at all.
  Sending `max` to one of them is not the request sending it to Sol is.
- **`ultra` exists on Sol and Terra and is not in the API's parameter enum.**
  The catalog describes it as maximum reasoning with automatic task delegation.
  The API's own `ReasoningEffortParam` rejects an unknown value with
  `Supported values are: 'none', 'minimal', 'low', 'medium', 'high', 'xhigh',
  and 'max'`, re-confirmed 2026-09-01. So `ultra` and `max` are different
  things, and `none` and `minimal` are in the parameter enum while appearing on
  no model's supported list.
- **The CLI does not validate effort locally.** `-c model_reasoning_effort=bogus`
  prints `reasoning effort: bogus` in the session header and ships it, and the
  rejection arrives from the server as a 400 mid-run. A config value that looks
  accepted has not been checked by anything yet.

One slug moved inside a day: `gpt-5.6-codex` executed on 2026-08-31 and is absent
from the catalog on 2026-09-01. Read the catalog rather than this table.

A per-call `model` override is honoured, but confirm it by reading
`turn_context.model` back out of the rollout log under `~/.codex/sessions/`. A
requested model is not an executed model, and the request tells you nothing.

## Eight traps, each already paid for

**An open stdin pipe hangs `codex exec` forever.** It appends piped stdin to the
prompt, so it waits for an EOF a spawned pipe never sends. Close it with
`< /dev/null` or `stdio: ['ignore','pipe','pipe']`. Cost 7 minutes to diagnose,
and it looks exactly like a slow model.

**A thread has exactly one writer.** Resuming a thread the desktop app holds
fails with `thread-store conflict: thread <uuid> already has an active writer
(code -32600)`. Storage is shared, so the lock is deliberate single-writer
enforcement. App holds the thread, only computer-use reaches it; app does not,
CLI resume works headless. Start long-lived agent jobs from the CLI. Finding a
thread UUID needs a full-content grep of the rollout files, because head and
tail sampling misses.

**A timeout aborts your call, not the delegate.** The delegate kept running for
about ten minutes after both dispatches had been recorded as failed, so
re-dispatching put two writers on one deliverable. The file vanished once
mid-rewrite and later turned up 415 lines shorter under an append that looked
clean. The tell was `git show --numstat`; no tool output announces that a file
got smaller.

**An empty result is a claim about the handover, not the work.** A delegate that
composes its answer at the end returns nothing when it ends early, which is
indistinguishable from a delegate that did nothing. One that returned "nothing"
had written three session logs of about 118 KB each. Tell a long delegation to
append findings to a file as it goes, in a format that survives being cut in
half, and to commit the deliverable as it grows. Before re-running anything
expensive, look at what it left.

**`codex exec review` takes no custom prompt, in either mode.** Its own help
prints `Usage: codex exec review --base <BRANCH> [PROMPT]` and then rejects
exactly that combination, on both `--base` and `--uncommitted`. A wrapper
written from the usage string exited 2 and skipped every committed diff, with a
skip message that read like a considered exemption. Custom review priorities go
in `AGENTS.md`, which Codex reads on its own. `--sandbox` belongs to `exec`, not
to `review`.

**Tool posture, not vendor, decided the last A/B.** Re-run properly on one
unreviewed 214-line gate: the cross-vendor reviewer returned 11 findings, an
in-house Opus subagent 10, about 8 of them the same. Opus additionally found a
live false pass and prefixed each finding with "Measured", having actually
executed the gate. It had Bash and Read; the other had `sandbox: read-only`.
**Any A/B between two models is void unless their tool grants match.** Give a
cross-vendor reviewer `workspace-write` and a prove-it requirement, or you are
paying for a reviewer that reasons where your own model measures.

**Testing names you invented is a probe of your imagination.** Four plausible
model names, three 400s, one success, reported as "valid models are exactly 3".
The real list was at least 8. The enumeration existed and was one subcommand
away: `codex debug models`. Enumerate from the vendor's own surface, a picker, a
config file, a `--help`, an error that lists the enum, before asserting a set is
complete. Otherwise say "these N work; I did not enumerate", because that is the
sentence that does not get acted on as a fact.

**The delegate starts cold, and `AGENTS.md` is the whole briefing.** Every CLI
and MCP invocation is a fresh session inheriting no conversation, no memory and
no machine-level rules. A find-replace of `CLAUDE.md` is worse than nothing: the
one tried here inverted repo facts and told the reader to write the one path the
validator refuses. Make it a pointer plus the few things true only for a cold
cross-vendor session.

## What to send it

The value in the 24-round cross-vendor audit came from the protocol rather than
the vendor. The adversary was required to write a test that fails on the defect,
and a test watched failing is empirical evidence by construction. That
discipline transfers to an in-house subagent, which is the cheaper place to
spend it.

So: **a gate defends an exit code, a model does not.** A gate must be
reproducible; a model is not. Point the model at the class a gate structurally
cannot see, and keep the exit status with the deterministic steps.

The two sets are disjoint, measured on one day. The deterministic gate caught a
3.53:1 contrast ratio and a 104x16 touch target, which no reviewer produces. It
missed a FAQ answer added to the visible page but not to the server-rendered
schema, and an echo printing a survives-in-its-merged-PR line as a hardcoded
string for nine branch deletions that nothing had verified. Neither replaces the
other.

That pattern lives here as `npm run check:review`: it runs `codex exec review`
over the diff, prints findings, and always exits 0. Pointed at its own diff
before anything else, it found six defects in itself. The eight false-verdict
defects the same audit found in this repo's gates were all one shape, a check
that had found the condition it exists to reject and then exited 0.

## The plugin surface

`codex@openai-codex` 1.0.6 ships no MCP server of its own. Its commands and its
agent shell out to the CLI, so "plugin versus MCP" is really CLI versus MCP.

| Command | What it does |
|---|---|
| `/codex:setup` | Checks the local CLI is ready; toggles the stop-time review gate. |
| `/codex:review` | Review against local git state. `--wait`/`--background`, `--base <ref>`, `--scope auto\|working-tree\|branch`. |
| `/codex:adversarial-review` | Challenges the approach and the design choices, not just implementation defects. |
| `/codex:rescue` | Hands investigation or a fix to the `codex:codex-rescue` subagent. Write-capable by default. |
| `/codex:status`, `/codex:result`, `/codex:cancel` | Background job control per repository. |
| `/codex:transfer` | Turns the current Claude session into a resumable Codex thread. |

Two rules the plugin enforces and that are worth keeping by hand: after
presenting review findings, stop, because auto-applying a fix from a review is
forbidden even when the fix is obvious; and a failed Codex run does not get
quietly replaced by a Claude-side attempt, it gets reported as a failure.

## How to verify any of this

**The channel is live.** `codex login status` prints `Logged in using ChatGPT`.
`codex --version` should be at least 0.151.0, because `exec review` flag
behaviour is version-sensitive. One trivial MCP call returning within about 10 s
with a `threadId` proves the server, the auth and the threading together.

**The sandbox default is what you think.** Read `sandbox_mode` in
`~/.codex/config.toml`, then dispatch a call with `sandbox: "read-only"` and ask
it to create a file. It should refuse; a success means the override did not
take.

**The model that ran is the model you asked for.** Dispatch with an explicit
`model`, then read `turn_context.model` from the newest `rollout-*.jsonl` under
`~/.codex/sessions/`.

If any of these disagrees with what is written above, this document is stale
rather than the machine, and the figure here should be replaced with what you
measured.
