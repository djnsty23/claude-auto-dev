# Runtime flow check

The steps, exit codes and measured reach of the runtime flow check in the auto skill. "As above" in step 1 means the dev-server block in SKILL.md, under Verification.

1. Start or find the dev server exactly as above.
2. Drive the **primary flow the criterion describes** with the browser tools:
   `navigate`, `find`, `form_input`, `computer`. For a bug fix, drive it
   first on the pre-fix tree and record what you read as `observedBefore`.
3. Read the outcome back, never eyeball it: `read_page` or `find` for a DOM
   count or text, `read_network_requests` for a request and its shape,
   `read_console_messages` for a log line or the error count, `javascript_tool`
   for a value the page holds. Use a **fresh tab** per check: the console
   buffer accumulates across navigations, and a tab left open across edits
   logs Fast Refresh errors that a fresh load does not reproduce. Read the
   error count once **before** the flow and record it as
   `consoleErrorsBaseline`; two dev trees here carried errors on every load.
   **While the Browser pane is hidden, `computer` clicks and key presses do
   not reach the page** (`[measured 2026-09-08]` a keydown listener saw
   nothing; `document.visibilityState` was `hidden`), while `navigate`,
   `find`, `form_input` and `javascript_tool` work. Front the tab with
   `tabs_select`, or dispatch the event from `javascript_tool`, and prove the
   input arrived before reading the outcome, or the red you report is about
   the probe.
4. Write `.claude/evidence/<story>/flow.json` — `node
   ${CLAUDE_PLUGIN_ROOT}/scripts/flow-evidence.js --template` prints the
   shape — with the steps, the assertion (`subject`, `claim`, `expected`),
   the `observed` value, screenshot paths, console error count, timestamp,
   and `commit`: the 40-character sha `git rev-parse HEAD` prints when the
   flow is driven, the tree the dev server was serving. The template fills it
   from the cwd; confirm it is still HEAD if you committed between driving and
   writing. Screenshot paths are **relative to the repository root**
   (`.claude/evidence/<story>/after.png`), not to the record's directory.
5. `node ${CLAUDE_PLUGIN_ROOT}/scripts/flow-evidence.js .claude/evidence/<story>/flow.json`.
   Exit 0 is PASS. Exit 1 is the product failing its own criterion: fix,
   re-drive, re-run. Exit 2 is the **record** being refused — no assertion,
   a "looked fine" claim, a `visual` subject, no observed value, or a
   `commit` that is missing, malformed, or not reachable from HEAD (the
   record was measured on another revision; `--at <sha>` verifies against a
   different commit) — and a refused record does not close a story. Commit the
   record with the change, as `prove` does with its captures: its `commit`
   is then the parent of the commit that carries it, which is what the
   ancestry rule expects.

**What it reaches, honestly.** `[measured 2026-09-08]` over 30 first-pass
fixes in a live repo, 4 were catchable by driving the primary flow with a state
assertion, 3 more only with specific data (a rate-limited account, a particular
prompt), 23 not at all — copy, contrast, cron, admin-only routes, server-side
counts. Replayed against the parent of three of those four fixes, the check
went red on every parent and green on every fix. It costs about 50 s and
three to five tool calls per story on a dev server the visual check already
needs. Cheap insurance on the 4, not a gate on the 30
(`docs/evidence-flow-verification-2026-09-08.md`).

**The Stop hook does not enforce this, on purpose.** `stop-auto-check.js`
blocks the end of a turn while pending stories remain; a block on a missing
flow record would hold every turn in a repo with no dev server, no browser
tools, or a criterion that names nothing user-visible. Enforcement is here, in
the verification step, and the validator is what makes the record checkable.
