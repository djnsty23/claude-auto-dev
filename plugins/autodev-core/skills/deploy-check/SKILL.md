---
name: deploy-check
description: "After a merge to the production branch, wait for that exact revision to be live, run the product's smoke command against the live URL, and record PASS, FAIL or TIMEOUT with evidence per acceptance item. A failure opens one draft revert pull request and nothing else: no push to main, no merge, no promote."
when_to_use: "Invoked when the user says \"deploy check\", \"is it live\", \"verify the deploy\", \"smoke test prod\", \"did the merge deploy\", right after a merge-lock.js merge lands on the production branch, and before saying a change is live."
allowed-tools: Bash, Read, Grep, Glob, mcp__Claude_Browser__*
model: sonnet
user-invocable: true
argument-hint: "<merged sha> [--prod-url URL]"
---

# Deploy check

Merged is not live, and live is not working. This skill closes the loop after a
merge: it proves the production deployment is the merged commit, runs the
product's own smoke command against it, and leaves a PASS, FAIL or TIMEOUT
record that a reader can check. It is the cheap, mechanical half of `ship`
Step 5. The judgement half (every entry point, auth, mobile layout) stays in
`ship`.

## What it may and may not do

| May | May not |
|-----|---------|
| Read the platform, run the smoke command, read the live URL | Push to the production branch |
| Write PASS/FAIL/TIMEOUT to the deploy ledger | Merge anything |
| On FAIL, let `deploy-gate.js` open one draft revert PR and notify the owner once | Promote, roll back or redeploy on the platform |
| | Mark the revert PR ready, or merge it |

A revert needs the owner. The draft PR is the proposal, and it goes through
`autoreview` and `merge-lock.js` like any other change.

## Step 1: the product opted in

The product's `package.json` needs a smoke command:

```json
{ "autodevDeployGate": { "smoke": "node scripts/smoke.js {url}" } }
```

`{url}` is replaced by the production URL. The command is split into arguments
and run without a shell, so keep it a single program call. With no smoke command
`deploy-gate.js` exits 2 and says so. That is "not run", never PASS: report it
as a gap and name the file to edit.

## Step 2: run it

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/deploy-gate.js" --repo-dir "$DIR" --sha "$SHA" \
  --prod-url "$URL"
```

Add `--timeout-ms N` to change the 15-minute wait. Add `--dry-run` to see what
it would do (the revert it would open included) without touching git or GitHub;
use it the first time on a product.

It waits for the production deployment of `$SHA`, runs the smoke command, and
appends PASS, FAIL or TIMEOUT to the deploy ledger. Read its printed verdict and
that ledger event. Do not infer the verdict from the exit code alone.

| Result | Meaning | Next |
|--------|---------|------|
| PASS | The deployment is the merged commit and the smoke command exited 0 | Step 3 |
| FAIL | Live and the smoke command failed | A draft revert PR exists and the owner was notified once. Keep the failing output. Do not retry the smoke command until it passes |
| TIMEOUT | The commit never went live in time | Read the platform status. A stuck build is a platform fault, not a code verdict. Report it as unresolved |
| exit 2 | Not run (no smoke command, bad arguments, platform unreadable) | Report the gap. Never PASS |

## Step 3: the acceptance checklist, on the live URL

A passing smoke command is one probe. Build the checklist from the story's
acceptance criteria and the change's surfaces. Every row needs evidence you
produced after the deploy was live, on the live URL, not before it:

| # | Item | Evidence |
|---|------|----------|
| 1 | The live build is the merged commit | The platform's deployment record for `$SHA`, or the version string the page serves |
| 2 | The smoke command passed | The command line, exit code and last lines of output |
| 3 | The changed route loads, no console errors | Browser pane console read, or a URL plus status from `curl -sI` |
| 4 | Each acceptance criterion holds | The flow you drove, and a screenshot path or response body |
| 5 | An unchanged neighbour route still works | The same kind of evidence |

For each row write PASS or FAIL beside its evidence. A row you did not run is
`not run`, which is not a pass. A blank evidence cell is a FAIL. Screenshots
come from the browser pane at phone width for a user-facing change; when the
pane is hidden, do the DOM pass and say that no screenshot was taken.

The checklist passes only when every row is PASS. One FAIL fails the deploy
check even when the smoke command passed.

## Step 4: report

One block, in this shape:

```
Deploy check: <PASS|FAIL|TIMEOUT|NOT RUN>
Commit: <full sha>   Live URL: <url>
Smoke: <command>, exit <n>
Checklist: <n> of <n> PASS   (rows that failed or did not run listed by number)
Revert PR: <draft PR URL or none>
```

PASS with the checklist complete is a deploy-done event for the owner. FAIL is
a deploy-failed event. Both go through `notify-policy.js` and nothing else
does; see `rule-own-the-loop`. A TIMEOUT or a gap is blocked-on-owner only when
you cannot resolve it yourself.

## Rules

- Never claim live from a green merge. Read the platform.
- Never push the production branch, merge, or promote from this skill, even when
  the revert looks obvious.
- Every number in the report names the command that produced it.
