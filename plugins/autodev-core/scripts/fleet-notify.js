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
 * A WORKER'S ASK TAPS YOU TOO. A headless worker or a runs/ job asks by writing
 * ask.json, and before 2026-09-24 only fleet-view.js showed it, on a page you had to
 * open. The asks come from fleet-view's own openAsks(), so the toast and the
 * page read the same files through the same code. An ask is keyed on its file
 * and stamped with its mtime: once per ask, again if the worker rewrites it.
 *
 * THE QUOTA TRIPWIRE RIDES THE SAME PASS. quota-tripwire.js was written to run
 * under a Monitor, which only exists while a session is open, so at night it
 * rang for nobody. Each pass now runs it once (`--once`) and toasts two things:
 *   - a PREP HANDOVER, keyed on the tripwire's own `firedAt`, so a toast the OS
 *     refused is retried on the next pass like any other
 *   - a DIAGNOSTIC that needs a human (no ceiling, a stale calibration, a broken
 *     source), at most once per local day. `insufficient-samples` and
 *     `span-too-short` clear on the next pass by themselves and never toast.
 * Silence from the tripwire stays silent. `AUTODEV_QUOTA_TRIPWIRE=off` skips it.
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
const claudePaths = require('./claude-paths.js');
const { execFile, execFileSync, spawnSync } = require('child_process');
const { scanFleet } = require(path.join(__dirname, 'fleet-status.js'));
const fleetView = require(path.join(__dirname, 'fleet-view.js'));

// Overridable so the dedup test can exercise real state writes without touching
// the live file. The dedup is the load-bearing behaviour here, so it has to be
// testable against a real read/write cycle rather than mocked away.
const STATE = process.env.AUTODEV_FLEET_STATE
    || path.join(claudePaths.configDir(), 'fleet', '.notified.json');
const TOAST = path.join(__dirname, 'toast.ps1');
// Overridable for the same reason as STATE: the suite points it at a stub, and
// every older case turns it off so no fixture run reads the live window.
const TRIPWIRE = process.env.AUTODEV_QUOTA_TRIPWIRE || path.join(__dirname, 'quota-tripwire.js');
const QUOTA_STATE = process.env.AUTODEV_QUOTA_STATE
    || path.join(claudePaths.configDir(), 'quota-tripwire-state.json');
// Diagnostics the next pass clears without anyone acting: a first sample after
// a rollover or a sleep, or two samples too close together to rate.
const SELF_CLEARING = new Set(['insufficient-samples', 'span-too-short']);

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const DRY = has('--dry');
const DAYS = Number(val('--days', 2));
// Beyond this many at once, send one summary instead of a stack of toasts.
const MAX_INDIVIDUAL = 3;

// Do not notify until a panel has been open this long.
//
// This number is measured, not chosen. Across 606 panels over 7 days: median
// open time is 2.2 minutes and 47% are answered inside 2 minutes, so notifying
// on sight would have fired 46 times a day with a worst hour of 24. That gets
// muted within a day, and a muted notifier is worse than none.
//
//   min-age   toasts/day   worst hour   hours with >6
//      2m        46.3          24            16
//      5m        28.1          18             7
//     10m        15.6           9             2
//     15m        11.0           6             0     <- the knee
//     30m         5.6           6             0
//
// 15m is the smallest threshold at which no hour is overwhelming, and it lines
// up with the measured p90 of 16.2 minutes: a panel open that long is in the
// tail, i.e. genuinely waiting rather than mid-conversation.
const MIN_AGE_MIN = Number(val('--min-age', 15));

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
    // Windows-only today: toast.ps1 uses the WinRT notifier. Say so plainly
    // rather than letting the powershell spawn fail with a confusing message —
    // the macOS equivalent is `osascript -e 'display notification ...'` and
    // nobody has written it. fleet-publish.js is platform-neutral, so a Mac can
    // still contribute to the board without this. See docs/fleet-cross-machine.md
    if (process.platform !== 'win32') {
        console.error(`  notifications are Windows-only (this is ${process.platform}); `
            + 'nothing was sent. Publishing still works — see docs/fleet-cross-machine.md');
        return;
    }
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

// Old enough to be worth a toast? An UNPARSEABLE askedAt counts as old enough:
// for a notifier, missing a real block is worse than one extra toast, so the
// unknown case falls to the safe side rather than the quiet one.
function oldEnough(askedAt) {
    const t = Date.parse(askedAt);
    if (!t) return true;
    return (Date.now() - t) / 60000 >= MIN_AGE_MIN;
}

/** A blocked Desktop panel as one toast item, keyed on the session. */
function panelItem(s) {
    const q0 = s.pending.questions[0];
    const q = (q0 && q0.question) || 'a question';
    const n = (q0 && q0.options || []).length;
    return {
        key: s.sessionId, stamp: s.pending.askedAt, due: oldEnough(s.pending.askedAt),
        title: s.title || 'A session is waiting', body: `${q}${n ? `  (${n} options)` : ''}`,
        short: s.title || '?', name: s.title || s.sessionId,
    };
}

/**
 * Every open worker ask as a toast item. No min-age: that threshold was measured
 * on Desktop panels, where a person already in the conversation answers half of
 * them inside 2 minutes. Nobody is in a headless worker's conversation, so there
 * is no quick answer to wait for. Nor has the rate ever burst: `[measured
 * 2026-09-24]` 150 headless records since 09-21 wrote 0 asks, and 32 runs wrote 11.
 */
function askItems() {
    let found;
    try { found = fleetView.openAsks(fleetView.settings({})); } catch (e) {
        return { items: [], sources: [`asks: COULD NOT READ (${e.message})`] };
    }
    const items = found.rows.map((r) => {
        let stamp = 'unknown';
        try { stamp = fs.statSync(r.askFile).mtime.toISOString(); } catch { /* removed since the read: 'unknown' still dedups */ }
        const n = r.question.options.length;
        return {
            key: 'ask:' + r.askFile, stamp, due: true,
            title: `${r.code} is asking`, body: `${r.question.text}${n ? `  (${n} options)` : ''}`,
            short: r.code, name: r.code,
        };
    });
    return { items, sources: found.sources.map((src) => src.population) };
}

const localDay = (d = new Date()) => [d.getFullYear(), d.getMonth() + 1, d.getDate()]
    .map((n) => String(n).padStart(2, '0')).join('-');

/**
 * Run the quota tripwire once and turn what it said into toast items.
 *
 * `--diag-repeat-minutes 0` hands the dedup to this file: the tripwire prints
 * its diagnostic on every pass, and the once-a-day key below decides whether
 * it reaches a human. Not run under --dry, because a tripwire run advances its
 * own state and would disarm on an alert that --dry then never shows.
 */
function quotaItems() {
    if (/^(0|off)$/i.test(TRIPWIRE)) return { items: [], status: 'off' };
    if (DRY) return { items: [], status: 'not run under --dry' };
    const r = spawnSync(process.execPath,
        [TRIPWIRE, '--once', '--diag-repeat-minutes', '0', '--state', QUOTA_STATE],
        // Above the tripwire's own 180 s source timeout, so a slow source is
        // reported by the tripwire as source-failed rather than killed here.
        { encoding: 'utf8', timeout: 200000, windowsHide: true });
    const lines = String(r.stdout || '').split('\n').map((l) => l.trimEnd());
    const alert = lines.find((l) => l.startsWith('QUOTA TRIPWIRE  PREP HANDOVER'));
    let diag = null;
    for (const l of lines) {
        const m = l.match(/^QUOTA TRIPWIRE DIAGNOSTIC {2}code=(\S+) .*?: (.*?)(?: {2}\| |$)/);
        if (m) { diag = { code: m[1], detail: m[2] }; break; }
    }
    if (!diag && (r.error || r.status !== 0)) {
        diag = { code: 'tripwire-run-failed', detail: r.error ? r.error.message
            : `exit ${r.status}: ${String(r.stderr || '').trim().slice(0, 160) || '(no stderr)'}` };
    }

    const items = [];
    // Keyed on the tripwire's own record of firing, not on the one line it
    // prints: that line appears once, so a refused toast would lose it.
    let firedAt = null;
    try { firedAt = JSON.parse(fs.readFileSync(QUOTA_STATE, 'utf8')).firedAt; } catch { /* no state yet */ }
    if (Number.isFinite(firedAt)) {
        items.push({
            key: 'quota:alert', stamp: String(firedAt), due: true, quota: true,
            title: 'Quota: prep handover',
            body: alert ? alert.slice('QUOTA TRIPWIRE  PREP HANDOVER  '.length, 240)
                : `the tripwire fired at ${new Date(firedAt).toISOString()}. Run quota-tripwire.js --status`,
            short: 'quota', name: 'quota tripwire alert',
        });
    }
    if (diag && !SELF_CLEARING.has(diag.code)) {
        items.push({
            key: 'quota:diag', stamp: localDay(), due: true, quota: true,
            title: 'Quota tripwire cannot project',
            body: `code=${diag.code}: ${diag.detail}`.slice(0, 240),
            short: 'quota', name: `quota tripwire diagnostic ${diag.code}`,
        });
    }
    const status = alert ? 'alert' : diag ? `diagnostic ${diag.code}` : 'silent';
    return { items, status };
}

/** One scan-and-notify pass. Returns how many notifications fired. */
function pass() {
    const fleet = scanFleet(DAYS);
    const blocked = fleet.sessions.filter((s) => s.pending);
    const asks = askItems();
    const quota = quotaItems();
    const items = [...blocked.map(panelItem), ...asks.items, ...quota.items];
    const state = readState();

    // Drop state for anything no longer waiting, so a later block re-notifies.
    // The day's diagnostic key stays until the day ends: a diagnostic that
    // clears and comes back within the day must not toast a second time.
    const liveKeys = new Set(items.map((i) => i.key));
    const before = Object.keys(state).length;
    for (const k of Object.keys(state)) {
        if (liveKeys.has(k) || (k === 'quota:diag' && state[k] === localDay())) continue;
        delete state[k];
    }
    const didPrune = Object.keys(state).length !== before;

    const fresh = items.filter((i) => state[i.key] !== i.stamp).filter((i) => i.due);

    // Population every pass: a report that prints only a verdict cannot be told
    // apart from a probe that returned nothing.
    console.log(`${new Date().toISOString()}  ${fleet.population.transcripts} transcripts, `
        + `${blocked.length} blocked, ${asks.items.length} asking, ${fresh.length} new, quota ${quota.status}`);

    // A run marker, written EVERY pass whether or not anything fired.
    //
    // Without it this is unauditable when scheduled: Task Scheduler's result
    // code reports whether the LAUNCHER started, not whether the work ran, so a
    // wscript that spawns a node that dies instantly still reports 0. And on a
    // quiet fleet the notifier's only other output is silence — indistinguishable
    // from never having run. The marker is the artifact to check.
    try {
        fs.mkdirSync(path.dirname(STATE), { recursive: true });
        fs.writeFileSync(path.join(path.dirname(STATE), '.notify-last-run.json'),
            JSON.stringify({
                at: new Date().toISOString(),
                transcripts: fleet.population.transcripts,
                blocked: blocked.length,
                asking: asks.items.length,
                fresh: fresh.length,
                dry: DRY,
                // A missing ledger reads the same as an empty one in the count,
                // so each source says here what it read or why it could not.
                askSources: asks.sources,
                quota: quota.status,
            }) + '\n');
    } catch { /* an unwritable marker must not stop a notification */ }

    // The prune must be PERSISTED even when nothing new fires, or a session that
    // unblocks stays marked seen forever and re-blocking is silent. Returning
    // early here without writing was a real bug, caught by the dedup test.
    if (!fresh.length) {
        if (didPrune && !DRY) writeState(state);
        return 0;
    }

    // A quota toast always stands alone: "4 sessions are waiting on you" must
    // never be where a PREP HANDOVER ends up.
    const waiting = fresh.filter((i) => !i.quota);
    let fired = 0;
    try {
        for (const i of fresh.filter((x) => x.quota)) {
            toast(i.title, i.body);
            fired++;
        }
        if (waiting.length > MAX_INDIVIDUAL) {
            const names = waiting.slice(0, 3).map((i) => i.short).join(', ');
            toast(`${waiting.length} sessions are waiting on you`,
                `${names} and ${waiting.length - 3} more. Open the fleet board.`);
            fired++;
        } else {
            for (const i of waiting) {
                toast(i.title, i.body);
                fired++;
            }
        }
    } catch {
        return 0;   // notify failed: leave state untouched so the next pass retries
    }

    for (const i of fresh) state[i.key] = i.stamp;
    if (!DRY) writeState(state);
    for (const i of fresh) console.log(`  notified: ${i.name}`);
    return fired;
}

function main() {
    // A pass can now toast a quota diagnostic on an empty fixture, so a --help
    // probe that fell through to pass() would put a real toast on the screen.
    if (has('--help') || has('-h')) {
        console.log([
            'fleet-notify.js - toast when a session blocks, a worker asks, or the quota tripwire fires',
            '',
            '  node fleet-notify.js                # one pass',
            '  node fleet-notify.js --watch 120    # every 120s until stopped',
            '  node fleet-notify.js --dry          # print what WOULD fire, notify nothing',
            '  node fleet-notify.js --test         # fire one sample toast and exit',
            '  node fleet-notify.js --min-age 15   # minutes a panel waits before it toasts',
            '',
            'AUTODEV_QUOTA_TRIPWIRE=off skips the quota tripwire.',
        ].join('\n'));
        return;
    }
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
