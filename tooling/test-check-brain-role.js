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
    check('--help exits 0 and names the four states', help.status === 0 && /absent/.test(help.out) && /degraded/.test(help.out) && /fault/.test(help.out), 'exit ' + help.status);
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

    /* This morning's record: a peer name nobody resolves, everything else fine.
       `[measured 2026-09-08]` five times over, and the verdict said `fault` while
       the text beneath it offered the desktop id. It is DEGRADED: the fault is
       exact, exit 2 is unchanged, and the difference is what the reader -- a
       person here, `stop-brain-report.js` in the hook -- is told to do next. */
    const suffix = run(['--status', '--role', role({ session_id: 'cli-live', peer_name: 'peer-live-71', desktop_session_id: 'local_desk-live' })]);
    check('a stale peer suffix alone: exit 2, and the fault named',
        suffix.status === 2 && /FAULT dead-peer: peer_name peer-live-71/.test(suffix.out) && !/dead-session/.test(suffix.out), suffix.out);
    check('  the verdict line says DEGRADED, not FAULT, because an address survives',
        /^brain-role: DEGRADED/m.test(suffix.out), suffix.out.split('\n')[0]);
    check('  and the advice offers the desktop id and names peer_name as the stale FIELD',
        /PARTLY STALE AND STILL REACHABLE\. Use desktop session id `local_desk-live`/.test(suffix.out)
        && /Stale, so a field to re-stamp and not an address: `peer_name`/.test(suffix.out)
        && !/Nobody can be reached/.test(suffix.out), suffix.out);
    /* The control: same shape, but the desktop id is gone too. Nothing reaches,
       so DEGRADED must not be printed. Without this pair a subject that says
       DEGRADED on every fault passes the three checks above. */
    const bothGone = run(['--status', '--role', role({ session_id: 'cli-live', peer_name: 'peer-live-71', desktop_session_id: 'local_desk-archived' })]);
    check('  control: with the desktop record archived too, nothing reaches -> FAULT',
        bothGone.status === 2 && /^brain-role: FAULT/m.test(bothGone.out)
        && /Nobody can be reached/.test(bothGone.out) && !/PARTLY STALE/.test(bothGone.out), bothGone.out);
    /* And the third state, from the same fixture: DEGRADED must not be reachable
       by "the check did not run". The desktop id above is live, and with no
       store to read it against the verdict may not lean on it. */
    const unchecked = run(['--status', '--role', role({ session_id: 'cli-live', peer_name: 'peer-live-71', desktop_session_id: 'local_desk-live' })],
        { CLAUDE_SESSION_STORE: path.join(ROOT, 'no-such-store') });
    check('  an UNCHECKED address never produces DEGRADED, and is not called dead either',
        unchecked.status === 2 && !/DEGRADED/.test(unchecked.out) && !/PARTLY STALE/.test(unchecked.out)
        && /NO ADDRESS HERE WAS VERIFIED REACHABLE/.test(unchecked.out) && !/Nobody can be reached/.test(unchecked.out),
        unchecked.out);

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

    // ------------------------------------------ the pipe delivers every byte
    //
    // node's process.stdout is ASYNCHRONOUS when it is a pipe on darwin and
    // synchronous when it is a pipe on linux/win32, and process.exit() does not
    // drain a pending async write. A run that prints past the 64KiB OS pipe
    // buffer and then exits hands its caller exactly 65536 bytes under an exit
    // status that says nothing failed — the shape rendered-layout-gate.js
    // shipped with until 2026-09-07.
    //
    // WHY IT IS REACHABLE HERE: --json echoes the role record back whole, and
    // the role file is operator-written JSON that nothing in this tool caps.
    //
    // TWO ASSERTIONS, and the first is what stops the second passing by
    // construction: the output must EXCEED one pipe buffer, and the piped byte
    // count must equal the same run redirected to a FILE, where the write is
    // synchronous on every platform.
    const bigRole = role({
        session_id: 'cli-live', peer_name: 'peer-live', desktop_session_id: 'local_desk-live',
        // A field a coordinator really would carry: the standing brief it is
        // working from. Long, and echoed straight back by --json.
        mandate: Array.from({ length: 900 },
            (unused, i) => 'paragraph ' + i + ' of a standing coordinator brief, long enough that the '
                + 'record it lives in is not a handful of bytes').join('\n'),
    });
    const PIPE_BUF = 64 * 1024;
    const viaFileBytes = (args) => {
        const out = path.join(ROOT, 'via-file.out');
        const fd = fs.openSync(out, 'w');
        spawnSync(process.execPath, [SUBJECT].concat(args), {
            stdio: ['ignore', fd, 'ignore'],
            env: Object.assign({}, process.env, { AUTODEV_SESSIONS_DIR: SESSIONS, CLAUDE_SESSION_STORE: STORE }),
        });
        fs.closeSync(fd);
        return fs.statSync(out).size;
    };
    const bigPipe = spawnSync(process.execPath, [SUBJECT, '--json', '--role', bigRole], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        env: Object.assign({}, process.env, { AUTODEV_SESSIONS_DIR: SESSIONS, CLAUDE_SESSION_STORE: STORE }),
    });
    const bigPipeBytes = Buffer.byteLength(bigPipe.stdout || '', 'utf8');
    const bigFileBytes = viaFileBytes(['--json', '--role', bigRole]);
    check('--json over a large role record exceeds one pipe buffer, so the next check is not vacuous',
        bigFileBytes > PIPE_BUF, JSON.stringify({ bytes: bigFileBytes, buffer: PIPE_BUF }));
    check('  and through a PIPE it delivers every byte it writes to a FILE',
        bigPipeBytes === bigFileBytes, JSON.stringify({ pipe: bigPipeBytes, file: bigFileBytes }));
    check('  and the piped JSON still parses at that size, under exit 0',
        (() => { try { return JSON.parse(bigPipe.stdout).state === 'ok' && bigPipe.status === 0; } catch { return false; } })(),
        'exit ' + bigPipe.status + ', tail ' + JSON.stringify((bigPipe.stdout || '').slice(-40)));

    // render() prints the faults and lines, not the role record, so --status
    // cannot be driven over the buffer from a fixture. It shares the exit path,
    // so it gets the equality alone; THIS LINE CANNOT CATCH THE REGRESSION.
    const statusPipe = run(['--status', '--role', bigRole]);
    check('  --status also delivers every byte, though it stays under the buffer',
        Buffer.byteLength(statusPipe.out, 'utf8') === viaFileBytes(['--status', '--role', bigRole]),
        Buffer.byteLength(statusPipe.out, 'utf8'));
} finally {
    try { fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* temp */ }
}

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
console.log('subject: plugins/autodev-core/scripts/check-brain-role.js; fixture of 2 session files (own pid live, 999999 dead), 2 nested store records (1 archived); every fault case beside the passing record, a dead-pid control, and the three verdicts driven off one record shape -- DEGRADED with a live desktop id, FAULT with it archived, and neither when no store could be read.');
if (fail) { console.log('failed: ' + failures.join('; ')); process.exit(1); }
