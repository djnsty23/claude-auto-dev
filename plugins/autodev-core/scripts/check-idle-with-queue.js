#!/usr/bin/env node
'use strict';

// check-idle-with-queue.js — a session that stopped while its queue was live.
//
// C1 of the harness acceptance contract: "no session idle with queued work".
//
// WHAT C1 ASKED FOR, AND WHY THIS DOES SOMETHING ELSE. The contract says to join
// each heartbeat row to `<cwd>/QUEUE.md` OPEN ITEMS. `[measured 2026-09-02]`
// across all four real QUEUE.md files on this machine — 1,488 lines together —
// there are ZERO checkboxes and ZERO `PREMISE:` lines, against a control showing
// the same grep finds a planted checkbox. They are prose: headings, tables and
// narrative. "Open item" is not a thing that exists in the data, so the
// specified join would report zero for every session forever — green, and
// structurally incapable of firing.
//
// So this keys on STALENESS instead, which is machine-readable today: a session
// idle past a threshold whose queue file was written recently enough to be live
// work. It answers a narrower question than C1's wording — "this session stopped
// while its queue was still moving", not "it has N open items" — and that
// narrowing is stated here rather than hidden behind the same name.
//
// THE THRESHOLD IS MEASURED, NOT CHOSEN. `[measured 2026-09-02]` over 178
// heartbeats, of which 23 sit in a directory carrying a QUEUE.md and 22 are idle
// past 20 minutes:
//
//     idle>20m + queue exists                     22   flags nearly everything
//     idle>20m + queue touched in last 24h          2   <- this
//     idle>20m + queue touched AFTER the heartbeat   0   cannot fire
//     idle>20m + queue touched in last 7d           21   flags nearly everything
//
// Queue ages for those sessions run 9h to 181h, median 55h. Most queues are
// abandoned, and a 24h window is what separates them from live work. The
// after-the-heartbeat variant was the first design and is recorded here because
// it is the seductive one: it sounds like the sharpest signal and it needs an
// EXTERNAL writer, which almost never happens, so it would have shipped a gate
// that never fires and looked rigorous doing it.
//
// Both thresholds are flags, because a number measured on one machine on one day
// is a default rather than a law.
//
// Exit: 0 nothing flagged, 1 at least one session flagged, 2 could not read the
// heartbeat directory (no population — an absence this script cannot vouch for).

const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

if (has('--help') || has('-h')) {
    console.log('usage: check-idle-with-queue.js [--idle-minutes N] [--queue-hours N] [--json] [--selftest]\n'
        + 'Flags a session idle past --idle-minutes (default 20) whose cwd holds a QUEUE.md\n'
        + 'written within --queue-hours (default 24). Reads heartbeats via fleet-heartbeat.js.\n'
        + 'C1 specifies a join to QUEUE.md OPEN ITEMS; those do not exist in the data, so this\n'
        + 'keys on staleness instead and answers a narrower question. See the header.\n'
        + 'Exit 0 clean, 1 flagged, 2 no population.');
    process.exit(0);
}

const IDLE_MIN = Math.max(0, Number(val('--idle-minutes', 20)) || 20);
const QUEUE_H = Math.max(0, Number(val('--queue-hours', 24)) || 24);

/**
 * The rule, isolated so the selftest drives it directly rather than through the
 * filesystem. Takes plain numbers so a fixture cannot depend on real mtimes.
 */
function isFlagged({ idleMinutes, queueAgeHours, hasQueue }, idleMin, queueH) {
    if (!hasQueue) return false;
    return idleMinutes > idleMin && queueAgeHours < queueH;
}

function scan(records, now, idleMin, queueH) {
    const rows = [];
    let withQueue = 0;
    let idle = 0;
    for (const r of records) {
        const stopped = Date.parse(r && r.stoppedAt);
        if (!Number.isFinite(stopped) || !r.cwd) continue;
        const idleMinutes = (now - stopped) / 60000;
        if (idleMinutes > idleMin) idle++;

        let st = null;
        try { st = fs.statSync(path.join(r.cwd, 'QUEUE.md')); } catch { /* no queue here */ }
        if (!st) continue;
        withQueue++;

        const queueAgeHours = (now - st.mtimeMs) / 3600000;
        const flagged = isFlagged({ idleMinutes, queueAgeHours, hasQueue: true }, idleMin, queueH);
        if (flagged) {
            rows.push({
                session: String(r.cliSessionId || '').slice(0, 8),
                cwd: r.cwd,
                idleMinutes: Math.round(idleMinutes),
                queueAgeHours: Math.round(queueAgeHours * 10) / 10,
            });
        }
    }
    return { rows, scanned: records.length, withQueue, idle };
}

// --- selftest -------------------------------------------------------------
// Drives the RULE with planted values, so it needs no fleet and no clock. The
// negatives matter more than the positive: this gate's whole risk is being
// unable to fire, and three of the four cases below are the ways that happens.
if (has('--selftest')) {
    let pass = 0;
    let fail = 0;
    const t = (label, ok) => { if (ok) pass++; else { fail++; } console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}`); };

    t('idle AND a fresh queue is flagged',
        isFlagged({ idleMinutes: 30, queueAgeHours: 2, hasQueue: true }, 20, 24) === true);
    t('idle but a STALE queue is not flagged (the abandoned-queue case, median 55h)',
        isFlagged({ idleMinutes: 999, queueAgeHours: 55, hasQueue: true }, 20, 24) === false);
    t('a fresh queue but a LIVE session is not flagged',
        isFlagged({ idleMinutes: 2, queueAgeHours: 1, hasQueue: true }, 20, 24) === false);
    t('no queue at all is never flagged',
        isFlagged({ idleMinutes: 999, queueAgeHours: 0, hasQueue: false }, 20, 24) === false);
    t('exactly at the idle threshold is NOT idle yet',
        isFlagged({ idleMinutes: 20, queueAgeHours: 1, hasQueue: true }, 20, 24) === false);
    t('exactly at the queue horizon is already stale',
        isFlagged({ idleMinutes: 30, queueAgeHours: 24, hasQueue: true }, 20, 24) === false);
    t('the thresholds are honoured, not hardcoded',
        isFlagged({ idleMinutes: 30, queueAgeHours: 40, hasQueue: true }, 20, 48) === true);

    // scan() over planted records, so the filesystem join is exercised too. The
    // temp dir gets a real QUEUE.md; a second record points at a directory with
    // none, which is the discriminating control for `withQueue`.
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ciwq-'));
    const withQ = path.join(dir, 'has-queue');
    const noQ = path.join(dir, 'no-queue');
    fs.mkdirSync(withQ); fs.mkdirSync(noQ);
    fs.writeFileSync(path.join(withQ, 'QUEUE.md'), '# QUEUE\n\nsome prose, no checkboxes\n');
    const now = Date.now();
    const rec = (cwd, agoMin, id) => ({ cliSessionId: id, cwd, stoppedAt: new Date(now - agoMin * 60000).toISOString() });
    const out = scan([rec(withQ, 60, 'aaaaaaaa'), rec(noQ, 60, 'bbbbbbbb'), rec(withQ, 1, 'cccccccc')],
        now, 20, 24);
    t('scan flags the idle session whose directory has a fresh queue', out.rows.length === 1);
    t('  and names it', out.rows[0] && out.rows[0].session === 'aaaaaaaa');
    t('  counts only directories that actually hold a QUEUE.md', out.withQueue === 2);
    t('  counts idle separately from flagged', out.idle === 2 && out.rows.length === 1);
    t('a record with an unparseable stoppedAt is skipped, not crashed on',
        scan([{ cliSessionId: 'x', cwd: withQ, stoppedAt: 'not a date' }], now, 20, 24).rows.length === 0);
    fs.rmSync(dir, { recursive: true, force: true });

    console.log(`\n${pass} passed, ${fail} failed  (${pass + fail} cases: 7 rule, 5 scan)`);
    process.exit(fail ? 1 : 0);
}

// --- live run -------------------------------------------------------------
let records;
try {
    records = require('./fleet-heartbeat.js').readAll();
} catch (err) {
    console.error('could not read heartbeats (' + (err && err.message) + ').');
    console.error('No population, so this run vouches for NOTHING — not even an all-clear.');
    process.exit(2);
}

// ZERO RECORDS IS NOT ZERO FINDINGS. `readAll()` swallows a missing or
// unreadable directory and returns [], so without this an absent fleet renders
// as a clean run: "0 heartbeat(s) scanned", exit 0, indistinguishable from a
// healthy fleet. Caught by this script's own suite, where the case asserting it
// passed on the wrong arm of an `||` — so the test was fixed too.
//
// The exit-2 path above only fires if require() itself throws, which it does not
// for a missing directory. This is the branch that actually runs.
if (!records.length) {
    console.error(`0 heartbeats found in ${require('./fleet-heartbeat.js').DIR}.`);
    console.error('No population, so this run vouches for NOTHING — not even an all-clear.');
    console.error('Either no session has ever recorded a heartbeat here, or the directory');
    console.error('is unreadable. Set AUTODEV_FLEET_DIR if the fleet lives elsewhere.');
    process.exit(2);
}

const result = scan(records, Date.now(), IDLE_MIN, QUEUE_H);

if (has('--json')) {
    console.log(JSON.stringify({
        idleMinutes: IDLE_MIN, queueHours: QUEUE_H, ...result,
    }, null, 2));
    process.exit(result.rows.length ? 1 : 0);
}

// The population always, before the verdict. A bare "none found" here is
// indistinguishable from a heartbeat directory this script could not read, and
// the two mean opposite things.
console.log(`${result.scanned} heartbeat(s) scanned · ${result.idle} idle past ${IDLE_MIN}m · `
    + `${result.withQueue} in a directory holding a QUEUE.md`);
console.log(`flagging: idle > ${IDLE_MIN}m AND QUEUE.md written within ${QUEUE_H}h\n`);

if (!result.rows.length) {
    console.log('0 flagged.');
    console.log('NOT an all-clear about queued work: this keys on queue FRESHNESS, because');
    console.log('QUEUE.md files carry no open/done marker. A session sitting on a queue');
    console.log('nobody has touched in a day is invisible here, by construction.');
    process.exit(0);
}

for (const r of result.rows) {
    console.log(`  ${String(r.idleMinutes).padStart(5)}m idle  ${r.session}  queue ${r.queueAgeHours}h old`);
    console.log(`         ${r.cwd}`);
}
console.log(`\n${result.rows.length} session(s) stopped while a live queue sat in their directory.`);
process.exit(1);
