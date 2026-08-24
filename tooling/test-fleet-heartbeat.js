#!/usr/bin/env node
// Suite for plugins/autodev-core/scripts/fleet-heartbeat.js
//
// The heartbeat store is what the fleet status board reasons about, and it is
// written from the wired Stop hook on EVERY turn end of every session. Nothing
// drove it before this file: write() was entered only by other suites' Stop-hook
// fixtures, which are named `sess.jsonl` / `clean.jsonl` and therefore bail at
// the UUID guard — so the interesting half never ran and isHeartbeatFile(),
// prune() and readAll() were never entered at all.
//
// Three behaviours, and the last two are the ones with a real incident behind
// them:
//
//   WRITE     a turn end records one file keyed on the cliSessionId, and a
//             FIXTURE-named transcript records nothing. The guard exists
//             because test heartbeats for names that were never sessions once
//             made the board report fabricated stalls.
//   READ      dotfiles in the same directory are notifier state, never
//             heartbeats. The planted dotfile here carries a year-2999
//             timestamp, so if the filter breaks it sorts to the top and is
//             impossible to miss.
//
//             Stated rather than implied, because a mutation run found it:
//             deleting `!name.startsWith('.')` from isHeartbeatFile() is an
//             EQUIVALENT mutant and this suite stays green against it. UUID_RE
//             is ^-anchored, so any leading dot already fails it — verified
//             over `.notified.json`, `.notify-last-run.json`, `.json`,
//             `..json` and `.<uuid>.json`, all false either way. The dot check
//             is defence-in-depth for a future looser UUID_RE, and no test can
//             kill it while that anchor stands. What IS pinned is the
//             observable behaviour: notifier state is never read and never
//             pruned, which the UUID clause enforces today and which a mutant
//             removing THAT clause does fail.
//   PRUNE     drops heartbeats past the retention window and MUST NOT drop the
//             notifier's dedup memory, which lives beside them and would be
//             silently wiped every 7 days.
//   LOCATE    where the store lives is itself behaviour: AUTODEV_FLEET_DIR wins,
//             then USERPROFILE, then HOME. The whole suite rests on the first of
//             those, and the other two are the only thing standing between a
//             Windows box and a Unix one, so all three are asserted against the
//             exported DIR rather than assumed.
//
// Method: drive the subject as a SUBPROCESS. write() goes through the real Stop
// hook, so the production call site is what is under test. readAll() goes
// through the script's own CLI. prune() and DIR need a tiny driver, which calls
// the named export when it is a function and prints it when it is not.
//
// ONE MUTANT IS KNOWINGLY LEFT ALIVE, so the next reader does not re-litigate
// it: line 104, `Math.floor(Date.now() / 1000) % PRUNE_EVERY === 0` flipped to
// `!== 0`. That gate is wall-clock, and its input only moves once per SECOND —
// twenty-five rapid writes inside one second all read the same modulus. Killing
// the mutant therefore means busy-waiting up to 25s for an aligned second and
// asserting a deletion happened, in a suite that is part of `npm test`; and the
// assertion would straddle a second boundary whenever the write is slow, so it
// would buy a flake as well as the delay. The flip is a FREQUENCY change (prune
// on 24 seconds in 25 instead of 1), not a correctness change: prune() itself is
// idempotent, is driven directly and exhaustively below, and deletes nothing
// that is inside the window however often it runs. Left alive deliberately.
//
// Run: node tooling/test-fleet-heartbeat.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SUBJECT = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'fleet-heartbeat.js');
const STOP_HOOK = path.resolve(__dirname, '..', 'plugins', 'autodev-core', 'hooks', 'stop-auto-check.js');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-hb-'));
const FLEET = path.join(ROOT, 'fleet');
const PROJ = path.join(ROOT, 'proj');
const DRIVER = path.join(ROOT, 'drive-heartbeat.js');
const MISSING = path.join(ROOT, 'no-such-fleet');
// Its own store, so the session_id fallback can be counted exactly without
// perturbing the population every other assertion here is stated against.
const FALLBACK = path.join(ROOT, 'fleet-fallback');
// Never created — DIR is computed at module load and nothing writes it.
const HOME_WIN = path.join(ROOT, 'home-userprofile');
const HOME_NIX = path.join(ROOT, 'home-unix');

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
    console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}${cond ? '' : ' - ' + detail}`);
    if (cond) passed++; else failed++;
}

// AUTODEV_FLEET_DIR is read at module load, so it has to reach the child's env.
// That is also why nothing here requires the subject into this process.
const envFor = (dir) => ({ ...process.env, AUTODEV_FLEET_DIR: dir });

const stop = (payload, dir = FLEET) => spawnSync(process.execPath, [STOP_HOOK], {
    input: JSON.stringify(payload), encoding: 'utf8', env: envFor(dir), cwd: PROJ, windowsHide: true,
});
const cli = (dir = FLEET) => spawnSync(process.execPath, [SUBJECT], {
    encoding: 'utf8', env: envFor(dir), windowsHide: true,
});
const drive = (fn, dir = FLEET) => spawnSync(process.execPath, [DRIVER, SUBJECT, fn], {
    encoding: 'utf8', env: envFor(dir), windowsHide: true,
});

// For the DIR assertions only: start from a child env with all three location
// variables REMOVED — case-insensitively, since Windows reports them in
// whatever case it stored — then set back exactly the ones under test.
const envLocating = (vars) => {
    const env = { ...process.env };
    for (const k of Object.keys(env)) {
        if (/^(AUTODEV_FLEET_DIR|USERPROFILE|HOME)$/i.test(k)) delete env[k];
    }
    return Object.assign(env, vars);
};
const dirWith = (vars) => spawnSync(process.execPath, [DRIVER, SUBJECT, 'DIR'], {
    encoding: 'utf8', env: envLocating(vars), windowsHide: true,
});
const store = (home) => path.join(home, '.claude', 'fleet');

const ls = (dir = FLEET) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);
const plant = (name, rec) => {
    fs.mkdirSync(FLEET, { recursive: true });
    fs.writeFileSync(path.join(FLEET, name), JSON.stringify(rec) + '\n', 'utf8');
};
const backdate = (name, days) => {
    const t = new Date(Date.now() - days * 864e5);
    fs.utimesSync(path.join(FLEET, name), t, t);
};

// Real UUIDs — anything else is rejected by the subject on purpose.
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const D = '44444444-4444-4444-8444-444444444444';
const E = '55555555-5555-4555-8555-555555555555';
const F = '66666666-6666-4666-8666-666666666666';
const G = '77777777-7777-4777-8777-777777777777';
const H = '88888888-8888-4888-8888-888888888888';
const I = '99999999-9999-4999-8999-999999999999';

function run() {
    fs.mkdirSync(PROJ, { recursive: true });
    fs.writeFileSync(DRIVER,
        '// spawned by tooling/test-fleet-heartbeat.js\n'
        + 'const hb = require(process.argv[2]);\n'
        + 'const m = hb[process.argv[3]];\n'
        + "const out = typeof m === 'function' ? m() : m;\n"
        + "if (out !== undefined) process.stdout.write(typeof out === 'string' ? out : JSON.stringify(out));\n", 'utf8');

    console.log('\n=== write: a turn end is recorded through the real Stop hook ===');

    const tA = path.join(ROOT, A + '.jsonl');
    const rA = stop({
        session_id: 'ignored-in-favour-of-the-transcript-name',
        transcript_path: tA, cwd: PROJ, hook_event_name: 'Stop', stop_hook_active: false,
    });
    check('the Stop hook still approves the turn',
        rA.status === 0 && (rA.stdout || '').includes('"approve"'),
        `exit=${rA.status} stdout=${JSON.stringify((rA.stdout || '').slice(0, 120))}`);
    check('a UUID-named transcript writes exactly one heartbeat',
        ls().length === 1 && ls()[0] === A + '.json', `dir=${JSON.stringify(ls())}`);

    let recA = {};
    try { recA = JSON.parse(fs.readFileSync(path.join(FLEET, A + '.json'), 'utf8')); } catch (e) { recA = { __err: e.message }; }
    check('the record keys on the cliSessionId taken from the transcript name',
        recA.cliSessionId === A, `got ${JSON.stringify(recA.cliSessionId)}`);
    check('the record carries the cwd the hook resolved', recA.cwd === PROJ, `got ${JSON.stringify(recA.cwd)}`);
    check('the record carries the transcript path', recA.transcript === tA, `got ${JSON.stringify(recA.transcript)}`);
    check('stoppedAt is a parseable timestamp from just now',
        Number.isFinite(Date.parse(recA.stoppedAt)) && Math.abs(Date.now() - Date.parse(recA.stoppedAt)) < 300000,
        `got ${JSON.stringify(recA.stoppedAt)}`);
    check('stopHookActive is false for a turn ending normally',
        recA.stopHookActive === false, `got ${JSON.stringify(recA.stopHookActive)}`);
    check('write-then-rename leaves no .tmp behind',
        !ls().some((f) => f.endsWith('.tmp')), `dir=${JSON.stringify(ls())}`);

    stop({ transcript_path: path.join(ROOT, B + '.jsonl'), cwd: PROJ, hook_event_name: 'Stop', stop_hook_active: true });
    let recB = {};
    try { recB = JSON.parse(fs.readFileSync(path.join(FLEET, B + '.json'), 'utf8')); } catch (e) { recB = { __err: e.message }; }
    check('stopHookActive is true inside a stop-hook continuation',
        recB.stopHookActive === true, `got ${JSON.stringify(recB.stopHookActive)}`);
    check('a second session gets its own record', ls().length === 2, `dir=${JSON.stringify(ls())}`);

    console.log('\n=== write: fixture residue must never reach the board ===');

    const before = ls().length;
    const rF = stop({ session_id: 'test', transcript_path: path.join(ROOT, 'sess.jsonl'), cwd: PROJ, hook_event_name: 'Stop' });
    check('a fixture-named transcript writes nothing',
        ls().length === before && !ls().includes('sess.json'), `dir=${JSON.stringify(ls())}`);
    check('and the turn still ends cleanly', rF.status === 0, `exit=${rF.status}`);

    const rN = stop({ session_id: 'test', cwd: PROJ, hook_event_name: 'Stop' });
    check('a non-UUID session_id with no transcript writes nothing',
        ls().length === before && rN.status === 0, `dir=${JSON.stringify(ls())} exit=${rN.status}`);

    console.log('\n=== write: session_id is the fallback when no transcript is named ===');

    // The negative above (a non-UUID session_id) cannot see this branch working,
    // because "rejected at the UUID guard" and "never read at all" produce the
    // same empty directory. Only a VALID session_id with no transcript separates
    // them. Written into its own store so the population asserted below is
    // exactly one file and nothing later has to be restated.
    const rG = stop({ session_id: G, cwd: PROJ, hook_event_name: 'Stop', stop_hook_active: false }, FALLBACK);
    check('a UUID session_id with no transcript writes exactly one heartbeat',
        ls(FALLBACK).length === 1 && ls(FALLBACK)[0] === G + '.json',
        `exit=${rG.status} dir=${JSON.stringify(ls(FALLBACK))}`);

    let recG = {};
    try { recG = JSON.parse(fs.readFileSync(path.join(FALLBACK, G + '.json'), 'utf8')); } catch (e) { recG = { __err: e.message }; }
    check('the fallback record keys on the session_id STRING, not the payload',
        recG.cliSessionId === G, `got ${JSON.stringify(recG.cliSessionId)}`);
    check('the fallback record carries a null transcript rather than inventing one',
        recG.transcript === null, `got ${JSON.stringify(recG.transcript)}`);
    check('the fallback record still carries the cwd and a fresh timestamp',
        recG.cwd === PROJ && Number.isFinite(Date.parse(recG.stoppedAt)),
        `cwd=${JSON.stringify(recG.cwd)} stoppedAt=${JSON.stringify(recG.stoppedAt)}`);

    console.log('\n=== read: population, filtering and order ===');

    // Year 2020 so both planted records sort BEHIND the two written above; year
    // 2999 on the two that must be filtered out, so a broken filter puts them
    // first rather than somewhere easy to overlook.
    plant(C + '.json', { cliSessionId: C, cwd: 'MARKER-OLDER', transcript: null, stoppedAt: '2020-01-01T00:00:00.000Z', stopHookActive: false });
    plant(D + '.json', { cliSessionId: D, cwd: 'MARKER-NEWER', transcript: null, stoppedAt: '2020-06-01T00:00:00.000Z', stopHookActive: false });
    plant('.notified.json', { cliSessionId: E, cwd: 'MARKER-DOTFILE', stoppedAt: '2999-01-01T00:00:00.000Z' });
    plant('sess.json', { cliSessionId: 'sess', cwd: 'MARKER-NONUUID', stoppedAt: '2999-01-01T00:00:00.000Z' });
    fs.writeFileSync(path.join(FLEET, 'notes.txt'), 'not json at all\n', 'utf8');

    // Planted population: A and B from the hook, C and D by hand = 4 heartbeats,
    // alongside 3 files that are not heartbeats.
    const out1 = (cli().stdout || '');
    check('the CLI reports the exact heartbeat population',
        out1.includes('4 heartbeat(s) in '), `out=${JSON.stringify(out1.slice(0, 200))}`);
    check('a dotfile is never read as a heartbeat',
        !out1.includes('MARKER-DOTFILE'), 'notifier state was read as a session record');
    check('a non-UUID .json is never read as a heartbeat',
        !out1.includes('MARKER-NONUUID'), 'a fixture-named record reached the board');
    check('records come back freshest first',
        out1.indexOf('MARKER-NEWER') !== -1 && out1.indexOf('MARKER-NEWER') < out1.indexOf('MARKER-OLDER'),
        `newer at ${out1.indexOf('MARKER-NEWER')}, older at ${out1.indexOf('MARKER-OLDER')}`);
    check('the two live records sort ahead of both planted ones',
        out1.indexOf(PROJ) !== -1 && out1.indexOf(PROJ) < out1.indexOf('MARKER-NEWER'),
        `live at ${out1.indexOf(PROJ)}, newer at ${out1.indexOf('MARKER-NEWER')}`);

    console.log('\n=== prune: the retention window, and what it must not touch ===');

    // Read the window off the subject rather than restating it. If both fixtures
    // drifted onto the same side of it, every assertion below would still be
    // green while testing nothing.
    const retainSrc = fs.readFileSync(SUBJECT, 'utf8').match(/RETAIN_DAYS\s*=\s*(\d+)/);
    check('the retention window is readable from the subject', !!retainSrc, 'RETAIN_DAYS not found');
    const RETAIN = retainSrc ? Number(retainSrc[1]) : NaN;
    const STALE_DAYS = 30;
    const FRESH_DAYS = 1;
    check(`the stale fixture (${STALE_DAYS}d) sits OUTSIDE the shipped ${RETAIN}d window`,
        STALE_DAYS > RETAIN, `RETAIN=${RETAIN}`);
    check(`the fresh fixture (${FRESH_DAYS}d) sits INSIDE the shipped ${RETAIN}d window`,
        FRESH_DAYS < RETAIN, `RETAIN=${RETAIN}`);

    backdate(C + '.json', STALE_DAYS);
    backdate(D + '.json', FRESH_DAYS);
    backdate('.notified.json', STALE_DAYS);
    backdate('sess.json', STALE_DAYS);

    const p = drive('prune');
    check('prune exits 0 and says nothing',
        p.status === 0 && !(p.stdout || '') && !(p.stderr || '').trim(),
        `exit=${p.status} out=${JSON.stringify(p.stdout)} err=${JSON.stringify((p.stderr || '').slice(0, 200))}`);
    check('prune deletes a heartbeat older than the window',
        !ls().includes(C + '.json'), `still present, dir=${JSON.stringify(ls())}`);
    check('prune keeps a heartbeat inside the window',
        ls().includes(D + '.json'), `deleted, dir=${JSON.stringify(ls())}`);
    check('prune keeps the records written this run',
        ls().includes(A + '.json') && ls().includes(B + '.json'), `dir=${JSON.stringify(ls())}`);
    check('prune NEVER touches notifier state, however old',
        ls().includes('.notified.json'), 'the notifier dedup memory was wiped');
    check('prune NEVER touches a .json that is not a heartbeat',
        ls().includes('sess.json'), 'a non-heartbeat file was deleted');

    console.log('\n=== a missing or damaged store is survivable, never fatal ===');

    const pm = drive('prune', MISSING);
    check('prune on a missing directory exits 0 with no stderr',
        pm.status === 0 && !(pm.stderr || '').trim(),
        `exit=${pm.status} err=${JSON.stringify((pm.stderr || '').slice(0, 200))}`);
    check('prune does not create the directory it could not read',
        !fs.existsSync(MISSING), 'the store was created by a read-only operation');

    const cm = cli(MISSING);
    check('the CLI reports zero on a missing store rather than crashing',
        cm.status === 0 && (cm.stdout || '').includes('0 heartbeat(s)'),
        `exit=${cm.status} out=${JSON.stringify((cm.stdout || '').slice(0, 160))}`);

    // Three heartbeats survive the prune (A, B, D). A half-written record must
    // be skipped rather than taking the whole read down with it.
    fs.writeFileSync(path.join(FLEET, F + '.json'), '{"cliSessionId":"' + F + '"', 'utf8');
    const cd = cli();
    check('a half-written record is skipped, not fatal',
        cd.status === 0 && (cd.stdout || '').includes('3 heartbeat(s) in '),
        `exit=${cd.status} out=${JSON.stringify((cd.stdout || '').slice(0, 160))}`);

    console.log('\n=== read: a UUID-named file is not yet a heartbeat RECORD ===');

    // The filename says which session a record claims to be; the cliSessionId
    // inside it is what the board joins on. A file can pass the name filter and
    // still be unusable — a truncated write that happened to close its brace, or
    // an older record shape. Neither is a corruption the CLI can survive by
    // luck: it prints `cliSessionId.slice(0, 8)` for every record it accepts, so
    // accepting one without the field takes the whole read down.
    plant(H + '.json', { cwd: 'MARKER-NO-ID', stoppedAt: '2999-01-01T00:00:00.000Z' });
    fs.writeFileSync(path.join(FLEET, I + '.json'), 'null\n', 'utf8');

    const cs = cli();
    check('the population is unchanged by a UUID-named file with no cliSessionId',
        (cs.stdout || '').includes('3 heartbeat(s) in '),
        `out=${JSON.stringify((cs.stdout || '').slice(0, 200))}`);
    check('an id-less record never reaches the board',
        !(cs.stdout || '').includes('MARKER-NO-ID'), 'a record with no session id was listed');
    check('a literal null record is skipped rather than dereferenced',
        cs.status === 0 && !(cs.stderr || '').trim(),
        `exit=${cs.status} err=${JSON.stringify((cs.stderr || '').slice(0, 200))}`);

    console.log('\n=== locate: AUTODEV_FLEET_DIR, then USERPROFILE, then HOME ===');

    // Nothing above can see this: every spawn here sets AUTODEV_FLEET_DIR, so
    // the home-directory branch is never evaluated. These three drive DIR with
    // that override removed. DIR is computed at load and creates nothing, so the
    // two home paths never need to exist.
    const dOverride = dirWith({ AUTODEV_FLEET_DIR: FLEET, USERPROFILE: HOME_WIN, HOME: HOME_NIX });
    check('AUTODEV_FLEET_DIR outranks both home variables',
        dOverride.status === 0 && dOverride.stdout === FLEET,
        `exit=${dOverride.status} got ${JSON.stringify(dOverride.stdout)} want ${JSON.stringify(FLEET)}`);

    const dWin = dirWith({ USERPROFILE: HOME_WIN, HOME: HOME_NIX });
    check('with both set, the store hangs off USERPROFILE',
        dWin.status === 0 && dWin.stdout === store(HOME_WIN),
        `exit=${dWin.status} got ${JSON.stringify(dWin.stdout)} want ${JSON.stringify(store(HOME_WIN))}`);

    // USERPROFILE is EMPTIED here rather than deleted, and that is not a
    // shortcut. libuv keeps a required-variable list on Windows and copies
    // USERPROFILE in from the parent whenever a spawned child's env omits it —
    // measured: deleting the key yields the real profile path in the child,
    // setting it to '' yields ''. So "absent" is unreachable through spawn on
    // this platform and "" is the falsy state the fallback actually meets.
    const dNix = dirWith({ USERPROFILE: '', HOME: HOME_NIX });
    check('with USERPROFILE empty, it falls back to HOME rather than to nothing',
        dNix.status === 0 && dNix.stdout === store(HOME_NIX),
        `exit=${dNix.status} got ${JSON.stringify(dNix.stdout)} want ${JSON.stringify(store(HOME_NIX))}`
        + ` err=${JSON.stringify((dNix.stderr || '').slice(0, 160))}`);
}

try {
    run();
} catch (e) {
    check('the suite ran to completion', false, `crashed: ${e && e.stack ? e.stack.split('\n')[0] : e}`);
} finally {
    try { fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows file locks */ }
}

const total = passed + failed;
console.log(`\ntest-fleet-heartbeat: ${failed ? `FAIL (${failed} of ${total})` : `PASS (${total} assertions)`}\n`);
process.exit(failed ? 1 : 0);
