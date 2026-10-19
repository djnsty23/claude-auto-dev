#!/usr/bin/env node
'use strict';
// test-host-uptime.js: the acceptance window's denominator writer. host-uptime.js reads boot,
// shutdown, sleep and standby events from the Windows event log and writes, per complete UTC day,
// how long the host was up. Unknown down time (a crash) counts as up, so it never shrinks the
// denominator.
//
// Every run is a subprocess of the real CLI with AUTODEV_HOST_EVENTS_FILE holding event XML in
// the shape wevtutil prints, and BRAIN_CLOCK_CLAUDE_DIR in a temp dir.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.resolve(__dirname, '../plugins/autodev-core/scripts/host-uptime.js');
let ran = 0;
let failed = 0;
function check(name, cond, detail) {
    ran++;
    if (cond) { console.log(`ok ${name}`); return; }
    failed++;
    console.log(`FAIL ${name}${detail ? `: ${String(detail).slice(0, 600)}` : ''}`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-uptime-'));
const claude = path.join(root, 'claude');
const out = path.join(claude, 'autodev', 'windows', 'host-up');
const events = path.join(root, 'events.xml');
const env = { ...process.env, BRAIN_CLOCK_CLAUDE_DIR: claude, AUTODEV_HOST_EVENTS_FILE: events };
const H = 3600000;
const DAY = 24 * H;
const today = Date.parse(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
const dayN = (n) => new Date(today - n * DAY).toISOString().slice(0, 10);
const ev = (provider, id, ms) => `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='${provider}' Guid='{0}'/><EventID>${id}</EventID><Version>0</Version><TimeCreated SystemTime='${new Date(ms).toISOString().replace('Z', '0000Z')}'/><Channel>System</Channel></System></Event>`;
const KG = 'Microsoft-Windows-Kernel-General';
const KP = 'Microsoft-Windows-Kernel-Power';
const PT = 'Microsoft-Windows-Power-Troubleshooter';
const run = () => spawnSync(process.execPath, [CLI], { env, encoding: 'utf8', timeout: 30000 });
const day = (n) => { try { return JSON.parse(fs.readFileSync(path.join(out, `${dayN(n)}.json`), 'utf8')); } catch { return null; } };

try {
    const d3 = today - 3 * DAY;
    const d2 = today - 2 * DAY;
    const d5 = today - 5 * DAY;
    fs.writeFileSync(events, [
        // Day -5: shut down 20:00, booted the next day at 06:00 (a 10 h interval across midnight).
        ev(KG, 13, d5 + 20 * H), ev(KG, 12, d5 + 30 * H),
        // Day -3: slept 01:00 to 03:00, modern standby 10:00 to 10:30, a crash with no shutdown at 15:00.
        ev(KP, 42, d3 + 1 * H), ev(PT, 1, d3 + 3 * H), ev(KP, 506, d3 + 10 * H), ev(KP, 507, d3 + 10.5 * H),
        ev(KG, 12, d3 + 15 * H), ev(KP, 41, d3 + 15 * H + 1000),
        // Day -2: an unrelated provider's event 1 is not a wake, and a sleep that never woke ends at the next boot.
        ev('Microsoft-Windows-FilterManager', 1, d2 + 2 * H), ev(KP, 42, d2 + 4 * H), ev(KG, 12, d2 + 9 * H),
    ].join(''));
    let r = run();
    check('the CLI writes 15 complete days and exits 0', r.status === 0 && /^host-uptime: 15 days written/.test(r.stdout) && fs.readdirSync(out).length === 15, r.stdout + r.stderr);
    check('today is never written, it is not complete', !fs.existsSync(path.join(out, `${dayN(0)}.json`)) && day(1) && day(15) && !day(16));
    check('a quiet day is 24 h up with no down intervals', day(10).upMs === DAY && day(10).downMs === 0 && day(10).down.length === 0 && day(10).source === 'windows-event-log', JSON.stringify(day(10)));
    check('a shutdown across midnight is cut at the day boundary on both sides',
        day(5).downMs === 4 * H && day(4).downMs === 6 * H && day(5).down[0].kind === 'shutdown', JSON.stringify([day(5), day(4)]));
    check('sleep to wake and standby to resume are down, and a crash boot adds no down time',
        day(3).downMs === 2.5 * H && day(3).down.map((x) => x.kind).join() === 'sleep,standby' && day(3).events === 6, JSON.stringify(day(3)));
    check('another provider\'s event 1 is not a wake, and an unwoken sleep ends at the next boot',
        day(2).downMs === 5 * H && day(2).down.length === 1 && day(2).events === 2, JSON.stringify(day(2)));
    check('every day file has upMs + downMs = 24 h', fs.readdirSync(out).every((f) => { const j = JSON.parse(fs.readFileSync(path.join(out, f), 'utf8')); return j.upMs + j.downMs === DAY && `${j.day}.json` === f; }));

    fs.writeFileSync(events, '');
    r = run();
    check('a rerun with no events rewrites the same days as fully up', r.status === 0 && day(5).upMs === DAY && fs.readdirSync(out).filter((f) => f.endsWith('.tmp')).length === 0, r.stdout + r.stderr);

    fs.rmSync(events);
    r = run();
    check('an unreadable event source exits 2 and says why', r.status === 2 && /^host-uptime: /.test(r.stderr), r.stdout + r.stderr);

    if (process.platform === 'win32') {
        const live = spawnSync(process.execPath, [CLI, '--json'], { env: { ...env, AUTODEV_HOST_EVENTS_FILE: '', BRAIN_CLOCK_CLAUDE_DIR: path.join(root, 'live') }, encoding: 'utf8', timeout: 90000 });
        let rows = [];
        try { rows = JSON.parse(live.stdout); } catch { /* reported below */ }
        check('on Windows the real event log is read: 15 days, each with a sane up time', live.status === 0 && rows.length === 15 && rows.every((x) => x.upMs >= 0 && x.upMs <= DAY), live.stdout.slice(0, 300) + live.stderr);
    }
} catch (e) {
    failed++;
    console.log(`FAIL the suite crashed: ${e.stack || e}`);
} finally {
    fs.rmSync(root, { recursive: true, force: true });
}
console.log(`\nhost uptime: ${ran - failed}/${ran} checks passed`);
process.exitCode = failed ? 1 : 0;
