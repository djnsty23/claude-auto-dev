#!/usr/bin/env node
/**
 * fleet-registry.js - every registered session on this machine, across
 * accounts, with whether its process is still alive.
 *
 * Reads the records session-register.js writes on SessionStart and SessionEnd
 * at <fleetDir>/sessions/<uuid>.json. The peer list a session sees is scoped
 * to its own CLAUDE_CONFIG_DIR; this table is not, because every account's
 * hook writes into the one directory keyed on HOME. See the header of
 * plugins/autodev-core/hooks/session-register.js for what the registry is
 * NOT (heartbeats are fleet-heartbeat.js, transcript-derived status is
 * fleet-status.js and session-pile.js).
 *
 * STATES, one per record:
 *   live    no endedAt, refreshed since this boot, and the pid answers
 *   ended   endedAt set, whatever the pid says (a reused pid must not revive it)
 *   dead    no endedAt, and the pid is gone or the record predates this boot
 *
 * Liveness is process.kill(pid, 0). Only ESRCH means dead. EPERM means a
 * process exists that this user may not signal, which is still alive; on
 * Windows the two are distinguished, which is why this check is written here
 * in Node and not in a shell. A record refreshed before the current boot is
 * dead whatever the pid says, because a pid is reused after a reboot and a
 * SessionEnd never fires for a session the reboot killed.
 *
 * READ-ONLY. It never writes to the registry.
 *
 * Usage:
 *   node fleet-registry.js list                  # grouped by config dir
 *   node fleet-registry.js list --json           # machine-readable
 *   node fleet-registry.js list --all            # include ended sessions
 *   node fleet-registry.js list --fleet-dir <d>  # instead of AUTODEV_FLEET_DIR
 *   node fleet-registry.js --selftest            # the classifier, both codes
 *
 * Always exits 0. This is a report, never a gate. The population line is
 * two-valued on purpose: a directory that could not be read prints
 * "could not read <path>", never "0 sessions", because three scripts in
 * this repo once turned a wrong path into a confident zero (claude-paths.js).
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = process.env.USERPROFILE || process.env.HOME || '';

function parseArgs(argv) {
    const out = { command: null, json: false, all: false, help: false, selftest: false, fleetDir: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--help' || a === '-h') out.help = true;
        else if (a === '--selftest') out.selftest = true;
        else if (a === '--json') out.json = true;
        else if (a === '--all') out.all = true;
        else if (a === '--fleet-dir') out.fleetDir = argv[++i] || null;
        else if (!a.startsWith('-') && !out.command) out.command = a;
    }
    return out;
}

/**
 * Does a process with this pid exist? `kill` is injectable so both error
 * codes can be asserted without owning a process of another user.
 */
function pidAlive(pid, kill) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        (kill || process.kill)(pid, 0);
        return true;
    } catch (e) {
        return !(e && e.code === 'ESRCH');
    }
}

/** Epoch ms of the current boot. A record refreshed before it cannot be live. */
function bootAt() {
    return Date.now() - os.uptime() * 1000;
}

function classify(rec, alive, boot) {
    if (rec.endedAt) return 'ended';
    const refreshed = Date.parse(rec.refreshedAt || rec.startedAt || '');
    if (Number.isFinite(boot) && Number.isFinite(refreshed) && refreshed < boot) return 'dead';
    return alive ? 'live' : 'dead';
}

/**
 * Read every record under <fleetDir>/sessions. `readable` is false when the
 * directory itself could not be listed, which callers must print as exactly
 * that. `unreadable` counts files that were listed but did not parse.
 */
function readRegistry(fleetDir) {
    const dir = path.join(fleetDir, 'sessions');
    let entries;
    try { entries = fs.readdirSync(dir); } catch { return { dir, readable: false, records: [], unreadable: 0 }; }
    const records = [];
    let unreadable = 0;
    for (const name of entries.sort()) {
        if (!name.endsWith('.json')) continue;
        try {
            const rec = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
            if (rec && typeof rec === 'object' && rec.sessionId) records.push(rec);
            else unreadable++;
        } catch { unreadable++; }
    }
    return { dir, readable: true, records, unreadable };
}

function ago(iso, now) {
    const t = Date.parse(iso || '');
    if (!Number.isFinite(t)) return '?';
    const m = Math.max(0, Math.round((now - t) / 60000));
    if (m < 60) return m + 'm';
    if (m < 1440) return Math.round(m / 60) + 'h';
    return Math.round(m / 1440) + 'd';
}

function render(reg, opts, now, boot) {
    const rows = reg.records.map((rec) => Object.assign({}, rec, {
        state: classify(rec, pidAlive(rec.pid), boot),
    }));
    const shown = opts.all ? rows : rows.filter((r) => r.state !== 'ended');
    const population = reg.readable
        ? `registry: ${reg.dir}: ${reg.records.length} record(s)`
            + (reg.unreadable ? `, ${reg.unreadable} unreadable` : '')
            + (opts.all ? '' : `, ${rows.length - shown.length} ended hidden (--all shows them)`)
        : `registry: could not read ${reg.dir}`;

    if (opts.json) {
        return JSON.stringify({
            dir: reg.dir, readable: reg.readable, records: reg.records.length,
            unreadable: reg.unreadable, bootAt: new Date(boot).toISOString(), population, sessions: shown,
        }, null, 2);
    }

    const lines = [population];
    const groups = new Map();
    for (const r of shown) {
        const key = r.configDir || 'default';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
    }
    for (const [configDir, list] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        lines.push('');
        lines.push(`[${configDir}]  ${list.length} session(s)`);
        for (const r of list) {
            const who = (r.headless ? ' headless' : '') + (r.workerCode ? ' ' + r.workerCode : '');
            lines.push(`  ${r.state.padEnd(5)}  pid ${String(r.pid).padStart(6)}  ${String(r.sessionId).slice(0, 8)}`
                + `  started ${ago(r.startedAt, now).padStart(4)} ago  refreshed ${ago(r.refreshedAt, now).padStart(4)} ago`
                + (r.endedAt ? `  ended ${ago(r.endedAt, now)} ago (${r.endReason || '?'})` : '')
                + `  ${r.cwd || '?'}${who}`);
        }
    }
    if (shown.some((r) => r.state === 'live')) {
        lines.push('');
        lines.push('live = no SessionEnd recorded and process.kill(pid, 0) answered. A killed session or a reboot');
        lines.push('fires no SessionEnd; records refreshed before this boot already read dead, and a pid reused');
        lines.push('since this boot still reads live until the 7-day prune removes the record.');
    }
    return lines.join('\n');
}

function selftest() {
    const esrch = () => { const e = new Error('no such process'); e.code = 'ESRCH'; throw e; };
    const eperm = () => { const e = new Error('operation not permitted'); e.code = 'EPERM'; throw e; };
    const now = Date.now();
    const cases = [
        ['ESRCH reads as dead', pidAlive(12345, esrch) === false],
        ['EPERM reads as alive (exists, owned by another user)', pidAlive(12345, eperm) === true],
        ['a pid that answers reads as alive', pidAlive(process.pid) === true],
        ['a non-integer pid reads as dead', pidAlive(null) === false && pidAlive('12') === false],
        ['ended outranks a live pid', classify({ endedAt: 'x', refreshedAt: new Date(now).toISOString() }, true, now - 1) === 'ended'],
        ['live when refreshed after boot and the pid answers', classify({ refreshedAt: new Date(now).toISOString() }, true, now - 1) === 'live'],
        ['dead when the pid is gone', classify({ refreshedAt: new Date(now).toISOString() }, false, now - 1) === 'dead'],
        ['dead when refreshed before this boot, whatever the pid says', classify({ refreshedAt: new Date(now - 10).toISOString() }, true, now) === 'dead'],
    ];
    let fail = 0;
    for (const [label, ok] of cases) { console.log((ok ? 'PASS  ' : 'FAIL  ') + label); if (!ok) fail++; }
    console.log(`${cases.length - fail} passed, ${fail} failed`);
    process.exitCode = fail ? 1 : 0;
}

function usage() {
    console.log([
        'usage: node fleet-registry.js list [--json] [--all] [--fleet-dir <dir>]',
        '       node fleet-registry.js --selftest',
        'Lists every session registered by session-register.js across config dirs, with',
        'live / ended / dead per record. Always exits 0; the population line says what was read.',
    ].join('\n'));
}

function main(argv) {
    const opts = parseArgs(argv);
    if (opts.help) return usage();
    if (opts.selftest) return selftest();
    if (opts.command !== 'list') return usage();
    const fleetDir = opts.fleetDir || process.env.AUTODEV_FLEET_DIR || path.join(HOME, '.claude', 'fleet');
    console.log(render(readRegistry(fleetDir), opts, Date.now(), bootAt()));
    process.exitCode = 0;
}

module.exports = { pidAlive, classify, readRegistry, render, parseArgs, bootAt };

if (require.main === module) main(process.argv.slice(2));
