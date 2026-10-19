#!/usr/bin/env node
'use strict';
/**
 * host-uptime.js - how long the host was up on each complete UTC day, from the Windows event log.
 *
 * WHY. The acceptance window grades the share of brain-clock ticks the host should have run. With
 * no record of when the host was off, every hour of the window was the denominator, so a night
 * the machine was shut down read as missed ticks. The clock cannot record its own downtime, and a
 * record the clock writes would stop exactly when the clock does. The event log is independent of
 * the clock and kept by the OS, so whoever runs this script, and however late, reads the same
 * intervals back.
 *
 * DOWN INTERVALS, from the System log:
 *   Kernel-General 13 (shutdown)            to the next Kernel-General 12 (boot)
 *   Kernel-Power 42 (entering sleep)        to the next Power-Troubleshooter 1 (resume)
 *   Kernel-Power 506 (modern standby entry) to the next Kernel-Power 507 (exit)
 * A boot with no shutdown before it (a crash or power loss, Kernel-Power 41) has no known down
 * start, so that gap counts as UP. Unknown time never shrinks the denominator. A down interval
 * still open at the end of a day is cut at midnight.
 *
 * OUTPUT. One file per complete UTC day of the last DAYS days, rewritten each run:
 *   <claude dir>/autodev/windows/host-up/<day>.json
 *   { day, upMs, downMs, down: [{ from, to, kind }], events, source, takenUtc }
 * <claude dir> is BRAIN_CLOCK_CLAUDE_DIR, else ~/.claude.
 *
 * USAGE. node host-uptime.js [--json]
 * Exit codes: 0 written, 2 the event log could not be read or a file could not be written.
 * Test seam: AUTODEV_HOST_EVENTS_FILE names a file of event XML used instead of wevtutil.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLAUDE_DIR = process.env.BRAIN_CLOCK_CLAUDE_DIR || path.join(os.homedir(), '.claude');
const OUT_DIR = path.join(CLAUDE_DIR, 'autodev', 'windows', 'host-up');
const DAY_MS = 24 * 60 * 60 * 1000;
const DAYS = 15;
const QUERY = "*[System[((Provider[@Name='Microsoft-Windows-Kernel-General'] and (EventID=12 or EventID=13))"
    + " or (Provider[@Name='Microsoft-Windows-Kernel-Power'] and (EventID=41 or EventID=42 or EventID=506 or EventID=507))"
    + " or (Provider[@Name='Microsoft-Windows-Power-Troubleshooter'] and EventID=1))"
    + ` and TimeCreated[timediff(@SystemTime) <= ${(DAYS + 2) * DAY_MS}]]]`;

// { kind, at } per event, oldest first. kind: boot, shutdown, crash, sleep, wake, standby, resume.
function parseEvents(xml) {
    const KIND = {
        'Microsoft-Windows-Kernel-General/12': 'boot', 'Microsoft-Windows-Kernel-General/13': 'shutdown',
        'Microsoft-Windows-Kernel-Power/41': 'crash', 'Microsoft-Windows-Kernel-Power/42': 'sleep',
        'Microsoft-Windows-Kernel-Power/506': 'standby', 'Microsoft-Windows-Kernel-Power/507': 'resume',
        'Microsoft-Windows-Power-Troubleshooter/1': 'wake',
    };
    const out = [];
    for (const ev of String(xml).split('<Event ').slice(1)) {
        const prov = /<Provider Name='([^']+)'/.exec(ev);
        const id = /<EventID[^>]*>(\d+)<\/EventID>/.exec(ev);
        const t = /<TimeCreated SystemTime='([^']+)'/.exec(ev);
        const kind = prov && id ? KIND[`${prov[1]}/${id[1]}`] : null;
        const at = t ? Date.parse(t[1]) : NaN;
        if (kind && Number.isFinite(at)) out.push({ kind, at });
    }
    return out.sort((a, b) => a.at - b.at);
}

function readEvents(env = process.env) {
    if (env.AUTODEV_HOST_EVENTS_FILE) return parseEvents(fs.readFileSync(env.AUTODEV_HOST_EVENTS_FILE, 'utf8'));
    if (process.platform !== 'win32') throw new Error(`host-uptime reads the Windows event log, and this host is ${process.platform}`);
    const r = spawnSync('wevtutil', ['qe', 'System', `/q:${QUERY}`, '/f:xml'], { encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`wevtutil exited ${r.status}: ${String(r.stderr || r.error || '').trim().slice(0, 300)}`);
    return parseEvents(String(r.stdout).replace(/\0/g, ''));
}

// Down intervals: each opener closes at the next event of its pair, or stays open (to: null).
function downIntervals(events) {
    const PAIR = { shutdown: 'boot', sleep: 'wake', standby: 'resume' };
    const down = [];
    let open = null;
    for (const e of events) {
        if (open && e.kind === PAIR[open.kind]) { down.push({ from: open.at, to: e.at, kind: open.kind }); open = null; continue; }
        // A boot always ends any down interval: a sleep that never woke ended in a power-off.
        if (open && e.kind === 'boot') { down.push({ from: open.at, to: e.at, kind: open.kind }); open = null; continue; }
        if (!open && PAIR[e.kind]) open = { kind: e.kind, at: e.at };
    }
    if (open) down.push({ from: open.at, to: null, kind: open.kind });
    return down;
}

function days(nowMs, events) {
    const today = Date.parse(new Date(nowMs).toISOString().slice(0, 10) + 'T00:00:00Z');
    const down = downIntervals(events);
    const out = [];
    for (let i = DAYS; i >= 1; i--) {
        const from = today - i * DAY_MS;
        const to = from + DAY_MS;
        const mine = down.map((d) => ({ from: Math.max(d.from, from), to: Math.min(d.to === null ? nowMs : d.to, to), kind: d.kind })).filter((d) => d.to > d.from);
        const downMs = mine.reduce((a, d) => a + d.to - d.from, 0);
        out.push({
            day: new Date(from).toISOString().slice(0, 10),
            upMs: DAY_MS - downMs, downMs,
            down: mine.map((d) => ({ from: new Date(d.from).toISOString(), to: new Date(d.to).toISOString(), kind: d.kind })),
            events: events.filter((e) => e.at >= from && e.at < to).length,
            source: 'windows-event-log',
            takenUtc: new Date(nowMs).toISOString(),
        });
    }
    return out;
}

function main(argv, env = process.env) {
    let rows;
    try { rows = days(Date.now(), readEvents(env)); } catch (e) {
        process.stderr.write(`host-uptime: ${String(e && e.message || e)}\n`);
        return 2;
    }
    try {
        fs.mkdirSync(OUT_DIR, { recursive: true });
        for (const r of rows) {
            const file = path.join(OUT_DIR, `${r.day}.json`);
            fs.writeFileSync(`${file}.tmp`, JSON.stringify(r) + '\n');
            fs.renameSync(`${file}.tmp`, file);
        }
    } catch (e) {
        process.stderr.write(`host-uptime: a day file could not be written (${e.code || e.message})\n`);
        return 2;
    }
    if (argv.includes('--json')) process.stdout.write(JSON.stringify(rows) + '\n');
    else {
        const up = rows.reduce((a, r) => a + r.upMs, 0);
        process.stdout.write(`host-uptime: ${rows.length} days written, host up ${(up / 3600000).toFixed(1)} of ${rows.length * 24} h\n`);
    }
    return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { parseEvents, downIntervals, days, OUT_DIR };
