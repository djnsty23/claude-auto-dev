---
name: autoreview
description: "Review a pull request with a cheap model before it merges, and write the review receipt merge-lock.js requires. A strict-JSON verdict (approve, request_changes or escalate) from a low-cost reviewer, checked against the story's acceptance criteria. Only an escalation reaches the expensive opus reviewer."
when_to_use: "Invoked when the user says \"autoreview\", \"review this PR\", \"cheap review\", \"get a review receipt\", \"is this PR ready to merge\", before any merge-lock.js merge, and whenever a PR has a green gate but no review receipt."
allowed-tools: Bash, Read, Grep, Glob, Task, Write, Edit
model: sonnet
user-invocable: true
argument-hint: "<PR number> [--max-lines N]"
---

# Autoreview

A merge needs two receipts: one that the tree passed its gate, and one that a
reviewer read the diff against what the story asked for. This skill produces
the second one at the lowest cost that is still a real read. The cheap reviewer
sees every PR. The opus `code-reviewer` agent sees only what the cheap one
cannot settle.

## Before you start

1. The PR is rebased onto its base and its gate (or fast-lane) receipt exists
   for the exact head. A review of a head that then moves is void: the receipt
   names the head and merge-lock refuses any other.
2. Read the head the PR has now, from the source, not from memory:

```bash
gh pr view "$PR" --repo "$REPO" --json headRefOid,baseRefName,state
```

3. Is the diff sensitive? Money, auth, sessions, migrations, RLS and policy
   paths are. Ask the classifier, then add your own judgement:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/fast-lane.js" classify --repo-dir "$DIR" --head "$HEAD" --json
```

   Its reasons name any sensitive path. A diff it calls ineligible only for size
   is not sensitive. When in doubt, treat it as sensitive: the cost is one extra
   pass, the saving is a payment bug.

## Step 1: run the cheap reviewer

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cheap-review.js" review \
  --repo "$REPO" --pr "$PR" --head "$HEAD" --repo-dir "$DIR" \
  --out "$DIR/.claude/reports/review-$PR.json" --prd prd.json
```

Add `--max-lines N` to change the 1500-line cap and `--comment` to post a short
summary on the PR. The script builds the prompt from the diff, the story whose
id appears in the branch name or PR body, `.claude/project-rules.md` and the
before/after evidence links in the PR body. It writes the receipt for every
verdict it reaches (exit 0, 1 and 3).

| Exit | Verdict | What you do |
|------|---------|-------------|
| 0 | approve | Step 3 |
| 1 | request_changes | Step 2 |
| 3 | escalate | Step 4 |
| 2 | indeterminate (usage or IO error, no receipt written) | Fix the cause and run it again. It is neither an approval nor a rejection |

Read `reason` and `findings` in the receipt. The script escalates, rather than
approves, when the reviewer output is invalid or empty, the reviewer times out
or exits non-zero, cannot be started, the diff is over the cap or empty (the reviewer is not called at all),
any acceptance item is `met:false`, the reviewer approves with a P0 finding, the
PR head is not the `--head` you passed, or the diff falls in a risk class and
the reviewer approved it (`risk-class: ...`): a new paid call, a cron, queue or
job, a link token or signature, or a diff over 1000 lines (`--risk-lines`). The
receipt lists them in `risk_classes`. Escalation is the safe direction.

### The reviewer

`cheap-review.js` finds the reviewer in this order: `AUTODEV_REVIEWER_CMD`, then
`agy` on PATH, then on Windows `%LOCALAPPDATA%\agy\bin\agy.exe`, then
`gemini -p`. It runs it with an allowlisted environment and an empty temp
directory as cwd, so a reviewer cannot read the checkout or your shell's
secrets.

| Variable | Meaning |
|----------|---------|
| `AUTODEV_REVIEWER_CMD` | The reviewer command line. The prompt goes on stdin |
| `AUTODEV_REVIEWER_MODEL` | The model name to record in the receipt |
| `AUTODEV_REVIEWER_ENV` | Comma-separated names of extra env vars to pass through, such as a provider key |
| `AUTODEV_REVIEWER_COST_PER_MTOK` | Price per million tokens, to estimate `est_cost` |

A paid API key in the reviewer's environment is refused by `paid-key-guard.js`:
this loop runs on a subscription or a free tier. Do not set
`AUTODEV_ALLOW_PAID_KEY=1` unless the owner said to pay for this run.

## Step 2: request_changes

Fix every P0 and P1 finding at the file and line it names, in the PR's own
worktree, or hand them to the builder worker that owns it (steer the existing
worker, do not start a new one). Run the gate again, push, take the new head
from `gh pr view`, and re-run Step 1 with that head. A P2 finding is advisory:
list it in the PR, do not block on it.

Stop after three rounds on one PR. A reviewer and a builder that disagree three
times need an owner, not a fourth loop: that is blocked-on-owner.

## Step 3: approve

For a diff that is not sensitive, pass the receipt to the merge lock with the
gate receipt:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/merge-lock.js" merge --repo "$REPO" --pr "$PR" --head "$HEAD" \
  --gate-receipt "$GATE" --review-receipt "$DIR/.claude/reports/review-$PR.json"
```

Use `--fast-lane-receipt` instead of `--gate-receipt` when the fast lane was the
bar. When the reviewer could not run and a person read the diff, the only
substitute is `--review-override "<reason>"` with a reason of at least ten
characters. It is recorded in the deploy ledger.

## Step 4: escalate, and sensitive diffs

Escalate means the cheap read is not enough. A sensitive diff needs more than
the cheap read whatever its verdict.

**Two independent passes for money, auth and migration diffs.** Follow the
`review` skill: run Step 1 twice with different `--out` files. Give both the
same prompt, let neither see the other's findings, and ask each to list what it
checked and found clean. Use two different reviewers where you have them
(`AUTODEV_REVIEWER_CMD` differs per run). Merge the two lists, drop duplicates,
and check each surviving finding against the code. Both receipts must read
approve. Pass the first to merge-lock and keep the second beside it.

**The opus pass.** On escalation, and always on a sensitive diff, dispatch the
existing `code-reviewer` agent pinned to opus with the `Task` tool:

- `subagent_type`: `autodev-core:code-reviewer`; `model`: `opus`.
- The brief names the repo, PR, full head SHA, the story's acceptance criteria,
  and the receipt's `findings` and `reason`, so it knows what the cheap pass
  could not settle.
- It has no write tool. It reads the diff and, when it approves, prints the
  escalation receipt as one JSON block:
  `{"schema":1,"repo":"OWNER/NAME","pr":N,"head":"<sha>","reviewer":"code-reviewer","model":"<model id containing opus>","verdict":"approve"}`.

Save that block yourself with `Write` to `$DIR/.claude/reports/escalation-$PR.json`
exactly as printed. Do not edit the model or the verdict, and do not write one
the agent did not print. If it requests changes, go to Step 2 with its
findings. Then merge:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/merge-lock.js" merge --repo "$REPO" --pr "$PR" --head "$HEAD" \
  --gate-receipt "$GATE" --review-receipt "$DIR/.claude/reports/review-$PR.json" \
  --escalation-receipt "$DIR/.claude/reports/escalation-$PR.json"
```

The same command lands an `escalate` review receipt: merge-lock accepts that
verdict only beside an escalation receipt for the same repo, PR and head. A
review override does not waive the escalation receipt on a sensitive diff.

## After

Say what ran: the reviewer command and model from the receipt, the verdict, the
number of rounds, and whether the opus pass ran. A notification goes to the
owner only through the policy in `rule-own-the-loop`: a PR with both receipts
is ready-to-merge, and anything else is digest.

## What this does not claim

The receipt is text. It stops an unreviewed head merging by mistake, and it
does not stop a forgery. A cheap model can also be wrong in the reassuring
direction, which is why a P0 with an approve, an unmet acceptance item and an
oversize diff all turn into escalate. When a defect slips past an approve, add
its class to `.claude/project-rules.md` so the next prompt carries it.
