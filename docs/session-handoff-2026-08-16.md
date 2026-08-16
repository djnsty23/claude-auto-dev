# Session prompt — evaluate the framework, then keep improving it

Paste everything below into a new session started in `/Users/andynastasa/Code/autodev`.

---

You are continuing work on **autodev**, a Claude Code plugin marketplace at
`/Users/andynastasa/Code/autodev` (public: `github.com/djnsty23/claude-auto-dev`).
It is currently **v8.15.0**, clean, and installed. Nine releases shipped on
2026-08-16 (8.7 → 8.15).

## Start by evaluating, not building

Run these four and read the output before proposing anything:

```bash
node tooling/test-all.js && npm run check:suites && node plugins/autodev-core/scripts/drift-audit.js && node plugins/autodev-core/scripts/find-orphan-checks.js .
```

`check:suites` is the newest and the one to trust least — it is one day old. It
stubs each suite's subject and asserts the suite goes red. It found three bugs in
*itself* on the way in, so assume a fourth.

## The rule that governs everything here

**`rule-ab-testing` is not optional and it is not ceremony.** Across two sessions
it overturned fifteen recommendations. Six proposed detectors were built,
measured, and thrown away because they found nothing true. Before you recommend
anything:

1. Measure the current behaviour first. "Faster" and "cheaper" are meaningless
   without the number they improve on.
2. Measure at least one alternative. Comparing only against doing nothing hides
   the case where a simpler variant wins.
3. **Read every finding before reporting a count.** A detector's output is a
   hypothesis. Most counts this framework produced were false positives.
4. **Run the fix you recommended before calling it shipped.** Four reversals were
   invisible until the recommendation was executable and executed.
5. **"No detector fits" is a legitimate result**, and cheaper than a checker
   nobody trusts. Record the dead end so it is not rebuilt.

The eleven-plus dead ends are already in
`plugins/autodev-core/skills/rule-ab-testing/SKILL.md`. **Read that table before
proposing a detector** — you will otherwise rebuild one of them.

## What is actually open

### autodev (free rein — commit and push without asking)

- **Git history still carries three private project names.** The working tree is
  anonymised (Project A/B/C) and `tooling/check-no-private-names.js` gates it, but
  history is untouched. Andy decided on 2026-08-16 to leave it. Do not reopen
  without being asked.
- **The `stop-auto-check` change from 8.9.0 needs a fresh session to take
  effect** — hooks register at session start, from a version-numbered path. If you
  are that fresh session, it is live.
- `check-suites-can-fail.js` reports `test-all.js` via a different path (make a
  child fail, assert the runner notices). Worth extending: it does not yet check
  that `validate.js` can fail.

### Product repos — ASK BEFORE TOUCHING. They deploy to production.

Andy's standing rule: *"Commit and push autodev, ask for product repos."*

| Repo | State |
|---|---|
| **ecommercebenchmark** | On branch `docs/prd-reconciliation-2026-08-16`, pushed. 14 of 15 pending stories untouched >30d (median 61d, oldest 99d). S1-060 rotation is console work only Andy can do. S3-013 is ~4/5 built and never flipped. S2-014's deliverable exists and is cited nowhere. S1-021 closes with one look at Bitbucket repo settings. |
| **fitmito** | `fix/comment-satisfied-gates-and-nudge-auth` pushed, unmerged — 2 P0 fixes + a runbook. Default branch is 42 behind; **five to eight sessions work in this repo concurrently**, so never `git checkout` in the main tree — use `git worktree add`. |
| **spotivibly** | 22 `S16-AUD-*` findings logged, none actioned. `S16-AUD-130` is **confirmed**: `/admin/server-errors` sits in `release-smoke.mjs:1057` and is absent from `App.tsx`, so it renders NotFound, returns 200, and the gate has always passed on a page that does not exist. A code comment at `:649` already *acknowledges* it renders NotFound and the route stayed in the list. |

### The finding that needs a human decision

In **fitmito**, `S4-AUD-72` and `S4-AUD-73` are marked `passes: true`, titled
`FIXED 2026-08-16`, with bodies reading *"CONFIRMED live and FIXED"*. The
verification behind them was excellent — an unauthenticated production call
returning HTTP 200. **The fix exists nowhere**: not on the default branch, not on
the 25 most recent remote branches, not in any of the 8 live worktrees including
uncommitted changes. The only fix in the repo is on the unmerged branch above.

There is also a real design disagreement to settle, not to steamroll: that
session argues the endpoint is unauthenticated *by design* for the service
worker, so the bug is the cron writing PII into a public fallback. The pushed
branch instead puts the endpoint behind auth. Both close the leak; they differ on
which side pays. **Andy decides.**

This is already encoded as a rule in `rule-verification` ("closing a task is a
claim"), and two detectors for it were measured and dropped — see the table.

## Conventions that will bite you

- **Never `cd` into a repo and `git checkout`** if other sessions are live there.
  Use `git worktree add`, and remove the worktree when done.
- **`git reset --hard` is blocked** by `pre-tool-filter`. That is deliberate.
- **Avoid nested quoting in `node -e` inside Bash.** It failed four times in one
  session. Use `Write` to a scratch file and run that.
- **Bump, tag, push, and reinstall all three plugins together.** Installing only
  `autodev-core` left memory and stack three versions behind — the drift audit
  caught it, which is the only reason it was noticed.
- Scratch files go in the session scratchpad, never `/tmp`.

## Close every turn with an AskUserQuestion menu

This is Andy's standing global preference. Options must be concrete work with
different outcomes, recommended first, `multiSelect: true` unless the paths
genuinely exclude each other, and descriptions that state the consequence rather
than restating the label.

## What to do first

Evaluate. Report what the four commands actually say, including anything that
contradicts this document — it was written by the session that just finished and
is exactly the kind of artifact that goes stale. Then propose the next
improvement **with a measurement attached**, and expect to throw it away.
