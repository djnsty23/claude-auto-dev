#!/usr/bin/env node
// Suite for plugins/autodev-core/scripts/check-brain-role.js.
//
// Drives the CLI as a SUBPROCESS against fixture directories, because the
// script's job is to read three registries off disk and the only honest test
// reads them the same way. This process's own pid is the live session and
// 999999 is the dead one, so liveness is measured rather than stubbed, and the
// negative control is what proves the probe can tell the cases apart rather
// than merely refusing: `[measured 2026-09-04]` a first implementation on
// Python's os.kill refused every claim while looking strict.
//
// Every fault case sits beside the known-positive that passes, so a mutant
// that refuses everything fails the pair, not half of it.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SUBJECT = path.join(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'check-brain-role.js');

let pass = 0, fail = 0;
const failures = [];
function check(label, ok, detail) {
    if (ok) pass++; else { fail++; failures.push(label); }
    console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (!ok && detail ? '  (' + detail + ')' : ''));
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'test-check-brain-role-'));
const SESSIONS = path.join(ROOT, 'sessions');
const STORE = path.join(ROOT, 'store');
fs.mkdirSync(SESSIONS, { recursive: true });
// Nested on purpose: the real store keeps records two directories down, and a
// flat fixture would pass a reader that never recurses.
fs.mkdirSync(path.join(STORE, 'acct', 'bucket'), { recursive: true });
const w = (p, o) => fs.writeFileSync(p, JSON.stringify(o));
w(path.join(SESSIONS, process.pid + '.json'), { pid: process.pid, sessionId: 'cli-live', name: 'peer-live' });
w(path.join(SESSIONS, '999999.json'), { pid: 999999, sessionId: 'cli-dead', name: 'peer-dead' });
w(path.join(STORE, 'acct', 'bucket', 'local_desk-live.json'), { sessionId: 'local_desk-live', cliSessionId: 'cli-live', isArchived: false });
w(path.join(STORE, 'acct', 'bucket', 'local_desk-archived.json'), { sessionId: 'local_desk-archived', cliSessionId: 'cli-dead', isArchived: true, title: 'Old brain' });

let n = 0;
function role(obj) {
    const p = path.join(ROOT, 'role-' + (n++) + '.json');
    if (obj !== null) fs.writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj));
    return p;
}

function run(args, env) {
    const r = spawnSync(process.execPath, [SUBJECT].concat(args), {
        encoding: 'utf8',
        env: Object.assign({}, process.env, { AUTODEV_SESSIONS_DIR: SESSIONS, CLAUDE_SESSION_STORE: STORE }, env || {}),
    });
    return { status: r.status, out: r.stdout || '', err: r.stderr || '' };
}

try {
    // --help and --selftest are what check-entrypoints and check-suites lean on.
    const help = run(['--help']);
    check('--help exits 0 and names the four states', help.status === 0 && /absent/.test(help.out) && /fault/.test(help.out), 'exit ' + help.status);
    const self = run(['--selftest']);
    check('--selftest passes on this machine', self.status === 0, self.out.slice(-400));
    /* Assert the ARITHMETIC, not the literal. This line read `fixture of 2
       session files` until a third fixture landed, and a hardcoded count in a
       population assertion decays into a false alarm the moment the fixture it
       describes legitimately grows. The invariant does not: live + dead must
       equal the files counted, archived cannot exceed the records, and nothing
       may be zero. That last clause is the one that matters, because the
       version of this line being replaced would have passed against a census
       taken after cleanup, which reported a confident 0 of everything. */
    const census = /selftest: (\d+) of (\d+) cases, fixture of (\d+) session file\(s\) \((\d+) live pid, (\d+) dead\) and (\d+) store record\(s\) \((\d+) archived\)/.exec(self.out);
    const c = census ? census.slice(1).map(Number) : null;
    check('  and prints a population whose arithmetic holds',
        !!c && c[0] === c[1] && c[0] > 0 && c[2] > 0 && c[3] > 0 && c[3] + c[4] === c[2] && c[5] > 0 && c[6] <= c[5],
        census ? census[0] : 'no population line: ' + self.out.slice(-200));

    // Known-positive.
    const okRole = role({ session_id: 'cli-live', peer_name: 'peer-live', desktop_session_id: 'local_desk-live' });
    const ok = run(['--status', '--role', okRole]);
    check('a live, complete record: exit 0', ok.status === 0, 'exit ' + ok.status + ' ' + ok.out.slice(0, 300));
    check('  verdict line says OK', /^brain-role: OK/m.test(ok.out));
    check('  population names both registries with counts', /population: 2 session file\(s\) under .*, 1 with a live pid, 1 dead; desktop store 2 record\(s\), 1 archived/.test(ok.out), ok.out.split('\n')[1]);
    check('  every field is shown resolving to a live pid', /session_id cli-live -> live session, pid \d+/.test(ok.out) && /peer_name peer-live -> live session/.test(ok.out) && /desktop_session_id local_desk-live -> live desktop record/.test(ok.out));
    check('  no FAULT line', !/FAULT/.test(ok.out));

    // The 2026-09-04 afternoon record: a session archived the day before.
    const dead = run(['--status', '--role', role({ session_id: 'cli-dead', peer_name: 'peer-dead', desktop_session_id: 'local_desk-archived' })]);
    check('a dead record: exit 2', dead.status === 2, 'exit ' + dead.status);
    check('  names the dead session id', /FAULT dead-session: session_id cli-dead has NO live session file/.test(dead.out), dead.out);
    check('  names the unresolvable peer', /FAULT dead-peer: peer_name peer-dead is not the name of any live session/.test(dead.out));
    check('  names the archived desktop record with its title', /FAULT archived-desktop: desktop_session_id local_desk-archived is ARCHIVED .*"Old brain"/.test(dead.out));
    check('  says there is no cwd fallback', /nothing here resolves a coordinator\s+by cwd/.test(dead.out));

    // The 2026-09-04 evening record: the desktop uuid written into session_id.
    const conf = run(['--status', '--role', role({ session_id: 'desk-live', peer_name: 'peer-live', desktop_session_id: 'local_desk-live' })]);
    check('desktop uuid in session_id: exit 2', conf.status === 2, 'exit ' + conf.status);
    check('  says the two registries key differently', /FAULT desktop-mismatch: desktop record local_desk-live belongs to CLI session cli-live, not to session_id desk-live/.test(conf.out), conf.out);

    // This morning's record: a peer name nobody resolves, everything else fine.
    const suffix = run(['--status', '--role', role({ session_id: 'cli-live', peer_name: 'peer-live-71', desktop_session_id: 'local_desk-live' })]);
    check('a stale peer suffix alone is a fault', suffix.status === 2 && /FAULT dead-peer: peer_name peer-live-71/.test(suffix.out) && !/dead-session/.test(suffix.out), suffix.out);

    // Half an address.
    const half = run(['--status', '--role', role({ session_id: 'cli-live', peer_name: 'peer-live' })]);
    check('a record with only a peer name is incomplete', half.status === 2 && /FAULT missing-field: `desktop_session_id` is absent/.test(half.out), half.out);

    // Absent, unreadable, and a store nobody can find.
    const absent = run(['--status', '--role', role(null)]);
    check('no role file: exit 0, absent, not a pass', absent.status === 0 && /^brain-role: ABSENT/m.test(absent.out) && /no coordinator has claimed/.test(absent.out), absent.out);
    const garbage = run(['--status', '--role', role('{ not json')]);
    check('an unparseable role file: exit 2, named', garbage.status === 2 && /FAULT unreadable/.test(garbage.out), garbage.out);
    const nostore = run(['--status', '--role', okRole], { CLAUDE_SESSION_STORE: path.join(ROOT, 'no-such-store') });
    check('a store that cannot be found is NOT CHECKED and does not fail a live record', nostore.status === 0 && /desktop store NOT FOUND/.test(nostore.out) && /NOT CHECKED/.test(nostore.out), nostore.out);

    // The discriminating control for the whole suite: the same OK record reads
    // dead once the live session file names a dead pid. Without this, every
    // "dead" verdict above could come from a probe that always says dead.
    const deadPidDir = path.join(ROOT, 'sessions-dead');
    fs.mkdirSync(deadPidDir);
    w(path.join(deadPidDir, '999998.json'), { pid: 999998, sessionId: 'cli-live', name: 'peer-live' });
    const flipped = run(['--status', '--role', okRole, '--sessions-dir', deadPidDir]);
    check('control: the OK record reads dead when its pid is dead, so the probe discriminates',
        flipped.status === 2 && /FAULT dead-session: session_id cli-live/.test(flipped.out) && /0 with a live pid, 1 dead/.test(flipped.out), flipped.out);

    const json = run(['--json', '--role', okRole]);
    check('--json is parseable and carries the population', (() => { try { const j = JSON.parse(json.out); return j.state === 'ok' && j.population.livePids === 1; } catch { return false; } })(), json.out.slice(0, 200));
} finally {
    try { fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* temp */ }
}

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
console.log('subject: plugins/autodev-core/scripts/check-brain-role.js; fixture of 2 session files (own pid live, 999999 dead), 2 nested store records (1 archived); every fault case beside the passing record, plus a dead-pid control.');
if (fail) { console.log('failed: ' + failures.join('; ')); process.exit(1); }
