# Fleet across machines

The Claude Code session registry is **machine-local**. A fleet board on one host
silently claims to show "the fleet" while covering one machine — and nothing
surfaces the gap, because a missing session produces no error.

This is how a second machine joins in. It takes about ten minutes and needs no
credentials.

## What crosses, and what deliberately does not

**Counts only.** A published record is exactly this:

```json
{ "host": "Beast", "platform": "win32", "publishedAt": "2026-08-21T20:32:05.734Z",
  "windowDays": 2, "sessions": 62, "blocked": 2, "oldestBlockedMin": 1,
  "byState": { "blocked": 2, "working": 9, "waiting": 32, "cold": 13 }, "schema": 1 }
```

No titles, no branches, no paths, no panel text. That is not caution, it is two
hard constraints:

1. **`claude-auto-dev` is a PUBLIC repo**, and the house rule is to assume every
   private repo eventually becomes public anyway. Session titles ("Retry Spotify
   429 in convert-spotify-to-youtube"), branch names and panel questions are all
   working context.
2. **The fleet contains CLIENT work.** Client material never goes to personal
   GitHub. A session title is client-derived metadata just as surely as code is,
   so this rules out `claude-memory` too for anything identifying — private or
   not.

Counts still answer what a remote board is actually for: **does the other machine
need me?** If yes, you go to that machine for the detail.

**Do not widen the payload.** `scripts/fleet-publish.js` has a test that derives
its forbidden strings from the live fleet rather than a hand-written list, so
adding an identifying field will fail it rather than quietly leaking. If you add
a field, ask whether it would be safe on a public repo — that is the standard,
regardless of where it lands.

## Setup on macOS

### 1. Clone this repo, and have a private sync location ready

```bash
git clone https://github.com/djnsty23/claude-auto-dev.git ~/claude-auto-dev
```

You also need somewhere private for the status file to ride in — a private git
repo both machines already sync. **This document does not name it**, because this
repo is public and pointing at a private one from here is exactly the leak the
payload rules below exist to prevent.

`fleet-publish.js` defaults to `~/claude-memory/fleet/`. Point it wherever your
private sync location actually is:

```bash
export AUTODEV_FLEET_PUBLISH_DIR="$HOME/<your-private-sync-repo>/fleet"
```

Set it in the launchd job too (step 4) — launchd does not read your shell profile.

### 2. Check it reads your sessions

```bash
node ~/claude-auto-dev/plugins/autodev-core/scripts/fleet-status.js --days 2
```

If this prints 0 transcripts, the transcript root differs on your machine — the
script looks in `~/.claude/projects`. Fix that before going further; everything
downstream reads from it.

### 3. Publish once, by hand, and read the output

```bash
node ~/claude-auto-dev/plugins/autodev-core/scripts/fleet-publish.js --print
```

`--print` writes nothing. **Read what it would publish before you let it run on a
timer** — that is the moment to catch a payload you are not comfortable with.
Then publish for real:

```bash
node ~/claude-auto-dev/plugins/autodev-core/scripts/fleet-publish.js
node ~/claude-auto-dev/plugins/autodev-core/scripts/fleet-publish.js --read
```

### 4. Put it on a timer

macOS uses launchd rather than Task Scheduler. Write
`~/Library/LaunchAgents/com.autodev.fleet-publish.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>            <string>com.autodev.fleet-publish</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/CHANGEME/claude-auto-dev/plugins/autodev-core/scripts/fleet-publish.js</string>
  </array>
  <key>StartInterval</key>    <integer>300</integer>
  <key>RunAtLoad</key>        <true/>
  <key>StandardErrorPath</key><string>/tmp/fleet-publish.err</string>
</dict>
</plist>
```

Replace `CHANGEME`, and check `which node` — Homebrew on Apple Silicon puts it at
`/opt/homebrew/bin/node`, not `/usr/local/bin/node`. launchd does not use your
shell's PATH, so the absolute path matters.

```bash
launchctl load ~/Library/LaunchAgents/com.autodev.fleet-publish.plist
```

### 5. Verify the WORK ran, not just the launcher

Same discipline as the Windows side: a scheduler reporting success means the
process started, not that it did anything. The artifact is the file's timestamp.

```bash
ls -l "$AUTODEV_FLEET_PUBLISH_DIR"
node ~/claude-auto-dev/plugins/autodev-core/scripts/fleet-publish.js --read
```

If the file is not being refreshed, read `/tmp/fleet-publish.err`.

### 6. Let it reach the other machine

The file only becomes visible elsewhere once that private repo is pushed. On
Windows a scheduled sync task does that every ~4h. On macOS there is no
equivalent yet, so either commit and push it yourself, or add a second launchd
job that does. **Until it is pushed, nothing crosses.**

## Latency, and why the board stamps ages

This rides a periodic git push, not a live connection, so a chip can read
"as of 3h ago" while that machine went blocked minutes later. The board therefore
stamps every machine chip with its age and dims anything past six hours. **A
synced count read as current is the whole failure mode** — never present one
without its age.

## What does NOT work on macOS yet

`fleet-notify.js` is **Windows-only**: `toast.ps1` uses the WinRT notifier. The
script now says so plainly on other platforms rather than failing obscurely. The
macOS equivalent is `osascript -e 'display notification "..." with title "..."'`
and nobody has written it.

Publishing is unaffected — a Mac can contribute to the board without ever
notifying anyone locally.
