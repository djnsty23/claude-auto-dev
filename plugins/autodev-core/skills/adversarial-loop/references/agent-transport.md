# Agent transport measurements

This file holds the measured cost of driving the adversary through a desktop app, an MCP server and a CLI, and the operational notes that came out of it.

`[measured 2026-08-31]` The same audit was driven by computer-use into a
desktop app, and the transport — not the model — produced most of the waste:
roughly fifteen click batches lost to focus changes, two stale clipboard
re-pastes that burned two entire review cycles, and several stalls waiting for
a human to unlock the machine.

An MCP server removes that failure class outright. Measured against the same
vendor's CLI on identical prompts:

| | MCP | CLI |
|---|---|---|
| Latency | 8,245 ms median | 8,993 ms median — a tie, ~8s is inference |
| Server startup | 207 ms, paid once | full process per call |
| Input tokens per call | 22,800 | 29,343 (−22% for MCP) |
| Multi-turn | returns a thread id; replies continue it | a thread another writer holds refuses resume |
| Concurrency | two calls in flight returned at +7.3s and +7.9s, not 2x | one process per call |
| Output | structured JSON | stdout to scrape |

Two operational notes that cost real time to learn:

- **The CLI appends piped stdin to the prompt.** Spawning it with an open stdin
  pipe blocks forever waiting for EOF. Close stdin explicitly.
- **Put the commit SHA in every message.** It is what catches a duplicate or
  stale send immediately, instead of spending a review round on already-reviewed
  work.

Pick the reviewing model deliberately and verify what RAN, not what was asked:
a per-call model override is honoured, but read it back from the vendor's own
session log before trusting it.
