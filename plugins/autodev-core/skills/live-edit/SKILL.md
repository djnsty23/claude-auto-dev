---
name: live-edit
description: "Apply a spoken or typed change to a site on localhost within seconds and show, on the page itself, how long until that change would be live in production: pending changes, an ETA as a duration and a clock time, and the measured parts behind it."
when_to_use: "Invoked when the user says \"live edit\", \"edit it live\", \"show me on localhost\", \"when would this be live\" or \"ETA until launch\", and when they want to iterate on a page by voice or chat while watching the browser pane."
allowed-tools: Bash, Read, Edit, Write, Grep, Glob, mcp__Claude_Browser__*
model: opus
user-invocable: true
argument-hint: "[site directory] [the first change to make]"
---

# Live edit

The owner says a change. It shows on localhost within seconds, and a small pill
on the page says when it would be live in production. "Launch" here means the
moment this change is live on the production site.

The overlay comes from `${CLAUDE_PLUGIN_ROOT}/scripts/live-edit.js`, a proxy in
front of the dev server. It adds one script tag to each HTML response. Nothing
is written to the site's repository, so a production build cannot contain it.

## Step 1: start the page behind the helper

Work in a git worktree of the site, never its main clone.

Add one entry to `.claude/launch.json` in the session's working directory, then
start it with `preview_start`:

```json
{
  "name": "site-live-edit",
  "runtimeExecutable": "node",
  "runtimeArgs": ["${CLAUDE_PLUGIN_ROOT}/scripts/live-edit.js", "serve", "--dir", "<absolute site directory>", "--port", "3417"],
  "port": 3417
}
```

Write the plugin root as an absolute path in that file: the launcher does not
expand variables.

The helper starts `npm run dev -- --port N` on a free port and stops it when it
exits. For another command, put it after `--` and read the port from `PORT`. For
a dev server that is already running, pass `--upstream http://localhost:N`.

Done when the page shows the pill and the console is clean.

## Step 2: calibrate once per repository

The ETA is a sum of measured parts. Build the samples file from records that
already exist:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/live-edit.js" calibrate --repo OWNER/NAME \
  --out "$(git rev-parse --path-format=absolute --git-common-dir)/live-edit/calibration.json" \
  --review-receipts <receipt files or folders> --fast-receipts <receipt files or folders> \
  --deployments deployments.json --merges merges.json --land-minutes <cron minute>
```

| Part | Source |
|---|---|
| Gate, full | The release records beside the gate lock. Read by default. |
| Gate, fast lane | Green `fast-lane.js` receipts, the sum of their steps. |
| Review | Review receipts, their `ms`. An escalation is not a review. |
| Landing | `merges.json` from `gh pr list --state merged --limit 40 --json number,mergedAt,commits`, against the landing routine's cron minute. |
| Production build | `deployments.json`: the host's production deployments as `[{ createdAt, ready, readyState, target }]`, times in milliseconds. |

The command prints every input with its sample count. Show that print to the
owner. A part with no samples reads "not measured" and the total is marked as a
floor. Never type a number in by hand.

## Step 3: one loop per instruction

1. Edit the source.
2. Record the change in the owner's words:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/live-edit.js" note --dir <site directory> --text "Hero button now reads: Tell us about your project."`
3. Confirm in the Browser pane that the new text is there **without a reload**:
   read the page, and check the document is the one that was open before the
   edit. Never navigate or refresh to make a change appear. A reload hides a
   broken hot reload.
4. Tell the owner the seconds from instruction to visible change.

The pill counts the notes written since the branch point. Without notes it
lists the changed files.

## Step 4: say what the ETA means

The panel lists the parts: gate, review, the wait for the next landing slot and
the production build. The gate is the fast lane when `fast-lane.js` accepts the
working tree's diff, the full gate otherwise.

`--headline queue` (the default) waits for the landing slot. `--headline direct`
uses the measured time of merges made outside the queue. Check which one the
repository's recent merges took before choosing:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/live-edit.js" backtest --calibration <file> --cases cases.json
```

`cases.json` holds past merges as `[{ pr, pushedAt, liveAt, lane }]`. Report the
error it prints with the ETA, never the ETA alone.

## Limits

- The overlay exists only on pages loaded through the helper's port.
- A page whose Content-Security-Policy pins scripts by hash refuses the tag. A
  nonce policy works: the tag carries the page's nonce.
- The pill moves to a spot that covers none of the page's controls when it is
  placed. A control in the page flow can still scroll under it.
- How the instruction arrives (typed, dictated) is outside this skill. It starts
  at the text.

## Never

- Never add the overlay to the site's own code.
- Never inject it with a browser tool's script runner: that copy dies on reload.
- Never push or merge from the live-edit worktree. Shipping the change goes
  through the product's normal gate and review.
