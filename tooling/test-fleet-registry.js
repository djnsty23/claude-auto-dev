#!/usr/bin/env node
'use strict';
// Suite for plugins/autodev-core/scripts/fleet-registry.js.
//
// The script lists the records session-register.js writes and says per record
// whether the session is live, ended or dead. Every listing case is a subprocess
// run of the real script with --fleet-dir at a fixture whose path contains a
// space, so nothing here can read or touch the live fleet directory. The
// classifier is ALSO required directly, because EPERM cannot be produced on
// demand from a process this user owns, and the ESRCH half of that synthetic
// assertion is cross-checked live through a child that has already exited.
//
// Run: node tooling/test-fleet-registry.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const sb = require('./spawn-budget.js');

const SCRIPT = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'fleet-registry.js');
const registry = require(SCRIPT);
const BUDGET_MS = 20000;

let pass = 0, fail = 0, infra = 0;
function check(label, ok, detail) {
    if (ok) { pass++; console.log('PASS  ' + label); }
    else { fail++; console.log('FAIL  ' + label + (detail !== undefined ? '  (' + detail + ')' : '')); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet registry '));
let n = 0;
const freshFleet = () => { const d = path.join(TMP, 'fleet ' + (++n)); fs.mkdirSync(d, { recursive: true }); return d; };
const plant = (fleet, id, rec) => {
    const dir = path.join(fleet, 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, id + '.json'), typeof rec === 'string' ? rec : JSON.stringify(rec) + '\n', 'utf8');
};

function run(args, fleet) {
    const env = Object.assign({}, process.env);
    // The env must not be the seam: every listing names its directory on the
    // command line, and a stray AUTODEV_FLEET_DIR from the parent is removed so a
    // script that ignored --fleet-dir could not pass by reading the right place.
    delete env.AUTODEV_FLEET_DIR;
    const r = sb.runBudgeted(process.execPath, [SCRIPT, ...args, ...(fleet ? ['--fleet-dir', fleet] : [])], {
        encoding: 'utf8', env, timeout: BUDGET_MS, windowsHide: true, input: '',
    });
    if (sb.classify(r) !== 'verdict') {
        infra++;
        console.log('INDETERMINATE  script run produced no verdict: ' + sb.reason(r) + ' ' + sb.lastWords(r, 300));
        return null;
    }
    return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}
const detail = (r) => r ? 'exit ' + r.code + ', stdout ' + JSON.stringify(r.out.slice(0, 120)) + ', stderr ' + JSON.stringify(r.err.slice(0, 120)) : 'no verdict';
const parse = (r) => { try { return JSON.parse(r.out); } catch { return null; } };

// A pid that certainly belonged to a process that has exited. The OS may reuse
// a pid quickly, so the candidate is re-checked and replaced until it is gone;
// the case then asserts what the fixture proved rather than what it hoped.
// The re-check is this suite's OWN process.kill, not the subject's classifier:
// a fixture that trusted the subject would hand it null the moment it was wrong
// and the dead case would pass for the wrong reason.
function exitedPid() {
    const gone = (pid) => { try { process.kill(pid, 0); return false; } catch (e) { return !!e && e.code === 'ESRCH'; } };
    for (let i = 0; i < 5; i++) {
        const c = spawnSync(process.execPath, ['-e', '0'], { encoding: 'utf8', windowsHide: true });
        if (c.pid && gone(c.pid)) return c.pid;
    }
    return null;
}

const now = () => new Date().toISOString();
const LIVE = 'aaaaaaaa-0000-4000-8000-000000000001';
const DEAD = 'bbbbbbbb-0000-4000-8000-000000000002';
const ENDED = 'cccccccc-0000-4000-8000-000000000003';

try {
    check('every fixture path contains a space', / /.test(TMP), TMP);

    // ---- 14. --help --------------------------------------------------------
    {
        const fleet = freshFleet();
        const started = Date.now();
        const r = run(['--help'], null);
        check('--help exits 0 with a usage line', !!r && r.code === 0 && /usage:/.test(r.out) && r.err === '', detail(r));
        check('  and returns instantly', Date.now() - started < BUDGET_MS / 2);
        check('  and writes nothing', !fs.existsSync(path.join(fleet, 'sessions')));
        const bare = run([], null);
        check('no command: usage, exit 0', !!bare && bare.code === 0 && /usage:/.test(bare.out), detail(bare));
    }

    // ---- 15. three states over a planted registry ---------------------------
    const fleet = freshFleet();
    const gone = exitedPid();
    check('fixture: a pid of an exited child was obtained', gone !== null);
    plant(fleet, LIVE, { sessionId: LIVE, configDir: 'default', cwd: '/w/one', pid: process.pid, headless: false, workerCode: null, startedAt: now(), refreshedAt: now(), endedAt: null, endReason: null });
    plant(fleet, DEAD, { sessionId: DEAD, configDir: 'default', cwd: '/w/two', pid: gone, headless: true, workerCode: 'ZZ1', startedAt: now(), refreshedAt: now(), endedAt: null, endReason: null });
    plant(fleet, ENDED, { sessionId: ENDED, configDir: 'alt-config', cwd: '/w/three', pid: process.pid, headless: false, workerCode: null, startedAt: now(), refreshedAt: now(), endedAt: now(), endReason: 'clear' });
    {
        const r = run(['list', '--json', '--all'], fleet);
        check('list --json --all exits 0 with parseable JSON', !!r && r.code === 0 && !!parse(r), detail(r));
        const j = parse(r) || {};
        const state = (id) => ((j.sessions || []).find((s) => s.sessionId === id) || {}).state;
        check('  a record with this suite\'s pid and no endedAt is live', state(LIVE) === 'live', JSON.stringify(j.sessions));
        check('  a record with the pid of an exited child is dead', state(DEAD) === 'dead', state(DEAD));
        check('  a record with endedAt set and a LIVE pid is ended (the pid does not override endedAt)', state(ENDED) === 'ended', state(ENDED));
        check('  the JSON carries the directory, the count and a population line', j.dir === path.join(fleet, 'sessions') && j.records === 3 && j.readable === true && /3 record\(s\)/.test(j.population), JSON.stringify(j.population));
    }

    // ---- 16. the classifier, both codes, synthetically and live -------------
    {
        const esrch = () => { const e = new Error('no such process'); e.code = 'ESRCH'; throw e; };
        const eperm = () => { const e = new Error('operation not permitted'); e.code = 'EPERM'; throw e; };
        const other = () => { const e = new Error('odd'); e.code = 'EINVAL'; throw e; };
        check('pidAlive reads ESRCH as dead', registry.pidAlive(4242, esrch) === false);
        check('pidAlive reads EPERM as alive (exists, another user)', registry.pidAlive(4242, eperm) === true);
        check('pidAlive reads any other error as alive too: only ESRCH means gone', registry.pidAlive(4242, other) === true);
        check('pidAlive reads a non-integer pid as dead', registry.pidAlive(undefined) === false && registry.pidAlive(-1) === false);
        check('pidAlive live: this process answers', registry.pidAlive(process.pid) === true);
        check('pidAlive live: the exited child reads ESRCH through the real process.kill', gone !== null && registry.pidAlive(gone) === false);
        const t = Date.now();
        const rec = (extra) => Object.assign({ refreshedAt: new Date(t).toISOString(), endedAt: null }, extra);
        check('classify: ended outranks a live pid', registry.classify(rec({ endedAt: new Date(t).toISOString() }), true, t - 1) === 'ended');
        check('classify: live needs both a live pid and a refresh since boot', registry.classify(rec({}), true, t - 1) === 'live' && registry.classify(rec({}), false, t - 1) === 'dead');
        check('classify: a record refreshed before this boot is dead whatever the pid says', registry.classify(rec({ refreshedAt: new Date(t - 5000).toISOString() }), true, t) === 'dead');
        check('bootAt is in the past and after the epoch', registry.bootAt() < Date.now() && registry.bootAt() > 0);
        const st = run(['--selftest'], null);
        check('--selftest passes as a subprocess', !!st && st.code === 0 && /8 passed, 0 failed/.test(st.out), detail(st));
    }

    // ---- 17. grouping by configDir --------------------------------------------
    {
        const r = run(['list', '--all'], fleet);
        check('list --all exits 0', !!r && r.code === 0 && r.err === '', detail(r));
        check('  both config dir headings appear', !!r && /^\[default\]  2 session\(s\)$/m.test(r.out) && /^\[alt-config\]  1 session\(s\)$/m.test(r.out), r && r.out);
        check('  one row per session, with state, pid and the short id', !!r && /^  live   pid +\d+  aaaaaaaa /m.test(r.out) && /^  dead   pid +\d+  bbbbbbbb /m.test(r.out) && /^  ended  pid +\d+  cccccccc .*\(clear\)/m.test(r.out), r && r.out);
        check('  the dead row shows headless and the worker code', !!r && /bbbbbbbb .*\/w\/two headless ZZ1$/m.test(r.out), r && r.out);
        check('  a live row comes with the pid-reuse caveat', !!r && /pid reused/.test(r.out));
    }

    // ---- 18. ended is hidden without --all, still counted -------------------
    {
        const r = run(['list'], fleet);
        check('list without --all hides the ended record', !!r && r.code === 0 && !/cccccccc/.test(r.out) && !/alt-config/.test(r.out), r && r.out);
        check('  and the population line still counts all three, naming the hidden one', !!r && /3 record\(s\), 1 ended hidden/.test(r.out), r && r.out.split('\n')[0]);
        check('  the live and dead rows are still there', !!r && /aaaaaaaa/.test(r.out) && /bbbbbbbb/.test(r.out));
        const j = run(['list', '--json'], fleet);
        const parsed = parse(j) || {};
        check('  --json without --all hides it too and keeps the count', (parsed.sessions || []).length === 2 && parsed.records === 3, JSON.stringify(parsed.sessions && parsed.sessions.map((s) => s.state)));
    }

    // ---- 19. missing versus empty --------------------------------------------
    {
        const missing = path.join(TMP, 'never made ' + (++n));
        const r = run(['list'], missing);
        check('a missing fleet directory prints "could not read" and exits 0', !!r && r.code === 0 && /could not read /.test(r.out) && !/0 record/.test(r.out), detail(r));
        const empty = freshFleet();
        fs.mkdirSync(path.join(empty, 'sessions'));
        const r2 = run(['list'], empty);
        check('an existing empty one prints a 0-record population line and exits 0', !!r2 && r2.code === 0 && /: 0 record\(s\)/.test(r2.out) && !/could not read/.test(r2.out), detail(r2));
        check('  and the two outputs differ textually', !!r && !!r2 && r.out !== r2.out);
        const j = parse(run(['list', '--json'], missing) || { out: '' }) || {};
        check('  --json says readable false for the missing one', j.readable === false && j.records === 0 && /could not read/.test(j.population), JSON.stringify(j));
    }

    // ---- 20. a corrupt record is skipped and counted ------------------------
    {
        const fleet2 = freshFleet();
        plant(fleet2, LIVE, { sessionId: LIVE, configDir: 'default', pid: process.pid, startedAt: now(), refreshedAt: now(), endedAt: null });
        plant(fleet2, 'dddddddd-0000-4000-8000-000000000004', '{not json');
        fs.writeFileSync(path.join(fleet2, 'sessions', 'stray.txt'), 'ignored\n', 'utf8');
        const r = run(['list'], fleet2);
        check('a corrupt record file is skipped and the run exits 0', !!r && r.code === 0 && /aaaaaaaa/.test(r.out), detail(r));
        check('  and it is counted as unreadable in the population line', !!r && /1 record\(s\), 1 unreadable/.test(r.out), r && r.out.split('\n')[0]);
        const reg = registry.readRegistry(fleet2);
        check('  readRegistry agrees: 1 record, 1 unreadable, the non-json file ignored', reg.readable && reg.records.length === 1 && reg.unreadable === 1);
    }

    // ---- 21. nothing was written anywhere -----------------------------------
    {
        const names = fs.readdirSync(path.join(fleet, 'sessions')).sort();
        check('the listing wrote nothing into the fixture', names.join(',') === [LIVE, DEAD, ENDED].map((s) => s + '.json').sort().join(','), names.join(','));
    }
} finally {
    try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best effort */ }
}

console.log('\n' + sb.tally(pass, fail, infra));
process.exitCode = sb.exitCode(fail, infra);
