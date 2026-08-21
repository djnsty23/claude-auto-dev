#!/usr/bin/env node
/**
 * watch-panels.js — emit ONE line per newly-blocked session, for the Monitor tool.
 *
 * Why a script and not an inline poll loop: the hook blocks long `node -e`, and a
 * failure there is silent. Why dedup on sessionId+askedAt rather than sessionId:
 * a session can raise several panels in a row, and each is a separate question
 * that deserves its own ping. Same key fleet-notify.js uses.
 *
 * Coverage note, per the Monitor contract: silence must not be able to mean
 * "the watcher died". A failed scan prints a WATCHER-ERROR line rather than
 * being swallowed, so a broken probe is distinguishable from a quiet fleet.
 */
const { execFileSync } = require('child_process');
const path = require('path');

const SCRIPTS = path.join(
  process.env.USERPROFILE,
  'claude-auto-dev',
  'plugins',
  'autodev-core',
  'scripts',
);
const FLEET_STATUS = path.join(SCRIPTS, 'fleet-status.js');
const INTERVAL_MS = 60_000;

// Self, so the overseer is not pinged about its own panels. Measured: the first
// armed version reported the running session's own AskUserQuestion back to it.
//
// This MUST NOT be hardcoded. The scratch version carried one session's literal
// id, which in a shipped script would exclude the wrong session forever — the
// overseer would be pinged about itself and silent about a real one.
// Pass --self <sessionId> or set AUTODEV_SELF_SESSION. Absent, nothing is
// excluded, which is the safe direction: a duplicate ping, never a missed one.
const argv = process.argv.slice(2);
const selfFlag = argv.indexOf('--self');
const SELF =
  (selfFlag !== -1 && argv[selfFlag + 1]) || process.env.AUTODEV_SELF_SESSION || null;

// Dedup state persists to disk. Measured the hard way: restarting the monitor to
// pick up a code fix reset an in-memory Set, and three panels that had ALREADY
// been answered were re-reported as new. A watcher whose memory dies with its
// process re-raises resolved work every time you improve it.
const fs = require('fs');
// State lives with the other fleet artifacts, not beside the script: the script
// now ships inside a VERSION-KEYED plugin cache path, so __dirname changes on
// every release and the dedup memory would reset each time.
const FLEET_DIR = process.env.AUTODEV_FLEET_DIR || path.join(process.env.USERPROFILE || process.env.HOME, '.claude', 'fleet');
const STATE = path.join(FLEET_DIR, 'watch-panels-seen.json');

function loadSeen() {
  try {
    return new Set(JSON.parse(fs.readFileSync(STATE, 'utf8')));
  } catch {
    return new Set();
  }
}
function saveSeen(set) {
  try {
    fs.mkdirSync(FLEET_DIR, { recursive: true });
    fs.writeFileSync(STATE, JSON.stringify([...set].slice(-500)));
  } catch {
    /* a failed write costs a duplicate ping, never a missed one */
  }
}

const seen = loadSeen();
let consecutiveErrors = 0;

function scan() {
  let raw;
  try {
    raw = execFileSync(process.execPath, [FLEET_STATUS, '--pending', '--days', '1', '--json'], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 90_000,
    });
    consecutiveErrors = 0;
  } catch (err) {
    consecutiveErrors++;
    // An empty result from a failed probe is a claim about the probe, not the
    // world. Only shout once it is persistent, so one transient miss is quiet.
    if (consecutiveErrors === 3) {
      console.log(`WATCHER-ERROR three consecutive scans failed: ${String(err.message).slice(0, 160)}`);
    }
    return;
  }

  let rows;
  try {
    const d = JSON.parse(raw);
    rows = Array.isArray(d) ? d : d.sessions || d.rows || [];
  } catch {
    console.log('WATCHER-ERROR fleet-status returned unparseable JSON');
    return;
  }

  let added = 0;
  for (const r of rows) {
    if (r.state !== 'blocked') continue;
    if (SELF && (r.sessionId === SELF || r.addressableId === SELF)) continue;
    const key = `${r.sessionId}|${r.pending?.askedAt || r.lastTs || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    added++;
    const id = r.addressableId || r.sessionId;
    // The shape is pending.questions[] — each with .question and .options[].label.
    // Verified against a live blocked row; an earlier guess at pending.question
    // produced "(question not captured)" on every ping, which is a ping worth
    // nothing: it tells you a session stopped but not what it asked.
    const qs = Array.isArray(r.pending?.questions) ? r.pending.questions : [];
    const parts = qs.map((q) => {
      const text = String(q.question || q.header || '?').replace(/\s+/g, ' ');
      const opts = (q.options || [])
        .map((o) => (typeof o === 'string' ? o : o.label))
        .filter(Boolean)
        .join(' | ');
      return opts ? `${text} [${opts}]` : text;
    });
    const body = parts.length ? parts.join(' ++ ').slice(0, 600) : '(no questions parsed)';
    console.log(`PANEL ${r.title || '(untitled)'} :: ${body} :: ${id}`);
  }
  if (added) saveSeen(seen);
}

scan();
setInterval(scan, INTERVAL_MS);
