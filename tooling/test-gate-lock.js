#!/usr/bin/env node
/**
 * test-gate-lock.js - drives tooling/gate-lock.js as a SUBPROCESS.
 *
 * Every property worth proving here belongs to a RUN, not a function: the lock
 * exists while the chain runs and is gone after it, the exit code survives the
 * wrapper exactly, a waiter really waits, and a killed chain never reads as
 * green. So each case starts the real script against a synthetic tree whose
 * `gate:chain` is a probe, with the lock path pointed at a temp directory.
 * The real lock under the home directory is never touched: every spawn sets
 * AUTODEV_GATE_LOCK_PATH, and that matters most when this suite runs INSIDE
 * `npm run gate`, which holds the real lock at the time.
 *
 * The probe (written into each fixture) records what the chain saw: whether
 * the lock existed and what it said, and its own pid. It then optionally
 * sleeps, so a case can kill things mid-run, and exits with the code asked.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const SUBJECT = path.join(__dirname, 'gate-lock.js');
const WIN = process.platform === 'win32';
let failed = 0;
let passed = 0;

function check(name, cond, detail) {
    if (cond) { passed++; console.log(`PASS  ${name}`); return; }
    failed++;
    console.log(`FAIL  ${name}`);
    if (detail) console.log(String(detail).split('\n').map((l) => '      ' + l).join('\n'));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const temps = [];
const mkTemp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); temps.push(d); return d; };

const PROBE = `'use strict';
const fs = require('fs');
const [code, sleepMs] = [Number(process.argv[2] || 0), Number(process.argv[3] || 0)];
const lock = process.env.AUTODEV_GATE_LOCK_PATH;
let content = null;
try { content = fs.readFileSync(lock, 'utf8'); } catch {}
fs.writeFileSync('probe-saw.json', JSON.stringify({ pid: process.pid, exists: content !== null, content }));
if (sleepMs > 0) setTimeout(() => process.exit(code), sleepMs);
else process.exitCode = code;
`;

/** A tree whose gate:chain is `chain`, plus a lock path whose directory does not exist yet. */
function fixture(chain) {
    const dir = mkTemp('gate-lock-tree-');
    const scripts = chain === null ? { gate: 'node gate-lock.js' } : { gate: 'node gate-lock.js', 'gate:chain': chain };
    fs.writeFileSync(path.join(dir, 'package.json'),
        JSON.stringify({ name: 'fixture', version: '0.0.0', private: true, scripts }, null, 2));
    fs.writeFileSync(path.join(dir, 'probe.js'), PROBE);
    const lockDir = path.join(mkTemp('gate-lock-home-'), 'locks');
    return { dir, lockDir, lockPath: path.join(lockDir, 'full-gate.lock') };
}

function envFor(fx, extra = {}) {
    const env = Object.assign({}, process.env, {
        AUTODEV_GATE_LOCK_PATH: fx.lockPath,
        AUTODEV_GATE_LOCK_POLL_MS: '100',
        AUTODEV_GATE_LOCK_REPORT_MS: '100000',
    }, extra);
    if (!('AUTODEV_GATE_LOCK' in extra)) delete env.AUTODEV_GATE_LOCK;
    return env;
}

/** Starts the wrapper; `done` resolves with its exit code, signal and output. */
function start(fx, extra) {
    const child = spawn(process.execPath, [SUBJECT, '--root', fx.dir],
        { env: envFor(fx, extra), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const run = { child, out: '' };
    child.stdout.on('data', (b) => { run.out += b; });
    child.stderr.on('data', (b) => { run.out += b; });
    run.done = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal, out: run.out })));
    return run;
}

async function waitFor(pred, ms, what) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        if (pred()) return true;
        await sleep(50);
    }
    console.log(`      (timed out after ${ms} ms waiting for ${what})`);
    return false;
}

/** Bounds a run: a wrapper that never exits fails the case instead of hanging the suite. */
async function finished(run, ms = 60000) {
    const t = sleep(ms).then(() => null);
    const r = await Promise.race([run.done, t]);
    if (r) return r;
    try { run.child.kill('SIGKILL'); } catch { /* gone */ }
    return { code: null, signal: 'TIMEOUT', out: run.out + '\n(test killed the wrapper after ' + ms + ' ms)' };
}

const saw = (fx) => {
    try { return JSON.parse(fs.readFileSync(path.join(fx.dir, 'probe-saw.json'), 'utf8')); } catch { return null; }
};
const asides = (fx, kind) => (fs.existsSync(fx.lockDir) ? fs.readdirSync(fx.lockDir) : [])
    .filter((f) => f.startsWith(`full-gate.lock.${kind}-`));

function killTree(pid) {
    if (!pid) return;
    if (WIN) spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    else { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
}

/** Asserts the lock was held during the run and released by rename afterwards. */
function heldThenReleased(label, fx, run, r) {
    const s = saw(fx);
    const lines = s && s.content ? s.content.split(/\r?\n/) : [];
    check(`${label}: the chain ran while the lock existed`, s && s.exists === true, r.out);
    check(`${label}: line 1 of the lock is the wrapper's pid`, lines[0] === String(run.child.pid),
        `line 1 ${JSON.stringify(lines[0])}, wrapper pid ${run.child.pid}`);
    check(`${label}: line 2 names branch, head, worktree and a UTC start`,
        /branch .+, head .+, worktree .+, started \d{4}-\d\d-\d\dT\d\d:\d\dZ$/.test(lines[1] || ''), lines[1]);
    check(`${label}: the lock is gone afterwards`, !fs.existsSync(fx.lockPath), r.out);
    const rel = asides(fx, 'released');
    check(`${label}: released by rename to .released-HHMM`,
        rel.length === 1 && /^full-gate\.lock\.released-\d{4}$/.test(rel[0]), JSON.stringify(rel));
}

async function main() {
    // -- 1. Green: acquire, run, release --------------------------------------
    {
        const fx = fixture('node probe.js 0');
        const run = start(fx);
        const r = await finished(run);
        check('green: exits 0', r.code === 0, `exit=${r.code}\n${r.out}`);
        heldThenReleased('green', fx, run, r);
        check('green: the final line says PASS and that the chain finished',
            /verdict PASS \(exit 0\), the chain finished/.test(r.out), r.out);
    }

    // -- 2. Red: released, exit 1 preserved -----------------------------------
    {
        const fx = fixture('node probe.js 1');
        const run = start(fx);
        const r = await finished(run);
        check('red: exits 1', r.code === 1, `exit=${r.code}\n${r.out}`);
        heldThenReleased('red', fx, run, r);
        check('red: the final line says FAIL', /verdict FAIL \(exit 1\), the chain finished/.test(r.out), r.out);
    }

    // -- 3. Exit 2 stays INDETERMINATE, and any other code survives exactly ----
    {
        const fx = fixture('node probe.js 2');
        const run = start(fx);
        const r = await finished(run);
        check('exit 2: the wrapper exits 2, not 1', r.code === 2, `exit=${r.code}\n${r.out}`);
        check('exit 2: reported INDETERMINATE', /verdict INDETERMINATE \(exit 2\), the chain finished/.test(r.out), r.out);
        check('exit 2: the lock is released', !fs.existsSync(fx.lockPath) && asides(fx, 'released').length === 1, r.out);

        const fx7 = fixture('node probe.js 7');
        const r7 = await finished(start(fx7));
        check('exit 7 comes out as 7', r7.code === 7, `exit=${r7.code}\n${r7.out}`);
    }

    // -- 4. A live holder: wait, report it, then acquire once it releases -------
    {
        const fx = fixture('node probe.js 0');
        fs.mkdirSync(fx.lockDir, { recursive: true });
        const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
        const peer = `${holder.pid}\npeer gate, head abc1234, worktrees/peer-session, started 11:30Z\n`;
        fs.writeFileSync(fx.lockPath, peer);
        const run = start(fx, { AUTODEV_GATE_LOCK_REPORT_MS: '300' });
        const waiting = await waitFor(() => /waiting for/.test(run.out), 20000, 'the waiting line');
        check('live holder: the wrapper says it is waiting', waiting, run.out);
        check("live holder: the waiting line quotes the holder's line 2",
            /held by live pid \d+\. Holder says: peer gate, head abc1234, worktrees\/peer-session/.test(run.out), run.out);
        await sleep(1200);
        check('live holder: the waiting line repeats on its cadence', (run.out.match(/waiting for/g) || []).length >= 2, run.out);
        check('live holder: the chain has not run while it waits', saw(fx) === null, run.out);
        check("live holder: the holder's lock is untouched while it waits",
            fs.readFileSync(fx.lockPath, 'utf8') === peer && asides(fx, 'stale').length === 0);
        fs.renameSync(fx.lockPath, fx.lockPath + '.released-peer');
        const r = await finished(run);
        killTree(holder.pid);
        check('live holder: after release, the wrapper acquires and exits 0', r.code === 0, `exit=${r.code}\n${r.out}`);
        const s = saw(fx);
        check('live holder: the chain then ran under the wrapper\'s own lock',
            s && s.exists && s.content.split('\n')[0] === String(run.child.pid), JSON.stringify(s));
        check("live holder: the peer's released record is intact",
            fs.readFileSync(fx.lockPath + '.released-peer', 'utf8') === peer);
    }

    // -- 5. A dead holder: moved aside to .stale-HHMM, never deleted -----------
    {
        const fx = fixture('node probe.js 0');
        fs.mkdirSync(fx.lockDir, { recursive: true });
        const dead = spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid;
        const old = `${dead}\nan abandoned gate, head 1234567, worktrees/gone, started 03:00Z\n`;
        fs.writeFileSync(fx.lockPath, old);
        const run = start(fx);
        const r = await finished(run);
        check('stale holder: the wrapper acquires and exits 0', r.code === 0, `exit=${r.code}\n${r.out}`);
        const stale = asides(fx, 'stale');
        check('stale holder: its lock is renamed to .stale-HHMM',
            stale.length === 1 && /^full-gate\.lock\.stale-\d{4}$/.test(stale[0]), JSON.stringify(stale));
        check('stale holder: the moved file keeps its content byte for byte',
            stale.length === 1 && fs.readFileSync(path.join(fx.lockDir, stale[0]), 'utf8') === old);
        check('stale holder: one line says what happened',
            new RegExp(`holder pid ${dead} is not running; moved its lock aside to full-gate\\.lock\\.stale-\\d{4} \\(it said: an abandoned gate`).test(r.out), r.out);
        heldThenReleased('stale holder', fx, run, r);
    }

    // -- 6. A holder it cannot judge is waited for, never taken ----------------
    {
        const fx = fixture('node probe.js 0');
        fs.mkdirSync(fx.lockDir, { recursive: true });
        const hand = 'not-a-pid\nhand-written by a session\n';
        fs.writeFileSync(fx.lockPath, hand);
        const run = start(fx);
        const waiting = await waitFor(() => /line 1 is not a pid/.test(run.out), 20000, 'the unjudgeable-holder line');
        await sleep(500);
        run.child.kill();
        await finished(run, 20000);
        check('unjudgeable holder: the wrapper waits and says why', waiting, run.out);
        check('unjudgeable holder: its lock is neither moved nor rewritten',
            fs.readFileSync(fx.lockPath, 'utf8') === hand && asides(fx, 'stale').length === 0);
        check('unjudgeable holder: the chain never ran', saw(fx) === null);
    }

    // -- 7. SIGTERM to the wrapper mid-chain: released, exit non-zero ----------
    if (WIN) {
        console.log('SKIP  SIGTERM release: win32 cannot deliver SIGTERM to another process (it terminates it outright); case 8 covers a forced kill of the chain');
    } else {
        const fx = fixture('node probe.js 0 30000');
        const run = start(fx);
        await waitFor(() => saw(fx) !== null, 20000, 'the chain to start');
        process.kill(run.child.pid, 'SIGTERM');
        const r = await finished(run);
        const s = saw(fx);
        if (s) killTree(s.pid);
        check('SIGTERM: the wrapper exits 2', r.code === 2, `exit=${r.code} signal=${r.signal}\n${r.out}`);
        check('SIGTERM: the final line says the chain did NOT finish',
            /verdict INDETERMINATE \(exit 2\), the chain did NOT finish: gate-lock was interrupted by SIGTERM/.test(r.out), r.out);
        check('SIGTERM: the lock is released', !fs.existsSync(fx.lockPath) && asides(fx, 'released').length === 1, r.out);
    }

    // -- 8. The chain child killed mid-run: never exit 0, lock released --------
    // A Git Bash wrapper recorded a `taskkill /F /T` of the gate as exit 0. The
    // exit status must come from the child's own exit event, code AND signal.
    {
        const fx = fixture('node probe.js 0 30000');
        const run = start(fx);
        const started = await waitFor(() => saw(fx) !== null && /chain pid \d+/.test(run.out), 20000, 'the chain to start');
        const chainPid = Number((run.out.match(/chain pid (\d+)/) || [])[1]);
        killTree(chainPid);
        // On POSIX a SIGKILL of the runner orphans npm and the probe, which
        // still hold the wrapper's stdout; end the probe so 'close' can fire.
        const s = saw(fx);
        if (s) killTree(s.pid);
        const r = await finished(run);
        check('killed chain: the wrapper printed the chain pid and the chain started', started && chainPid > 0, run.out);
        check('killed chain: the wrapper exits 2, INDETERMINATE', r.code === 2, `exit=${r.code}\n${r.out}`);
        // On Windows the forced kill arrives as exit code 1 with no signal, so
        // only the runner's missing record can tell it from a red chain.
        check('killed chain: the final line says the chain did NOT finish',
            WIN ? /verdict INDETERMINATE \(exit 2\), the chain did NOT finish: the chain runner exited \d+ without recording/.test(r.out)
                : /verdict INDETERMINATE \(exit 2\), the chain did NOT finish: the chain was killed by SIGKILL/.test(r.out), r.out);
        check('killed chain: the final line never says PASS', /verdict (FAIL|INDETERMINATE)/.test(r.out) && !/verdict PASS/.test(r.out), r.out);
        check('killed chain: the lock is released', !fs.existsSync(fx.lockPath) && asides(fx, 'released').length === 1, r.out);
    }

    // -- 9. AUTODEV_GATE_LOCK=0 skips the lock and keeps the exit code ----------
    {
        const fx = fixture('node probe.js 1');
        const r = await finished(start(fx, { AUTODEV_GATE_LOCK: '0' }));
        const s = saw(fx);
        check('env skip: the chain runs', s !== null, r.out);
        check('env skip: no lock existed while it ran', s && s.exists === false, JSON.stringify(s));
        check('env skip: the exit code is preserved', r.code === 1, `exit=${r.code}\n${r.out}`);
        check('env skip: it says the lock was skipped', /lock skipped \(AUTODEV_GATE_LOCK=0\)/.test(r.out), r.out);
        check('env skip: nothing was written in the lock directory', !fs.existsSync(fx.lockDir));
    }

    // -- 10. No gate:chain: INDETERMINATE, and no lock taken -------------------
    {
        const fx = fixture(null);
        const r = await finished(start(fx));
        check('no gate:chain: exits 2', r.code === 2, `exit=${r.code}\n${r.out}`);
        check('no gate:chain: says the chain did NOT run', /did NOT run; no lock was taken/.test(r.out), r.out);
        check('no gate:chain: no lock was taken', !fs.existsSync(fx.lockDir));
    }

    // -- 11. --help returns without running anything ---------------------------
    {
        const r = spawnSync(process.execPath, [SUBJECT, '--help'], { encoding: 'utf8', timeout: 10000 });
        check('--help exits 0 and prints usage', r.status === 0 && /usage: node tooling\/gate-lock\.js/.test(r.stdout), r.stdout);
    }
}

main()
    .catch((e) => { failed++; console.log('FAIL  the suite threw: ' + (e && e.stack)); })
    .finally(() => {
        for (const d of temps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
        console.log(`\n${passed} passed, ${failed} failed`);
        console.log(failed ? `${failed} gate-lock check(s) failed` : 'all gate-lock checks passed');
        process.exitCode = failed ? 1 : 0;
    });
