#!/usr/bin/env node
/**
 * fleet-notify.js - tap you when a session becomes blocked.
 *
 * WHY THIS EXISTS ALONGSIDE THE BOARD: a pending panel is perishable.
 * `[measured]` 2026-08-21, three scans minutes apart found 2 blocked, then 0,
 * then 1, and two panels caught at 19:24 were answered inside fifteen minutes.
 * A board you have to remember to open misses exactly the window it exists for.
 * This inverts it - the fleet taps you.
 *
 * FIRES ONCE PER PANEL, NOT PER SCAN. The state key is sessionId + askedAt, so:
 *   - re-scanning the same open panel is silent
 *   - a NEW panel in the same session notifies again (askedAt changed)
 *   - a session that unblocks and later re-blocks notifies again
 * A notifier that repeats itself gets muted, and a muted notifier is worse than
 * none because it also stops you checking manually.
 *
 * Usage:
 *   node fleet-notify.js                # one pass
 *   node fleet-notify.js --watch 120    # every 120s until stopped
 *   node fleet-notify.js --dry          # print what WOULD fire, notify nothing
 *   node fleet-notify.js --test         # fire one sample toast and exit
 *
 * Always exits 0 in normal operation. Prints the population every pass, so a
 * quiet run is distinguishable from a broken one.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { scanFleet } = require(path.join(__dirname, 'fleet-status.js'));

const HOME = process.env.USERPROFILE || process.env.HOME;
// Overridable so the dedup test can exercise real state writes without touching
// the live file. The dedup is the load-bearing behaviour here, so it has to be
// testable against a real read/write cycle rather than mocked away.
const STATE = process.env.AUTODEV_FLEET_STATE
    || path.join(HOME, '.claude', 'fleet', '.notified.json');
const TOAST = path.join(__dirname, 'toast.ps1');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const DRY = has('--dry');
const DAYS = Number(val('--days', 2));
// Beyond this many at once, send one summary instead of a stack of toasts.
const MAX_INDIVIDUAL = 3;

function readState() {
    try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; }
}
function writeState(s) {
    try {
        fs.mkdirSync(path.dirname(STATE), { recursive: true });
        fs.writeFileSync(STATE, JSON.stringify(s, null, 1) + '\n');
    } catch { /* unwritable state just means we may notify twice */ }
}

// Swappable so the dedup test can count notifications without firing real
// toasts at a human who did not ask for four of them.
let notifier = null;
function setNotifier(fn) { notifier = fn; }

function toast(title, body) {
    if (notifier) { notifier(title, body); return; }
    if (DRY) { console.log(`  [dry] ${title} :: ${body}`); return; }
    try {
        execFileSync('powershell', [
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', TOAST,
            '-Title', title, '-Body', body,
        ], { stdio: 'ignore', timeout: 15000 });
    } catch (e) {
        // A failed toast must not kill the watch loop - the next pass retries,
        // and the state is only written for panels that actually notified.
        console.error('  toast failed: ' + e.message);
        throw e;
    }
}

/** One scan-and-notify pass. Returns how many notifications fired. */
function pass() {
    const fleet = scanFleet(DAYS);
    const blocked = fleet.sessions.filter((s) => s.pending);
    const state = readState();

    // Drop state for anything no longer blocked, so a later block re-notifies.
    const liveKeys = new Set(blocked.map((s) => s.sessionId));
    const before = Object.keys(state).length;
    for (const k of Object.keys(state)) if (!liveKeys.has(k)) delete state[k];
    const didPrune = Object.keys(state).length !== before;

    const fresh = blocked.filter((s) => state[s.sessionId] !== s.pending.askedAt);

    // Population every pass: a report that prints only a verdict cannot be told
    // apart from a probe that returned nothing.
    console.log(`${new Date().toISOString()}  ${fleet.population.transcripts} transcripts, `
        + `${blocked.length} blocked, ${fresh.length} new`);

    // The prune must be PERSISTED even when nothing new fires, or a session that
    // unblocks stays marked seen forever and re-blocking is silent. Returning
    // early here without writing was a real bug, caught by the dedup test.
    if (!fresh.length) {
        if (didPrune && !DRY) writeState(state);
        return 0;
    }

    let fired = 0;
    try {
        if (fresh.length > MAX_INDIVIDUAL) {
            const names = fresh.slice(0, 3).map((s) => s.title || '?').join(', ');
            toast(`${fresh.length} sessions are waiting on you`,
                `${names} and ${fresh.length - 3} more. Open the fleet board.`);
            fired = 1;
        } else {
            for (const s of fresh) {
                const q = (s.pending.questions[0] && s.pending.questions[0].question) || 'a question';
                const n = (s.pending.questions[0] && s.pending.questions[0].options || []).length;
                toast(s.title || 'A session is waiting', `${q}${n ? `  (${n} options)` : ''}`);
                fired++;
            }
        }
    } catch {
        return 0;   // notify failed: leave state untouched so the next pass retries
    }

    for (const s of fresh) state[s.sessionId] = s.pending.askedAt;
    if (!DRY) writeState(state);
    for (const s of fresh) console.log(`  notified: ${s.title || s.sessionId}`);
    return fired;
}

function main() {
    if (has('--test')) {
        toast('Fleet — test', 'The notifier can reach you. No action needed.');
        console.log('sent one test toast (exit 0 means the API accepted it, not that it rendered)');
        return;
    }
    if (!fs.existsSync(TOAST)) {
        console.error('missing toast.ps1 beside this script — cannot notify');
        process.exit(0);
    }

    const watch = Number(val('--watch', 0));
    if (!watch) { pass(); return; }

    console.log(`watching every ${watch}s — ctrl-c to stop`);
    pass();
    setInterval(() => {
        try { pass(); } catch (e) { console.error('pass failed: ' + e.message); }
    }, watch * 1000);
}

if (require.main === module) main();
module.exports = { pass, setNotifier };
