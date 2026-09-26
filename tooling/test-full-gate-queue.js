#!/usr/bin/env node
/**
 * test-full-gate-queue.js - drives plugins/autodev-core/scripts/full-gate-queue.js
 * as a SUBPROCESS.
 *
 * The property that matters is ORDER across processes: a newcomer that polls
 * first after a release must still lose to a waiter that arrived before it.
 * That is a property of runs, so every case starts the real script against a
 * lock path in a temp directory, with real long-lived processes standing in
 * for holders and waiters. The machine's real lock is never touched: every
 * spawn sets AUTODEV_GATE_LOCK_PATH, which matters most when this suite runs
 * inside a full gate that holds the real lock at the time.
 *
 * PLANTED DEFECTS. A green run of these scenarios says nothing until the same
 * scenarios have been seen to go red against the defect they exist to catch.
 * So the suite copies the subject, plants each defect by an exact anchor (the
 * anchor must match exactly once, or the plant itself is a failure), runs the
 * scenario against the copy, and requires it to FAIL:
 *   M1  any ticket may take a free lock, not only the oldest   -> newcomer jumps
 *   M2  a release hands the lock to the NEWEST ticket          -> newcomer jumps
 *   M3  liveness ignores ps, so an MSYS pid reads as dead      -> a live waiter is dropped
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const SUBJECT = path.join(__dirname, '..', 'plugins', 'autodev-core', 'scripts', 'full-gate-queue.js');
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

// ---------------------------------------------------------------------------
// Real processes as holders and waiters.
// ---------------------------------------------------------------------------

const sleepers = [];
const trees = []; // processes with children of their own, killed as a tree

function sleeper() {
    const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore', windowsHide: true });
    sleepers.push(c);
    return c.pid;
}

/** A pid that existed and has exited. */
function deadPid() {
    const r = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8', windowsHide: true });
    return Number(r.stdout.trim());
}

function killAll() {
    // A sleeper has no children, so killing it directly is enough and costs
    // nothing; taskkill /T runs only for the bash tree, at about a second each.
    for (const c of sleepers) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
    for (const c of trees) {
        if (WIN) spawnSync('taskkill', ['/F', '/T', '/PID', String(c.pid)], { stdio: 'ignore', windowsHide: true });
        else { try { c.kill('SIGKILL'); } catch { /* gone */ } }
    }
}

// ---------------------------------------------------------------------------
// Fixtures and invocation.
// ---------------------------------------------------------------------------

function fixture() {
    const dir = path.join(mkTemp('fgq-'), 'locks');
    fs.mkdirSync(dir, { recursive: true });
    return { dir, lock: path.join(dir, 'full-gate.lock'), queue: path.join(dir, 'full-gate.queue') };
}

function envFor(fx) {
    return Object.assign({}, process.env, {
        AUTODEV_GATE_LOCK_PATH: fx.lock,
        AUTODEV_GATE_LOCK_POLL_MS: '100',
        AUTODEV_GATE_LOCK_REPORT_MS: '100000',
        AUTODEV_GATE_QUEUE_STALE_MS: '600000',
    });
}

function run(subject, fx, args) {
    const r = spawnSync(process.execPath, [subject, ...args],
        { env: envFor(fx), encoding: 'utf8', windowsHide: true, timeout: 120000 });
    return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, error: r.error };
}

const take = (s, fx, pid) => run(s, fx, ['take', '--pid', String(pid), '--what', `test waiter ${pid}`]);
const release = (s, fx, pid) => run(s, fx, ['release', '--pid', String(pid)]);
const lockPid = (fx) => { try { return Number(fs.readFileSync(fx.lock, 'utf8').split(/\r?\n/)[0]); } catch { return null; } };
const tickets = (fx) => (fs.existsSync(fx.queue) ? fs.readdirSync(fx.queue).filter((f) => f.endsWith('.ticket')).sort() : []);
const ticketPids = (fx) => tickets(fx).map((f) => Number(f.split('-')[1].replace('.ticket', '')));
const asides = (fx, kind) => fs.readdirSync(fx.dir).filter((f) => f.startsWith(`full-gate.lock.${kind}-`));

/** A ticket written by hand, `agoMs` in the past, as a queued waiter would have left it. */
function plantTicket(fx, pid, agoMs, heartbeatAgoMs = 0) {
    fs.mkdirSync(fx.queue, { recursive: true });
    const d = new Date(Date.now() - agoMs);
    const name = `${d.toISOString().replace(/[-:.]/g, '')}-${String(pid).padStart(10, '0')}.ticket`;
    const file = path.join(fx.queue, name);
    fs.writeFileSync(file, `${pid}\nplanted ticket ${pid}\n${d.toISOString()}\n`);
    if (heartbeatAgoMs) { const h = new Date(Date.now() - heartbeatAgoMs); fs.utimesSync(file, h, h); }
    return file;
}

// ---------------------------------------------------------------------------
// Scenarios. Each returns [name, ok, detail] rows so it can be run against the
// real subject (every row must pass) and against a mutant (some row must fail).
// ---------------------------------------------------------------------------

/** The 2026-09-26 incident: a plain rename release, and the newcomer polls first. */
function scenarioNewcomerPollsFirst(subject) {
    const fx = fixture();
    const [h, a, b] = [sleeper(), sleeper(), sleeper()];
    fs.writeFileSync(fx.lock, `${h}\nhand-written holder\n`);
    const rows = [];
    const ra = take(subject, fx, a);
    rows.push(['A arrives while the lock is held: exit 3, place 1 of 1', ra.code === 3 && /place 1 of 1/.test(ra.out), ra.out]);
    const rb = take(subject, fx, b);
    rows.push(['B arrives after A: exit 3, place 2 of 2', rb.code === 3 && /place 2 of 2/.test(rb.out), rb.out]);
    fs.renameSync(fx.lock, `${fx.lock}.released-0000`);
    const rb2 = take(subject, fx, b);
    rows.push(['the holder releases by plain rename and B polls FIRST: B is still queued (exit 3)', rb2.code === 3, rb2.out]);
    rows.push(['B did not create the free lock', !fs.existsSync(fx.lock), fs.existsSync(fx.lock) ? fs.readFileSync(fx.lock, 'utf8') : '']);
    const ra2 = take(subject, fx, a);
    rows.push(['A polls second and takes the lock (exit 0, line 1 is A)', ra2.code === 0 && lockPid(fx) === a, ra2.out]);
    rows.push(['A\'s ticket is gone and B\'s remains', JSON.stringify(ticketPids(fx)) === JSON.stringify([b]), tickets(fx).join(', ')]);
    return rows;
}

/** Queue-aware release: the lock goes to the OLDEST ticket and never disappears. */
function scenarioHandoff(subject) {
    const fx = fixture();
    const [h, a, b] = [sleeper(), sleeper(), sleeper()];
    const rows = [];
    const rh = take(subject, fx, h);
    rows.push(['H takes a free lock with an empty queue (exit 0, line 1 is H)', rh.code === 0 && lockPid(fx) === h, rh.out]);
    rows.push(['H holds no ticket once it holds the lock', tickets(fx).length === 0, tickets(fx).join(', ')]);
    take(subject, fx, a);
    take(subject, fx, b);
    const rel = release(subject, fx, h);
    rows.push(['H releases: exit 0, the lock now names A, the oldest ticket', rel.code === 0 && lockPid(fx) === a, `${rel.out}\nlock: ${lockPid(fx)}`]);
    const rec = asides(fx, 'released');
    rows.push(['the release left a .released-HHMM record naming H',
        rec.length === 1 && fs.readFileSync(path.join(fx.dir, rec[0]), 'utf8').startsWith(`${h}\n`), rec.join(', ')]);
    const rb = take(subject, fx, b);
    rows.push(['B polls right after the handoff: still queued (exit 3)', rb.code === 3 && lockPid(fx) === a, rb.out]);
    const ra = take(subject, fx, a);
    rows.push(['A learns it holds the lock (exit 0)', ra.code === 0, ra.out]);
    const rel2 = release(subject, fx, a);
    rows.push(['A releases: the lock is handed to B', rel2.code === 0 && lockPid(fx) === b, rel2.out]);
    const rel3 = release(subject, fx, b);
    rows.push(['B releases with nobody queued: the lock is renamed aside, not handed over',
        rel3.code === 0 && !fs.existsSync(fx.lock) && asides(fx, 'released').length === 3 && /nobody was queued/.test(rel3.out), rel3.out]);
    return rows;
}

/** A waiter whose pid is an MSYS (Git Bash) pid: tasklist cannot see it, ps can. */
function scenarioMsysWaiter(subject, msys) {
    const fx = fixture();
    const h = sleeper();
    fs.writeFileSync(fx.lock, `${h}\nhand-written holder\n`);
    plantTicket(fx, msys, 60000);
    fs.writeFileSync(fx.lock, `${h}\nhand-written holder\n`);
    const rows = [];
    const rel = run(subject, fx, ['release', '--pid', String(h)]);
    rows.push([`H releases: the lock is handed to the live MSYS pid ${msys}, not dropped`,
        rel.code === 0 && lockPid(fx) === msys, `${rel.out}\nlock: ${lockPid(fx)}`]);
    return rows;
}

function report(label, rows) {
    for (const [name, ok, detail] of rows) check(`${label}: ${name}`, ok, detail);
}

/** Copies the subject with `anchor` replaced; null (and a FAIL) unless it matches exactly once. */
function mutant(id, anchor, replacement) {
    const src = fs.readFileSync(SUBJECT, 'utf8');
    const count = src.split(anchor).length - 1;
    check(`${id}: the anchor matches exactly once in the subject (found ${count})`, count === 1, anchor);
    if (count !== 1) return null;
    const file = path.join(mkTemp(`fgq-${id}-`), 'full-gate-queue.js');
    fs.writeFileSync(file, src.replace(anchor, replacement));
    return file;
}

function expectRed(id, what, rows) {
    const red = rows.filter(([, ok]) => !ok).map(([name]) => name);
    check(`${id} planted (${what}): the scenario goes red (${red.length} of ${rows.length} rows fail)`,
        red.length > 0, red.length ? `failing: ${red.join(' | ')}` : 'every row passed against the defect');
}

// ---------------------------------------------------------------------------
// The MSYS pid, when this machine has Git Bash.
// ---------------------------------------------------------------------------

function gitUsrBin(exe) {
    const ex = spawnSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true });
    if (ex.error || ex.status !== 0) return null;
    const p = path.resolve(ex.stdout.trim(), '..', '..', '..', 'usr', 'bin', exe);
    return fs.existsSync(p) ? p : null;
}

/** Starts a Git Bash that prints its own MSYS pid and sleeps. Resolves the pid, or null with a reason. */
async function msysPid() {
    if (!WIN) return { pid: null, why: 'not Windows, so there is no second pid table' };
    const bash = gitUsrBin('bash.exe');
    const ps = gitUsrBin('ps.exe');
    if (!bash || !ps) return { pid: null, why: 'Git Bash (usr/bin/bash.exe and ps.exe) not found' };
    // The pid goes to a FILE, not a pipe: a pipe inherited by the sleeping
    // grandchild keeps this suite alive until the sleep ends, whatever is killed.
    // One-second sleeps, so an orphan left by the tree kill is gone in a second.
    const pidFile = path.join(mkTemp('fgq-msys-'), 'pid');
    const c = spawn(bash, ['-c', `echo $$ > '${pidFile.replace(/\\/g, '/')}'; for i in $(seq 1 300); do sleep 1; done`],
        { stdio: 'ignore', windowsHide: true });
    trees.push(c);
    let text = '';
    for (let i = 0; i < 200 && !/\n/.test(text); i++) {
        await sleep(100);
        try { text = fs.readFileSync(pidFile, 'utf8'); } catch { /* not written yet */ }
    }
    const pid = Number(text.trim());
    if (!pid) return { pid: null, why: 'bash did not write its pid within 20 s' };
    const t = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8', windowsHide: true });
    if (new RegExp(`^"[^"]*","${pid}"`, 'm').test(t.stdout || '')) return { pid: null, why: `MSYS pid ${pid} is also a live Windows pid, so it proves nothing` };
    const p = spawnSync(ps, ['-p', String(pid)], { encoding: 'utf8', windowsHide: true });
    if (!(p.stdout || '').split(/\r?\n/).some((l) => l.trim().split(/\s+/)[0] === String(pid))) return { pid: null, why: `ps -p ${pid} did not list it` };
    return { pid, why: null };
}

// ---------------------------------------------------------------------------

async function main() {
    // --help and argument errors.
    {
        const fx = fixture();
        const h = run(SUBJECT, fx, ['--help']);
        check('--help exits 0 and names all four commands',
            h.code === 0 && ['take', 'wait', 'release', 'status'].every((c) => h.out.includes(c)), h.out);
        check('--help touches nothing', fs.readdirSync(fx.dir).length === 0, fs.readdirSync(fx.dir).join(', '));
        const bad = run(SUBJECT, fx, ['grab']);
        check('an unknown command exits 1 and points at --help', bad.code === 1 && /--help/.test(bad.out), bad.out);
        const badPid = run(SUBJECT, fx, ['take', '--pid', 'abc']);
        check('a non-numeric --pid exits 1', badPid.code === 1 && /whole number/.test(badPid.out), badPid.out);
        const dead = run(SUBJECT, fx, ['take', '--pid', String(deadPid())]);
        check('a --pid that is not running exits 1 and queues nothing',
            dead.code === 1 && /not running/.test(dead.out) && tickets(fx).length === 0, dead.out);
    }

    report('newcomer polls first', scenarioNewcomerPollsFirst(SUBJECT));
    report('handoff', scenarioHandoff(SUBJECT));

    // A dead waiter's ticket is dropped, and it does not hold up the queue.
    {
        const fx = fixture();
        const [d, a] = [deadPid(), sleeper()];
        const planted = plantTicket(fx, d, 120000);
        const ra = take(SUBJECT, fx, a);
        check('dead ticket: a live waiter behind a dead pid\'s older ticket takes the free lock',
            ra.code === 0 && lockPid(fx) === a, ra.out);
        check('dead ticket: the dead pid\'s ticket file is removed and the drop is reported',
            !fs.existsSync(planted) && new RegExp(`dropped the ticket of pid ${d}`).test(ra.out), ra.out);
    }

    // A live pid whose ticket heartbeat is stale is skipped at release.
    {
        const fx = fixture();
        const [h, s, a] = [sleeper(), sleeper(), sleeper()];
        fs.writeFileSync(fx.lock, `${h}\nholder\n`);
        const staleTicket = plantTicket(fx, s, 30 * 60000, 20 * 60000);
        take(SUBJECT, fx, a);
        const rel = release(SUBJECT, fx, h);
        check('stale heartbeat: the release skips an older ticket with no heartbeat for 20 min and hands to A',
            rel.code === 0 && lockPid(fx) === a && !fs.existsSync(staleTicket), `${rel.out}\nlock: ${lockPid(fx)}`);
    }

    // A dead holder: only the head of the queue moves its lock aside.
    {
        const fx = fixture();
        const [d, a, b] = [deadPid(), sleeper(), sleeper()];
        fs.writeFileSync(fx.lock, `${d}\ncrashed holder\n`);
        plantTicket(fx, a, 60000);
        const rb = take(SUBJECT, fx, b);
        check('dead holder: B, not the head, leaves the dead holder\'s lock in place (exit 3)',
            rb.code === 3 && lockPid(fx) === d && asides(fx, 'stale').length === 0, rb.out);
        const ra = take(SUBJECT, fx, a);
        check('dead holder: A, the head, moves it to .stale-HHMM and takes the lock',
            ra.code === 0 && lockPid(fx) === a && asides(fx, 'stale').length === 1, ra.out);
    }

    // A live holder the queue cannot judge is waited for, never moved.
    {
        const fx = fixture();
        const a = sleeper();
        fs.writeFileSync(fx.lock, 'not-a-pid\nsomething odd\n');
        const ra = take(SUBJECT, fx, a);
        check('unjudgeable holder: a lock whose line 1 is not a pid is waited for, not moved',
            ra.code === 3 && fs.readFileSync(fx.lock, 'utf8').startsWith('not-a-pid'), ra.out);
    }

    // release refuses what is not its own.
    {
        const fx = fixture();
        const [h, x] = [sleeper(), sleeper()];
        const none = release(SUBJECT, fx, x);
        check('release with no lock exits 1', none.code === 1 && /nothing to release/.test(none.out), none.out);
        fs.writeFileSync(fx.lock, `${h}\nholder\n`);
        const other = release(SUBJECT, fx, x);
        check('release by a pid that does not hold the lock exits 1 and leaves the lock untouched',
            other.code === 1 && lockPid(fx) === h && asides(fx, 'released').length === 0, other.out);
    }

    // status is read-only and lists the queue in arrival order.
    {
        const fx = fixture();
        const [h, a, b, d] = [sleeper(), sleeper(), sleeper(), deadPid()];
        fs.writeFileSync(fx.lock, `${h}\nholder text\n`);
        plantTicket(fx, a, 90000);
        plantTicket(fx, b, 60000);
        plantTicket(fx, d, 30000);
        const before = tickets(fx).join(',');
        const st = run(SUBJECT, fx, ['status']);
        const ia = st.out.indexOf(`pid ${a},`);
        const ib = st.out.indexOf(`pid ${b},`);
        check('status: prints the live holder and the queue oldest first',
            st.code === 0 && st.out.includes(`holder: pid ${h} (alive): holder text`) && ia > 0 && ib > ia, st.out);
        check('status: marks the dead ticket and deletes nothing',
            /will be dropped: pid \d+ is not running/.test(st.out) && tickets(fx).join(',') === before, st.out);
        const js = run(SUBJECT, fx, ['status', '--json']);
        let parsed = null;
        try { parsed = JSON.parse(js.out); } catch { /* reported below */ }
        check('status --json: parses, three tickets read, in arrival order',
            parsed && parsed.ticketFilesRead === 3 && parsed.queue.map((t) => t.pid).join() === [a, b, d].join(), js.out);
    }

    // wait blocks until the handoff, then exits 0.
    {
        const fx = fixture();
        const [h, a] = [sleeper(), sleeper()];
        fs.writeFileSync(fx.lock, `${h}\nholder\n`);
        const w = spawn(process.execPath, [SUBJECT, 'wait', '--pid', String(a), '--what', 'waiting test'],
            { env: envFor(fx), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        let out = '';
        w.stdout.on('data', (d) => { out += d; });
        w.stderr.on('data', (d) => { out += d; });
        const done = new Promise((r) => w.on('close', (code) => r(code)));
        for (let i = 0; i < 300 && !/waiting: place 1 of 1/.test(out); i++) await sleep(100);
        check('wait: reports its place while the lock is held', /waiting: place 1 of 1/.test(out), out);
        const rel = release(SUBJECT, fx, h);
        let timer;
        const bound = new Promise((r) => { timer = setTimeout(() => r('timeout'), 60000); });
        const code = await Promise.race([done, bound]);
        clearTimeout(timer); // a pending 60 s timer would hold the suite open after its summary
        if (code === 'timeout') { try { w.kill(); } catch { /* gone */ } }
        check('wait: exits 0 once the release hands it the lock, and the lock names its pid',
            code === 0 && lockPid(fx) === a, `${rel.out}\n${out}\nexit ${code}`);
    }

    // wait --timeout-ms gives up and removes its ticket.
    {
        const fx = fixture();
        const [h, a] = [sleeper(), sleeper()];
        fs.writeFileSync(fx.lock, `${h}\nholder\n`);
        const w = run(SUBJECT, fx, ['wait', '--pid', String(a), '--what', 'impatient', '--timeout-ms', '300']);
        check('wait --timeout-ms: exits 3, removes its ticket, leaves the lock with its holder',
            w.code === 3 && tickets(fx).length === 0 && lockPid(fx) === h && /NOT taken/.test(w.out), w.out);
    }

    // With no --what, line 2 describes the checkout; with no lock path, the
    // default is under the OS home directory.
    {
        const fx = fixture();
        const a = sleeper();
        const r = run(SUBJECT, fx, ['take', '--pid', String(a)]);
        const line2 = fs.existsSync(fx.lock) ? fs.readFileSync(fx.lock, 'utf8').split(/\r?\n/)[1] : '';
        check('no --what: line 2 names the branch, head and worktree, and when the lock was taken',
            r.code === 0 && /^npm run gate, branch \S+, head \S+, worktree \S+, queued \d\d:\d\dZ, lock taken \d\d:\d\dZ$/.test(line2), `${r.out}\nline 2: ${line2}`);
        const home = mkTemp('fgq-home-');
        const env = Object.assign({}, process.env, { USERPROFILE: home, HOME: home });
        delete env.AUTODEV_GATE_LOCK_PATH;
        const st = spawnSync(process.execPath, [SUBJECT, 'status'], { env, encoding: 'utf8', windowsHide: true });
        const want = path.join(home, '.claude', 'autodev', 'locks', 'full-gate.lock');
        check('no AUTODEV_GATE_LOCK_PATH: the lock defaults to <home>/.claude/autodev/locks/full-gate.lock',
            st.status === 0 && st.stdout.includes(want), st.stdout + st.stderr);
    }

    // A signal stops wait without taking the lock. Windows cannot deliver one
    // that a handler sees, so this runs where it can.
    if (!WIN) {
        const fx = fixture();
        const [h, a] = [sleeper(), sleeper()];
        fs.writeFileSync(fx.lock, `${h}\nholder\n`);
        const w = spawn(process.execPath, [SUBJECT, 'wait', '--pid', String(a), '--what', 'signalled'],
            { env: envFor(fx), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        let out = '';
        w.stdout.on('data', (d) => { out += d; });
        const done = new Promise((r) => w.on('close', (code) => r(code)));
        for (let i = 0; i < 300 && !/waiting: place/.test(out); i++) await sleep(100);
        w.kill('SIGTERM');
        const code = await done;
        check('wait on SIGTERM: exits 2, removes its ticket, leaves the lock with its holder',
            code === 2 && tickets(fx).length === 0 && lockPid(fx) === h, `${out}\nexit ${code}`);
    } else {
        console.log('SKIP  wait on SIGTERM: Windows delivers no signal a handler can see');
    }

    // The planted defects. Each must turn a scenario above red.
    const m1 = mutant('M1', 'if (mine !== 0) return queued(held);', 'if (mine < 0) return queued(held);');
    if (m1) expectRed('M1', 'any ticket may take a free lock', scenarioNewcomerPollsFirst(m1));
    const m2 = mutant('M2', 'const next = live[0];', 'const next = live[live.length - 1];');
    if (m2) expectRed('M2', 'release hands the lock to the newest ticket', scenarioHandoff(m2));

    const msys = await msysPid();
    if (msys.pid) {
        report('MSYS waiter', scenarioMsysWaiter(SUBJECT, msys.pid));
        const m3 = mutant('M3', 'if (found) return true;', 'if (found) { /* planted: ps ignored */ }');
        if (m3) expectRed('M3', 'liveness ignores ps', scenarioMsysWaiter(m3, msys.pid));
    } else {
        console.log(`SKIP  MSYS waiter and planted M3: ${msys.why}`);
    }
}

main()
    .catch((e) => { failed++; console.log(`FAIL  the suite threw: ${e && e.stack ? e.stack : e}`); })
    .finally(() => {
        killAll();
        for (const d of temps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
        console.log(`\n${passed} passed, ${failed} failed`);
        process.exitCode = failed ? 1 : 0;
    });
