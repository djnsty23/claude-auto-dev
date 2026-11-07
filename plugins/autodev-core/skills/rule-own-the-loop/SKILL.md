---
name: rule-own-the-loop
description: "A coordinator carries a task to done itself and pings the owner only for an owner decision, a PR ready to merge with both receipts, or a deploy outcome. Everything else goes to the daily digest. Steer the worker you have, pick the cheapest capable model tier. Load before notifying the owner or spawning a worker."
when_to_use: "Before notifying the owner about anything, before spawning or replacing a worker, and before choosing a model for a step. Always-on background rule for coordinators. Not user-invocable."
user-invocable: false
allowed-tools: Read, Bash, Grep
paths:
  - "**/prd.json"
  - "**/PUBLISH-QUEUE.md"
  - "**/*.workflow.js"
---

# Own the loop

A coordinator that hands every decision back to the owner is a relay, and a
relay costs the owner more attention than doing the work. Own the task until it
is done, deployed and verified. Interrupt the owner for four things only.

## 1. Who gets pinged

| Event | Notify the owner? | Condition |
|-------|-------------------|-----------|
| `blocked-on-owner` | Yes | A decision, credential or action only the owner can give, after you have tried what you can. One line: what is needed, the exact command or link |
| `ready-to-merge` | Yes | The PR has a review receipt with verdict approve (or escalate beside an opus escalation receipt) AND a gate (or fast-lane) receipt, all for the current head. A sensitive diff also has its escalation receipt |
| `deploy-done` | Yes | `deploy-check` recorded PASS and its checklist is complete |
| `deploy-failed` | Yes, once | `deploy-gate.js` recorded FAIL, with the draft revert PR link |
| Anything else | No | Progress, a retry, a worker finishing, a review round, a green gate alone, an idle worker |

Route every event through `notify-policy.js`. It returns `notify` for the four
rows above and `digest` for everything else, and a digest event appends one line
to the daily digest at `~/.claude/autodev/digest/YYYY-MM-DD.md`. An unknown kind
goes to the digest too: it is never dropped and never promoted.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/notify-policy.js" --kind ready-to-merge --repo "$REPO" --pr "$PR" \
  --sha "$HEAD" --review-receipt "$REVIEW" --gate-receipt "$GATE" --summary "<one line>"
```

It prints `notify <kind>` or `digest <kind>`. `ready-to-merge` without both
receipts is a digest line, not a notification: a PR that is green but
unreviewed is not ready. Exit 2 means nothing was recorded, so retry, do not
assume the owner heard.

Do not reword a digest event into an urgent one to get attention. If it is not
one of the four, it waits for the owner's next read of the digest.

## 2. Steer, do not respawn

A worker that has context is worth more than a fresh one.

- Message the existing worker or session with the next instruction. Start a new
  one only when the old one is gone, stuck on a pending prompt, or has the wrong
  worktree.
- Reuse the worktree. A new worker for the same PR branches in place; it does
  not create a second branch for the same change.
- Before restarting anything, read its state (`git status`, the PR, the last
  receipt). A finished worker with a red gate needs a message, not a replacement.
- Never hand the owner a question a command can answer.

## 3. The cheapest capable tier

`worker-profiles.js` exports `TIERS`. Use the lowest tier that can do the step
and move up only on a measured failure, never on a hunch.

| Tier | Runs | Use for |
|------|------|---------|
| reviewer | the command in `AUTODEV_REVIEWER_CMD` | The first read of every PR (`autoreview`) |
| builder | sonnet | Scoped implementation where an acceptance test exists before the worker starts |
| escalation, plan, ship | opus | A reviewer that could not settle a diff, planning, the release step, anything money, auth or irreversible |

A builder that comes back red on its first endpoint goes to the next tier with
the failing output, not to a second attempt at the same tier. A subscription or
free tier pays for these loops. A paid key in a worker's environment is refused
by `paid-key-guard.js`: do not work around it without the owner saying so.

## 4. The done bar for the loop

A task is done when its PR merged through `merge-lock.js` with both receipts,
`deploy-check` recorded PASS on the live URL, and the evidence for each is
named. Until then, keep going. Then send one `deploy-done`, and stop.

If you stop for any other reason, leave a record of what finished, what is
verified (command and output), what is blocked and on whom, and what you
propose. A promise in your last paragraph is work you should do now.
