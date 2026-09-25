#!/usr/bin/env node
/**
 * test-gate-lock.js - drives tooling/gate-lock.js as a SUBPROCESS.
 *
 * What is worth proving here is a property of processes, not of functions:
 * which pid a lock names, and whether a reader in another pid table can see
 * it. So every case runs the real binary against a lock under a scratch dir,
 * and every hold waits on a go-file the suite creates, never on a timer. A
 * timer would let machine load decide whether the probe landed inside the
 * hold, which is the failure shape this lock exists to prevent.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const SUBJECT = path.join(__dirname, 'gate-lock.js');
const { msysAlive } = require('./gate-lock.js');
let failed = 0;

function check(name, cond, detail) {
    if (cond) { console.log(`PASS  ${name}`); return; }
    failed++;
    console.log(`FAIL  ${name}`);
    if (detail) console.log(String(detail).split('\n').map((l) => '      ' + l).join('\n'));
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-lock-suite-'));
const home = path.join(dir, 'home');
fs.mkdirSync(home);
const ENV = { ...process.env, HOME: home, USERPROFILE: home };

// The command every `run` case executes: writes its pid to a marker, waits for
// an optional go-file (60 s cap), then exits with the code it was given.
const FIXTURE = path.join(dir, 'fixture.js');
fs.writeFileSync(FIXTURE, [
    "const fs = require('fs');",
    'const [marker, code, go] = process.argv.slice(2);',
    'fs.writeFileSync(marker, String(process.pid));',
    'const end = Date.now() + 60000;',
    'const tick = () => {',
    '    if (!go || fs.existsSync(go) || Date.now() > end) { process.exitCode = Number(code); return; }',
    '    setTimeout(tick, 50);',
    '};',
    'tick();',
].join('\n'));
const q = (s) => `"${s}"`;
const fixture = (marker, code, go) => ['--', q(process.execPath), q(FIXTURE), q(marker), String(code), ...(go ? [q(go)] : [])];

function gl(args) {
    const r = spawnSync(process.execPath, [SUBJECT, ...args], { encoding: 'utf8', env: ENV, timeout: 120000 });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), error: r.error };
}
function glAsync(args) {
    const c = spawn(process.execPath, [SUBJECT, ...args], { env: ENV, windowsHide: true });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    const done = new Promise((res) => c.on('close', (code) => res({ code, out })));
    return { child: c, done };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, ms = 60000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (pred()) return true; await sleep(50); }
    return false;
}
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const released = (lock) => fs.readdirSync(path.dirname(lock)).filter((n) => n.startsWith(path.basename(lock) + '.released-'));
/** A pid that WAS a process and is not one now. */
function deadPid() { return spawnSync(process.execPath, ['-e', '0']).pid; }

(async () => {
    // -- 1. --help answers and touches nothing ------------------------------
    {
        const r = gl(['--help']);
        check('--help exits 0', r.code === 0, r.out);
        check('--help prints the usage', /gate-lock\.js - one full gate at a time/.test(r.out), r.out);
        check('--help creates no lock directory', !fs.existsSync(path.join(home, '.claude')), r.out);
    }

    // -- 2. status on a free lock names the path it read --------------------
    {
        const r = gl(['status']);
        const expected = path.join(home, '.claude', 'autodev', 'locks', 'full-gate.lock');
        check('status on a free default lock exits 0', r.code === 0, r.out);
        check('status names the default lock path it read', r.out.includes(expected) && /FREE/.test(r.out), r.out);
    }

    // -- 3. run holds the lock with its OWN pid, then releases it -----------
    {
        const lock = path.join(dir, 'l3', 'full-gate.lock');
        const marker = path.join(dir, 'm3');
        const go = path.join(dir, 'go3');
        const h = glAsync(['run', '--lock', lock, '--label', 'suite three', ...fixture(marker, 5, go)]);
        const seen = await until(() => /\nchild \d+\n/.test(read(lock) || '') && read(marker) !== null);
        const text = read(lock) || '';
        const lines = text.split('\n');
        const holder = Number(lines[0]);
        check('run creates the lock and records its child', seen, text);
        check('line 1 is the holder pid, the gate-lock process itself', holder === h.child.pid, `line 1 ${lines[0]}, gate-lock pid ${h.child.pid}`);
        check('line 2 carries the label and the start time', /^suite three, started \d\d:\d\dZ$/.test(lines[1]), text);
        const st = gl(['status', '--lock', lock]);
        check('status on a held lock exits 4', st.code === 4, st.out);
        check('status reads the holder alive in the native table', new RegExp(`pid ${holder}: native alive`).test(st.out), st.out);
        fs.writeFileSync(go, '');
        const r = await h.done;
        check('run exits with the command status', r.code === 5, `exit ${r.code}\n${r.out}`);
        check('run releases the lock when the command ends', !fs.existsSync(lock), r.out);
        const rel = released(lock);
        check('the released lock is kept as evidence', rel.length === 1, rel.join(', '));
        check('run reports the command exit and the release', /command exit 5 after \d+s, released to /.test(r.out), r.out);
    }

    // -- 4. a held lock refuses a second run, and --wait waits it out -------
    {
        const lock = path.join(dir, 'l4', 'full-gate.lock');
        const go = path.join(dir, 'go4');
        const m1 = path.join(dir, 'm4a');
        const m2 = path.join(dir, 'm4b');
        const m3 = path.join(dir, 'm4c');
        const h = glAsync(['run', '--lock', lock, ...fixture(m1, 0, go)]);
        await until(() => /\nchild \d+\n/.test(read(lock) || ''));
        const before = read(lock);
        const r2 = gl(['run', '--lock', lock, ...fixture(m2, 0)]);
        check('a second run against a live holder exits 4', r2.code === 4, `exit ${r2.code}\n${r2.out}`);
        check('a refused run never starts its command', read(m2) === null, r2.out);
        check('a refused run leaves the lock byte-identical', read(lock) === before, read(lock));
        const w = glAsync(['run', '--lock', lock, '--wait', '1', '--poll', '0.2', ...fixture(m3, 0)]);
        await sleep(600);
        check('a waiting run has not started while the holder runs', read(m3) === null);
        fs.writeFileSync(go, '');
        const [rh, rw] = await Promise.all([h.done, w.done]);
        check('the holder exits 0', rh.code === 0, rh.out);
        check('the waiting run takes the lock once it is released', rw.code === 0 && read(m3) !== null, `exit ${rw.code}\n${rw.out}`);
        check('both runs left a released lock', released(lock).length === 2, released(lock).join(', '));
    }

    // -- 5. a dead holder is reported and never removed ---------------------
    const psReadable = process.platform !== 'win32' || msysAlive(process.pid) !== null;
    {
        const lock = path.join(dir, 'l5.lock');
        const pid = deadPid();
        const text = `${pid}\nlegacy writer, started 00:00Z\n`;
        fs.writeFileSync(lock, text);
        const want = psReadable ? 3 : 2;
        const st = gl(['status', '--lock', lock]);
        check(`status on a dead holder exits ${want} (${psReadable ? 'every table read' : 'MSYS table unreadable'})`, st.code === want, st.out);
        if (psReadable) check('a dead lock names the command that sets it aside', /set it aside with: mv /.test(st.out), st.out);
        const m = path.join(dir, 'm5');
        const r = gl(['run', '--lock', lock, ...fixture(m, 0)]);
        check('run against a dead holder refuses with the same verdict', r.code === want && read(m) === null, `exit ${r.code}\n${r.out}`);
        check('a dead lock is left byte-identical', read(lock) === text, read(lock));
        // The same lock read with no `ps` reachable: on Windows the MSYS table is
        // then unreadable, and a pid that table might hold cannot be called dead.
        const key = Object.keys(ENV).find((k) => k.toLowerCase() === 'path');
        const bare = { ...ENV, [key]: path.dirname(process.execPath) };
        const r2 = spawnSync(process.execPath, [SUBJECT, 'status', '--lock', lock], { encoding: 'utf8', env: bare, timeout: 120000 });
        const wantBare = process.platform === 'win32' ? 2 : 3;
        check(`with no ps on PATH the same lock exits ${wantBare}${process.platform === 'win32' ? ', undecidable rather than dead' : ''}`,
            r2.status === wantBare, `exit ${r2.status}\n${r2.stdout}${r2.stderr}`);
    }

    // -- 6. a dead holder with a LIVE child is still held --------------------
    // The wrapper was killed and its gate still runs: exactly when a second
    // gate would do the most damage.
    {
        const go = path.join(dir, 'go6');
        const m = path.join(dir, 'm6');
        const c = spawn(process.execPath, [FIXTURE, m, '0', go], { windowsHide: true });
        await until(() => read(m) !== null);
        const lock = path.join(dir, 'l6.lock');
        fs.writeFileSync(lock, `${deadPid()}\nkilled wrapper, started 00:00Z\nchild ${c.pid}\n`);
        const st = gl(['status', '--lock', lock]);
        check('a dead holder with a live child reads HELD (exit 4)', st.code === 4, st.out);
        fs.writeFileSync(go, '');
        await new Promise((res) => c.on('close', res));
        const after = gl(['status', '--lock', lock]);
        check('once that child ends too, the lock is no longer held', after.code !== 4, after.out);
    }

    // -- 7. the incident: line 1 is a Git Bash $$ ---------------------------
    // On Windows $$ is an MSYS pid that process.kill() cannot see. On other
    // platforms it is a native pid, and the case holds trivially.
    if (!psReadable) {
        console.log('SKIP  a lock naming a live MSYS pid: `ps` is not runnable here, so the MSYS table cannot be read');
    } else {
        const b = spawn('bash', ['-c', 'echo $$; read x'], { windowsHide: true });
        let first = '';
        b.stdout.on('data', (d) => { first += d; });
        b.on('error', () => {});
        const got = await until(() => /^\d+\s/.test(first), 30000);
        const pid = Number(first.trim().split(/\s+/)[0]);
        const lock = path.join(dir, 'l7.lock');
        fs.writeFileSync(lock, `${pid}\ngate-tail-locked.sh, started 00:00Z\n`);
        const st = gl(['status', '--lock', lock]);
        check('a bash writer reported its $$', got, first);
        check('a lock naming a live bash $$ reads HELD (exit 4)', st.code === 4, st.out);
        b.stdin.end();
        await new Promise((res) => b.on('close', res));
        const after = gl(['status', '--lock', lock]);
        check('once that bash exits, the same lock reads dead (exit 3)', after.code === 3, after.out);
    }

    // -- 8. a lock that names no pid is undecidable, not free ---------------
    {
        const lock = path.join(dir, 'l8.lock');
        fs.writeFileSync(lock, 'hello\n');
        const st = gl(['status', '--lock', lock]);
        check('a lock with no pid on line 1 exits 2', st.code === 2 && /line 1 is not a pid/.test(st.out), st.out);
        const r = gl(['run', '--lock', lock, ...fixture(path.join(dir, 'm8'), 0)]);
        check('run against it refuses and leaves it alone', r.code === 2 && read(lock) === 'hello\n', `exit ${r.code}\n${r.out}`);
    }

    // -- 9. words after -- belong to the command ----------------------------
    {
        const lock = path.join(dir, 'l9.lock');
        const m = path.join(dir, 'm9');
        const go = path.join(dir, 'go9');
        fs.writeFileSync(go, '');
        const r = gl(['run', '--lock', lock, ...fixture(m, 0, go), '--help']);
        check('a --help after -- is passed to the command, not answered', r.code === 0 && read(m) !== null && !/one full gate at a time/.test(r.out), r.out);
        const none = gl(['run', '--lock', lock]);
        check('run with no command exits 2 and takes no lock', none.code === 2 && !fs.existsSync(lock), none.out);
    }

    // -- 10. a run releases only a lock that still names it ----------------
    // Someone set this run's lock aside while it ran, and another gate took
    // the path. Renaming it at the end would free the machine under that gate.
    {
        const lock = path.join(dir, 'l10.lock');
        const go = path.join(dir, 'go10');
        const h = glAsync(['run', '--lock', lock, ...fixture(path.join(dir, 'm10'), 0, go)]);
        await until(() => /\nchild \d+\n/.test(read(lock) || ''));
        fs.renameSync(lock, `${lock}.stale-suite`);
        const theirs = `${process.pid}\nanother gate, started 00:00Z\n`;
        fs.writeFileSync(lock, theirs);
        fs.writeFileSync(go, '');
        const r = await h.done;
        check("a run leaves alone a lock that no longer names it", read(lock) === theirs, `lock now: ${read(lock)}\n${r.out}`);
        check('and says so', /no longer names this process/.test(r.out), r.out);
    }

    fs.rmSync(dir, { recursive: true, force: true });
    console.log(failed ? `\n${failed} check(s) failed` : '\nall gate-lock checks passed');
    process.exitCode = failed ? 1 : 0;
})();
